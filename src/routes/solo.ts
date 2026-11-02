import { randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assertChapterUnlocked, requireMembership } from "../access.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { runningGameListeners } from "../runningGames.ts";
import { loadEffectiveSettings } from "../settingsStore.ts";
import { startOfDay } from "../time.ts";
import { newBadgesSafe } from "../badges.ts";
import { choiceOrder, displayChoices, toDisplayed, toOriginal } from "../shuffle.ts";
import { levelFromXp, type LevelInfo } from "../xp.ts";

/** Marge accordée pour la latence réseau avant de considérer une réponse comme hors délai. */
const GRACE_MS = 1500;

/** Copie des paramètres au lancement : une modification pendant la partie ne la change pas. */
const GameConfigSchema = z.object({
  timePerQuestionSec: z.number(),
  xpPerCorrect: z.number(),
  levelBase: z.number(),
  levelExponent: z.number(),
  totalQuestions: z.number(),
  startXp: z.number(),
  shuffleChoices: z.boolean().default(false),
});
type GameConfig = z.infer<typeof GameConfigSchema>;

const StartBody = z.object({ subjectId: z.string().min(1), chapterId: z.string().min(1) });
const AnswerBody = z.object({ gameQuestionId: z.string().min(1), choiceIndex: z.number().int().min(0) });

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const levelOf = (xp: number, cfg: GameConfig): LevelInfo => levelFromXp(xp, { base: cfg.levelBase, exponent: cfg.levelExponent });

function parseConfig(json: string): GameConfig {
  return GameConfigSchema.parse(JSON.parse(json));
}

/**
 * Contenu figé d'une partie (questions, bonnes réponses, config) gardé en mémoire : il ne change pas pendant la partie,
 * donc inutile de le relire à chaque réponse (la base est distante). Seul l'état (réponses, chrono) est relu.
 */
type StaticGame = {
  at: number;
  subjectId: string;
  cfg: GameConfig;
  players: Set<string>;
  qs: { id: string; position: number; question: { text: string; choices: string; answerIndex: number; explanation: string | null } }[];
};
const gameCache = new Map<string, StaticGame>();
runningGameListeners.push(() => gameCache.clear());
const GAME_TTL_MS = 30 * 60_000;
function rememberGame(gameId: string, subjectId: string, cfg: GameConfig, userId: string, all: { id: string; position: number; question: { text: string; choices: string; answerIndex: number; explanation: string | null } }[]) {
  if (gameCache.size > 500) for (const [k, v] of gameCache) if (Date.now() - v.at > GAME_TTL_MS) gameCache.delete(k);
  const prev = gameCache.get(gameId);
  const players = prev?.players ?? new Set<string>();
  players.add(userId);
  gameCache.set(gameId, {
    at: Date.now(), subjectId, cfg, players,
    qs: all.map((g) => ({ id: g.id, position: g.position, question: { text: g.question.text, choices: g.question.choices, answerIndex: g.question.answerIndex, explanation: g.question.explanation } })),
  });
}

async function loadOwnGame(prisma: PrismaClient, userId: string, gameId: string) {
  const game = await prisma.game.findFirst({
    where: { id: gameId, mode: "SOLO", players: { some: { userId } } },
    include: { rounds: { include: { chapter: { select: { id: true, name: true } } } } },
  });
  if (!game) throw new HttpError(404, "game_not_found", "Partie introuvable");
  return game;
}

/** Choix tels que le joueur les voit (mélangés ou non). */
function shownChoices(gqId: string, userId: string, json: string, cfg: GameConfig): string[] {
  const choices = JSON.parse(json) as string[];
  return displayChoices(choices, choiceOrder(gqId, userId, choices.length, cfg.shuffleChoices));
}

type QuestionView = {
  gameQuestionId: string;
  position: number;
  total: number;
  text: string;
  choices: string[];
  timeLimitSec: number;
  remainingMs: number | null;
};

type Current = { status: "FINISHED" } | { status: "IN_PROGRESS"; question: QuestionView };

async function finishGame(prisma: PrismaClient, gameId: string): Promise<void> {
  await prisma.game.updateMany({ where: { id: gameId, status: "IN_PROGRESS" }, data: { status: "FINISHED", finishedAt: new Date() } });
}

/**
 * Question en cours : la première sans réponse. Lance son chronomètre à la première consultation (jamais remis à zéro
 * ensuite). Une question dont le temps est largement dépassé est clôturée comme "temps écoulé" et on passe à la suivante.
 * Ne révèle jamais la bonne réponse.
 */
async function currentQuestion(prisma: PrismaClient, gameId: string, userId: string, cfg: GameConfig, subjectId: string): Promise<Current> {
  const limitMs = cfg.timePerQuestionSec * 1000;
  for (let guard = 0; guard <= cfg.totalQuestions + 1; guard++) {
    if (!gameCache.get(gameId)?.players.has(userId)) {
      const rows = await prisma.gameQuestion.findMany({ where: { gameId }, orderBy: { position: "asc" }, include: { question: true } });
      rememberGame(gameId, subjectId, cfg, userId, rows);
    }
    const st = gameCache.get(gameId)!;
    // État mutable (réponses, chrono) : deux lectures simples en parallèle.
    const [answers, serves] = await Promise.all([
      prisma.answer.findMany({ where: { userId, gameQuestion: { gameId } }, select: { gameQuestionId: true } }),
      prisma.gameQuestion.findMany({ where: { gameId }, select: { id: true, servedAt: true } }),
    ]);
    const done = new Set(answers.map((a) => a.gameQuestionId));
    const next = st.qs.find((g) => !done.has(g.id));
    if (!next) {
      await finishGame(prisma, gameId);
      return { status: "FINISHED" };
    }

    const now = new Date();
    let servedAt = serves.find((g) => g.id === next.id)?.servedAt ?? null;
    if (!servedAt) {
      const r = await prisma.gameQuestion.updateMany({ where: { id: next.id, servedAt: null }, data: { servedAt: now } });
      servedAt = r.count > 0 ? now : (await prisma.gameQuestion.findUniqueOrThrow({ where: { id: next.id } })).servedAt!;
    }
    const elapsed = now.getTime() - servedAt.getTime();

    if (limitMs > 0 && elapsed > limitMs + GRACE_MS) {
      try {
        await prisma.answer.create({ data: { gameQuestionId: next.id, userId, choiceIndex: null, isCorrect: false, timeMs: limitMs } });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      }
      continue;
    }

    return {
      status: "IN_PROGRESS",
      question: {
        gameQuestionId: next.id,
        position: next.position,
        total: st.qs.length,
        text: next.question.text,
        choices: shownChoices(next.id, userId, next.question.choices, cfg),
        timeLimitSec: cfg.timePerQuestionSec,
        remainingMs: limitMs > 0 ? Math.max(0, limitMs - elapsed) : null,
      },
    };
  }
  throw new Error("currentQuestion : boucle inattendue");
}

export function registerSoloRoutes(app: FastifyInstance, { prisma, auth, timezone }: Deps): void {
  /** Parties solo du jour (heure locale du fuseau configuré) et partie en cours éventuelle. */
  async function dailyStatus(userId: string, subjectId: string, limit: number) {
    const [played, active] = await Promise.all([
      prisma.game.count({
        where: { mode: "SOLO", subjectId, createdAt: { gte: startOfDay(new Date(), timezone) }, players: { some: { userId } } },
      }),
      prisma.game.findFirst({
        where: { mode: "SOLO", subjectId, status: "IN_PROGRESS", players: { some: { userId } } },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    return {
      played,
      limit, // 0 = illimité
      remaining: limit === 0 ? null : Math.max(0, limit - played),
      activeGameId: active?.id ?? null,
    };
  }

  // ── Tickets : parties restantes par type (null = illimité). Le joueur les voit sous forme d'icônes, sans phrase.
  app.get<{ Params: { id: string } }>("/api/subjects/:id/tickets", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id, ctx.user.role);
    const subject = await prisma.subject.findUnique({ where: { id: req.params.id } });
    if (!subject) throw new HttpError(404, "subject_not_found", "Matière introuvable");
    const settings = await loadEffectiveSettings(prisma, subject.settings, subject.organizationId);
    const [solo, activeDuels] = await Promise.all([
      dailyStatus(ctx.user.id, subject.id, settings.soloGamesPerDay),
      settings.maxActiveDuels > 0
        ? prisma.game.count({ where: { mode: "DUEL", subjectId: subject.id, status: "IN_PROGRESS", players: { some: { userId: ctx.user.id } } } })
        : Promise.resolve(0),
    ]);
    return {
      solo: { total: solo.limit || null, left: solo.limit ? solo.remaining : null, resume: solo.activeGameId },
      duel: { total: settings.maxActiveDuels || null, left: settings.maxActiveDuels ? Math.max(0, settings.maxActiveDuels - activeDuels) : null },
      live: { total: null, left: null },
    };
  });

  // ── État du jour : combien de parties restantes, partie en cours
  app.get<{ Params: { id: string } }>("/api/subjects/:id/solo/status", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id);
    const subject = await prisma.subject.findUnique({ where: { id: req.params.id } });
    if (!subject) throw new HttpError(404, "subject_not_found", "Matière introuvable");
    const settings = await loadEffectiveSettings(prisma, subject.settings, subject.organizationId);
    return { ...(await dailyStatus(ctx.user.id, subject.id, settings.soloGamesPerDay)), questionsPerGame: settings.soloQuestions };
  });

  // ── Lancer une partie (ou reprendre celle en cours)
  app.post("/api/solo/start", async (req, reply) => {
    const ctx = await auth(req);
    const { subjectId, chapterId } = StartBody.parse(req.body);
    const membership = await requireMembership(prisma, ctx.user.id, subjectId);
    const subject = await prisma.subject.findUniqueOrThrow({ where: { id: subjectId } });
    const settings = await loadEffectiveSettings(prisma, subject.settings, subject.organizationId);

    // Une partie déjà en cours est reprise : elle ne consomme pas une seconde partie du jour.
    const status = await dailyStatus(ctx.user.id, subjectId, settings.soloGamesPerDay);
    if (status.activeGameId) {
      const game = await loadOwnGame(prisma, ctx.user.id, status.activeGameId);
      const cfg = parseConfig(game.config);
      const current = await currentQuestion(prisma, game.id, ctx.user.id, cfg, game.subjectId);
      return reply.send({
        resumed: true,
        game: { id: game.id, chapter: game.rounds[0]?.chapter ?? null, total: cfg.totalQuestions, timePerQuestionSec: cfg.timePerQuestionSec },
        ...current,
      });
    }

    if (settings.soloGamesPerDay > 0 && status.played >= settings.soloGamesPerDay) {
      throw new HttpError(429, "daily_limit_reached", `Limite atteinte : ${settings.soloGamesPerDay} partie(s) solo par jour dans cette matière.`, status);
    }

    // Le chapitre doit appartenir à la matière demandée.
    const chapter = await prisma.chapter.findUnique({ where: { id: chapterId } });
    if (!chapter || chapter.deletedAt || chapter.subjectId !== subjectId) {
      throw new HttpError(404, "chapter_not_found", "Chapitre introuvable dans cette matière");
    }
    assertChapterUnlocked(chapter);
    const available = await prisma.question.findMany({ where: { chapterId, deletedAt: null }, select: { id: true } });
    if (available.length === 0) throw new HttpError(422, "chapter_empty", "Ce chapitre ne contient aucune question");

    const picked = shuffle(available.map((q) => q.id)).slice(0, settings.soloQuestions);
    const cfg: GameConfig = {
      timePerQuestionSec: settings.timePerQuestionSec,
      xpPerCorrect: settings.xpPerCorrect,
      levelBase: settings.levelBase,
      levelExponent: settings.levelExponent,
      totalQuestions: picked.length,
      startXp: membership.xp,
      shuffleChoices: settings.shuffleChoices,
    };

    const game = await prisma.$transaction(async (tx) => {
      const g = await tx.game.create({ data: { subjectId, mode: "SOLO", status: "IN_PROGRESS", config: JSON.stringify(cfg) } });
      await tx.gamePlayer.create({ data: { gameId: g.id, userId: ctx.user.id } });
      const round = await tx.round.create({ data: { gameId: g.id, number: 1, chapterId } });
      await tx.gameQuestion.createMany({
        data: picked.map((questionId, i) => ({ gameId: g.id, roundId: round.id, position: i + 1, questionId })),
      });
      return g;
    });

    const current = await currentQuestion(prisma, game.id, ctx.user.id, cfg, subjectId);
    return reply.status(201).send({
      resumed: false,
      game: { id: game.id, chapter: { id: chapter.id, name: chapter.name }, total: cfg.totalQuestions, timePerQuestionSec: cfg.timePerQuestionSec },
      ...current,
    });
  });

  // ── Question en cours (sert aussi à reprendre après un rechargement)
  app.get<{ Params: { id: string } }>("/api/solo/:id/current", async (req) => {
    const ctx = await auth(req);
    const game = await loadOwnGame(prisma, ctx.user.id, req.params.id);
    if (game.status !== "IN_PROGRESS") return { status: game.status };
    await requireMembership(prisma, ctx.user.id, game.subjectId, ctx.user.role);
    return currentQuestion(prisma, game.id, ctx.user.id, parseConfig(game.config), game.subjectId);
  });

  // ── Répondre à la question en cours (renvoie aussi la suivante : une seule requête par question)
  app.post<{ Params: { id: string } }>("/api/solo/:id/answer", async (req) => {
    const ctx = await auth(req);
    const body = AnswerBody.parse(req.body);
    const userId = ctx.user.id;
    if (!gameCache.get(req.params.id)?.players.has(userId)) {
      // Premier accès depuis le démarrage du serveur : on charge le contenu figé de la partie (vérifie aussi qu'elle t'appartient).
      const g0 = await loadOwnGame(prisma, userId, req.params.id);
      const rows = await prisma.gameQuestion.findMany({ where: { gameId: g0.id }, orderBy: { position: "asc" }, include: { question: true } });
      rememberGame(g0.id, g0.subjectId, parseConfig(g0.config), userId, rows);
    }
    const st = gameCache.get(req.params.id)!;
    const cfg = st.cfg;
    // État mutable : lectures simples indépendantes, en parallèle (un seul aller-retour vers la base).
    const [game, answers, served] = await Promise.all([
      prisma.game.findFirst({ where: { id: req.params.id, mode: "SOLO", players: { some: { userId } } }, select: { id: true, subjectId: true, status: true } }),
      prisma.answer.findMany({ where: { userId, gameQuestion: { gameId: req.params.id } }, select: { gameQuestionId: true } }),
      prisma.gameQuestion.findUnique({ where: { id: body.gameQuestionId }, select: { servedAt: true } }),
      requireMembership(prisma, userId, st.subjectId, ctx.user.role),
    ]);
    if (!game) throw new HttpError(404, "game_not_found", "Partie introuvable");
    if (game.status !== "IN_PROGRESS") throw new HttpError(409, "game_not_active", "Cette partie est terminée");
    const done = new Set(answers.map((a) => a.gameQuestionId));
    const all = st.qs;
    const target = all.find((g) => g.id === body.gameQuestionId);
    if (!target) throw new HttpError(404, "question_not_found", "Question introuvable dans cette partie");
    if (done.has(target.id)) throw new HttpError(409, "already_answered", "Tu as déjà répondu à cette question");
    if (all.find((g) => !done.has(g.id))?.id !== target.id) {
      throw new HttpError(409, "not_current", "Ce n'est pas la question en cours");
    }
    const servedAt = served?.servedAt;
    if (!servedAt) throw new HttpError(409, "not_served", "Cette question n'a pas encore été affichée");

    const limitMs = cfg.timePerQuestionSec * 1000;
    const nowMs = Date.now();
    const elapsed = nowMs - servedAt.getTime();
    const timedOut = limitMs > 0 && elapsed > limitMs + GRACE_MS;
    const choices = JSON.parse(target.question.choices) as string[];
    if (!timedOut && body.choiceIndex >= choices.length) {
      throw new HttpError(400, "invalid_choice", `choiceIndex doit être compris entre 0 et ${choices.length - 1}`);
    }
    const order = choiceOrder(target.id, userId, choices.length, cfg.shuffleChoices);
    const originalChoice = timedOut ? null : toOriginal(order, body.choiceIndex);
    const isCorrect = !timedOut && originalChoice === target.question.answerIndex;
    const idx = all.findIndex((g) => g.id === target.id);
    const isLast = idx === all.length - 1;
    const upcoming = isLast ? null : all[idx + 1];
    const membershipKey = { userId_subjectId: { userId, subjectId: game.subjectId } };
    const gained = isCorrect ? cfg.xpPerCorrect : 0;

    // La réponse est écrite en premier (la contrainte d'unicité est le garde-fou contre le double envoi) ;
    // le reste part ensuite en parallèle, sans transaction interactive (chaque BEGIN/COMMIT coûte un aller-retour).
    try {
      await prisma.answer.create({
        data: { gameQuestionId: target.id, userId, choiceIndex: originalChoice, isCorrect, timeMs: Math.min(elapsed, limitMs > 0 ? limitMs : elapsed) },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new HttpError(409, "already_answered", "Tu as déjà répondu à cette question");
      }
      throw e;
    }

    const [totalXp] = await Promise.all([
      isCorrect
        ? Promise.all([
            prisma.gamePlayer.update({
              where: { gameId_userId: { gameId: game.id, userId } },
              data: { correctCount: { increment: 1 }, xpEarned: { increment: cfg.xpPerCorrect } },
            }),
            prisma.xpEvent.create({ data: { userId, subjectId: game.subjectId, source: "CORRECT_ANSWER", amount: cfg.xpPerCorrect, gameId: game.id } }),
            prisma.membership.update({ where: membershipKey, data: { xp: { increment: cfg.xpPerCorrect } } }),
          ]).then(([, , m]) => m.xp)
        : prisma.membership.findUniqueOrThrow({ where: membershipKey }).then((m) => m.xp),
      isLast
        ? prisma.game.updateMany({ where: { id: game.id, status: "IN_PROGRESS" }, data: { status: "FINISHED", finishedAt: new Date() } })
        : null,
    ]);

    const before = levelOf(totalXp - gained, cfg);
    const after = levelOf(totalXp, cfg);
    const nextQuestion: QuestionView | null = upcoming
      ? {
          gameQuestionId: upcoming.id,
          position: upcoming.position,
          total: all.length,
          text: upcoming.question.text,
          choices: shownChoices(upcoming.id, userId, upcoming.question.choices, cfg),
          timeLimitSec: cfg.timePerQuestionSec,
          // Le chrono de la suivante démarre quand le joueur l'affiche : le client appelle GET /current à ce moment-là.
          remainingMs: limitMs > 0 ? limitMs : null,
        }
      : null;
    return {
      correct: isCorrect,
      timedOut,
      correctIndex: toDisplayed(order, target.question.answerIndex),
      explanation: target.question.explanation,
      xpGained: gained,
      totalXp,
      level: after,
      leveledUp: after.level > before.level,
      finished: isLast,
      next: nextQuestion,
      newBadges: isLast ? await newBadgesSafe(prisma, userId, timezone) : [],
    };
  });

  // ── Abandonner la partie en cours (compte dans les parties du jour ; l'XP déjà gagné reste acquis)
  app.post<{ Params: { id: string } }>("/api/solo/:id/abandon", async (req) => {
    const ctx = await auth(req);
    const game = await loadOwnGame(prisma, ctx.user.id, req.params.id);
    if (game.status !== "IN_PROGRESS") throw new HttpError(409, "game_not_active", "Cette partie est déjà terminée");
    await prisma.game.update({ where: { id: game.id }, data: { status: "ABANDONED", finishedAt: new Date() } });
    return { status: "ABANDONED" };
  });

  // ── Résultat et revue des questions (seulement une fois la partie terminée)
  app.get<{ Params: { id: string } }>("/api/solo/:id/result", async (req) => {
    const ctx = await auth(req);
    const game = await loadOwnGame(prisma, ctx.user.id, req.params.id);
    if (game.status === "IN_PROGRESS") throw new HttpError(409, "game_in_progress", "La partie n'est pas terminée");
    const cfg = parseConfig(game.config);

    const [player, membership, questions] = await Promise.all([
      prisma.gamePlayer.findUniqueOrThrow({ where: { gameId_userId: { gameId: game.id, userId: ctx.user.id } } }),
      prisma.membership.findUniqueOrThrow({ where: { userId_subjectId: { userId: ctx.user.id, subjectId: game.subjectId } } }),
      prisma.gameQuestion.findMany({
        where: { gameId: game.id },
        orderBy: { position: "asc" },
        include: { question: true, answers: { where: { userId: ctx.user.id } } },
      }),
    ]);

    const review = questions
      .filter((g) => g.answers.length > 0)
      .map((g) => {
        const a = g.answers[0];
        const raw = JSON.parse(g.question.choices) as string[];
        const order = choiceOrder(g.id, ctx.user.id, raw.length, cfg.shuffleChoices);
        return {
          position: g.position,
          text: g.question.text,
          choices: displayChoices(raw, order),
          yourChoice: toDisplayed(order, a.choiceIndex),
          correctIndex: toDisplayed(order, g.question.answerIndex),
          isCorrect: a.isCorrect,
          timedOut: a.choiceIndex === null,
          explanation: g.question.explanation,
        };
      });

    const levelAtStart = levelOf(cfg.startXp, cfg);
    const levelNow = levelOf(membership.xp, cfg);
    return {
      status: game.status,
      chapter: game.rounds[0]?.chapter ?? null,
      correct: player.correctCount,
      answered: review.length,
      total: cfg.totalQuestions,
      xpEarned: player.xpEarned,
      totalXp: membership.xp,
      level: levelNow,
      leveledUp: levelNow.level > levelAtStart.level,
      review,
    };
  });
}
