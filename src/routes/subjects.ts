import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadSubject } from "../access.ts";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { assertCan } from "../permissions.ts";
import { fakeVerify, hashPassword, verifyPassword } from "../password.ts";
import { applyTimeToRunningGames } from "../runningGames.ts";
import { invalidateSettings } from "../settingsStore.ts";
import { applyPatch, mergeSettings, parseStoredSettings, SettingsPatchSchema } from "../settings.ts";

const accessName = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "3 caractères minimum")
  .max(40, "40 caractères maximum")
  .regex(/^[a-z0-9_.-]+$/, "lettres, chiffres, point, tiret et underscore uniquement");
const accessPassword = z.string().min(6, "6 caractères minimum").max(128);
const subjectName = z.string().trim().min(2).max(60);

const CreateBody = z.object({ name: subjectName, accessName, accessPassword });

const PatchBody = z
  .object({ name: subjectName, accessName, accessPassword, settings: SettingsPatchSchema })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, "Aucune modification demandée");

const JoinBody = z.object({ accessName: z.string().trim().toLowerCase().min(1), accessPassword: z.string().min(1).max(128) });

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

export function registerSubjectRoutes(app: FastifyInstance, { prisma, auth, limit }: Deps): void {
  // ── Liste des matières à gérer (administrateur : toutes ; responsable : les siennes)
  app.get("/api/subjects", async (req) => {
    const ctx = await auth(req);
    if (ctx.actor.role === "USER") throw new HttpError(403, "forbidden", "Action non autorisée");
    const where = ctx.actor.role === "ADMIN" ? {} : { id: { in: [...ctx.actor.managedSubjectIds] } };
    const subjects = await prisma.subject.findMany({
      where,
      orderBy: { name: "asc" },
      select: { id: true, name: true, accessName: true, createdAt: true, _count: { select: { memberships: { where: { user: { role: { not: "ADMIN" } } } } } } },
    });
    return { subjects: subjects.map(({ _count, ...s }) => ({ ...s, memberCount: _count.memberships })) };
  });

  app.post("/api/subjects", async (req, reply) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "subject:create");
    const body = CreateBody.parse(req.body);

    if (await prisma.subject.findUnique({ where: { name: body.name } })) {
      throw new HttpError(409, "subject_name_taken", "Une matière porte déjà ce nom");
    }
    if (await prisma.subject.findUnique({ where: { accessName: body.accessName } })) {
      throw new HttpError(409, "access_name_taken", "Ce nom d'accès est déjà utilisé");
    }
    const subject = await prisma.subject.create({
      data: { name: body.name, accessName: body.accessName, accessPasswordHash: await hashPassword(body.accessPassword) },
    });
    await logAction(prisma, ctx.user.id, subject.id, "CREATE_SUBJECT", { name: subject.name });
    // L'administrateur n'est pas un joueur : il n'est membre d'aucune matière, il choisit seulement celle qu'il gère.
    if (ctx.actor.role === "ADMIN" && !ctx.user.activeSubjectId) {
      await prisma.user.update({ where: { id: ctx.user.id }, data: { activeSubjectId: subject.id } });
    }
    return reply.status(201).send({ subject: { id: subject.id, name: subject.name, accessName: subject.accessName } });
  });

  // ── Détail d'une matière pour la gestion (jamais le mot de passe d'accès)
  app.get<{ Params: { id: string } }>("/api/subjects/:id", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "subject:settings", subject.id);
    const overrides = parseStoredSettings(subject.settings);
    const effective = mergeSettings(await globalSettings(prisma), overrides);
    const managers = await prisma.subjectManager.findMany({
      where: { subjectId: subject.id },
      select: { user: { select: { id: true, username: true } } },
    });
    return {
      subject: { id: subject.id, name: subject.name, accessName: subject.accessName },
      overrides,
      settings: effective,
      managers: managers.map((m) => m.user),
    };
  });

  app.patch<{ Params: { id: string } }>("/api/subjects/:id", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    const body = PatchBody.parse(req.body);

    if (body.name !== undefined) assertCan(ctx.actor, "subject:rename", subject.id);
    if (body.accessName !== undefined || body.accessPassword !== undefined) assertCan(ctx.actor, "subject:access", subject.id);
    if (body.settings !== undefined) assertCan(ctx.actor, "subject:settings", subject.id);

    const data: Record<string, unknown> = {};
    if (body.name !== undefined && body.name !== subject.name) {
      if (await prisma.subject.findUnique({ where: { name: body.name } })) {
        throw new HttpError(409, "subject_name_taken", "Une matière porte déjà ce nom");
      }
      data.name = body.name;
    }
    if (body.accessName !== undefined && body.accessName !== subject.accessName) {
      if (await prisma.subject.findUnique({ where: { accessName: body.accessName } })) {
        throw new HttpError(409, "access_name_taken", "Ce nom d'accès est déjà utilisé");
      }
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
      subject: { id: updated.id, name: updated.name, accessName: updated.accessName },
      overrides: parseStoredSettings(updated.settings),
    };
  });

  // ── Rejoindre une matière avec son nom et son mot de passe d'accès
  app.post("/api/subjects/join", { config: limit(10) }, async (req) => {
    const ctx = await auth(req);
    if (ctx.actor.role === "ADMIN") throw new HttpError(403, "admin_cannot_play", "Un administrateur ne rejoint pas de matière : il les gère toutes");
    const { accessName: name, accessPassword: password } = JoinBody.parse(req.body);

    const subject = await prisma.subject.findUnique({ where: { accessName: name } });
    const ok = subject ? await verifyPassword(password, subject.accessPasswordHash) : await fakeVerify(password);
    if (!subject || !ok) throw new HttpError(401, "bad_access", "Nom ou mot de passe d'accès incorrect");

    const existing = await prisma.membership.findUnique({
      where: { userId_subjectId: { userId: ctx.user.id, subjectId: subject.id } },
    });
    if (existing?.revokedAt) throw new HttpError(403, "access_revoked", "Ton accès à cette matière a été révoqué");
    if (!existing) {
      await prisma.membership.create({ data: { userId: ctx.user.id, subjectId: subject.id } });
    }
    if (!ctx.user.activeSubjectId) {
      await prisma.user.update({ where: { id: ctx.user.id }, data: { activeSubjectId: subject.id } });
    }
    return { subject: { id: subject.id, name: subject.name }, alreadyMember: !!existing };
  });

  // ── Changer de matière active
  app.post("/api/me/active-subject", async (req) => {
    const ctx = await auth(req);
    const { subjectId } = z.object({ subjectId: z.string().min(1) }).parse(req.body);
    const membership = await prisma.membership.findUnique({
      where: { userId_subjectId: { userId: ctx.user.id, subjectId } },
    });
    if (ctx.actor.role === "ADMIN") {
      // L'administrateur choisit la matière qu'il gère, sans en être membre.
      if (!(await prisma.subject.findUnique({ where: { id: subjectId } }))) throw new HttpError(404, "subject_not_found", "Matière introuvable");
    } else if (!membership || membership.revokedAt) {
      throw new HttpError(403, "not_a_member", "Tu n'as pas accès à cette matière");
    }
    await prisma.user.update({ where: { id: ctx.user.id }, data: { activeSubjectId: subjectId } });
    return { activeSubjectId: subjectId };
  });

  // ── Responsables de matière (administrateur uniquement)
  app.put<{ Params: { id: string; userId: string } }>("/api/subjects/:id/managers/:userId", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "managers:assign");
    const subject = await loadSubject(prisma, req.params.id);
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) throw new HttpError(404, "user_not_found", "Utilisateur introuvable");
    if (target.role === "ADMIN") throw new HttpError(400, "target_is_admin", "Un administrateur n'a pas besoin d'être responsable");

    await prisma.$transaction(async (tx) => {
      await tx.subjectManager.upsert({
        where: { userId_subjectId: { userId: target.id, subjectId: subject.id } },
        create: { userId: target.id, subjectId: subject.id },
        update: {},
      });
      if (target.role !== "SUBJECT_MANAGER") await tx.user.update({ where: { id: target.id }, data: { role: "SUBJECT_MANAGER" } });
      await logAction(tx, ctx.user.id, subject.id, "ASSIGN_MANAGER", { userId: target.id, username: target.username });
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/subjects/:id/managers/:userId", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "managers:assign");
    const subject = await loadSubject(prisma, req.params.id);
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) throw new HttpError(404, "user_not_found", "Utilisateur introuvable");

    await prisma.$transaction(async (tx) => {
      await tx.subjectManager.deleteMany({ where: { userId: target.id, subjectId: subject.id } });
      const remaining = await tx.subjectManager.count({ where: { userId: target.id } });
      if (remaining === 0 && target.role === "SUBJECT_MANAGER") {
        await tx.user.update({ where: { id: target.id }, data: { role: "USER" } });
      }
      await logAction(tx, ctx.user.id, subject.id, "REMOVE_MANAGER", { userId: target.id, username: target.username });
    });
    return { ok: true };
  });

  // ── Utilisateurs (administrateur) : recherche, filtres, pagination
  app.get("/api/users", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "users:list");
    const q = z
      .object({
        q: z.string().trim().toLowerCase().max(40).default(""),
        role: z.enum(["USER", "SUBJECT_MANAGER", "ADMIN"]).optional(),
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
      select: { id: true, username: true, role: true, bannedAt: true, createdAt: true, _count: { select: { memberships: true } } },
    });
    const page = rows.slice(0, q.limit);
    return {
      users: page.map(({ _count, bannedAt, ...u }) => ({ ...u, banned: !!bannedAt, subjectCount: _count.memberships })),
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
