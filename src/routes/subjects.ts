import { parseAvatar } from "../avatar.ts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadSubject } from "../access.ts";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { assertCan } from "../permissions.ts";
import { fakeVerify, hashPassword, verifyPassword } from "../password.ts";
import { randomBytes } from "node:crypto";
import { usernameSchema } from "./auth.ts";
import { emailSchema } from "./email.ts";
import { sendVerificationMail, staffDeadline, verificationOverdue } from "../emailService.ts";
import { applyTimeToRunningGames } from "../runningGames.ts";
import { invalidateSettings, loadEffectiveSettings } from "../settingsStore.ts";
import { applyPatch, mergeSettings, parseStoredSettings, SettingsPatchSchema } from "../settings.ts";

const subjectName = z.string().trim().min(2).max(60);

const accessName = z.string().trim().toLowerCase().min(3, "3 caractères minimum").max(40).regex(/^[a-z0-9_.-]+$/, "lettres, chiffres, point, tiret et underscore");
const accessPassword = z.string().min(8, "8 caractères minimum").max(128);
const JoinBody = z.object({ accessName: z.string().trim().toLowerCase().min(1), accessPassword: z.string().min(1).max(128) });

const CreateBody = z
  .object({ name: subjectName, organizationId: z.string().min(1).optional(), accessName: accessName.optional(), accessPassword: accessPassword.optional() })
  .refine((b) => (b.accessName === undefined) === (b.accessPassword === undefined), "Indique le nom d'accès et le mot de passe d'accès");

const PatchBody = z
  .object({ name: subjectName, settings: SettingsPatchSchema, accessName, accessPassword })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, "Aucune modification demandée");

const ManagerAccountBody = z.object({ username: usernameSchema, email: emailSchema.optional(), password: z.string().min(8, "8 caractères minimum").max(128) });

async function globalSettings(prisma: Deps["prisma"]) {
  const rows = await prisma.setting.findMany();
  const obj: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      obj[r.key] = JSON.parse(r.value);
    } catch {
      /* ignoré */
    }
  }
  return parseStoredSettings(JSON.stringify(obj));
}

export function registerSubjectRoutes(app: FastifyInstance, deps: Deps): void {
  const { prisma, auth, limit } = deps;
  // ── Matières à gérer : super admin = toutes ; admin d'organisation = celles de ses organisations ; responsable = les siennes.
  app.get<{ Querystring: { organizationId?: string } }>("/api/subjects", async (req) => {
    const ctx = await auth(req);
    if (ctx.actor.role === "USER") throw new HttpError(403, "forbidden", "Action non autorisée");
    const ids = ctx.actor.role === "ADMIN" ? null : ctx.actor.role === "ORG_ADMIN" ? [...(ctx.actor.orgSubjectIds ?? [])] : [...ctx.actor.managedSubjectIds];
    const orgFilter = typeof req.query.organizationId === "string" && req.query.organizationId ? { organizationId: req.query.organizationId } : {};
    const subjects = await prisma.subject.findMany({
      where: { ...(ids ? { id: { in: ids } } : {}), ...orgFilter },
      orderBy: [{ organization: { name: "asc" } }, { name: "asc" }],
      select: {
        id: true, name: true, createdAt: true, organizationId: true,
        organization: { select: { name: true } },
        managers: { select: { user: { select: { id: true, username: true } } } },
        _count: { select: { memberships: { where: { user: { role: "USER" } } } } },
      },
    });
    return {
      subjects: subjects.map(({ _count, organization, managers, ...s }) => ({
        ...s, organizationName: organization.name, managers: managers.map((m) => m.user), memberCount: _count.memberships,
      })),
    };
  });

  app.post("/api/subjects", async (req, reply) => {
    const ctx = await auth(req);
    if (ctx.actor.role !== "ADMIN" && ctx.actor.role !== "ORG_ADMIN") throw new HttpError(403, "forbidden", "Action non autorisée");
    const body = CreateBody.parse(req.body);
    // Le super administrateur peut omettre l'organisation s'il n'en existe qu'une.
    let organizationId = body.organizationId;
    if (!organizationId && ctx.actor.role === "ADMIN") {
      const orgs = await prisma.organization.findMany({ select: { id: true }, take: 2 });
      if (orgs.length === 1) organizationId = orgs[0].id;
    }
    if (!organizationId) throw new HttpError(422, "organization_required", "Choisis l'organisation de la matière");
    assertCan(ctx.actor, "subject:create", organizationId);
    if (!(await prisma.organization.findUnique({ where: { id: organizationId } }))) throw new HttpError(404, "organization_not_found", "Organisation introuvable");

    if (await prisma.subject.findUnique({ where: { organizationId_name: { organizationId, name: body.name } } })) {
      throw new HttpError(409, "subject_name_taken", "Une matière porte déjà ce nom dans cette organisation");
    }
    // Sans clés d'accès fournies, la matière reste fermée tant que le nom et le mot de passe d'accès ne sont pas définis.
    const internal = randomBytes(12).toString("hex");
    const name = body.accessName ?? `m-${internal}`;
    if (await prisma.subject.findUnique({ where: { accessName: name } })) throw new HttpError(409, "access_name_taken", "Ce nom d'accès est déjà utilisé");
    const subject = await prisma.subject.create({
      data: { organizationId, name: body.name, accessName: name, accessPasswordHash: await hashPassword(body.accessPassword ?? internal) },
    });
    await logAction(prisma, ctx.user.id, subject.id, "CREATE_SUBJECT", { name: subject.name });
    // Un compte de gestion n'est pas un joueur : il choisit seulement la matière qu'il gère.
    if (!ctx.user.activeSubjectId) {
      await prisma.user.update({ where: { id: ctx.user.id }, data: { activeSubjectId: subject.id } });
    }
    return reply.status(201).send({ subject: { id: subject.id, name: subject.name, organizationId } });
  });

  // ── Détail d'une matière pour la gestion
  app.get<{ Params: { id: string } }>("/api/subjects/:id", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "subject:settings", subject.id);
    const overrides = parseStoredSettings(subject.settings);
    const effective = await loadEffectiveSettings(prisma, subject.settings, subject.organizationId);
    const managers = await prisma.subjectManager.findMany({
      where: { subjectId: subject.id },
      select: { user: { select: { id: true, username: true, avatar: true } } },
    });
    return {
      subject: { id: subject.id, name: subject.name, organizationId: subject.organizationId, accessName: subject.accessName },
      overrides,
      settings: effective,
      managers: managers.map((m) => ({ ...m.user, avatar: parseAvatar(m.user.avatar) })),
    };
  });

  app.patch<{ Params: { id: string } }>("/api/subjects/:id", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    const body = PatchBody.parse(req.body);

    if (body.name !== undefined) assertCan(ctx.actor, "subject:rename", subject.id);
    if (body.settings !== undefined) assertCan(ctx.actor, "subject:settings", subject.id);
    if (body.accessName !== undefined || body.accessPassword !== undefined) assertCan(ctx.actor, "subject:access", subject.id);

    const data: Record<string, unknown> = {};
    if (body.name !== undefined && body.name !== subject.name) {
      if (await prisma.subject.findUnique({ where: { organizationId_name: { organizationId: subject.organizationId, name: body.name } } })) {
        throw new HttpError(409, "subject_name_taken", "Une matière porte déjà ce nom dans cette organisation");
      }
      data.name = body.name;
    }
    if (body.accessName !== undefined && body.accessName !== subject.accessName) {
      if (await prisma.subject.findUnique({ where: { accessName: body.accessName } })) throw new HttpError(409, "access_name_taken", "Ce nom d'accès est déjà utilisé");
      data.accessName = body.accessName;
    }
    if (body.accessPassword !== undefined) data.accessPasswordHash = await hashPassword(body.accessPassword);
    if (body.settings !== undefined) {
      data.settings = JSON.stringify(applyPatch(parseStoredSettings(subject.settings), body.settings));
    }

    const updated = await prisma.subject.update({ where: { id: subject.id }, data });
    if (body.settings && "timePerQuestionSec" in body.settings) await applyTimeToRunningGames(prisma, subject.id);
    await logAction(prisma, ctx.user.id, subject.id, "UPDATE_SUBJECT", { fields: Object.keys(body) });
    return {
      subject: { id: updated.id, name: updated.name },
      overrides: parseStoredSettings(updated.settings),
    };
  });

  // ── Rejoindre une matière avec ses clés d'accès : l'organisation en découle. Un joueur n'appartient qu'à une organisation.
  app.post("/api/subjects/join", { config: limit(10) }, async (req) => {
    const ctx = await auth(req);
    if (ctx.actor.role !== "USER") throw new HttpError(403, "admin_cannot_play", "Un compte de gestion ne rejoint pas de matière");
    const body = JoinBody.parse(req.body);
    const subject = await prisma.subject.findUnique({ where: { accessName: body.accessName } });
    const ok = subject ? await verifyPassword(body.accessPassword, subject.accessPasswordHash) : await fakeVerify(body.accessPassword);
    if (!subject || !ok) throw new HttpError(401, "bad_access", "Nom ou mot de passe d'accès incorrect");

    const orgs = await prisma.orgMember.findMany({ where: { userId: ctx.user.id } });
    if (orgs.some((o) => o.organizationId !== subject.organizationId)) {
      throw new HttpError(409, "other_organization", "Tu appartiens déjà à une autre organisation. Crée un autre compte pour rejoindre cette matière.");
    }
    if (orgs.some((o) => o.revokedAt)) throw new HttpError(403, "access_revoked", "Ton accès à cette organisation a été révoqué");
    const existing = await prisma.membership.findUnique({ where: { userId_subjectId: { userId: ctx.user.id, subjectId: subject.id } } });
    if (existing?.revokedAt) throw new HttpError(403, "access_revoked", "Ton accès à cette matière a été révoqué");
    if (!orgs.length) await prisma.orgMember.create({ data: { userId: ctx.user.id, organizationId: subject.organizationId } });
    if (!existing) await prisma.membership.create({ data: { userId: ctx.user.id, subjectId: subject.id } });
    if (!ctx.user.activeSubjectId) await prisma.user.update({ where: { id: ctx.user.id }, data: { activeSubjectId: subject.id } });
    return { subject: { id: subject.id, name: subject.name }, alreadyMember: !!existing };
  });

  // ── Changer de matière active (joueur : une matière rejointe ; compte de gestion : une matière qu'il gère)
  app.post("/api/me/active-subject", async (req) => {
    const ctx = await auth(req);
    const { subjectId } = z.object({ subjectId: z.string().min(1) }).parse(req.body);
    if (ctx.actor.role !== "USER") {
      const allowed = ctx.actor.role === "ADMIN" || ctx.actor.managedSubjectIds.has(subjectId) || !!ctx.actor.orgSubjectIds?.has(subjectId);
      if (!allowed) throw new HttpError(403, "forbidden", "Tu ne gères pas cette matière");
      if (!(await prisma.subject.findUnique({ where: { id: subjectId } }))) throw new HttpError(404, "subject_not_found", "Matière introuvable");
    } else {
      const membership = await prisma.membership.findUnique({ where: { userId_subjectId: { userId: ctx.user.id, subjectId } } });
      if (!membership || membership.revokedAt) throw new HttpError(403, "not_a_member", "Tu n'as pas accès à cette matière");
    }
    await prisma.user.update({ where: { id: ctx.user.id }, data: { activeSubjectId: subjectId } });
    return { activeSubjectId: subjectId };
  });

  // ── Responsables de matière : comptes CRÉÉS par l'administrateur de l'organisation (ou le super admin), jamais un joueur promu
  app.post<{ Params: { id: string } }>("/api/subjects/:id/managers", async (req, reply) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "managers:assign", subject.id);
    const { username, email, password } = ManagerAccountBody.parse(req.body);
    if (await prisma.user.findUnique({ where: { username } })) throw new HttpError(409, "username_taken", "Ce pseudo est déjà pris");
    if (email && (await prisma.user.findUnique({ where: { email } }))) throw new HttpError(409, "email_taken", "Cette adresse e-mail est déjà utilisée");
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { username, email: email ?? null, verifyDeadline: staffDeadline(), passwordHash: await hashPassword(password), role: "SUBJECT_MANAGER", createdById: ctx.user.id } });
      await tx.subjectManager.create({ data: { userId: u.id, subjectId: subject.id } });
      await logAction(tx, ctx.user.id, subject.id, "CREATE_MANAGER", { username });
      return u;
    });
    if (email) await sendVerificationMail(deps, req, user, email).catch((e) => req.log.error(e, "mail de vérification"));
    return reply.status(201).send({ manager: { id: user.id, username: user.username } });
  });

  // Confier une matière de plus à un responsable existant de la même organisation
  app.put<{ Params: { id: string; userId: string } }>("/api/subjects/:id/managers/:userId", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "managers:assign", subject.id);
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target || target.role !== "SUBJECT_MANAGER") throw new HttpError(404, "user_not_found", "Responsable introuvable : crée d'abord son compte");
    const sameOrg = target.createdById === ctx.user.id || ctx.actor.role === "ADMIN"
      || (await prisma.subjectManager.count({ where: { userId: target.id, subject: { organizationId: subject.organizationId } } })) > 0;
    if (!sameOrg) throw new HttpError(403, "forbidden", "Ce responsable n'appartient pas à ton organisation");
    await prisma.subjectManager.upsert({
      where: { userId_subjectId: { userId: target.id, subjectId: subject.id } },
      create: { userId: target.id, subjectId: subject.id },
      update: {},
    });
    await logAction(prisma, ctx.user.id, subject.id, "ASSIGN_MANAGER", { userId: target.id, username: target.username });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/subjects/:id/managers/:userId", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "managers:assign", subject.id);
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) throw new HttpError(404, "user_not_found", "Utilisateur introuvable");
    await prisma.subjectManager.deleteMany({ where: { userId: target.id, subjectId: subject.id } });
    await logAction(prisma, ctx.user.id, subject.id, "REMOVE_MANAGER", { userId: target.id, username: target.username });
    return { ok: true };
  });

  // ── Utilisateurs (administrateur) : recherche, filtres, pagination
  app.get("/api/users", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "users:list");
    const q = z
      .object({
        q: z.string().trim().toLowerCase().max(40).default(""),
        role: z.enum(["USER", "SUBJECT_MANAGER", "ORG_ADMIN", "ADMIN"]).optional(),
        banned: z.enum(["true", "false"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).catch(20).default(20),
        cursor: z.string().min(1).optional(),
      })
      .parse(req.query);
    const rows = await prisma.user.findMany({
      where: {
        ...(q.q ? { username: { contains: q.q } } : {}),
        ...(q.role ? { role: q.role } : {}),
        ...(q.banned ? { bannedAt: q.banned === "true" ? { not: null } : null } : {}),
      },
      orderBy: [{ username: "asc" }, { id: "asc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: { id: true, username: true, avatar: true, email: true, emailVerifiedAt: true, verifyDeadline: true, role: true, bannedAt: true, deactivatedAt: true, createdAt: true, _count: { select: { memberships: true } },
        orgMemberships: { where: { revokedAt: null }, select: { organization: { select: { name: true } } } }, adminOrgs: { select: { organization: { select: { name: true } } } } },
    });
    const page = rows.slice(0, q.limit);
    return {
      users: page.map(({ _count, bannedAt, deactivatedAt, emailVerifiedAt, orgMemberships, adminOrgs, ...u }) => ({ ...u, avatar: parseAvatar(u.avatar), organizations: [...new Set([...adminOrgs, ...orgMemberships].map((o) => o.organization.name))].sort((a, b) => a.localeCompare(b)), deactivated: !!deactivatedAt, emailVerified: !!emailVerifiedAt, overdue: verificationOverdue({ role: u.role, emailVerifiedAt, verifyDeadline: u.verifyDeadline }), banned: !!bannedAt, subjectCount: _count.memberships })),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    };
  });

  // ── Paramètres globaux (administrateur)
  app.get("/api/settings", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "settings:global");
    const stored = await globalSettings(prisma);
    return { overrides: stored, settings: mergeSettings(stored) };
  });

  app.put("/api/settings", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "settings:global");
    const patch = SettingsPatchSchema.parse(req.body);
    await prisma.$transaction(async (tx) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (value === null) await tx.setting.deleteMany({ where: { key } });
        else await tx.setting.upsert({ where: { key }, create: { key, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } });
      }
      await logAction(tx, ctx.user.id, null, "UPDATE_GLOBAL_SETTINGS", { keys: Object.keys(patch) });
    });
    invalidateSettings();
    if ("timePerQuestionSec" in patch) await applyTimeToRunningGames(prisma, null);
    const stored = await globalSettings(prisma);
    return { overrides: stored, settings: mergeSettings(stored) };
  });
}
