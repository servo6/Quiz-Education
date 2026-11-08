import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { hashPassword } from "../password.ts";
import { isTester, testerKey } from "../tester.ts";
import { usernameSchema } from "./auth.ts";

export function registerTesterRoutes(app: FastifyInstance, deps: Deps): void {
  const { prisma, auth, limit } = deps;

  // ── Création (super administrateur uniquement)
  app.post("/api/testers", { config: limit(20) }, async (req, reply) => {
    const ctx = await auth(req);
    if (ctx.actor.role !== "ADMIN") throw new HttpError(403, "forbidden", "Seul le super administrateur crée un super testeur");
    const body = z.object({ username: usernameSchema, password: z.string().min(8, "8 caractères minimum").max(128) }).parse(req.body);
    if (await prisma.user.findUnique({ where: { username: body.username } })) throw new HttpError(409, "username_taken", "Ce pseudo est déjà pris");
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { username: body.username, passwordHash: await hashPassword(body.password), role: "USER", createdById: ctx.user.id } });
      await tx.setting.create({ data: { key: testerKey(u.id), value: "1" } });
      await logAction(tx, ctx.user.id, null, "CREATE_TESTER", { username: u.username });
      return u;
    });
    return reply.status(201).send({ tester: { id: user.id, username: user.username } });
  });

  app.get("/api/testers", async (req) => {
    const ctx = await auth(req);
    if (ctx.actor.role !== "ADMIN") throw new HttpError(403, "forbidden", "Action non autorisée");
    const flags = await prisma.setting.findMany({ where: { key: { startsWith: "tester:" } }, select: { key: true } });
    const ids = flags.map((f) => f.key.slice("tester:".length));
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, orderBy: { username: "asc" }, select: { id: true, username: true, bannedAt: true, orgMemberships: { select: { organization: { select: { name: true } } } } } });
    return { testers: users.map((u) => ({ id: u.id, username: u.username, banned: !!u.bannedAt, organizations: u.orgMemberships.map((o) => o.organization.name) })) };
  });

  // ── Pour le testeur : toutes les matières de toutes les organisations
  app.get("/api/tester/subjects", async (req) => {
    const ctx = await auth(req);
    if (!(await isTester(prisma, ctx.user.id))) throw new HttpError(403, "forbidden", "Réservé aux super testeurs");
    const [orgs, mine] = await Promise.all([
      prisma.organization.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, subjects: { orderBy: { name: "asc" }, select: { id: true, name: true } } } }),
      prisma.membership.findMany({ where: { userId: ctx.user.id }, select: { subjectId: true } }),
    ]);
    const joined = new Set(mine.map((m) => m.subjectId));
    return { organizations: orgs.map((o) => ({ id: o.id, name: o.name, subjects: o.subjects.map((s) => ({ ...s, joined: joined.has(s.id) })) })) };
  });

  // Inscription directe, sans clés d'accès
  app.post("/api/tester/join", { config: limit(60) }, async (req) => {
    const ctx = await auth(req);
    if (!(await isTester(prisma, ctx.user.id))) throw new HttpError(403, "forbidden", "Réservé aux super testeurs");
    const { subjectId } = z.object({ subjectId: z.string().min(1) }).parse(req.body);
    const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
    if (!subject) throw new HttpError(404, "subject_not_found", "Matière introuvable");
    await prisma.orgMember.upsert({ where: { userId_organizationId: { userId: ctx.user.id, organizationId: subject.organizationId } }, create: { userId: ctx.user.id, organizationId: subject.organizationId }, update: { revokedAt: null } });
    await prisma.membership.upsert({ where: { userId_subjectId: { userId: ctx.user.id, subjectId } }, create: { userId: ctx.user.id, subjectId }, update: { revokedAt: null } });
    return { subject: { id: subject.id, name: subject.name } };
  });
}
