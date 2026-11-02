import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadSubject } from "../access.ts";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { hashQuestion, QuestionSchema } from "../import/validate.ts";
import { assertCan } from "../permissions.ts";

/**
 * Gestion fine des questions : consultation, modification, suppression/restauration unitaires,
 * lots, corbeille, purge définitive et export au format d'import.
 */

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).catch(50).default(50),
  cursor: z.string().min(1).optional(),
  q: z.string().trim().max(100).optional(),
  deleted: z.enum(["no", "only", "all"]).catch("no").default("no"),
});

const EditBody = z
  .object({
    question: z.string(),
    choices: z.array(z.string()),
    answer: z.number(),
    explanation: z.string().nullable(),
    chapterId: z.string().min(1),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, "Aucune modification demandée");

const PurgeBody = z.object({ olderThanDays: z.number().int().min(0).max(3650).default(30) }).default({});

const parseChoices = (json: string) => JSON.parse(json) as string[];

export function registerLibraryRoutes(app: FastifyInstance, { prisma, auth }: Deps): void {
  /** Chapitre (même supprimé) + droit de gestion sur sa matière. */
  async function manageChapter(req: Parameters<typeof auth>[0], chapterId: string, action: "chapter:manage" | "question:delete" = "chapter:manage") {
    const ctx = await auth(req);
    const chapter = await prisma.chapter.findUnique({ where: { id: chapterId } });
    if (!chapter) throw new HttpError(404, "chapter_not_found", "Chapitre introuvable");
    assertCan(ctx.actor, action, chapter.subjectId);
    return { ctx, chapter };
  }
  async function manageQuestion(req: Parameters<typeof auth>[0], id: string, action: "chapter:manage" | "question:delete" = "chapter:manage") {
    const ctx = await auth(req);
    const question = await prisma.question.findUnique({ where: { id }, include: { chapter: true } });
    if (!question) throw new HttpError(404, "question_not_found", "Question introuvable");
    assertCan(ctx.actor, action, question.chapter.subjectId);
    return { ctx, question };
  }

  // ── Questions d'un chapitre, avec leur taux de réussite
  app.get<{ Params: { id: string } }>("/api/chapters/:id/questions", async (req) => {
    const { chapter } = await manageChapter(req, req.params.id);
    const q = ListQuery.parse(req.query);
    const rows = await prisma.question.findMany({
      where: {
        chapterId: chapter.id,
        ...(q.deleted === "no" ? { deletedAt: null } : q.deleted === "only" ? { deletedAt: { not: null } } : {}),
        ...(q.q ? { text: { contains: q.q, mode: "insensitive" as const } } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, q.limit);

    const answers = await prisma.answer.findMany({
      where: { gameQuestion: { questionId: { in: page.map((r) => r.id) } } },
      select: { isCorrect: true, gameQuestion: { select: { questionId: true } } },
    });
    const stats = new Map<string, { answered: number; correct: number }>();
    for (const a of answers) {
      const s = stats.get(a.gameQuestion.questionId) ?? { answered: 0, correct: 0 };
      s.answered++;
      if (a.isCorrect) s.correct++;
      stats.set(a.gameQuestion.questionId, s);
    }
    return {
      chapter: { id: chapter.id, name: chapter.name, deleted: !!chapter.deletedAt },
      questions: page.map((r) => {
        const s = stats.get(r.id) ?? { answered: 0, correct: 0 };
        return {
          id: r.id,
          question: r.text,
          choices: parseChoices(r.choices),
          answer: r.answerIndex,
          explanation: r.explanation,
          batchId: r.batchId,
          createdAt: r.createdAt,
          deletedAt: r.deletedAt,
          stats: { answered: s.answered, correct: s.correct, accuracy: s.answered === 0 ? null : Math.round((s.correct / s.answered) * 1000) / 10 },
        };
      }),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    };
  });

  // ── Modifier une question (texte, choix, bonne réponse, explication, ou la déplacer vers un autre chapitre)
  app.patch<{ Params: { id: string } }>("/api/questions/:id", async (req) => {
    const { ctx, question } = await manageQuestion(req, req.params.id);
    const body = EditBody.parse(req.body);
    if (question.deletedAt) throw new HttpError(409, "question_deleted", "Cette question est dans la corbeille : restaure-la d'abord");

    let target = question.chapter;
    if (body.chapterId && body.chapterId !== question.chapterId) {
      const dest = await prisma.chapter.findUnique({ where: { id: body.chapterId } });
      if (!dest || dest.deletedAt || dest.subjectId !== question.chapter.subjectId) throw new HttpError(404, "chapter_not_found", "Chapitre de destination introuvable dans cette matière");
      target = dest;
    }

    const merged = QuestionSchema.safeParse({
      question: body.question ?? question.text,
      choices: body.choices ?? parseChoices(question.choices),
      answer: body.answer ?? question.answerIndex,
      explanation: body.explanation === null ? undefined : (body.explanation ?? question.explanation ?? undefined),
    });
    if (!merged.success) {
      throw new HttpError(422, "invalid_question", "Question invalide", merged.error.issues.map((i) => `${i.path.join(".") || "question"} : ${i.message}`));
    }
    const v = merged.data;
    const hash = hashQuestion(v.question);
    const clash = await prisma.question.findFirst({ where: { chapterId: target.id, hash, deletedAt: null, id: { not: question.id } } });
    if (clash) throw new HttpError(409, "duplicate_question", "Une question identique existe déjà dans ce chapitre", { questionId: clash.id });

    const updated = await prisma.question.update({
      where: { id: question.id },
      data: { text: v.question, choices: JSON.stringify(v.choices), answerIndex: v.answer, explanation: v.explanation ?? null, hash, chapterId: target.id },
    });
    await logAction(prisma, ctx.user.id, question.chapter.subjectId, "UPDATE_QUESTION", { questionId: question.id, fields: Object.keys(body) });
    return { question: { id: updated.id, question: updated.text, choices: parseChoices(updated.choices), answer: updated.answerIndex, explanation: updated.explanation, chapterId: updated.chapterId } };
  });

  // ── Supprimer / restaurer une question
  app.delete<{ Params: { id: string } }>("/api/questions/:id", async (req) => {
    const { ctx, question } = await manageQuestion(req, req.params.id, "question:delete");
    if (question.deletedAt) throw new HttpError(409, "already_deleted", "Cette question est déjà supprimée");
    await prisma.question.update({ where: { id: question.id }, data: { deletedAt: new Date() } });
    await logAction(prisma, ctx.user.id, question.chapter.subjectId, "DELETE_QUESTION", { questionId: question.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/questions/:id/restore", async (req) => {
    const { ctx, question } = await manageQuestion(req, req.params.id, "question:delete");
    if (!question.deletedAt) throw new HttpError(409, "not_deleted", "Cette question n'est pas supprimée");
    if (question.chapter.deletedAt) throw new HttpError(409, "chapter_deleted", "Le chapitre est supprimé : restaure-le d'abord");
    if (await prisma.question.findFirst({ where: { chapterId: question.chapterId, hash: question.hash, deletedAt: null } })) {
      throw new HttpError(409, "duplicate_question", "Une question identique existe déjà dans ce chapitre");
    }
    await prisma.question.update({ where: { id: question.id }, data: { deletedAt: null } });
    await logAction(prisma, ctx.user.id, question.chapter.subjectId, "RESTORE_QUESTION", { questionId: question.id });
    return { ok: true };
  });

  // ── Imports (lots) d'un chapitre
  app.get<{ Params: { id: string } }>("/api/chapters/:id/batches", async (req) => {
    const { chapter } = await manageChapter(req, req.params.id);
    const batches = await prisma.importBatch.findMany({
      where: { chapterId: chapter.id },
      orderBy: { createdAt: "desc" },
      include: { admin: { select: { id: true, username: true } }, _count: { select: { questions: { where: { deletedAt: null } } } } },
    });
    return {
      batches: batches.map((b) => ({ id: b.id, createdAt: b.createdAt, importedBy: b.admin, importedCount: b.questionCount, activeCount: b._count.questions, deletedAt: b.deletedAt })),
    };
  });

  /** Restaure ce qui a été supprimé *en même temps* (même horodatage), sans recréer de doublon. */
  async function restoreQuestions(where: { chapterId?: string; batchId?: string }, deletedAt: Date) {
    const rows = await prisma.question.findMany({ where: { ...where, deletedAt }, select: { id: true, chapterId: true, hash: true } });
    const active = new Set(
      (await prisma.question.findMany({ where: { chapterId: { in: [...new Set(rows.map((r) => r.chapterId))] }, deletedAt: null }, select: { chapterId: true, hash: true } })).map((q) => `${q.chapterId}:${q.hash}`),
    );
    const ids: string[] = [];
    let skipped = 0;
    for (const r of rows) {
      const key = `${r.chapterId}:${r.hash}`;
      if (active.has(key)) skipped++;
      else {
        active.add(key);
        ids.push(r.id);
      }
    }
    await prisma.question.updateMany({ where: { id: { in: ids } }, data: { deletedAt: null } });
    return { restored: ids.length, skippedDuplicates: skipped };
  }

  app.post<{ Params: { id: string } }>("/api/batches/:id/restore", async (req) => {
    const ctx = await auth(req);
    const batch = await prisma.importBatch.findUnique({ where: { id: req.params.id }, include: { chapter: true } });
    if (!batch) throw new HttpError(404, "batch_not_found", "Import introuvable");
    assertCan(ctx.actor, "question:delete", batch.chapter.subjectId);
    if (!batch.deletedAt) throw new HttpError(409, "not_deleted", "Cet import n'est pas supprimé");
    if (batch.chapter.deletedAt) throw new HttpError(409, "chapter_deleted", "Le chapitre est supprimé : restaure-le d'abord");
    const out = await restoreQuestions({ batchId: batch.id }, batch.deletedAt);
    await prisma.importBatch.update({ where: { id: batch.id }, data: { deletedAt: null } });
    await logAction(prisma, ctx.user.id, batch.chapter.subjectId, "RESTORE_BATCH", { batchId: batch.id, ...out });
    return out;
  });

  app.post<{ Params: { id: string } }>("/api/chapters/:id/restore", async (req) => {
    const { ctx, chapter } = await manageChapter(req, req.params.id, "question:delete");
    if (!chapter.deletedAt) throw new HttpError(409, "not_deleted", "Ce chapitre n'est pas supprimé");
    const out = await restoreQuestions({ chapterId: chapter.id }, chapter.deletedAt);
    await prisma.importBatch.updateMany({ where: { chapterId: chapter.id, deletedAt: chapter.deletedAt }, data: { deletedAt: null } });
    await prisma.chapter.update({ where: { id: chapter.id }, data: { deletedAt: null } });
    await logAction(prisma, ctx.user.id, chapter.subjectId, "RESTORE_CHAPTER", { chapterId: chapter.id, ...out });
    return out;
  });

  // ── Corbeille d'une matière
  app.get<{ Params: { id: string } }>("/api/subjects/:id/trash", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "chapter:manage", subject.id);
    const [chapters, batches, questions, questionCount] = await Promise.all([
      prisma.chapter.findMany({ where: { subjectId: subject.id, deletedAt: { not: null } }, orderBy: { deletedAt: "desc" }, include: { _count: { select: { questions: true } } } }),
      prisma.importBatch.findMany({ where: { chapter: { subjectId: subject.id }, deletedAt: { not: null } }, orderBy: { deletedAt: "desc" }, include: { chapter: { select: { id: true, name: true } } } }),
      prisma.question.findMany({ where: { chapter: { subjectId: subject.id, deletedAt: null }, deletedAt: { not: null } }, orderBy: { deletedAt: "desc" }, take: 100, select: { id: true, text: true, deletedAt: true, chapter: { select: { id: true, name: true } } } }),
      prisma.question.count({ where: { chapter: { subjectId: subject.id }, deletedAt: { not: null } } }),
    ]);
    return {
      chapters: chapters.map((c) => ({ id: c.id, name: c.name, deletedAt: c.deletedAt, questions: c._count.questions })),
      batches: batches.map((b) => ({ id: b.id, chapter: b.chapter, deletedAt: b.deletedAt, importedCount: b.questionCount })),
      questions: questions.map((q) => ({ id: q.id, question: q.text, deletedAt: q.deletedAt, chapter: q.chapter })),
      totalDeletedQuestions: questionCount,
    };
  });

  // ── Purge définitive : seules les questions jamais jouées peuvent disparaître (l'historique des parties reste cohérent)
  app.post<{ Params: { id: string } }>("/api/subjects/:id/trash/purge", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "question:delete", subject.id);
    const { olderThanDays } = PurgeBody.parse(req.body ?? {});
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);

    const candidates = await prisma.question.findMany({ where: { chapter: { subjectId: subject.id }, deletedAt: { lte: cutoff } }, select: { id: true } });
    const played = new Set((await prisma.gameQuestion.findMany({ where: { questionId: { in: candidates.map((c) => c.id) } }, select: { questionId: true }, distinct: ["questionId"] })).map((g) => g.questionId));
    const deletable = candidates.filter((c) => !played.has(c.id)).map((c) => c.id);

    const result = await prisma.$transaction(async (tx) => {
      const questions = (await tx.question.deleteMany({ where: { id: { in: deletable } } })).count;
      // Lots supprimés devenus vides
      const emptyBatches = (await tx.importBatch.findMany({ where: { chapter: { subjectId: subject.id }, deletedAt: { lte: cutoff }, questions: { none: {} } }, select: { id: true } })).map((b) => b.id);
      const batches = (await tx.importBatch.deleteMany({ where: { id: { in: emptyBatches } } })).count;
      // Chapitres supprimés, vides, jamais joués
      const emptyChapters = (
        await tx.chapter.findMany({ where: { subjectId: subject.id, deletedAt: { lte: cutoff }, questions: { none: {} }, rounds: { none: {} }, batches: { none: {} } }, select: { id: true } })
      ).map((c) => c.id);
      const chapters = (await tx.chapter.deleteMany({ where: { id: { in: emptyChapters } } })).count;
      await logAction(tx, ctx.user.id, subject.id, "PURGE_TRASH", { olderThanDays, questions, batches, chapters });
      return { questions, batches, chapters };
    });
    return { ...result, keptBecausePlayed: played.size };
  });

  // ── Export au format d'import (sauvegarde ou copie vers une autre matière)
  app.get<{ Params: { id: string }; Querystring: { chapterId?: string } }>("/api/subjects/:id/export", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "chapter:manage", subject.id);
    const chapters = await prisma.chapter.findMany({
      where: { subjectId: subject.id, deletedAt: null, ...(req.query.chapterId ? { id: req.query.chapterId } : {}) },
      orderBy: { name: "asc" },
      include: { questions: { where: { deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    });
    if (req.query.chapterId && chapters.length === 0) throw new HttpError(404, "chapter_not_found", "Chapitre introuvable dans cette matière");
    return {
      subject: subject.name,
      exportedAt: new Date().toISOString(),
      chapters: chapters.map((c) => ({
        name: c.name,
        // Directement recollable dans l'import : { "questions": [...] }
        questions: c.questions.map((q) => ({ question: q.text, choices: parseChoices(q.choices), answer: q.answerIndex, ...(q.explanation ? { explanation: q.explanation } : {}) })),
      })),
    };
  });
}
