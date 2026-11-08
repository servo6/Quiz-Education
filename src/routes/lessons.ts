import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadSubject, requireMembership } from "../access.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { assertCan } from "../permissions.ts";

/** Rappel de cours par chapitre : rédigé par les responsables, proposé aux joueurs après une mauvaise réponse. */
export function registerLessonRoutes(app: FastifyInstance, { prisma, auth }: Deps): void {
  /** Accepte l'identifiant d'une question ou celui d'une question de partie (ce que voit le client en jeu). */
  async function chapterOf(id: string) {
    const q = await prisma.question.findUnique({ where: { id }, include: { chapter: true } });
    if (q) return q.chapter;
    const gq = await prisma.gameQuestion.findUnique({ where: { id }, include: { question: { include: { chapter: true } } } });
    if (!gq) throw new HttpError(404, "question_not_found", "Question introuvable");
    return gq.question.chapter;
  }

  app.get<{ Params: { id: string } }>("/api/questions/:id/lesson", async (req) => {
    const ctx = await auth(req);
    const ch = await chapterOf(req.params.id);
    await requireMembership(prisma, ctx.user.id, ch.subjectId, ctx.user.role);
    if (!ch.lesson.trim()) return { lesson: null };
    return { lesson: ch.lesson, chapter: { id: ch.id, name: ch.name } };
  });

  app.get<{ Params: { id: string } }>("/api/subjects/:id/lessons", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "chapter:manage", subject.id);
    const rows = await prisma.chapter.findMany({ where: { subjectId: subject.id, deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, lesson: true } });
    return { chapters: rows };
  });

  app.put<{ Params: { id: string } }>("/api/chapters/:id/lesson", async (req) => {
    const ctx = await auth(req);
    const body = z.object({ lesson: z.string().max(8000) }).parse(req.body);
    const ch = await prisma.chapter.findUnique({ where: { id: req.params.id } });
    if (!ch || ch.deletedAt) throw new HttpError(404, "chapter_not_found", "Chapitre introuvable");
    assertCan(ctx.actor, "chapter:manage", ch.subjectId);
    await prisma.chapter.update({ where: { id: ch.id }, data: { lesson: body.lesson.trim() } });
    return { ok: true };
  });
}
