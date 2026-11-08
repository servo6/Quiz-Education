import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireMembership } from "../access.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";

/**
 * Révision espacée : les questions ratées reviennent à intervalles croissants (10 min, puis 1, 3, 7, 14 jours).
 * Aucune modification des modes de jeu : une question est « à réviser » quand ta dernière réponse dessus est fausse
 * (solo ou duel), ou quand sa carte de révision arrive à échéance. Une erreur remet la carte au début ; réussir
 * toute la série la fait passer en « maîtrisée ».
 */
const MIN = 60_000, DAY = 86_400_000;
const INTERVAL_MS = [10 * MIN, DAY, 3 * DAY, 7 * DAY, 14 * DAY];
const MASTERED = INTERVAL_MS.length; // box 5
const SESSION_MAX = 10;
const AnswerBody = z.object({ gameQuestionId: z.string().min(1), choiceIndex: z.number().int().min(0), done: z.number().int().min(0).max(100).default(0), size: z.number().int().min(1).max(100).default(SESSION_MAX) });

type Due = { questionId: string; box: number; fresh: boolean };

/** Questions à réviser maintenant, les plus fragiles d'abord. */
export async function dueQuestions(prisma: PrismaClient, userId: string, subjectId: string, now = new Date()): Promise<Due[]> {
  const [cards, answers] = await Promise.all([
    prisma.reviewCard.findMany({ where: { userId, subjectId } }),
    prisma.answer.findMany({
      where: { userId, gameQuestion: { game: { subjectId } } },
      orderBy: { answeredAt: "desc" },
      take: 3000,
      select: { isCorrect: true, answeredAt: true, gameQuestion: { select: { questionId: true } } },
    }),
  ]);
  const latest = new Map<string, { correct: boolean; at: Date }>();
  for (const a of answers) if (!latest.has(a.gameQuestion.questionId)) latest.set(a.gameQuestion.questionId, { correct: a.isCorrect, at: a.answeredAt });
  const byQ = new Map(cards.map((c) => [c.questionId, c]));
  const out = new Map<string, Due>();
  for (const [qid, l] of latest) {
    if (l.correct) continue;
    const c = byQ.get(qid);
    if (!c || l.at > c.reviewedAt) out.set(qid, { questionId: qid, box: 0, fresh: true });
  }
  for (const c of cards) if (c.box < MASTERED && c.dueAt <= now && !out.has(c.questionId)) out.set(c.questionId, { questionId: c.questionId, box: c.box, fresh: false });
  if (out.size === 0) return [];
  const ok = await prisma.question.findMany({ where: { id: { in: [...out.keys()] }, deletedAt: null, chapter: { subjectId, deletedAt: null, locked: false } }, select: { id: true } });
  const alive = new Set(ok.map((q) => q.id));
  const hash = (s: string) => createHash("sha256").update(s + now.toISOString().slice(0, 10)).digest("hex");
  return [...out.values()].filter((d) => alive.has(d.questionId)).sort((a, b) => a.box - b.box || hash(a.questionId).localeCompare(hash(b.questionId)));
}

export function registerReviewRoutes(app: FastifyInstance, { prisma, auth }: Deps): void {
  const view = async (questionId: string, position: number, total: number) => {
    const q = await prisma.question.findUniqueOrThrow({ where: { id: questionId } });
    return { gameQuestionId: q.id, round: 1, position, total, text: q.text, choices: JSON.parse(q.choices) as string[], timeLimitSec: 0, remainingMs: null };
  };

  app.get<{ Params: { id: string } }>("/api/subjects/:id/review", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id, ctx.user.role);
    const [due, cards] = await Promise.all([dueQuestions(prisma, ctx.user.id, req.params.id), prisma.reviewCard.findMany({ where: { userId: ctx.user.id, subjectId: req.params.id }, select: { box: true } })]);
    return { due: due.length, sessionSize: Math.min(SESSION_MAX, due.length), learning: cards.filter((c) => c.box < MASTERED).length, mastered: cards.filter((c) => c.box >= MASTERED).length };
  });

  app.get<{ Params: { id: string }; Querystring: { done?: string; size?: string } }>("/api/subjects/:id/review/next", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id, ctx.user.role);
    const done = Math.max(0, Number(req.query.done) || 0);
    const due = await dueQuestions(prisma, ctx.user.id, req.params.id);
    const size = Math.min(SESSION_MAX, Math.max(1, Number(req.query.size) || Math.min(SESSION_MAX, done + due.length)));
    if (done >= size || due.length === 0) return { status: "DONE" };
    return { status: "IN_PROGRESS", question: await view(due[0].questionId, done + 1, size) };
  });

  app.post<{ Params: { id: string } }>("/api/subjects/:id/review/answer", async (req) => {
    const ctx = await auth(req);
    const body = AnswerBody.parse(req.body);
    await requireMembership(prisma, ctx.user.id, req.params.id, ctx.user.role);
    const userId = ctx.user.id;
    const due = await dueQuestions(prisma, userId, req.params.id);
    const item = due.find((d) => d.questionId === body.gameQuestionId);
    if (!item) throw new HttpError(409, "not_due", "Cette question n'est pas à réviser maintenant");
    const q = await prisma.question.findUniqueOrThrow({ where: { id: item.questionId } });
    const choices = JSON.parse(q.choices) as string[];
    if (body.choiceIndex >= choices.length) throw new HttpError(400, "invalid_choice", `choiceIndex doit être compris entre 0 et ${choices.length - 1}`);
    const correct = body.choiceIndex === q.answerIndex;
    const now = new Date();
    const prev = await prisma.reviewCard.findUnique({ where: { userId_questionId: { userId, questionId: q.id } } });
    const base = item.fresh ? 0 : item.box;
    const box = correct ? Math.min(MASTERED, base + 1) : 0;
    const dueAt = new Date(now.getTime() + (correct ? (box >= MASTERED ? 3650 * DAY : INTERVAL_MS[box]) : INTERVAL_MS[0]));
    await prisma.reviewCard.upsert({
      where: { userId_questionId: { userId, questionId: q.id } },
      create: { userId, questionId: q.id, subjectId: req.params.id, box, dueAt, reviewedAt: now, lapses: correct ? 0 : 1 },
      update: { box, dueAt, reviewedAt: now, lapses: (prev?.lapses ?? 0) + (correct ? 0 : 1) },
    });
    const done = body.done + 1;
    const last = done >= body.size;
    let next = null;
    if (!last) {
      const rest = (await dueQuestions(prisma, userId, req.params.id)).filter((d) => d.questionId !== q.id);
      next = rest.length ? await view(rest[0].questionId, done + 1, body.size) : null;
    }
    return {
      correct, timedOut: false, correctIndex: q.answerIndex, explanation: q.explanation, xpGained: 0,
      roundDone: last || !next, finished: last || !next, next, mastered: correct && box >= MASTERED, newBadges: [] as unknown[],
    };
  });
}
