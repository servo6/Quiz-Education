import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { loadSubject, requireMembership } from "../access.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { assertCan } from "../permissions.ts";
import { addDaysKey, localDayKey, localHourAndWeekday, startOfPeriod } from "../time.ts";
import { subjectView } from "./progress.ts";

const MAX_ROWS = 200_000;
const pct = (c: number, n: number) => (n === 0 ? null : Math.round((c / n) * 1000) / 10);
const DUEL_MODES = ["FRIENDLY", "DUEL"];

/** Séries de jours consécutifs : en cours (encore valable aujourd'hui ou hier) et la plus longue. */
export function dayStreaks(dayKeys: Iterable<string>, today: string): { current: number; longest: number } {
  const days = [...new Set(dayKeys)].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of days) {
    run = prev && addDaysKey(prev, 1) === d ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  let current = 0;
  const set = new Set(days);
  let cursor = set.has(today) ? today : addDaysKey(today, -1);
  while (set.has(cursor)) {
    current++;
    cursor = addDaysKey(cursor, -1);
  }
  return { current, longest };
}

/** Suite de bonnes réponses d'affilée (en cours et la plus longue). */
export function answerStreaks(results: boolean[]): { current: number; longest: number } {
  let run = 0;
  let longest = 0;
  for (const ok of results) {
    run = ok ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return { current: run, longest };
}

/** Toutes les statistiques d'un joueur dans une matière. */
export async function playerStats(prisma: PrismaClient, userId: string, subjectId: string, timezone: string, days: number, now = new Date()) {
  const [answers, players, xpEvents] = await Promise.all([
    prisma.answer.findMany({
      where: { userId, gameQuestion: { game: { subjectId } } },
      orderBy: { answeredAt: "asc" },
      take: MAX_ROWS,
      select: {
        isCorrect: true,
        choiceIndex: true,
        timeMs: true,
        answeredAt: true,
        gameQuestion: { select: { game: { select: { mode: true } }, round: { select: { chapter: { select: { id: true, name: true } } } } } },
      },
    }),
    prisma.gamePlayer.findMany({
      where: { userId, game: { subjectId } },
      select: { result: true, correctCount: true, game: { select: { mode: true, status: true, finishedAt: true, createdAt: true, _count: { select: { questions: true } } } } },
    }),
    prisma.xpEvent.findMany({ where: { userId, subjectId }, select: { amount: true, createdAt: true }, take: MAX_ROWS }),
  ]);

  const today = localDayKey(now, timezone);
  const daily = new Map<string, { answers: number; correct: number; xp: number; timeMs: number; timed: number }>();
  const slot = (k: string) => {
    let v = daily.get(k);
    if (!v) daily.set(k, (v = { answers: 0, correct: 0, xp: 0, timeMs: 0, timed: 0 }));
    return v;
  };
  const weekday = Array.from({ length: 7 }, () => ({ answers: 0, correct: 0 }));
  const hours = Array.from({ length: 24 }, () => 0);
  const byChapter = new Map<string, { id: string; name: string; answered: number; correct: number }>();
  const byMode: Record<string, { answered: number; correct: number }> = {};
  let correct = 0;
  let timedOut = 0;
  let timeSum = 0;
  let timeN = 0;
  for (const a of answers) {
    const k = localDayKey(a.answeredAt, timezone);
    const d = slot(k);
    d.answers++;
    if (a.isCorrect) {
      d.correct++;
      correct++;
    }
    if (a.choiceIndex === null) timedOut++;
    else if (a.timeMs != null) {
      timeSum += a.timeMs;
      timeN++;
    }
    const { hour, weekday: wd } = localHourAndWeekday(a.answeredAt, timezone);
    hours[hour]++;
    weekday[wd].answers++;
    if (a.isCorrect) weekday[wd].correct++;
    const mode = a.gameQuestion.game.mode === "SOLO" ? "SOLO" : "DUEL";
    const m = (byMode[mode] ??= { answered: 0, correct: 0 });
    m.answered++;
    if (a.isCorrect) m.correct++;
    const ch = a.gameQuestion.round.chapter;
    const c = byChapter.get(ch.id) ?? { id: ch.id, name: ch.name, answered: 0, correct: 0 };
    c.answered++;
    if (a.isCorrect) c.correct++;
    byChapter.set(ch.id, c);
  }
  let totalXp = 0;
  for (const e of xpEvents) {
    slot(localDayKey(e.createdAt, timezone)).xp += e.amount;
    totalXp += e.amount;
  }

  // Courbe continue sur la période demandée (les jours sans activité valent 0).
  const series: Array<{ date: string; answers: number; correct: number; accuracy: number | null; xp: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDaysKey(today, -i);
    const v = daily.get(date);
    series.push({ date, answers: v?.answers ?? 0, correct: v?.correct ?? 0, accuracy: v ? pct(v.correct, v.answers) : null, xp: v?.xp ?? 0 });
  }
  // Calendrier : un an d'activité.
  const since = addDaysKey(today, -370);
  const calendar = [...daily.entries()].filter(([k]) => k >= since && daily.get(k)!.answers > 0).map(([date, v]) => ({ date, answers: v.answers, correct: v.correct })).sort((a, b) => a.date.localeCompare(b.date));

  const practiced = [...daily.entries()].filter(([, v]) => v.answers > 0).map(([k]) => k);
  const dStreak = dayStreaks(practiced, today);
  const aStreak = answerStreaks(answers.map((a) => a.isCorrect));
  const bestDay = [...daily.entries()].sort((a, b) => b[1].answers - a[1].answers)[0];

  const finished = players.filter((p) => p.game.status === "FINISHED");
  const duels = finished.filter((p) => DUEL_MODES.includes(p.game.mode) && p.result);
  const count = (r: string) => duels.filter((p) => p.result === r).length;
  const wins = count("WIN");
  const draws = count("DRAW");
  const losses = count("LOSS") + count("FORFEIT");
  const recent = [...duels].sort((a, b) => (b.game.finishedAt?.getTime() ?? 0) - (a.game.finishedAt?.getTime() ?? 0)).slice(0, 10).map((p) => (p.result === "WIN" ? "W" : p.result === "DRAW" ? "D" : "L"));
  // Série de victoires (du plus récent au plus ancien, en s'arrêtant à la première non-victoire).
  const ordered = [...duels].sort((a, b) => (a.game.finishedAt?.getTime() ?? 0) - (b.game.finishedAt?.getTime() ?? 0));
  let winRun = 0;
  let bestWinRun = 0;
  for (const p of ordered) {
    winRun = p.result === "WIN" ? winRun + 1 : 0;
    bestWinRun = Math.max(bestWinRun, winRun);
  }
  const solos = finished.filter((p) => p.game.mode === "SOLO");
  const soloScores = solos.filter((p) => p.game._count.questions > 0).map((p) => ({ correct: p.correctCount, total: p.game._count.questions }));
  const bestSolo = soloScores.sort((a, b) => b.correct / b.total - a.correct / a.total || b.total - a.total)[0] ?? null;

  return {
    totals: {
      answers: answers.length,
      correct,
      wrong: answers.length - correct - timedOut,
      timedOut,
      accuracy: pct(correct, answers.length),
      avgTimeMs: timeN ? Math.round(timeSum / timeN) : null,
      xp: totalXp,
      activeDays: practiced.length,
    },
    streaks: { daysCurrent: dStreak.current, daysLongest: dStreak.longest, correctCurrent: aStreak.current, correctLongest: aStreak.longest, practicedToday: practiced.includes(today) },
    duels: { played: duels.length, wins, draws, losses, winRate: pct(wins, duels.length), recent, bestWinRun, currentWinRun: winRun },
    solo: { finished: solos.length, avgScore: soloScores.length ? Math.round((soloScores.reduce((n, s) => n + s.correct / s.total, 0) / soloScores.length) * 1000) / 10 : null, best: bestSolo },
    byMode: Object.fromEntries(Object.entries(byMode).map(([k, v]) => [k, { ...v, accuracy: pct(v.correct, v.answered) }])),
    chapters: [...byChapter.values()].map((c) => ({ ...c, accuracy: pct(c.correct, c.answered) })).sort((a, b) => a.name.localeCompare(b.name)),
    series,
    calendar,
    weekday: weekday.map((w) => ({ ...w, accuracy: pct(w.correct, w.answers) })),
    hours,
    bestDay: bestDay ? { date: bestDay[0], answers: bestDay[1].answers } : null,
    today,
  };
}

const PERIODS = ["today", "week", "month", "year", "all"] as const;
const METRICS = ["xp", "wins", "correct"] as const;

export function registerStatsRoutes(app: FastifyInstance, { prisma, auth, timezone }: Deps): void {
  const Days = z.coerce.number().int().min(7).max(365).catch(30);

  // ── Mes statistiques complètes dans la matière
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>("/api/subjects/:id/stats/full", async (req) => {
    const ctx = await auth(req);
    const m = await requireMembership(prisma, ctx.user.id, req.params.id);
    const view = await subjectView(prisma, req.params.id);
    const me = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id }, select: { id: true, username: true, avatar: true } });
    const rank = (await prisma.membership.count({ where: { subjectId: req.params.id, revokedAt: null, user: { bannedAt: null, role: "USER" }, xp: { gt: m.xp } } })) + 1;
    const total = await prisma.membership.count({ where: { subjectId: req.params.id, revokedAt: null, user: { bannedAt: null, role: "USER" } } });
    const stats = await playerStats(prisma, ctx.user.id, req.params.id, timezone, Days.parse(req.query.days ?? 30));
    return { player: view.card(me, m.xp), rank, totalPlayers: total, ...stats };
  });

  // ── Classement filtrable : critère (XP, victoires, bonnes réponses) × période
  app.get<{ Params: { id: string }; Querystring: { metric?: string; period?: string; limit?: string } }>("/api/subjects/:id/ranking", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id);
    const metric = z.enum(METRICS).catch("xp").parse(req.query.metric ?? "xp");
    const period = z.enum(PERIODS).catch("all").parse(req.query.period ?? "all");
    const limit = z.coerce.number().int().min(3).max(200).catch(50).parse(req.query.limit ?? 50);
    const subjectId = req.params.id;
    const view = await subjectView(prisma, subjectId);
    const since = period === "all" ? null : startOfPeriod(period, new Date(), timezone);

    const members = await prisma.membership.findMany({
      where: { subjectId, revokedAt: null, user: { bannedAt: null, role: "USER" } },
      include: { user: { select: { id: true, username: true, avatar: true } } },
    });
    const values = new Map<string, number>();
    if (metric === "xp" && !since) for (const m of members) values.set(m.userId, m.xp);
    else if (metric === "xp") {
      for (const r of await prisma.xpEvent.groupBy({ by: ["userId"], where: { subjectId, createdAt: { gte: since! } }, _sum: { amount: true } })) values.set(r.userId, r._sum.amount ?? 0);
    } else if (metric === "wins") {
      const rows = await prisma.gamePlayer.groupBy({
        by: ["userId"],
        where: { result: "WIN", game: { subjectId, status: "FINISHED", mode: { in: DUEL_MODES }, ...(since ? { finishedAt: { gte: since } } : {}) } },
        _count: { _all: true },
      });
      for (const r of rows) values.set(r.userId, r._count._all);
    } else {
      const rows = await prisma.answer.groupBy({
        by: ["userId"],
        where: { isCorrect: true, gameQuestion: { game: { subjectId } }, ...(since ? { answeredAt: { gte: since } } : {}) },
        _count: { _all: true },
      });
      for (const r of rows) values.set(r.userId, r._count._all);
    }

    const sorted = members
      .map((m) => ({ m, value: values.get(m.userId) ?? 0 }))
      .filter((x) => x.value > 0 || period === "all")
      .sort((a, b) => b.value - a.value || b.m.xp - a.m.xp || a.m.joinedAt.getTime() - b.m.joinedAt.getTime());
    // Rang : à valeur égale, même rang.
    let lastValue = -1;
    let lastRank = 0;
    const ranked = sorted.map((x, i) => {
      const rank = x.value === lastValue ? lastRank : i + 1;
      lastValue = x.value;
      lastRank = rank;
      return { rank, value: x.value, ...view.card(x.m.user, x.m.xp) };
    });
    const mine = ranked.find((r) => r.id === ctx.user.id);
    return { metric, period, since, players: ranked.slice(0, limit), totalPlayers: ranked.length, you: mine ? { rank: mine.rank, value: mine.value } : { rank: null, value: 0 } };
  });

  // ── Statistiques d'un joueur vues par l'administrateur / le responsable de la matière
  app.get<{ Params: { id: string; userId: string }; Querystring: { days?: string } }>("/api/subjects/:id/stats/player/:userId", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "members:view", subject.id);
    const m = await prisma.membership.findUnique({
      where: { userId_subjectId: { userId: req.params.userId, subjectId: subject.id } },
      include: { user: { select: { id: true, username: true, avatar: true, role: true } } },
    });
    if (!m || m.user.role !== "USER") throw new HttpError(404, "player_not_found", "Joueur introuvable dans cette matière");
    const view = await subjectView(prisma, subject.id);
    return { player: view.card(m.user, m.xp), ...(await playerStats(prisma, m.userId, subject.id, timezone, Days.parse(req.query.days ?? 30))) };
  });

  // ── Vue d'ensemble de la matière (administrateur / responsable)
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>("/api/subjects/:id/admin-stats", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "members:view", subject.id);
    const days = Days.parse(req.query.days ?? 30);
    const view = await subjectView(prisma, subject.id);
    const now = new Date();
    const today = localDayKey(now, timezone);

    const [members, answers, players, xpEvents] = await Promise.all([
      prisma.membership.findMany({
        where: { subjectId: subject.id, user: { role: "USER" } },
        include: { user: { select: { id: true, username: true, avatar: true, bannedAt: true } } },
      }),
      prisma.answer.findMany({
        where: { gameQuestion: { game: { subjectId: subject.id } } },
        orderBy: { answeredAt: "asc" },
        take: MAX_ROWS,
        select: { userId: true, isCorrect: true, answeredAt: true, timeMs: true, gameQuestion: { select: { questionId: true, game: { select: { mode: true } }, round: { select: { chapterId: true } } } } },
      }),
      prisma.gamePlayer.findMany({ where: { game: { subjectId: subject.id } }, select: { userId: true, result: true, game: { select: { mode: true, status: true, createdAt: true } } } }),
      prisma.xpEvent.findMany({ where: { subjectId: subject.id }, select: { createdAt: true, amount: true }, take: MAX_ROWS }),
    ]);
    const active = members.filter((m) => !m.revokedAt && !m.user.bannedAt);
    const activeIds = new Set(active.map((m) => m.userId));

    type Row = { answers: number; correct: number; days: Set<string>; last: Date | null; timeSum: number; timeN: number };
    const per = new Map<string, Row>();
    const daily = new Map<string, { answers: number; correct: number; players: Set<string> }>();
    const chap = new Map<string, { answered: number; correct: number }>();
    const quest = new Map<string, { answered: number; correct: number }>();
    const weekday = Array.from({ length: 7 }, () => 0);
    const hours = Array.from({ length: 24 }, () => 0);
    let totalCorrect = 0;
    let timeSum = 0;
    let timeN = 0;
    for (const a of answers) {
      const k = localDayKey(a.answeredAt, timezone);
      const r = per.get(a.userId) ?? { answers: 0, correct: 0, days: new Set<string>(), last: null, timeSum: 0, timeN: 0 };
      r.answers++;
      if (a.isCorrect) r.correct++;
      r.days.add(k);
      r.last = a.answeredAt;
      if (a.timeMs != null) {
        r.timeSum += a.timeMs;
        r.timeN++;
        timeSum += a.timeMs;
        timeN++;
      }
      per.set(a.userId, r);
      const d = daily.get(k) ?? { answers: 0, correct: 0, players: new Set<string>() };
      d.answers++;
      if (a.isCorrect) d.correct++;
      d.players.add(a.userId);
      daily.set(k, d);
      if (a.isCorrect) totalCorrect++;
      const cid = a.gameQuestion.round.chapterId;
      const c = chap.get(cid) ?? { answered: 0, correct: 0 };
      c.answered++;
      if (a.isCorrect) c.correct++;
      chap.set(cid, c);
      const qid = a.gameQuestion.questionId;
      const q = quest.get(qid) ?? { answered: 0, correct: 0 };
      q.answered++;
      if (a.isCorrect) q.correct++;
      quest.set(qid, q);
      const { hour, weekday: wd } = localHourAndWeekday(a.answeredAt, timezone);
      hours[hour]++;
      weekday[wd]++;
    }

    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = addDaysKey(today, -i);
      const v = daily.get(date);
      const joined = members.filter((m) => localDayKey(m.joinedAt, timezone) === date).length;
      series.push({ date, answers: v?.answers ?? 0, correct: v?.correct ?? 0, accuracy: v ? pct(v.correct, v.answers) : null, activePlayers: v?.players.size ?? 0, newMembers: joined });
    }
    const dayKeysWith = (uid: string) => per.get(uid)?.days ?? new Set<string>();
    const duelStat = new Map<string, { w: number; d: number; l: number }>();
    for (const p of players) {
      if (!DUEL_MODES.includes(p.game.mode) || p.game.status !== "FINISHED" || !p.result) continue;
      const s = duelStat.get(p.userId) ?? { w: 0, d: 0, l: 0 };
      if (p.result === "WIN") s.w++;
      else if (p.result === "DRAW") s.d++;
      else s.l++;
      duelStat.set(p.userId, s);
    }
    const table = active.map((m) => {
      const r = per.get(m.userId);
      const ds = duelStat.get(m.userId) ?? { w: 0, d: 0, l: 0 };
      const st = dayStreaks(dayKeysWith(m.userId), today);
      return {
        ...view.card(m.user, m.xp),
        answers: r?.answers ?? 0,
        correct: r?.correct ?? 0,
        accuracy: r ? pct(r.correct, r.answers) : null,
        avgTimeMs: r && r.timeN ? Math.round(r.timeSum / r.timeN) : null,
        activeDays: r?.days.size ?? 0,
        streak: st.current,
        longestStreak: st.longest,
        wins: ds.w,
        draws: ds.d,
        losses: ds.l,
        lastActive: r?.last ?? null,
        joinedAt: m.joinedAt,
      };
    });
    const since7 = addDaysKey(today, -6);
    const since30 = addDaysKey(today, -29);
    const activeIn = (from: string) => active.filter((m) => [...dayKeysWith(m.userId)].some((d) => d >= from)).length;

    const chapters = await prisma.chapter.findMany({ where: { subjectId: subject.id, deletedAt: null }, select: { id: true, name: true, _count: { select: { questions: { where: { deletedAt: null } } } } } });
    const chapterRows = chapters.map((c) => {
      const v = chap.get(c.id);
      return { id: c.id, name: c.name, questions: c._count.questions, answered: v?.answered ?? 0, accuracy: v ? pct(v.correct, v.answered) : null };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const hardIds = [...quest.entries()].filter(([, v]) => v.answered >= 5).map(([id, v]) => ({ id, ...v, acc: v.correct / v.answered })).sort((a, b) => a.acc - b.acc).slice(0, 8);
    const hardQuestions = hardIds.length
      ? (await prisma.question.findMany({ where: { id: { in: hardIds.map((h) => h.id) } }, select: { id: true, text: true, chapter: { select: { name: true } } } })).reduce<Record<string, { text: string; chapter: string }>>((o, q) => ((o[q.id] = { text: q.text, chapter: q.chapter.name }), o), {})
      : {};

    const duelGames = new Set<string>();
    const results = { wins: 0, draws: 0, decisive: 0 };
    const finishedDuels = await prisma.game.findMany({ where: { subjectId: subject.id, mode: { in: DUEL_MODES }, status: "FINISHED" }, select: { id: true, mode: true, players: { select: { result: true } } } });
    for (const g of finishedDuels) {
      duelGames.add(g.id);
      if (g.players.some((p) => p.result === "DRAW")) results.draws++;
      else results.decisive++;
    }
    const gameCounts = await prisma.game.groupBy({ by: ["mode", "status"], where: { subjectId: subject.id }, _count: { _all: true } });
    const gc = (modes: string[], status?: string) => gameCounts.filter((g) => modes.includes(g.mode) && (!status || g.status === status)).reduce((n, g) => n + g._count._all, 0);
    const xpByDay = new Map<string, number>();
    for (const e of xpEvents) xpByDay.set(localDayKey(e.createdAt, timezone), (xpByDay.get(localDayKey(e.createdAt, timezone)) ?? 0) + e.amount);

    return {
      totals: {
        members: active.length,
        revoked: members.length - active.length,
        active7: activeIn(since7),
        active30: activeIn(since30),
        answers: answers.length,
        correct: totalCorrect,
        accuracy: pct(totalCorrect, answers.length),
        avgTimeMs: timeN ? Math.round(timeSum / timeN) : null,
        soloFinished: gc(["SOLO"], "FINISHED"),
        duelsFinished: gc(DUEL_MODES, "FINISHED"),
        duelsInProgress: gc(DUEL_MODES, "IN_PROGRESS"),
        xpTotal: xpEvents.reduce((n, e) => n + e.amount, 0),
        xpPerDay: series.map((s) => ({ date: s.date, xp: xpByDay.get(s.date) ?? 0 })),
      },
      duelOutcomes: results,
      series,
      players: table.sort((a, b) => b.xp - a.xp),
      chapters: chapterRows,
      hardQuestions: hardIds.map((h) => ({ questionId: h.id, text: hardQuestions[h.id]?.text ?? "", chapter: hardQuestions[h.id]?.chapter ?? "", answered: h.answered, accuracy: pct(h.correct, h.answered) })),
      weekday,
      hours,
      activeIds: [...activeIds].length,
    };
  });
}
