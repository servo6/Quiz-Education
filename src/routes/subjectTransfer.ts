import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadSubject } from "../access.ts";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { hashPassword } from "../password.ts";
import { saveShare } from "../accessShare.ts";
import { isTester } from "../tester.ts";

const nameSchema = z.string().trim().min(2).max(60);
const accessNameSchema = z.string().trim().toLowerCase().min(3).max(40).regex(/^[a-z0-9_.-]+$/, "lettres, chiffres, point, tiret et underscore");
const CHUNK = 500;

/** Déplacer ou copier une matière d'une organisation à une autre (super administrateur). */
export function registerTransferRoutes(app: FastifyInstance, deps: Deps): void {
  const { prisma, auth, limit } = deps;

  async function target(ctx: Awaited<ReturnType<Deps["auth"]>>, organizationId: string, from: string) {
    if (ctx.actor.role !== "ADMIN") throw new HttpError(403, "forbidden", "Seul le super administrateur déplace ou copie une matière");
    if (organizationId === from) throw new HttpError(422, "same_organization", "La matière est déjà dans cette organisation");
    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw new HttpError(404, "organization_not_found", "Organisation introuvable");
    return org;
  }

  // ── Déplacer : la matière (chapitres, questions, historique) change d'organisation.
  app.post<{ Params: { id: string } }>("/api/subjects/:id/move", { config: limit(10) }, async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    const body = z.object({ organizationId: z.string().min(1), name: nameSchema.optional(), force: z.boolean().optional() }).parse(req.body);
    const org = await target(ctx, body.organizationId, subject.organizationId);
    const name = body.name ?? subject.name;
    if (await prisma.subject.findUnique({ where: { organizationId_name: { organizationId: org.id, name } } })) throw new HttpError(409, "subject_name_taken", "Une matière porte déjà ce nom dans l'organisation de destination");

    // Joueurs inscrits : un joueur ne peut appartenir qu'à une organisation. Ceux qui n'ont que cette matière suivent la matière ;
    // ceux qui suivent aussi d'autres matières de l'ancienne organisation seraient en conflit (désinscrits seulement avec `force`).
    const members = await prisma.membership.findMany({ where: { subjectId: subject.id, user: { role: "USER" } }, select: { userId: true } });
    const testers = new Set<string>();
    for (const m of members) if (await isTester(prisma, m.userId)) testers.add(m.userId);
    const players = members.map((m) => m.userId).filter((id) => !testers.has(id));
    const others = await prisma.membership.findMany({ where: { userId: { in: players }, subjectId: { not: subject.id }, subject: { organizationId: subject.organizationId } }, select: { userId: true } });
    const conflicts = [...new Set(others.map((o) => o.userId))];
    if (conflicts.length && !body.force) {
      throw new HttpError(409, "players_conflict", `${conflicts.length} joueur${conflicts.length > 1 ? "s suivent" : " suit"} aussi d'autres matières de l'organisation actuelle : ils seraient désinscrits de cette matière.`, { count: conflicts.length });
    }
    const moving = players.filter((id) => !conflicts.includes(id));

    await prisma.$transaction(async (tx) => {
      if (conflicts.length) {
        await tx.membership.deleteMany({ where: { subjectId: subject.id, userId: { in: conflicts } } });
        await tx.user.updateMany({ where: { id: { in: conflicts }, activeSubjectId: subject.id }, data: { activeSubjectId: null } });
      }
      await tx.subject.update({ where: { id: subject.id }, data: { organizationId: org.id, name } });
      for (const userId of moving) {
        const dest = await tx.orgMember.findUnique({ where: { userId_organizationId: { userId, organizationId: org.id } } });
        if (dest) await tx.orgMember.deleteMany({ where: { userId, organizationId: subject.organizationId } });
        else await tx.orgMember.updateMany({ where: { userId, organizationId: subject.organizationId }, data: { organizationId: org.id } });
      }
      await logAction(tx, ctx.user.id, subject.id, "MOVE_SUBJECT", { name, fromOrganizationId: subject.organizationId, toOrganizationId: org.id, players: moving.length, unenrolled: conflicts.length });
    }, { timeout: 60_000 });
    return { subject: { id: subject.id, name, organizationId: org.id }, players: moving.length, unenrolled: conflicts.length };
  });

  // ── Copier : nouvelle matière (réglages, titres, chapitres, questions). Ni joueurs, ni historique, ni responsables.
  app.post<{ Params: { id: string } }>("/api/subjects/:id/copy", { config: limit(5) }, async (req, reply) => {
    const ctx = await auth(req);
    const source = await loadSubject(prisma, req.params.id);
    const body = z.object({ organizationId: z.string().min(1), name: nameSchema.optional(), accessName: accessNameSchema.optional(), accessPassword: z.string().min(8).max(128).optional() })
      .refine((b) => (b.accessName === undefined) === (b.accessPassword === undefined), "Indique le nom d'accès et le mot de passe d'accès").parse(req.body);
    const org = await target(ctx, body.organizationId, "");
    let name = body.name ?? source.name;
    const taken = (n: string) => prisma.subject.findUnique({ where: { organizationId_name: { organizationId: org.id, name: n } } });
    if (await taken(name)) {
      if (body.name) throw new HttpError(409, "subject_name_taken", "Une matière porte déjà ce nom dans l'organisation de destination");
      const base = `${source.name} (copie)`;
      name = base;
      for (let i = 2; await taken(name); i++) name = `${base} ${i}`;
    }
    const internal = randomBytes(12).toString("hex");
    const accessName = body.accessName ?? `m-${internal}`;
    if (await prisma.subject.findUnique({ where: { accessName } })) throw new HttpError(409, "access_name_taken", "Ce nom d'accès est déjà utilisé");
    const passwordHash = await hashPassword(body.accessPassword ?? internal);

    const chapters = await prisma.chapter.findMany({ where: { subjectId: source.id, deletedAt: null }, orderBy: { createdAt: "asc" } });
    const tiers = await prisma.tier.findMany({ where: { subjectId: source.id } });
    const themeRow = await prisma.setting.findUnique({ where: { key: `ui.theme:subject:${source.id}` } });

    const result = await prisma.$transaction(async (tx) => {
      const copy = await tx.subject.create({ data: { organizationId: org.id, name, accessName, accessPasswordHash: passwordHash, settings: source.settings } });
      if (tiers.length) await tx.tier.createMany({ data: tiers.map((t) => ({ subjectId: copy.id, name: t.name, minLevel: t.minLevel, color: t.color })) });
      if (themeRow) await tx.setting.create({ data: { key: `ui.theme:subject:${copy.id}`, value: themeRow.value } });
      let questions = 0;
      for (const ch of chapters) {
        const qs = await tx.question.findMany({ where: { chapterId: ch.id, deletedAt: null }, orderBy: { createdAt: "asc" } });
        const nc = await tx.chapter.create({ data: { subjectId: copy.id, name: ch.name, color: ch.color, lesson: ch.lesson, locked: ch.locked } });
        if (!qs.length) continue;
        const batch = await tx.importBatch.create({ data: { chapterId: nc.id, adminId: ctx.user.id, questionCount: qs.length } });
        for (let i = 0; i < qs.length; i += CHUNK) {
          await tx.question.createMany({ data: qs.slice(i, i + CHUNK).map((q) => ({ chapterId: nc.id, batchId: batch.id, text: q.text, choices: q.choices, answerIndex: q.answerIndex, explanation: q.explanation, hash: q.hash })) });
        }
        questions += qs.length;
      }
      await logAction(tx, ctx.user.id, copy.id, "COPY_SUBJECT", { name, fromSubjectId: source.id, toOrganizationId: org.id, chapters: chapters.length, questions });
      return { copy, questions };
    }, { timeout: 120_000 });
    if (body.accessPassword) await saveShare(prisma, deps.secret, result.copy.id, body.accessPassword);
    return reply.status(201).send({ subject: { id: result.copy.id, name: result.copy.name, organizationId: org.id }, chapters: chapters.length, questions: result.questions });
  });
}
