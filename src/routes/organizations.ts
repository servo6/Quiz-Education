import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { loadSubject } from "../access.ts";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { hashPassword } from "../password.ts";
import { assertCan, can } from "../permissions.ts";
import { usernameSchema } from "./auth.ts";
import { emailSchema } from "./email.ts";
import { sendVerificationMail, staffDeadline } from "../emailService.ts";
import { applyPatch, mergeSettings, parseStoredSettings, SettingsPatchSchema } from "../settings.ts";
import { invalidateSettings, loadGlobalSettings } from "../settingsStore.ts";
import { applyTimeToRunningGames } from "../runningGames.ts";

const name = z.string().trim().min(2, "2 caractères minimum").max(80);
const CreateBody = z.object({ name });
const PatchBody = z.object({ name: name.optional() }).strict().refine((b) => Object.keys(b).length > 0, "Aucune modification demandée");
const AccountBody = z.object({ username: usernameSchema, email: emailSchema.optional(), password: z.string().min(8, "8 caractères minimum").max(128) });

export function registerOrganizationRoutes(app: FastifyInstance, deps: Deps): void {
  const { prisma, auth, limit } = deps;
  async function loadOrg(id: string) {
    const o = await prisma.organization.findUnique({ where: { id } });
    if (!o) throw new HttpError(404, "organization_not_found", "Organisation introuvable");
    return o;
  }

  // ───────────── Gestion (super admin, admin de l'organisation) ─────────────

  app.get("/api/organizations", async (req) => {
    const ctx = await auth(req);
    if (ctx.actor.role !== "ADMIN" && ctx.actor.role !== "ORG_ADMIN") throw new HttpError(403, "forbidden", "Action non autorisée");
    const where = ctx.actor.role === "ADMIN" ? {} : { id: { in: [...(ctx.actor.adminOrgIds ?? [])] } };
    const orgs = await prisma.organization.findMany({
      where,
      orderBy: { name: "asc" },
      select: { id: true, name: true, createdAt: true, _count: { select: { subjects: true, members: { where: { revokedAt: null } }, admins: true } } },
    });
    return { organizations: orgs.map(({ _count, ...o }) => ({ ...o, subjectCount: _count.subjects, memberCount: _count.members, adminCount: _count.admins })) };
  });

  app.post("/api/organizations", async (req, reply) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "org:create");
    const body = CreateBody.parse(req.body);
    if (await prisma.organization.findUnique({ where: { name: body.name } })) throw new HttpError(409, "organization_name_taken", "Une organisation porte déjà ce nom");
    const internal = randomBytes(12).toString("hex"); // clés internes inutilisées : l'accès se fait par matière
    const org = await prisma.organization.create({ data: { name: body.name, accessName: `o-${internal}`, accessPasswordHash: await hashPassword(internal) } });
    await logAction(prisma, ctx.user.id, null, "CREATE_ORGANIZATION", { name: org.name });
    return reply.status(201).send({ organization: { id: org.id, name: org.name } });
  });

  app.get<{ Params: { id: string } }>("/api/organizations/:id", async (req) => {
    const ctx = await auth(req);
    const org = await loadOrg(req.params.id);
    assertCan(ctx.actor, "org:manage", org.id);
    const [admins, subjects] = await Promise.all([
      prisma.orgAdmin.findMany({ where: { organizationId: org.id }, select: { user: { select: { id: true, username: true, bannedAt: true } } } }),
      prisma.subject.findMany({ where: { organizationId: org.id }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ]);
    return { organization: { id: org.id, name: org.name }, admins: admins.map((a) => ({ id: a.user.id, username: a.user.username, banned: !!a.user.bannedAt })), subjects };
  });

  app.patch<{ Params: { id: string } }>("/api/organizations/:id", async (req) => {
    const ctx = await auth(req);
    const org = await loadOrg(req.params.id);
    assertCan(ctx.actor, "org:manage", org.id);
    const body = PatchBody.parse(req.body);
    const data: Record<string, unknown> = {};
    if (body.name !== undefined && body.name !== org.name) {
      if (await prisma.organization.findUnique({ where: { name: body.name } })) throw new HttpError(409, "organization_name_taken", "Une organisation porte déjà ce nom");
      data.name = body.name;
    }
    const updated = await prisma.organization.update({ where: { id: org.id }, data });
    await logAction(prisma, ctx.user.id, null, "UPDATE_ORGANIZATION", { organization: org.name, fields: Object.keys(body) });
    return { organization: { id: updated.id, name: updated.name } };
  });

  // Une organisation ne se supprime que vide : on supprime d'abord ses matières (chacune demande sa confirmation).
  app.delete<{ Params: { id: string } }>("/api/organizations/:id", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "org:delete");
    const org = await loadOrg(req.params.id);
    const { confirmName } = z.object({ confirmName: z.string() }).parse(req.body ?? {});
    if (confirmName !== org.name) throw new HttpError(422, "confirmation_mismatch", "Pour confirmer, saisis exactement le nom de l'organisation", { expected: "name" });
    if ((await prisma.subject.count({ where: { organizationId: org.id } })) > 0) {
      throw new HttpError(409, "organization_not_empty", "Supprime d'abord les matières de cette organisation");
    }
    await prisma.$transaction(async (tx) => {
      await tx.setting.deleteMany({ where: { key: { in: [`org:${org.id}`, `ui.theme:org:${org.id}`] } } });
      await tx.orgMember.deleteMany({ where: { organizationId: org.id } });
      await tx.orgAdmin.deleteMany({ where: { organizationId: org.id } });
      await tx.organization.delete({ where: { id: org.id } });
      await logAction(tx, ctx.user.id, null, "DELETE_ORGANIZATION", { name: org.name });
    });
    return { ok: true };
  });

  // ── Administrateurs d'organisation : comptes CRÉÉS par le super administrateur (jamais un joueur promu)
  app.post<{ Params: { id: string } }>("/api/organizations/:id/admins", async (req, reply) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "orgadmin:manage");
    const org = await loadOrg(req.params.id);
    const { username, email, password } = AccountBody.parse(req.body);
    if (await prisma.user.findUnique({ where: { username } })) throw new HttpError(409, "username_taken", "Ce pseudo est déjà pris");
    if (email && (await prisma.user.findUnique({ where: { email } }))) throw new HttpError(409, "email_taken", "Cette adresse e-mail est déjà utilisée");
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { username, email: email ?? null, verifyDeadline: staffDeadline(), passwordHash: await hashPassword(password), role: "ORG_ADMIN", createdById: ctx.user.id } });
      await tx.orgAdmin.create({ data: { userId: u.id, organizationId: org.id } });
      await logAction(tx, ctx.user.id, null, "CREATE_ORG_ADMIN", { organization: org.name, username });
      return u;
    });
    if (email) await sendVerificationMail(deps, req, user, email).catch((e) => req.log.error(e, "mail de vérification"));
    return reply.status(201).send({ admin: { id: user.id, username: user.username } });
  });

  // Rattacher un administrateur existant à une autre organisation
  app.put<{ Params: { id: string; userId: string } }>("/api/organizations/:id/admins/:userId", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "orgadmin:manage");
    const org = await loadOrg(req.params.id);
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target || target.role !== "ORG_ADMIN") throw new HttpError(404, "user_not_found", "Administrateur d'organisation introuvable");
    await prisma.orgAdmin.upsert({ where: { userId_organizationId: { userId: target.id, organizationId: org.id } }, create: { userId: target.id, organizationId: org.id }, update: {} });
    await logAction(prisma, ctx.user.id, null, "ASSIGN_ORG_ADMIN", { organization: org.name, username: target.username });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/organizations/:id/admins/:userId", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "orgadmin:manage");
    const org = await loadOrg(req.params.id);
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) throw new HttpError(404, "user_not_found", "Utilisateur introuvable");
    await prisma.orgAdmin.deleteMany({ where: { userId: target.id, organizationId: org.id } });
    await logAction(prisma, ctx.user.id, null, "REMOVE_ORG_ADMIN", { organization: org.name, username: target.username });
    return { ok: true };
  });

  // ── Réglages de la plateforme appliqués à une seule organisation (par-dessus les réglages globaux)
  async function orgSettings(orgId: string) {
    const row = await prisma.setting.findUnique({ where: { key: `org:${orgId}` } });
    const overrides = parseStoredSettings(row?.value);
    return { overrides, settings: mergeSettings({ ...(await loadGlobalSettings(prisma)), ...overrides }) };
  }
  app.get<{ Params: { id: string } }>("/api/organizations/:id/settings", async (req) => {
    const ctx = await auth(req);
    const org = await loadOrg(req.params.id);
    assertCan(ctx.actor, "org:manage", org.id);
    return orgSettings(org.id);
  });
  app.put<{ Params: { id: string } }>("/api/organizations/:id/settings", async (req) => {
    const ctx = await auth(req);
    const org = await loadOrg(req.params.id);
    assertCan(ctx.actor, "org:manage", org.id);
    const patch = SettingsPatchSchema.parse(req.body);
    const key = `org:${org.id}`;
    const current = parseStoredSettings((await prisma.setting.findUnique({ where: { key } }))?.value);
    const next = applyPatch(current, patch);
    if (Object.keys(next).length) await prisma.setting.upsert({ where: { key }, create: { key, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
    else await prisma.setting.deleteMany({ where: { key } });
    invalidateSettings();
    await logAction(prisma, ctx.user.id, null, "UPDATE_ORG_SETTINGS", { organization: org.name, keys: Object.keys(patch) });
    if ("timePerQuestionSec" in patch) await applyTimeToRunningGames(prisma, null);
    return orgSettings(org.id);
  });

  // ── Joueurs d'une organisation
  app.get<{ Params: { id: string } }>("/api/organizations/:id/members", async (req) => {
    const ctx = await auth(req);
    const org = await loadOrg(req.params.id);
    assertCan(ctx.actor, "org:manage", org.id);
    const rows = await prisma.orgMember.findMany({
      where: { organizationId: org.id },
      orderBy: { joinedAt: "desc" },
      take: 500,
      select: { revokedAt: true, joinedAt: true, user: { select: { id: true, username: true, bannedAt: true } } },
    });
    return { members: rows.map((m) => ({ userId: m.user.id, username: m.user.username, joinedAt: m.joinedAt, revokedAt: m.revokedAt, banned: !!m.user.bannedAt })) };
  });

  // ───────────── Côté joueur ─────────────

  void can;
}
