import { randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireMembership } from "../access.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";

/**
 * Examen blanc : questions tirées au hasard, temps global (1 minute par question), aucune correction avant la remise.
 * On peut revenir en arrière et changer ses réponses. Le serveur garde les réponses et l'heure de début : fermer la page
 * ne remet pas le chrono à zéro. Les examens ne rapportent pas d'XP et ne comptent pas dans les statistiques.
 */
export const EXAM_SIZES = [10, 20, 30] as const;
const SEC_PER_QUESTION = 60;
const GRACE_MS = 30_000;

type Answers = Record<string, number | null>;
const parseJson = <T>(s: string, fb: T): T => { try { return JSON.parse(s) as T; } catch { return fb; } };

export function registerExamRoutes(app: FastifyInstance, { prisma, auth }: Deps): void {
  async function questionsOf(ids: string[]) {
    const rows = await prisma.question.findMany({ where: { id: { in: ids } }, include: { chapter: { select: { name: true } } } });
    return ids.map((id) => rows.find((r) => r.id === id)).filter((q): q is NonNullable<typeof q> => !!q);
  }
  const deadlineOf = (a: { startedAt: Date; durationSec: number }) => a.startedAt.getTime() + a.durationSec * 1000;

  /** Note finale et correction détaillée ; ne sert qu'une fois l'examen remis. */
  async function result(a: { id: string; questionIds: string; answers: string; startedAt: Date; finishedAt: Date | null; durationSec: number }) {
    const ids = parseJson<string[]>(a.questionIds, []);
    const answers = parseJson<Answers>(a.answers, {});
    const qs = await questionsOf(ids);
    const chapters = new Map<string, { name: string; correct: number; total: number }>();
    const corrections = qs.map((q, i) => {
      const choice = answers[q.id] ?? null;
      const correct = choice === q.answerIndex;
      const c = chapters.get(q.chapter.name) ?? { name: q.chapter.name, correct: 0, total: 0 };
      c.total++; if (correct) c.correct++;
      chapters.set(q.chapter.name, c);
      return { n: i + 1, id: q.id, text: q.text, choices: parseJson<string[]>(q.choices, []), choice, correctIndex: q.answerIndex, correct, explanation: q.explanation };
    });
    const correct = corrections.filter((c) => c.correct).length;
    const total = ids.length;
    return {
      id: a.id, total, correct, blank: corrections.filter((c) => c.choice == null).length,
      grade: total ? Math.round((correct / total) * 200) / 10 : 0, // note sur 20, au dixième
      startedAt: a.startedAt, finishedAt: a.finishedAt, durationSec: a.durationSec,
      timeUsedSec: a.finishedAt ? Math.min(a.durationSec, Math.round((a.finishedAt.getTime() - a.startedAt.getTime()) / 1000)) : null,
      chapters: [...chapters.values()].map((c) => ({ ...c, accuracy: Math.round((c.correct / c.total) * 100) })), corrections,
    };
  }

  async function finalize(a: { id: string }) {
    const full = await prisma.examAttempt.findUniqueOrThrow({ where: { id: a.id } });
    if (full.finishedAt) return full;
    const ids = parseJson<string[]>(full.questionIds, []);
    const answers = parseJson<Answers>(full.answers, {});
    const qs = await questionsOf(ids);
    const correct = qs.filter((q) => answers[q.id] === q.answerIndex).length;
    const end = new Date(Math.min(Date.now(), deadlineOf(full)));
    await prisma.examAttempt.updateMany({ where: { id: full.id, finishedAt: null }, data: { finishedAt: end, correct } });
    return prisma.examAttempt.findUniqueOrThrow({ where: { id: full.id } });
  }

  const publicAttempt = async (a: { id: string; questionIds: string; answers: string; startedAt: Date; durationSec: number }) => {
    const qs = await questionsOf(parseJson<string[]>(a.questionIds, []));
    return { id: a.id, startedAt: a.startedAt, deadline: deadlineOf(a), durationSec: a.durationSec, serverNow: Date.now(), answers: parseJson<Answers>(a.answers, {}), questions: qs.map((q) => ({ id: q.id, text: q.text, choices: parseJson<string[]>(q.choices, []) })) };
  };

  /** Examen en cours (le temps écoulé le remet automatiquement). */
  async function inProgress(userId: string, subjectId: string) {
    const a = await prisma.examAttempt.findFirst({ where: { userId, subjectId, finishedAt: null }, orderBy: { startedAt: "desc" } });
    if (!a) return null;
    if (Date.now() > deadlineOf(a) + GRACE_MS) { await finalize(a); return null; }
    return a;
  }

  app.get<{ Params: { id: string } }>("/api/subjects/:id/exam", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id, ctx.user.role);
    const [cur, hist, count, chapterRows] = await Promise.all([
      inProgress(ctx.user.id, req.params.id),
      prisma.examAttempt.findMany({ where: { userId: ctx.user.id, subjectId: req.params.id, finishedAt: { not: null } }, orderBy: { finishedAt: "desc" }, take: 10 }),
      prisma.question.count({ where: { deletedAt: null, chapter: { subjectId: req.params.id, deletedAt: null, locked: false } } }),
      prisma.chapter.findMany({ where: { subjectId: req.params.id, deletedAt: null, locked: false }, orderBy: { name: "asc" }, select: { id: true, name: true, _count: { select: { questions: { where: { deletedAt: null } } } } } }),
    ]);
    return {
      sizes: EXAM_SIZES.filter((n) => n <= count).length ? EXAM_SIZES.filter((n) => n <= count) : count >= 5 ? [EXAM_SIZES[0]] : [], available: count, chapters: chapterRows.filter((c) => c._count.questions > 0).map((c) => ({ id: c.id, name: c.name, count: c._count.questions })),
      current: cur ? { id: cur.id, deadline: deadlineOf(cur), total: parseJson<string[]>(cur.questionIds, []).length } : null,
      history: hist.map((a) => { const total = parseJson<string[]>(a.questionIds, []).length; return { id: a.id, finishedAt: a.finishedAt, correct: a.correct, total, grade: total ? Math.round((a.correct / total) * 200) / 10 : 0 }; }),
    };
  });

  app.post<{ Params: { id: string } }>("/api/subjects/:id/exam", async (req) => {
    const ctx = await auth(req);
    const body = z.object({ size: z.number().int(), chapterIds: z.array(z.string().min(1)).max(100).optional() }).parse(req.body);
    if (body.size < 5 || body.size > Math.max(...EXAM_SIZES)) throw new HttpError(400, "bad_size", "Nombre de questions invalide");
    await requireMembership(prisma, ctx.user.id, req.params.id, ctx.user.role);
    const existing = await inProgress(ctx.user.id, req.params.id);
    if (existing) return publicAttempt(existing);
    const rows = await prisma.question.findMany({ where: { deletedAt: null, chapter: { subjectId: req.params.id, deletedAt: null, locked: false, ...(body.chapterIds?.length ? { id: { in: body.chapterIds } } : {}) } }, select: { id: true } });
    if (rows.length < 5) throw new HttpError(409, "not_enough_questions", "Pas assez de questions pour un examen");
    for (let i = rows.length - 1; i > 0; i--) { const j = randomInt(i + 1); [rows[i], rows[j]] = [rows[j], rows[i]]; }
    const ids = rows.slice(0, body.size).map((r) => r.id);
    const a = await prisma.examAttempt.create({ data: { userId: ctx.user.id, subjectId: req.params.id, questionIds: JSON.stringify(ids), durationSec: ids.length * SEC_PER_QUESTION } });
    return publicAttempt(a);
  });

  app.get<{ Params: { id: string } }>("/api/subjects/:id/exam/current", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id, ctx.user.role);
    const a = await inProgress(ctx.user.id, req.params.id);
    return a ? publicAttempt(a) : { id: null };
  });

  async function mine(userId: string, id: string) {
    const a = await prisma.examAttempt.findUnique({ where: { id } });
    if (!a || a.userId !== userId) throw new HttpError(404, "exam_not_found", "Examen introuvable");
    return a;
  }

  app.put<{ Params: { id: string } }>("/api/exam/:id/answers", async (req) => {
    const ctx = await auth(req);
    const body = z.object({ answers: z.record(z.string(), z.number().int().min(0).max(9).nullable()) }).parse(req.body);
    const a = await mine(ctx.user.id, req.params.id);
    if (a.finishedAt) throw new HttpError(409, "exam_finished", "L'examen est déjà remis");
    if (Date.now() > deadlineOf(a) + GRACE_MS) { await finalize(a); throw new HttpError(409, "exam_finished", "Le temps est écoulé"); }
    const allowed = new Set(parseJson<string[]>(a.questionIds, []));
    const clean: Answers = {};
    for (const [k, v] of Object.entries(body.answers)) if (allowed.has(k)) clean[k] = v;
    await prisma.examAttempt.update({ where: { id: a.id }, data: { answers: JSON.stringify(clean) } });
    return { saved: true };
  });

  app.post<{ Params: { id: string } }>("/api/exam/:id/submit", async (req) => {
    const ctx = await auth(req);
    const body = z.object({ answers: z.record(z.string(), z.number().int().min(0).max(9).nullable()).optional() }).parse(req.body ?? {});
    const a = await mine(ctx.user.id, req.params.id);
    if (!a.finishedAt && body.answers && Date.now() <= deadlineOf(a) + GRACE_MS) {
      const allowed = new Set(parseJson<string[]>(a.questionIds, []));
      const clean: Answers = {};
      for (const [k, v] of Object.entries(body.answers)) if (allowed.has(k)) clean[k] = v;
      await prisma.examAttempt.update({ where: { id: a.id }, data: { answers: JSON.stringify(clean) } });
    }
    return result(await finalize(a));
  });

  app.get<{ Params: { id: string } }>("/api/exam/:id", async (req) => {
    const ctx = await auth(req);
    let a = await mine(ctx.user.id, req.params.id);
    if (!a.finishedAt && Date.now() > deadlineOf(a) + GRACE_MS) a = await finalize(a);
    if (!a.finishedAt) throw new HttpError(409, "exam_running", "L'examen est en cours : la correction arrive après la remise");
    return result(a);
  });
}
