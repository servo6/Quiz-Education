import { randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assertChapterUnlocked, requireMembership } from "../access.ts";
import type { Deps } from "../auth.ts";
import type { Hub } from "../duel/engine.ts";
import { HttpError } from "../http.ts";
import { loadEffectiveSettings } from "../settingsStore.ts";
import { newBadgesSafe } from "../badges.ts";
import { choiceOrder, displayChoices, toDisplayed, toOriginal } from "../shuffle.ts";
import { awardXp } from "../xpService.ts";
import { levelFromXp } from "../xp.ts";

/**
 * Duel différé (mode "DUEL") : chacun joue quand il veut, à tour de rôle.
 *
 *   A : manche 1                 (A choisit le chapitre en lançant le défi)
 *   B : manche 1, puis manche 2  (B choisit le chapitre de la manche 2)
 *   A : manche 2, puis manche 3  (A choisit le chapitre de la manche 3)
 *   B : manche 3, puis manche 4  (B choisit le chapitre de la manche 4)
 *   A : manche 4                 → fin
 *
 * La manche r est ouverte (chapitre + questions) par le challenger si r est impair, par l'adversaire sinon.
 * L'autre joueur la joue une fois que l'ouvreur l'a terminée. Si la partie n'est pas finie au bout de
 * `duelDeadlineDays` jours, elle est clôturée : le plus de bonnes réponses gagne, égalité = match nul.
 * Tout est en base : rien en mémoire, le serveur peut redémarrer à tout moment.
 */

const GRACE_MS = 1500;
const DAY_MS = 86_400_000;

const CfgSchema = z.object({
  challengerId: z.string(),
  opponentId: z.string(),
  rounds: z.number(),
  questionsPerRound: z.number(),
  timePerQuestionSec: z.number(),
  xpPerCorrect: z.number(),
  winBonus: z.number(),
  drawBonus: z.number(),
  levelBase: z.number(),
  levelExponent: z.number(),
  deadlineAt: z.string(),
  shuffleChoices: z.boolean().default(false),
});
type Cfg = z.infer<typeof CfgSchema>;

const CreateBody = z.object({ subjectId: z.string().min(1), opponentId: z.string().min(1), chapterId: z.string().min(1) });
const PickBody = z.object({ chapterId: z.string().min(1) });
const AnswerBody = z.object({ gameQuestionId: z.string().min(1), choiceIndex: z.number().int().min(0) });

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const parseCfg = (json: string): Cfg => CfgSchema.parse(JSON.parse(json));
const openerOf = (cfg: Cfg, round: number) => (round % 2 === 1 ? cfg.challengerId : cfg.opponentId);
const otherOf = (cfg: Cfg, userId: string) => (userId === cfg.challengerId ? cfg.opponentId : cfg.challengerId);

// ───────────── Chargement et état ─────────────

const gameInclude = {
  players: { include: { user: { select: { id: true, username: true, avatar: true } } } },
  rounds: {
    orderBy: { number: "asc" as const },
    include: {
      chapter: { select: { id: true, name: true } },
      questions: { orderBy: { position: "asc" as const }, include: { question: true, answers: true } },
    },
  },
} satisfies Prisma.GameInclude;
type FullGame = Prisma.GameGetPayload<{ include: typeof gameInclude }>;
type FullRound = FullGame["rounds"][number];

async function loadGame(prisma: PrismaClient, userId: string, gameId: string): Promise<FullGame> {
  const game = await prisma.game.findFirst({ where: { id: gameId, mode: "DUEL", players: { some: { userId } } }, include: gameInclude });
  if (!game) throw new HttpError(404, "duel_not_found", "Duel introuvable");
  return game;
}

const answersOf = (r: FullRound, userId: string) => r.questions.map((q) => q.answers.find((a) => a.userId === userId));
const isComplete = (r: FullRound | undefined, userId: string) => !!r && r.questions.length > 0 && answersOf(r, userId).every((a) => !!a);
const correctIn = (r: FullRound, userId: string) => answersOf(r, userId).filter((a) => a?.isCorrect).length;
const totalCorrect = (g: FullGame, userId: string) => g.rounds.reduce((n, r) => n + correctIn(r, userId), 0);
const totalAnswered = (g: FullGame, userId: string) => g.rounds.reduce((n, r) => n + answersOf(r, userId).filter(Boolean).length, 0);

type Next =
  | { action: "play"; round: number }
  | { action: "pick"; round: number }
  | { action: "wait"; round: number; reason: "opponent_round" | "opponent_pick" }
  | { action: "done" };

/** Ce que `userId` doit faire ensuite. */
function nextFor(game: FullGame, cfg: Cfg, userId: string): Next {
  for (let r = 1; r <= cfg.rounds; r++) {
    const round = game.rounds.find((x) => x.number === r);
    if (round && isComplete(round, userId)) continue;
    const opener = openerOf(cfg, r);
    if (!round) return opener === userId ? { action: "pick", round: r } : { action: "wait", round: r, reason: "opponent_pick" };
    if (opener !== userId && !isComplete(round, opener)) return { action: "wait", round: r, reason: "opponent_round" };
    return { action: "play", round: r };
  }
  return { action: "done" };
}

const bothDone = (game: FullGame, cfg: Cfg) => nextFor(game, cfg, cfg.challengerId).action === "done" && nextFor(game, cfg, cfg.opponentId).action === "done";

// ───────────── Clôture ─────────────

type FinishReason = "completed" | "expired" | "forfeit";

/**
 * Termine un duel (une seule fois, même en cas d'appels simultanés) et attribue les bonus.
 * Plus de bonnes réponses = victoire ; égalité = nul ; abandon = victoire de l'adversaire.
 * Si personne n'a répondu à rien, la partie est abandonnée sans bonus.
 */
export async function finishDuel(prisma: PrismaClient, gameId: string, reason: FinishReason, forfeitedBy?: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const game = await tx.game.findUnique({ where: { id: gameId }, include: gameInclude });
    if (!game || game.mode !== "DUEL" || game.status !== "IN_PROGRESS") return false;
    const claimed = await tx.game.updateMany({ where: { id: gameId, status: "IN_PROGRESS" }, data: { status: "FINISHED", finishedAt: new Date() } });
    if (claimed.count === 0) return false;

    const cfg = parseCfg(game.config);
    const ids = [cfg.challengerId, cfg.opponentId];
    const score = Object.fromEntries(ids.map((id) => [id, totalCorrect(game, id)]));
    const answered = ids.reduce((n, id) => n + totalAnswered(game, id), 0);

    if (answered === 0) {
      await tx.game.update({ where: { id: gameId }, data: { status: "ABANDONED" } });
      return true;
    }

    const result: Record<string, "WIN" | "DRAW" | "LOSS" | "FORFEIT"> = {};
    if (reason === "forfeit" && forfeitedBy) {
      for (const id of ids) result[id] = id === forfeitedBy ? "FORFEIT" : "WIN";
    } else if (score[ids[0]] === score[ids[1]]) {
      for (const id of ids) result[id] = "DRAW";
    } else {
      const winner = score[ids[0]] > score[ids[1]] ? ids[0] : ids[1];
      for (const id of ids) result[id] = id === winner ? "WIN" : "LOSS";
    }

    for (const id of ids) {
      const bonus = result[id] === "WIN" ? cfg.winBonus : result[id] === "DRAW" ? cfg.drawBonus : 0;
      if (bonus > 0) {
        await awardXp(tx, { userId: id, subjectId: game.subjectId, source: result[id] === "WIN" ? "FRIENDLY_WIN" : "FRIENDLY_DRAW", amount: bonus, gameId });
      }
      await tx.gamePlayer.update({
        where: { gameId_userId: { gameId, userId: id } },
        data: { result: result[id], correctCount: score[id], xpEarned: score[id] * cfg.xpPerCorrect + bonus },
      });
    }
    return true;
  });
}

/** Clôture les duels dont le délai est dépassé. Appelée au démarrage, toutes les 5 minutes, et avant chaque lecture. */
export async function expireDueDuels(prisma: PrismaClient, now = new Date(), onFinished?: (gameId: string) => void | Promise<void>): Promise<number> {
  const open = await prisma.game.findMany({ where: { mode: "DUEL", status: "IN_PROGRESS" }, select: { id: true, config: true } });
  let n = 0;
  for (const g of open) {
    let due = false;
    try {
      due = new Date(parseCfg(g.config).deadlineAt).getTime() <= now.getTime();
    } catch {
      continue;
    }
    if (due && (await finishDuel(prisma, g.id, "expired"))) {
      n++;
      await onFinished?.(g.id);
    }
  }
  return n;
}

async function expireIfDue(prisma: PrismaClient, game: FullGame): Promise<boolean> {
  const cfg = parseCfg(game.config);
  if (game.status === "IN_PROGRESS" && new Date(cfg.deadlineAt).getTime() <= Date.now()) return finishDuel(prisma, game.id, "expired");
  return false;
}

// ───────────── Vues ─────────────

function summary(game: FullGame, userId: string) {
  const cfg = parseCfg(game.config);
  const oppId = otherOf(cfg, userId);
  const opp = game.players.find((p) => p.userId === oppId)!;
  const me = game.players.find((p) => p.userId === userId)!;
  const next = game.status === "IN_PROGRESS" ? nextFor(game, cfg, userId) : ({ action: "done" } as Next);
  return {
    id: game.id,
    subjectId: game.subjectId,
    status: game.status,
    opponent: { id: oppId, username: opp.user.username },
    challenger: cfg.challengerId === userId,
    deadlineAt: cfg.deadlineAt,
    rounds: cfg.rounds,
    questionsPerRound: cfg.questionsPerRound,
    next,
    yourTurn: next.action === "play" || next.action === "pick",
    score: { you: totalCorrect(game, userId), opponent: game.status === "IN_PROGRESS" ? null : totalCorrect(game, oppId) },
    result: me.result,
    createdAt: game.createdAt,
    finishedAt: game.finishedAt,
  };
}

type QuestionView = { gameQuestionId: string; round: number; position: number; total: number; text: string; choices: string[]; timeLimitSec: number; remainingMs: number | null };
type Current = { status: "ROUND_DONE" } | { status: "IN_PROGRESS"; question: QuestionView };

/**
 * Question en cours pour `userId` dans la manche `roundNumber`. Le chrono démarre à la première consultation et ne
 * repart jamais à zéro ; une question dont le temps est dépassé est comptée fausse. Ne révèle pas la bonne réponse.
 */
async function currentQuestion(prisma: PrismaClient, gameId: string, roundNumber: number, userId: string, cfg: Cfg): Promise<Current> {
  const limitMs = cfg.timePerQuestionSec * 1000;
  for (let guard = 0; guard <= cfg.questionsPerRound + 1; guard++) {
    const round = await prisma.round.findUniqueOrThrow({
      where: { gameId_number: { gameId, number: roundNumber } },
      include: { questions: { orderBy: { position: "asc" }, include: { question: true, answers: { where: { userId }, select: { id: true } } } } },
    });
    const next = round.questions.find((q) => q.answers.length === 0);
    if (!next) return { status: "ROUND_DONE" };

    const servedAt = await servedAtFor(prisma, next.id, userId);
    const elapsed = Date.now() - servedAt.getTime();
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
        round: roundNumber,
        position: next.position,
        total: round.questions.length,
        text: next.question.text,
        choices: displayChoices(JSON.parse(next.question.choices) as string[], choiceOrder(next.id, userId, (JSON.parse(next.question.choices) as string[]).length, cfg.shuffleChoices)),
        timeLimitSec: cfg.timePerQuestionSec,
        remainingMs: limitMs > 0 ? Math.max(0, limitMs - elapsed) : null,
      },
    };
  }
  throw new Error("currentQuestion : boucle inattendue");
}

/** Début du chronomètre d'un joueur sur une question : posé à la première consultation, jamais modifié ensuite. */
async function servedAtFor(prisma: PrismaClient, gameQuestionId: string, userId: string): Promise<Date> {
  await prisma.questionServe.createMany({ data: [{ gameQuestionId, userId }], skipDuplicates: true });
  return (await prisma.questionServe.findUniqueOrThrow({ where: { gameQuestionId_userId: { gameQuestionId, userId } } })).servedAt;
}

async function pickQuestionIds(prisma: PrismaClient, game: FullGame, chapterId: string, need: number): Promise<string[]> {
  const rows = await prisma.question.findMany({ where: { chapterId, deletedAt: null }, select: { id: true } });
  const used = new Set(game.rounds.flatMap((r) => r.questions.map((q) => q.questionId)));
  const fresh = shuffle(rows.filter((r) => !used.has(r.id)).map((r) => r.id)).slice(0, need);
  if (fresh.length >= need) return fresh;
  // Chapitre déjà bien utilisé : on complète avec des questions déjà posées plutôt que de raccourcir la manche.
  const again = shuffle(rows.filter((r) => used.has(r.id)).map((r) => r.id)).slice(0, need - fresh.length);
  return [...fresh, ...again];
}

/** Crée la manche `number` : même chapitre et mêmes questions pour les deux joueurs. */
async function openRound(prisma: PrismaClient, game: FullGame, cfg: Cfg, number: number, chapterId: string): Promise<void> {
  const chapter = await prisma.chapter.findUnique({ where: { id: chapterId } });
  if (!chapter || chapter.deletedAt || chapter.subjectId !== game.subjectId) throw new HttpError(404, "chapter_not_found", "Chapitre introuvable dans cette matière");
  assertChapterUnlocked(chapter);
  const ids = await pickQuestionIds(prisma, game, chapterId, cfg.questionsPerRound);
  if (ids.length === 0) throw new HttpError(422, "chapter_empty", "Ce chapitre ne contient aucune question");
  // Une seule requête atomique (manche + questions) : pas de manche à moitié créée, pas de transaction longue.
  const base = game.rounds.reduce((n, r) => n + r.questions.length, 0);
  try {
    await prisma.round.create({
      data: { gameId: game.id, number, chapterId, questions: { create: ids.map((questionId, i) => ({ gameId: game.id, position: base + i + 1, questionId })) } },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Double clic ou requête rejouée : la manche existe déjà, on continue avec elle.
      const exists = await prisma.round.findUnique({ where: { gameId_number: { gameId: game.id, number } }, include: { questions: true } });
      if (exists && exists.questions.length > 0) return;
      throw new HttpError(409, "round_exists", "Cette manche est déjà ouverte");
    }
    throw e;
  }
}

async function chaptersOf(prisma: PrismaClient, subjectId: string) {
  const rows = await prisma.chapter.findMany({
    where: { subjectId, deletedAt: null, locked: false },
    orderBy: { name: "asc" },
    select: { id: true, name: true, color: true, _count: { select: { questions: { where: { deletedAt: null } } } } },
  });
  return rows.filter((r) => r._count.questions > 0).map((r) => ({ id: r.id, name: r.name, color: r.color, questionCount: r._count.questions }));
}

// ───────────── Routes ─────────────

/** Prévient les deux joueurs qu'un duel est terminé (connexion temps réel ; ignoré s'ils ne sont pas connectés). */
export async function notifyEnded(prisma: PrismaClient, hub: Pick<Hub, "emit">, gameId: string): Promise<void> {
  const g = await prisma.game.findUnique({ where: { id: gameId }, include: { players: true } });
  if (!g) return;
  for (const p of g.players) hub.emit(p.userId, "duel:ended", { duelId: g.id, subjectId: g.subjectId, status: g.status, result: p.result });
}

export function registerDuelAsyncRoutes(app: FastifyInstance, { prisma, auth, timezone }: Deps, hub: Pick<Hub, "emit">): void {
  /** Pousse "c'est à toi" à l'adversaire si c'est maintenant son tour (silencieux s'il n'est pas connecté). */
  function notifyTurn(game: FullGame, fromId: string): void {
    const cfg = parseCfg(game.config);
    const oppId = otherOf(cfg, fromId);
    const next = nextFor(game, cfg, oppId);
    if (next.action !== "play" && next.action !== "pick") return;
    const from = game.players.find((p) => p.userId === fromId)!.user;
    hub.emit(oppId, "duel:turn", { duelId: game.id, subjectId: game.subjectId, action: next.action, round: next.round, from, deadlineAt: cfg.deadlineAt });
  }

  /** Charge le duel, applique l'expiration éventuelle et vérifie l'accès à la matière. */
  async function load(userId: string, gameId: string): Promise<FullGame> {
    let game = await loadGame(prisma, userId, gameId);
    if (await expireIfDue(prisma, game)) {
      game = await loadGame(prisma, userId, gameId);
      await notifyEnded(prisma, hub, gameId);
    }
    await requireMembership(prisma, userId, game.subjectId);
    return game;
  }
  const mustBeActive = (g: FullGame) => {
    if (g.status !== "IN_PROGRESS") throw new HttpError(409, "duel_not_active", "Ce duel est terminé");
  };

  // ── Lancer un défi : la partie démarre tout de suite, le challenger choisit le chapitre de la manche 1
  async function createDuel(userId: string, subjectId: string, opponentId: string, chapterId: string): Promise<FullGame> {
    if (opponentId === userId) throw new HttpError(422, "self_challenge", "Tu ne peux pas te défier toi-même");
    await requireMembership(prisma, userId, subjectId);
    const opponent = await prisma.user.findUnique({ where: { id: opponentId } });
    const oppMember = await prisma.membership.findUnique({ where: { userId_subjectId: { userId: opponentId, subjectId } } });
    if (!opponent || opponent.bannedAt || opponent.role === "ADMIN" || !oppMember || oppMember.revokedAt) {
      throw new HttpError(422, "not_same_subject", "Cet utilisateur n'est pas membre de cette matière");
    }

    const subject = await prisma.subject.findUniqueOrThrow({ where: { id: subjectId } });
    const settings = await loadEffectiveSettings(prisma, subject.settings);

    // Un seul duel en cours entre deux mêmes joueurs dans une matière.
    const existing = await prisma.game.findFirst({
      where: { mode: "DUEL", subjectId, status: "IN_PROGRESS", AND: [{ players: { some: { userId } } }, { players: { some: { userId: opponentId } } }] },
    });
    if (existing) throw new HttpError(409, "duel_exists", "Un duel est déjà en cours avec ce joueur", { gameId: existing.id });

    // Plafond de duels simultanés (0 = illimité) : évite qu'un joueur en inonde un autre.
    if (settings.maxActiveDuels > 0) {
      const countFor = (uid: string) => prisma.game.count({ where: { mode: "DUEL", subjectId, status: "IN_PROGRESS", players: { some: { userId: uid } } } });
      if ((await countFor(userId)) >= settings.maxActiveDuels) {
        throw new HttpError(429, "too_many_duels", `Tu as déjà ${settings.maxActiveDuels} duels en cours dans cette matière`);
      }
      if ((await countFor(opponentId)) >= settings.maxActiveDuels) {
        throw new HttpError(409, "opponent_too_many_duels", "Cet adversaire a déjà trop de duels en cours");
      }
    }

    const chapter = await prisma.chapter.findUnique({ where: { id: chapterId } });
    if (!chapter || chapter.deletedAt || chapter.subjectId !== subjectId) throw new HttpError(404, "chapter_not_found", "Chapitre introuvable dans cette matière");
    assertChapterUnlocked(chapter);
    if ((await prisma.question.count({ where: { chapterId: chapter.id, deletedAt: null } })) === 0) throw new HttpError(422, "chapter_empty", "Ce chapitre ne contient aucune question");

    const cfg: Cfg = {
      challengerId: userId,
      opponentId,
      rounds: settings.roundsPerDuel,
      questionsPerRound: settings.questionsPerRound,
      timePerQuestionSec: settings.timePerQuestionSec,
      xpPerCorrect: settings.xpPerCorrect,
      winBonus: settings.friendlyWinBonus,
      drawBonus: settings.friendlyDrawBonus,
      levelBase: settings.levelBase,
      levelExponent: settings.levelExponent,
      deadlineAt: new Date(Date.now() + settings.duelDeadlineDays * DAY_MS).toISOString(),
      shuffleChoices: settings.shuffleChoices,
    };
    const game = await prisma.$transaction(async (tx) => {
      const g = await tx.game.create({ data: { subjectId, mode: "DUEL", status: "IN_PROGRESS", config: JSON.stringify(cfg) } });
      await tx.gamePlayer.createMany({ data: [{ gameId: g.id, userId }, { gameId: g.id, userId: opponentId }] });
      return g;
    });
    try {
      await openRound(prisma, await loadGame(prisma, userId, game.id), cfg, 1, chapter.id);
    } catch (e) {
      // Pas de duel orphelin sans première manche : on le supprime avant de remonter l'erreur.
      await prisma.game.delete({ where: { id: game.id } }).catch(() => undefined);
      throw e;
    }
    const full = await loadGame(prisma, userId, game.id);
    const me = full.players.find((p) => p.userId === userId)!.user;
    hub.emit(opponentId, "duel:challenged", { duelId: game.id, subjectId, from: me, deadlineAt: cfg.deadlineAt });
    return full;
  }

  app.post("/api/duels", async (req, reply) => {
    const ctx = await auth(req);
    const body = CreateBody.parse(req.body);
    const game = await createDuel(ctx.user.id, body.subjectId, body.opponentId, body.chapterId);
    return reply.status(201).send({ duel: summary(game, ctx.user.id) });
  });

  // ── Adversaire au hasard parmi les membres de la matière (hors ceux avec qui un duel est déjà en cours)
  app.post<{ Params: { id: string } }>("/api/subjects/:id/duels/random", async (req, reply) => {
    const ctx = await auth(req);
    const { chapterId } = PickBody.parse(req.body);
    await requireMembership(prisma, ctx.user.id, req.params.id);
    const busyWith = await prisma.gamePlayer.findMany({
      where: { game: { mode: "DUEL", subjectId: req.params.id, status: "IN_PROGRESS", players: { some: { userId: ctx.user.id } } }, userId: { not: ctx.user.id } },
      select: { userId: true },
    });
    const candidates = await prisma.membership.findMany({
      where: { subjectId: req.params.id, revokedAt: null, userId: { notIn: [ctx.user.id, ...busyWith.map((b) => b.userId)] }, user: { bannedAt: null, role: { not: "ADMIN" } } },
      select: { userId: true },
      take: 500,
    });
    if (candidates.length === 0) throw new HttpError(404, "no_opponent", "Aucun adversaire disponible dans cette matière pour le moment");
    // On essaie dans un ordre aléatoire jusqu'à en trouver un qui n'a pas atteint son plafond de duels.
    let lastError: unknown;
    for (const c of shuffle(candidates)) {
      try {
        const game = await createDuel(ctx.user.id, req.params.id, c.userId, chapterId);
        return reply.status(201).send({ duel: summary(game, ctx.user.id) });
      } catch (e) {
        if (e instanceof HttpError && ["opponent_too_many_duels", "duel_exists"].includes(e.code)) {
          lastError = e;
          continue;
        }
        throw e;
      }
    }
    throw lastError ?? new HttpError(404, "no_opponent", "Aucun adversaire disponible dans cette matière pour le moment");
  });

  // ── Revanche : même adversaire, nouveau duel (celui qui la demande devient le challenger)
  app.post<{ Params: { id: string } }>("/api/duels/:id/rematch", async (req, reply) => {
    const ctx = await auth(req);
    const { chapterId } = PickBody.parse(req.body);
    const old = await load(ctx.user.id, req.params.id);
    if (old.status === "IN_PROGRESS") throw new HttpError(409, "duel_not_finished", "La revanche n'est possible qu'après la fin du duel");
    const oppId = otherOf(parseCfg(old.config), ctx.user.id);
    const game = await createDuel(ctx.user.id, old.subjectId, oppId, chapterId);
    return reply.status(201).send({ duel: summary(game, ctx.user.id) });
  });

  // ── Ce qui m'attend, toutes matières confondues (pour une pastille "à ton tour" et les rappels avant expiration)
  app.get("/api/me/summary", async (req) => {
    const ctx = await auth(req);
    if (ctx.actor.role === "ADMIN") throw new HttpError(403, "admin_cannot_play", "Un administrateur ne joue pas : il gère la plateforme");
    await expireDueDuels(prisma, new Date(), (id) => notifyEnded(prisma, hub, id));
    const games = await prisma.game.findMany({
      where: { mode: "DUEL", status: "IN_PROGRESS", players: { some: { userId: ctx.user.id } }, subject: { memberships: { some: { userId: ctx.user.id, revokedAt: null } } } },
      include: { ...gameInclude, subject: { select: { id: true, name: true } } },
    });
    const now = Date.now();
    const duels = games
      .map((g) => {
        const sm = summary(g, ctx.user.id);
        const msLeft = new Date(sm.deadlineAt).getTime() - now;
        return { duelId: g.id, subject: g.subject, opponent: sm.opponent, action: sm.next.action, round: "round" in sm.next ? sm.next.round : null, yourTurn: sm.yourTurn, deadlineAt: sm.deadlineAt, hoursLeft: Math.max(0, Math.floor(msLeft / 3_600_000)), expiresSoon: msLeft < 24 * 3_600_000 };
      })
      .sort((a, b) => a.deadlineAt.localeCompare(b.deadlineAt));
    const solo = await prisma.game.findMany({ where: { mode: "SOLO", status: "IN_PROGRESS", players: { some: { userId: ctx.user.id } } }, select: { id: true, subjectId: true } });
    return {
      yourTurnCount: duels.filter((d) => d.yourTurn).length,
      expiringSoonCount: duels.filter((d) => d.yourTurn && d.expiresSoon).length,
      duels,
      soloInProgress: solo.map((g) => ({ gameId: g.id, subjectId: g.subjectId })),
    };
  });

  // ── Mes duels dans une matière
  app.get<{ Params: { id: string } }>("/api/subjects/:id/duels", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id);
    await expireDueDuels(prisma);
    const games = await prisma.game.findMany({
      where: { mode: "DUEL", subjectId: req.params.id, players: { some: { userId: ctx.user.id, hiddenAt: null } } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: gameInclude,
    });
    const duels = games.map((g) => summary(g, ctx.user.id));
    return { duels, yourTurnCount: duels.filter((d) => d.status === "IN_PROGRESS" && d.yourTurn).length };
  });

  // ── Détail d'un duel
  app.get<{ Params: { id: string } }>("/api/duels/:id", async (req) => {
    const ctx = await auth(req);
    const game = await load(ctx.user.id, req.params.id);
    const cfg = parseCfg(game.config);
    const oppId = otherOf(cfg, ctx.user.id);
    const rounds = game.rounds.map((r) => {
      const bothFinished = isComplete(r, ctx.user.id) && isComplete(r, oppId);
      return {
        number: r.number,
        chapter: r.chapter,
        openedBy: openerOf(cfg, r.number) === ctx.user.id ? "you" : "opponent",
        questions: r.questions.length,
        you: { answered: answersOf(r, ctx.user.id).filter(Boolean).length, correct: correctIn(r, ctx.user.id) },
        // Le score adverse d'une manche n'est révélé qu'une fois que les deux l'ont jouée (ou après la fin du duel).
        opponent: bothFinished || game.status !== "IN_PROGRESS" ? { correct: correctIn(r, oppId) } : null,
      };
    });
    const pick = nextFor(game, cfg, ctx.user.id);
    return {
      duel: summary(game, ctx.user.id),
      rounds,
      chapters: game.status === "IN_PROGRESS" && pick.action === "pick" ? await chaptersOf(prisma, game.subjectId) : undefined,
    };
  });

  // ── Choisir le chapitre de la manche dont on est l'ouvreur
  app.post<{ Params: { id: string } }>("/api/duels/:id/pick", async (req, reply) => {
    const ctx = await auth(req);
    const { chapterId } = PickBody.parse(req.body);
    const game = await load(ctx.user.id, req.params.id);
    mustBeActive(game);
    const cfg = parseCfg(game.config);
    const next = nextFor(game, cfg, ctx.user.id);
    if (next.action !== "pick") throw new HttpError(409, "not_your_turn", "Ce n'est pas à toi de choisir un chapitre");
    await openRound(prisma, game, cfg, next.round, chapterId);
    const current = await currentQuestion(prisma, game.id, next.round, ctx.user.id, cfg);
    return reply.status(201).send({ round: next.round, ...current });
  });

  // ── Question en cours (sert aussi à reprendre après un rechargement)
  app.get<{ Params: { id: string } }>("/api/duels/:id/current", async (req) => {
    const ctx = await auth(req);
    const game = await load(ctx.user.id, req.params.id);
    mustBeActive(game);
    const cfg = parseCfg(game.config);
    const next = nextFor(game, cfg, ctx.user.id);
    if (next.action !== "play") return { status: "NOTHING_TO_PLAY", next };
    const oppId = otherOf(cfg, ctx.user.id);
    const [current, members] = await Promise.all([
      currentQuestion(prisma, game.id, next.round, ctx.user.id, cfg),
      prisma.membership.findMany({ where: { subjectId: game.subjectId, userId: { in: [ctx.user.id, oppId] } }, select: { userId: true, xp: true } }),
    ]);
    const card = (uid: string) => {
      const p = game.players.find((x) => x.userId === uid)!;
      let avatar: unknown = null;
      try { avatar = p.user.avatar ? JSON.parse(p.user.avatar) : null; } catch { /* avatar illisible : ignoré */ }
      const xp = members.find((m) => m.userId === uid)?.xp ?? 0;
      return { id: uid, username: p.user.username, avatar, level: levelFromXp(xp, { base: cfg.levelBase, exponent: cfg.levelExponent }).level };
    };
    if (current.status === "IN_PROGRESS") return { ...current, versus: { you: card(ctx.user.id), opponent: card(oppId) } };
    if (current.status === "ROUND_DONE") return { status: "ROUND_DONE", next: nextFor(await loadGame(prisma, ctx.user.id, game.id), cfg, ctx.user.id) };
    return current;
  });

  // ── Répondre
  app.post<{ Params: { id: string } }>("/api/duels/:id/answer", async (req) => {
    const ctx = await auth(req);
    const body = AnswerBody.parse(req.body);
    // Lecture de la partie et du début de chrono en parallèle (un seul aller-retour).
    const [game, serveRow] = await Promise.all([
      load(ctx.user.id, req.params.id),
      prisma.questionServe.findUnique({ where: { gameQuestionId_userId: { gameQuestionId: body.gameQuestionId, userId: ctx.user.id } } }),
    ]);
    mustBeActive(game);
    const cfg = parseCfg(game.config);
    const next = nextFor(game, cfg, ctx.user.id);
    if (next.action !== "play") throw new HttpError(409, "not_your_turn", "Tu n'as rien à jouer pour le moment");

    const round = game.rounds.find((r) => r.number === next.round)!;
    const cur = round.questions.find((q) => !q.answers.some((a) => a.userId === ctx.user.id));
    const target = round.questions.find((q) => q.id === body.gameQuestionId);
    if (!target) throw new HttpError(404, "question_not_found", "Question introuvable dans ce duel");
    if (target.answers.some((a) => a.userId === ctx.user.id)) throw new HttpError(409, "already_answered", "Tu as déjà répondu à cette question");
    if (!cur || cur.id !== target.id) throw new HttpError(409, "not_current", "Ce n'est pas la question en cours");
    const serve = serveRow;
    if (!serve) throw new HttpError(409, "not_served", "Cette question n'a pas encore été affichée");

    const limitMs = cfg.timePerQuestionSec * 1000;
    const elapsed = Date.now() - serve.servedAt.getTime();
    const timedOut = limitMs > 0 && elapsed > limitMs + GRACE_MS;
    const choices = JSON.parse(target.question.choices) as string[];
    if (!timedOut && body.choiceIndex >= choices.length) throw new HttpError(400, "invalid_choice", `choiceIndex doit être compris entre 0 et ${choices.length - 1}`);
    const order = choiceOrder(target.id, ctx.user.id, choices.length, cfg.shuffleChoices);
    const originalChoice = timedOut ? null : toOriginal(order, body.choiceIndex);
    const isCorrect = !timedOut && originalChoice === target.question.answerIndex;

    // Réponse d'abord (l'unicité protège contre le double envoi), puis le reste en parallèle, sans transaction interactive.
    const membershipKey = { userId_subjectId: { userId: ctx.user.id, subjectId: game.subjectId } };
    let created;
    try {
      created = await prisma.answer.create({
        data: { gameQuestionId: target.id, userId: ctx.user.id, choiceIndex: originalChoice, isCorrect, timeMs: Math.min(elapsed, limitMs > 0 ? limitMs : elapsed) },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new HttpError(409, "already_answered", "Tu as déjà répondu à cette question");
      throw e;
    }
    const totalXp: number = await (isCorrect
      ? Promise.all([
          prisma.gamePlayer.update({
            where: { gameId_userId: { gameId: game.id, userId: ctx.user.id } },
            data: { correctCount: { increment: 1 }, xpEarned: { increment: cfg.xpPerCorrect } },
          }),
          prisma.xpEvent.create({ data: { userId: ctx.user.id, subjectId: game.subjectId, source: "CORRECT_ANSWER", amount: cfg.xpPerCorrect, gameId: game.id } }),
          prisma.membership.update({ where: membershipKey, data: { xp: { increment: cfg.xpPerCorrect } } }),
        ]).then(([, , m]) => m.xp)
      : prisma.membership.findUniqueOrThrow({ where: membershipKey }).then((m) => m.xp));

    // État après réponse, reconstitué en mémoire (pas de nouvelle lecture complète).
    target.answers.push(created as (typeof target.answers)[number]);
    const after = game;
    const roundDone = isComplete(after.rounds.find((r) => r.number === next.round), ctx.user.id);
    let finished = false;
    if (bothDone(after, cfg)) finished = await finishDuel(prisma, game.id, "completed");
    const finalGame = finished ? await loadGame(prisma, ctx.user.id, game.id) : after;
    if (finished) await notifyEnded(prisma, hub, game.id);
    else if (roundDone) notifyTurn(after, ctx.user.id);
    const upcoming = roundDone ? undefined : round.questions.find((q) => !q.answers.some((a) => a.userId === ctx.user.id));
    const nextQuestion: QuestionView | null = upcoming
      ? (() => {
          const raw = JSON.parse(upcoming.question.choices) as string[];
          return {
            gameQuestionId: upcoming.id,
            round: round.number,
            position: upcoming.position,
            total: round.questions.length,
            text: upcoming.question.text,
            choices: displayChoices(raw, choiceOrder(upcoming.id, ctx.user.id, raw.length, cfg.shuffleChoices)),
            timeLimitSec: cfg.timePerQuestionSec,
            remainingMs: limitMs > 0 ? limitMs : null, // le chrono démarre quand le client affiche la question (GET /current)
          };
        })()
      : null;
    const gained = isCorrect ? cfg.xpPerCorrect : 0;
    const lc = { base: cfg.levelBase, exponent: cfg.levelExponent };
    const lvlAfter = levelFromXp(totalXp, lc);
    return {
      correct: isCorrect,
      timedOut,
      correctIndex: toDisplayed(order, target.question.answerIndex),
      explanation: target.question.explanation,
      xpGained: gained,
      totalXp,
      level: lvlAfter,
      leveledUp: lvlAfter.level > levelFromXp(totalXp - gained, lc).level,
      roundDone,
      next: nextQuestion,
      newBadges: finished || roundDone ? await newBadgesSafe(prisma, ctx.user.id, timezone) : [],
      duel: summary(finalGame, ctx.user.id),
    };
  });

  // ── Abandonner : l'adversaire gagne
  app.post<{ Params: { id: string } }>("/api/duels/:id/forfeit", async (req) => {
    const ctx = await auth(req);
    const game = await load(ctx.user.id, req.params.id);
    mustBeActive(game);
    await finishDuel(prisma, game.id, "forfeit", ctx.user.id);
    await notifyEnded(prisma, hub, game.id);
    return { duel: summary(await loadGame(prisma, ctx.user.id, game.id), ctx.user.id) };
  });

  // ── Résultat et revue (seulement quand le duel est terminé)
  app.get<{ Params: { id: string } }>("/api/duels/:id/result", async (req) => {
    const ctx = await auth(req);
    const game = await load(ctx.user.id, req.params.id);
    if (game.status === "IN_PROGRESS") throw new HttpError(409, "duel_in_progress", "Le duel n'est pas terminé");
    const cfg = parseCfg(game.config);
    const oppId = otherOf(cfg, ctx.user.id);
    const me = game.players.find((p) => p.userId === ctx.user.id)!;
    const membership = await prisma.membership.findUniqueOrThrow({ where: { userId_subjectId: { userId: ctx.user.id, subjectId: game.subjectId } } });
    const review = game.rounds.flatMap((r) =>
      r.questions.map((q) => {
        const mine = q.answers.find((a) => a.userId === ctx.user.id);
        const theirs = q.answers.find((a) => a.userId === oppId);
        const raw = JSON.parse(q.question.choices) as string[];
        const order = choiceOrder(q.id, ctx.user.id, raw.length, cfg.shuffleChoices);
        return {
          round: r.number,
          chapter: r.chapter.name,
          text: q.question.text,
          choices: displayChoices(raw, order),
          correctIndex: toDisplayed(order, q.question.answerIndex),
          explanation: q.question.explanation,
          you: mine ? { choice: toDisplayed(order, mine.choiceIndex), correct: mine.isCorrect } : null,
          opponent: theirs ? { choice: toDisplayed(order, theirs.choiceIndex), correct: theirs.isCorrect } : null,
        };
      }),
    );
    return {
      duel: summary(game, ctx.user.id),
      result: me.result,
      xpEarned: me.xpEarned,
      totalXp: membership.xp,
      level: levelFromXp(membership.xp, { base: cfg.levelBase, exponent: cfg.levelExponent }),
      review,
    };
  });
}
