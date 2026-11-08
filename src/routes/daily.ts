import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireMembership } from "../access.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { loadEffectiveSettings } from "../settingsStore.ts";
import { addDaysKey, localDayKey } from "../time.ts";
import { awardXp } from "../xpService.ts";
import { dayStreaks } from "./stats.ts";

/** Défi du jour : mêmes questions pour tous les membres d'une matière, un seul essai par jour. */
const DAILY_SIZE = 5;
const MIN_QUESTIONS = 3;
const GRACE_MS = 1500;
const COMPLETION_BONUS = 10;
const STREAK_BONUS_PER_DAY = 2;
const STREAK_BONUS_MAX_DAYS = 10;

type Ans = { q: string; choice: number | null; correct: boolean; ms: number };
const AnswerBody = z.object({ gameQuestionId: z.string().min(1), choiceIndex: z.number().int().min(0) });
const parseAnswers = (json: string): Ans[] => { try { const a = JSON.parse(json); return Array.isArray(a) ? a : []; } catch { return []; } };
const parseIds = (json: string): string[] => { try { const a = JSON.parse(json); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
const hashKey = (s: string) => createHash("sha256").update(s).digest("hex");

/** Série de défis terminés (jours consécutifs), à partir des jours où le joueur a fini le défi. */
async function streakOf(prisma: PrismaClient, userId: string, subjectId: string, today: string) {
  const rows = await prisma.dailyEntry.findMany({ where: { userId, finishedAt: { not: null }, challenge: { subjectId } }, select: { challenge: { select: { day: true } } }, take: 400, orderBy: { createdAt: "desc" } });
  return dayStreaks(rows.map((r) => r.challenge.day), today);
}

export function registerDailyRoutes(app: FastifyInstance, { prisma, auth, timezone }: Deps): void {
  const today = () => localDayKey(new Date(), timezone);

  /** Défi du jour de la matière : créé à la première demande (questions tirées de façon déterministe, puis figées). */
  async function challengeFor(subjectId: string, day: string) {
    const existing = await prisma.dailyChallenge.findUnique({ where: { subjectId_day: { subjectId, day } } });
    if (existing) return existing;
    const rows = await prisma.question.findMany({ where: { deletedAt: null, chapter: { subjectId, deletedAt: null, locked: false } }, select: { id: true } });
    if (rows.length < MIN_QUESTIONS) return null;
    const picked = rows.map((r) => r.id).sort((a, b) => hashKey(`${subjectId}:${day}:${a}`).localeCompare(hashKey(`${subjectId}:${day}:${b}`))).slice(0, DAILY_SIZE);
    try {
      return await prisma.dailyChallenge.create({ data: { subjectId, day, questionIds: JSON.stringify(picked) } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return prisma.dailyChallenge.findUniqueOrThrow({ where: { subjectId_day: { subjectId, day } } });
      throw e;
    }
  }

  async function questionsOf(ids: string[]) {
    const rows = await prisma.question.findMany({ where: { id: { in: ids } } });
    return ids.map((id) => rows.find((r) => r.id === id)).filter((q): q is NonNullable<typeof q> => !!q);
  }

  async function ranking(challengeId: string, userId: string) {
    const rows = await prisma.dailyEntry.findMany({
      where: { challengeId, finishedAt: { not: null } },
      orderBy: [{ correct: "desc" }, { timeMs: "asc" }, { createdAt: "asc" }],
      take: 20,
      include: { user: { select: { id: true, username: true, avatar: true } } },
    });
    const list = rows.map((r, i) => {
      let avatar: unknown = null;
      try { avatar = r.user.avatar ? JSON.parse(r.user.avatar) : null; } catch { /* avatar illisible */ }
      return { rank: i + 1, userId: r.userId, username: r.user.username, avatar, correct: r.correct, timeMs: r.timeMs, mine: r.userId === userId };
    });
    const mine = await prisma.dailyEntry.findUnique({ where: { challengeId_userId: { challengeId, userId } } });
    let myRank: number | null = null;
    if (mine?.finishedAt) {
      myRank = 1 + (await prisma.dailyEntry.count({
        where: { challengeId, finishedAt: { not: null }, OR: [{ correct: { gt: mine.correct } }, { correct: mine.correct, timeMs: { lt: mine.timeMs } }] },
      }));
    }
    const total = await prisma.dailyEntry.count({ where: { challengeId, finishedAt: { not: null } } });
    return { list, myRank, total };
  }

  app.get<{ Params: { id: string } }>("/api/subjects/:id/daily", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id, ctx.user.role);
    const day = today();
    const [streak, ch] = await Promise.all([streakOf(prisma, ctx.user.id, req.params.id, day), challengeFor(req.params.id, day)]);
    if (!ch) return { day, available: false, total: 0, status: "NONE", streak: { current: streak.current, longest: streak.longest } };
    const ids = parseIds(ch.questionIds);
    const entry = await prisma.dailyEntry.findUnique({ where: { challengeId_userId: { challengeId: ch.id, userId: ctx.user.id } } });
    const done = !!entry?.finishedAt;
    const base = { day, available: true, total: ids.length, streak: { current: streak.current, longest: streak.longest } };
    if (!entry) return { ...base, status: "NOT_STARTED", answered: 0 };
    if (!done) return { ...base, status: "IN_PROGRESS", answered: parseAnswers(entry.answers).length };
    const r = await ranking(ch.id, ctx.user.id);
    return { ...base, status: "DONE", answered: ids.length, mine: { correct: entry.correct, total: ids.length, timeMs: entry.timeMs, xpEarned: entry.xpEarned, rank: r.myRank }, ranking: r.list, participants: r.total };
  });

  /** Question en cours (crée la participation à la première demande ; le chrono de chaque question ne repart jamais à zéro). */
  async function currentFor(userId: string, subjectId: string) {
    const day = today();
    const ch = await challengeFor(subjectId, day);
    if (!ch) throw new HttpError(404, "daily_unavailable", "Pas assez de questions dans cette matière pour un défi du jour");
    const ids = parseIds(ch.questionIds);
    let entry = await prisma.dailyEntry.findUnique({ where: { challengeId_userId: { challengeId: ch.id, userId } } });
    if (!entry) {
      try { entry = await prisma.dailyEntry.create({ data: { challengeId: ch.id, userId } }); }
      catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") entry = await prisma.dailyEntry.findUniqueOrThrow({ where: { challengeId_userId: { challengeId: ch.id, userId } } }); else throw e; }
    }
    if (entry.finishedAt) return { status: "DONE" as const, ch, ids, entry };
    const subject = await prisma.subject.findUniqueOrThrow({ where: { id: subjectId } });
    const settings = await loadEffectiveSettings(prisma, subject.settings, subject.organizationId);
    const limitMs = settings.timePerQuestionSec * 1000;
    let answers = parseAnswers(entry.answers);
    let servedAt = entry.servedAt;
    // Questions dont le temps est écoulé : comptées fausses.
    for (let guard = 0; guard <= ids.length; guard++) {
      if (answers.length >= ids.length) break;
      if (!servedAt) { servedAt = new Date(); await prisma.dailyEntry.update({ where: { id: entry.id }, data: { servedAt } }); break; }
      if (limitMs > 0 && Date.now() - servedAt.getTime() > limitMs + GRACE_MS) {
        answers = [...answers, { q: ids[answers.length], choice: null, correct: false, ms: limitMs }];
        servedAt = answers.length >= ids.length ? null : new Date();
        await prisma.dailyEntry.update({ where: { id: entry.id }, data: { answers: JSON.stringify(answers), servedAt } });
        continue;
      }
      break;
    }
    if (answers.length >= ids.length) {
      await finish(userId, subjectId, ch.id, entry.id, ids.length, settings.xpPerCorrect);
      const fresh = await prisma.dailyEntry.findUniqueOrThrow({ where: { id: entry.id } });
      return { status: "DONE" as const, ch, ids, entry: fresh };
    }
    const qs = await questionsOf([ids[answers.length]]);
    const q = qs[0];
    if (!q) throw new HttpError(409, "question_missing", "Une question du défi n'existe plus");
    return {
      status: "IN_PROGRESS" as const, ch, ids, entry, settings, limitMs, servedAt: servedAt!, answers,
      question: { gameQuestionId: q.id, round: 1, position: answers.length + 1, total: ids.length, text: q.text, choices: JSON.parse(q.choices) as string[], timeLimitSec: settings.timePerQuestionSec,
        remainingMs: limitMs > 0 ? Math.max(0, limitMs - (Date.now() - servedAt!.getTime())) : null },
    };
  }

  /** Clôture : score, temps total et XP (une seule fois, même en cas d'appels simultanés). */
  async function finish(userId: string, subjectId: string, challengeId: string, entryId: string, total: number, xpPerCorrect: number): Promise<number> {
    const entry = await prisma.dailyEntry.findUniqueOrThrow({ where: { id: entryId } });
    if (entry.finishedAt) return entry.xpEarned;
    const answers = parseAnswers(entry.answers);
    const correct = answers.filter((a) => a.correct).length;
    const timeMs = answers.reduce((n, a) => n + a.ms, 0);
    const day = (await prisma.dailyChallenge.findUniqueOrThrow({ where: { id: challengeId } })).day;
    const before = await streakOf(prisma, userId, subjectId, day);
    // La série d'aujourd'hui = celle d'hier + 1 (si le défi d'hier est fait).
    const yesterdayDone = await prisma.dailyEntry.count({ where: { userId, finishedAt: { not: null }, challenge: { subjectId, day: addDaysKey(day, -1) } } });
    const streakNow = (yesterdayDone ? before.current : 0) + 1;
    const xp = correct * xpPerCorrect + COMPLETION_BONUS + STREAK_BONUS_PER_DAY * Math.min(streakNow, STREAK_BONUS_MAX_DAYS);
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.dailyEntry.updateMany({ where: { id: entryId, finishedAt: null }, data: { finishedAt: new Date(), correct, timeMs, xpEarned: xp } });
      if (claimed.count === 0) return (await tx.dailyEntry.findUniqueOrThrow({ where: { id: entryId } })).xpEarned;
      await awardXp(tx, { userId, subjectId, source: "DAILY_CHALLENGE", amount: xp });
      return xp;
    });
  }

  app.get<{ Params: { id: string } }>("/api/subjects/:id/daily/current", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id, ctx.user.role);
    const cur = await currentFor(ctx.user.id, req.params.id);
    if (cur.status === "DONE") return { status: "DONE" };
    return { status: "IN_PROGRESS", question: cur.question };
  });

  app.post<{ Params: { id: string } }>("/api/subjects/:id/daily/answer", async (req) => {
    const ctx = await auth(req);
    const body = AnswerBody.parse(req.body);
    await requireMembership(prisma, ctx.user.id, req.params.id, ctx.user.role);
    const cur = await currentFor(ctx.user.id, req.params.id);
    if (cur.status === "DONE") throw new HttpError(409, "already_done", "Tu as déjà terminé le défi du jour");
    const { ids, entry, answers, servedAt, limitMs, settings } = cur;
    const expected = ids[answers.length];
    if (body.gameQuestionId !== expected) throw new HttpError(409, "not_current", "Ce n'est pas la question en cours");
    const q = (await questionsOf([expected]))[0];
    const choices = JSON.parse(q.choices) as string[];
    const elapsed = Date.now() - servedAt.getTime();
    const timedOut = limitMs > 0 && elapsed > limitMs + GRACE_MS;
    if (!timedOut && body.choiceIndex >= choices.length) throw new HttpError(400, "invalid_choice", `choiceIndex doit être compris entre 0 et ${choices.length - 1}`);
    const correct = !timedOut && body.choiceIndex === q.answerIndex;
    const next: Ans[] = [...answers, { q: expected, choice: timedOut ? null : body.choiceIndex, correct, ms: limitMs > 0 ? Math.min(elapsed, limitMs) : elapsed }];
    const last = next.length >= ids.length;
    // Écriture conditionnelle : un double envoi de la même réponse est refusé.
    const w = await prisma.dailyEntry.updateMany({ where: { id: entry.id, answers: entry.answers }, data: { answers: JSON.stringify(next), servedAt: last ? null : new Date() } });
    if (w.count === 0) throw new HttpError(409, "already_answered", "Tu as déjà répondu à cette question");
    let xpGained = correct ? settings.xpPerCorrect : 0;
    let summary: unknown;
    if (last) {
      const total = await finish(ctx.user.id, req.params.id, cur.ch.id, entry.id, ids.length, settings.xpPerCorrect);
      xpGained = total;
      const fin = await prisma.dailyEntry.findUniqueOrThrow({ where: { id: entry.id } });
      const r = await ranking(cur.ch.id, ctx.user.id);
      summary = { correct: fin.correct, total: ids.length, timeMs: fin.timeMs, xpEarned: fin.xpEarned, rank: r.myRank, participants: r.total };
    }
    let nextQuestion = null;
    if (!last) {
      const nq = (await questionsOf([ids[next.length]]))[0];
      nextQuestion = { gameQuestionId: nq.id, round: 1, position: next.length + 1, total: ids.length, text: nq.text, choices: JSON.parse(nq.choices) as string[], timeLimitSec: settings.timePerQuestionSec, remainingMs: limitMs > 0 ? limitMs : null };
    }
    return {
      correct, timedOut, correctIndex: q.answerIndex, explanation: q.explanation, xpGained, roundDone: last, finished: last, next: nextQuestion, daily: summary ?? null,
      newBadges: [] as unknown[],
    };
  });
}
