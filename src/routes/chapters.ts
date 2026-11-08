import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canReadSubject, loadChapter, loadSubject } from "../access.ts";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { assertCan, can } from "../permissions.ts";

export const chapterColor = z.string().trim().regex(/^(#[0-9a-fA-F]{6})?$/, "Couleur au format #RRGGBB");
export const chapterName = z.string().trim().min(1, "Nom de chapitre vide").max(80, "80 caractères maximum");

export function registerChapterRoutes(app: FastifyInstance, { prisma, auth }: Deps): void {
  // ── Liste (administrateur, responsable de la matière, ou membre actif)
  app.get<{ Params: { id: string } }>("/api/subjects/:id/chapters", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    if (!(await canReadSubject(prisma, ctx, subject.id))) {
      throw new HttpError(403, "not_a_member", "Tu n'as pas accès à cette matière");
    }
    // Les joueurs ne voient que les chapitres débloqués ; l'administration voit tout.
    const manager = can(ctx.actor, "chapter:manage", subject.id);
    const chapters = await prisma.chapter.findMany({
      where: { subjectId: subject.id, deletedAt: null, ...(manager ? {} : { locked: false }) },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true, locked: true, createdAt: true, _count: { select: { questions: { where: { deletedAt: null } } } } },
    });
    return { chapters: chapters.map(({ _count, ...c }) => ({ ...c, questionCount: _count.questions })) };
  });

  app.post<{ Params: { id: string } }>("/api/subjects/:id/chapters", async (req, reply) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "chapter:manage", subject.id);
    const { name, color, locked } = z.object({ name: chapterName, color: chapterColor.default(""), locked: z.boolean().default(false) }).parse(req.body);

    const existing = await prisma.chapter.findUnique({ where: { subjectId_name: { subjectId: subject.id, name } } });
    if (existing && !existing.deletedAt) throw new HttpError(409, "chapter_exists", "Ce chapitre existe déjà");

    // Un chapitre supprimé qui porte le même nom est simplement réactivé (ses anciennes questions restent supprimées).
    const chapter = existing
      ? await prisma.chapter.update({ where: { id: existing.id }, data: { deletedAt: null, color, locked } })
      : await prisma.chapter.create({ data: { subjectId: subject.id, name, color, locked } });
    await logAction(prisma, ctx.user.id, subject.id, "CREATE_CHAPTER", { chapterId: chapter.id, name, color, locked });
    return reply.status(201).send({ chapter: { id: chapter.id, name: chapter.name, color: chapter.color, locked: chapter.locked } });
  });

  app.patch<{ Params: { id: string } }>("/api/chapters/:id", async (req) => {
    const ctx = await auth(req);
    const chapter = await loadChapter(prisma, req.params.id);
    assertCan(ctx.actor, "chapter:manage", chapter.subjectId);
    const body = z.object({ name: chapterName.optional(), color: chapterColor.optional(), locked: z.boolean().optional() }).strict()
      .refine((b) => Object.keys(b).length > 0, "Aucune modification demandée").parse(req.body);

    if (body.name !== undefined) {
      const clash = await prisma.chapter.findUnique({ where: { subjectId_name: { subjectId: chapter.subjectId, name: body.name } } });
      if (clash && clash.id !== chapter.id) throw new HttpError(409, "chapter_exists", "Un chapitre porte déjà ce nom");
    }
    const updated = await prisma.chapter.update({ where: { id: chapter.id }, data: body });
    if (body.name !== undefined && body.name !== chapter.name) await logAction(prisma, ctx.user.id, chapter.subjectId, "RENAME_CHAPTER", { chapterId: chapter.id, from: chapter.name, to: body.name });
    if (body.locked !== undefined && body.locked !== chapter.locked) await logAction(prisma, ctx.user.id, chapter.subjectId, body.locked ? "LOCK_CHAPTER" : "UNLOCK_CHAPTER", { chapterId: chapter.id, name: updated.name });
    if (body.color !== undefined && body.color !== chapter.color) await logAction(prisma, ctx.user.id, chapter.subjectId, "CHAPTER_COLOR", { chapterId: chapter.id, color: body.color });
    return { chapter: { id: updated.id, name: updated.name, color: updated.color, locked: updated.locked } };
  });

  // ── Fusionner plusieurs chapitres en un seul (les questions sont déplacées, les doublons retirés)
  app.post<{ Params: { id: string } }>("/api/subjects/:id/chapters/merge", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "chapter:manage", subject.id);
    const body = z.object({ chapterIds: z.array(z.string().min(1)).min(2).max(50), name: chapterName }).parse(req.body);
    const ids = [...new Set(body.chapterIds)];
    if (ids.length < 2) throw new HttpError(422, "merge_needs_two", "Choisis au moins deux chapitres");
    const sources = await prisma.chapter.findMany({ where: { id: { in: ids }, subjectId: subject.id, deletedAt: null }, orderBy: { name: "asc" } });
    if (sources.length !== ids.length) throw new HttpError(404, "chapter_not_found", "Un des chapitres est introuvable");
    const clash = await prisma.chapter.findUnique({ where: { subjectId_name: { subjectId: subject.id, name: body.name } } });
    if (clash && !clash.deletedAt && !ids.includes(clash.id)) throw new HttpError(409, "chapter_exists", "Un chapitre porte déjà ce nom");

    const result = await prisma.$transaction(async (tx) => {
      const lesson = sources.map((c) => c.lesson.trim()).filter(Boolean).join("\n\n");
      const common = { color: sources.find((c) => c.color)?.color ?? "", locked: sources.every((c) => c.locked), lesson };
      // Le chapitre d'arrivée : un des chapitres fusionnés s'il porte déjà ce nom, sinon un nouveau (ou un ancien supprimé du même nom).
      const target = clash && ids.includes(clash.id)
        ? await tx.chapter.update({ where: { id: clash.id }, data: { ...common, color: clash.color || common.color } })
        : clash
          ? await tx.chapter.update({ where: { id: clash.id }, data: { deletedAt: null, ...common } })
          : await tx.chapter.create({ data: { subjectId: subject.id, name: body.name, ...common } });
      const others = ids.filter((id) => id !== target.id);
      await tx.question.updateMany({ where: { chapterId: { in: others } }, data: { chapterId: target.id } });
      await tx.importBatch.updateMany({ where: { chapterId: { in: others } }, data: { chapterId: target.id } });
      await tx.chapter.updateMany({ where: { id: { in: others } }, data: { deletedAt: new Date() } });
      // Doublons (même énoncé dans deux chapitres fusionnés) : on garde la plus ancienne.
      const active = await tx.question.findMany({ where: { chapterId: target.id, deletedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, hash: true } });
      const seen = new Set<string>(); const dup: string[] = [];
      for (const q of active) { if (seen.has(q.hash)) dup.push(q.id); else seen.add(q.hash); }
      if (dup.length) await tx.question.updateMany({ where: { id: { in: dup } }, data: { deletedAt: new Date() } });
      await logAction(tx, ctx.user.id, subject.id, "MERGE_CHAPTERS", { into: target.id, name: target.name, from: sources.map((c) => c.name), duplicatesRemoved: dup.length });
      return { chapter: { id: target.id, name: target.name, color: target.color, locked: target.locked }, questions: active.length - dup.length, duplicatesRemoved: dup.length };
    });
    return result;
  });

  // ── Suppression d'un chapitre et de toutes ses questions (corbeille : suppression douce)
  app.delete<{ Params: { id: string } }>("/api/chapters/:id", async (req) => {
    const ctx = await auth(req);
    const chapter = await loadChapter(prisma, req.params.id);
    assertCan(ctx.actor, "question:delete", chapter.subjectId);

    const now = new Date();
    const deleted = await prisma.$transaction(async (tx) => {
      const q = await tx.question.updateMany({ where: { chapterId: chapter.id, deletedAt: null }, data: { deletedAt: now } });
      await tx.importBatch.updateMany({ where: { chapterId: chapter.id, deletedAt: null }, data: { deletedAt: now } });
      await tx.chapter.update({ where: { id: chapter.id }, data: { deletedAt: now } });
      await logAction(tx, ctx.user.id, chapter.subjectId, "DELETE_CHAPTER", { chapterId: chapter.id, name: chapter.name, questions: q.count });
      return q.count;
    });
    return { deletedQuestions: deleted };
  });

  // ── Supprimer les questions d'un chapitre ajoutées à partir d'une date et d'une heure
  app.post<{ Params: { id: string } }>("/api/chapters/:id/questions/delete-since", async (req) => {
    const ctx = await auth(req);
    const chapter = await loadChapter(prisma, req.params.id);
    assertCan(ctx.actor, "question:delete", chapter.subjectId);
    const { since } = z
      .object({ since: z.string().datetime({ offset: true, message: "Date invalide (format ISO 8601, ex. 2026-11-01T14:30:00+01:00)" }) })
      .parse(req.body);
    const sinceDate = new Date(since);

    const result = await prisma.question.updateMany({
      where: { chapterId: chapter.id, deletedAt: null, createdAt: { gte: sinceDate } },
      data: { deletedAt: new Date() },
    });
    await logAction(prisma, ctx.user.id, chapter.subjectId, "DELETE_BY_DATE", { chapterId: chapter.id, since, questions: result.count });
    return { deletedQuestions: result.count };
  });

  // ── Annuler un import précis
  app.delete<{ Params: { id: string } }>("/api/batches/:id", async (req) => {
    const ctx = await auth(req);
    const batch = await prisma.importBatch.findUnique({ where: { id: req.params.id }, include: { chapter: true } });
    if (!batch || batch.deletedAt) throw new HttpError(404, "batch_not_found", "Import introuvable");
    assertCan(ctx.actor, "question:delete", batch.chapter.subjectId);

    const now = new Date();
    const count = await prisma.$transaction(async (tx) => {
      const q = await tx.question.updateMany({ where: { batchId: batch.id, deletedAt: null }, data: { deletedAt: now } });
      await tx.importBatch.update({ where: { id: batch.id }, data: { deletedAt: now } });
      await logAction(tx, ctx.user.id, batch.chapter.subjectId, "DELETE_BATCH", { batchId: batch.id, questions: q.count });
      return q.count;
    });
    return { deletedQuestions: count };
  });
}
