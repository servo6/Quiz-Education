import { choiceOrder, displayChoices, toDisplayed, toOriginal } from "../shuffle.ts";
import { randomInt, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { loadEffectiveSettings } from "../settingsStore.ts";
import { awardXp } from "../xpService.ts";
import { levelFromXp, type LevelInfo } from "../xp.ts";

/**
 * Moteur des duels ("parties amicales") : défi entre deux joueurs d'une même matière, 4 manches de 4 questions,
 * chapitre choisi avant chaque manche (au tour de rôle), XP de victoire / de match nul, reconnexion et forfait.
 *
 * L'état de la partie en cours vit en mémoire (un seul processus serveur) ; tout ce qui compte (parties, manches,
 * questions, réponses, XP) est écrit en base. La bonne réponse n'est révélée qu'une fois la question close.
 */

export interface Hub {
  emit(userId: string, event: string, payload: unknown): void;
  isOnline(userId: string): boolean;
}

export class DuelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DuelError";
  }
}

export interface Timings {
  /** Pause entre la correction d'une question et la suivante. */
  revealMs: number;
  /** Marge pour la latence réseau après la fin du temps d'une question. */
  graceMs: number;
  /** Durée de validité d'un défi. */
  challengeTtlMs: number;
  /** Remplace `chapterPickSec` (tests uniquement). */
  pickMs?: number;
}

export const DEFAULT_TIMINGS: Timings = { revealMs: 3000, graceMs: 1000, challengeTtlMs: 60_000 };

/** En duel, une question a toujours une limite (sinon un joueur pourrait bloquer l'autre) : 60 s si le réglage vaut 0. */

export interface EngineOptions {
  prisma: PrismaClient;
  hub: Hub;
  timings?: Partial<Timings>;
  logger?: { error: (...args: unknown[]) => void };
}

type Result = "WIN" | "DRAW" | "LOSS" | "FORFEIT";
type Phase = "PICKING" | "QUESTION" | "REVEAL" | "DONE";
type FinishReason = "completed" | "forfeit" | "abandoned" | "error";
type Timer = ReturnType<typeof setTimeout>;

interface DuelConfig {
  timePerQuestionSec: number;
  roundsPerDuel: number;
  questionsPerRound: number;
  xpPerCorrect: number;
  friendlyWinBonus: number;
  friendlyDrawBonus: number;
  levelBase: number;
  levelExponent: number;
  reconnectSec: number;
  chapterPickSec: number;
  shuffleChoices: boolean;
}

interface PlayerState {
  userId: string;
  username: string;
  avatar: unknown;
  startXp: number;
  totalXp: number;
  correct: number;
  /** XP gagnés avec les bonnes réponses (hors bonus de fin de partie). */
  xpEarned: number;
  connected: boolean;
  absenceTimer?: Timer;
}

interface QuestionState {
  gameQuestionId: string;
  position: number;
  text: string;
  choices: string[];
  answerIndex: number;
  /** Position d'origine de chaque choix affiché (même ordre pour les deux joueurs en duel direct). */
  order: number[];
  explanation: string | null;
  servedAt: number;
  deadline: number;
  answers: Map<string, { choiceIndex: number | null; correct: boolean; timeMs: number }>;
  closed: boolean;
  timer?: Timer;
}

interface ChapterOption {
  id: string;
  name: string;
  questionCount: number;
  color?: string;
}

interface Game {
  id: string;
  subjectId: string;
  cfg: DuelConfig;
  players: [PlayerState, PlayerState];
  phase: Phase;
  round: number;
  used: Set<string>;
  roundQuestions: QuestionState[];
  qIndex: number;
  current: QuestionState | null;
  questionsClosed: number;
  positionCounter: number;
  pick: { picker: string; chapters: ChapterOption[]; deadline: number } | null;
  pickTimer?: Timer;
  revealTimer?: Timer;
  lastReveal: Map<string, unknown>;
  lock: Mutex;
}

interface Challenge {
  id: string;
  subjectId: string;
  from: string;
  to: string;
  expiresAt: number;
  timer: Timer;
}

/** Exécute les opérations d'une partie l'une après l'autre (deux réponses simultanées, un timer, une déconnexion...). */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export class DuelEngine {
  private readonly prisma: PrismaClient;
  private readonly hub: Hub;
  private readonly timings: Timings;
  private readonly logger: { error: (...args: unknown[]) => void };

  private readonly games = new Map<string, Game>();
  private readonly gameByUser = new Map<string, string>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly challengeByUser = new Map<string, string>();

  constructor(opts: EngineOptions) {
    this.prisma = opts.prisma;
    this.hub = opts.hub;
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.logger = opts.logger ?? { error: (...a) => console.error(...a) };
  }

  // ───────────── Consultation ─────────────

  isBusy(userId: string): boolean {
    return this.gameByUser.has(userId) || this.challengeByUser.has(userId);
  }

  hasGame(userId: string): boolean {
    return this.gameByUser.has(userId);
  }

  /** Parties abandonnées au redémarrage : l'état en mémoire est perdu, les parties en cours ne peuvent pas reprendre. */
  async recoverOrphans(): Promise<number> {
    const r = await this.prisma.game.updateMany({
      where: { mode: "FRIENDLY", status: { in: ["IN_PROGRESS", "WAITING"] } },
      data: { status: "ABANDONED", finishedAt: new Date() },
    });
    return r.count;
  }

  shutdown(): void {
    for (const c of this.challenges.values()) clearTimeout(c.timer);
    for (const g of this.games.values()) this.clearGameTimers(g);
    this.challenges.clear();
    this.challengeByUser.clear();
    this.games.clear();
    this.gameByUser.clear();
  }

  // ───────────── Défis ─────────────

  async createChallenge(fromId: string, subjectId: string, toId: string): Promise<{ challengeId: string; expiresAt: number }> {
    if (fromId === toId) throw new DuelError("self_challenge", "Tu ne peux pas te défier toi-même");
    if (this.gameByUser.has(fromId)) throw new DuelError("already_in_duel", "Tu es déjà en duel");
    if (this.challengeByUser.has(fromId)) throw new DuelError("challenge_pending", "Tu as déjà un défi en cours");
    if (this.gameByUser.has(toId) || this.challengeByUser.has(toId)) throw new DuelError("opponent_busy", "Ce joueur est occupé");
    if (!this.hub.isOnline(toId)) throw new DuelError("opponent_offline", "Ce joueur n'est pas connecté");

    const members = await this.prisma.membership.findMany({
      where: { subjectId, userId: { in: [fromId, toId] }, revokedAt: null, user: { bannedAt: null, role: { not: "ADMIN" } } },
      include: { user: { select: { id: true, username: true, avatar: true } } },
    });
    const me = members.find((m) => m.userId === fromId);
    const opp = members.find((m) => m.userId === toId);
    if (!me) throw new DuelError("not_a_member", "Tu n'as pas accès à cette matière");
    if (!opp) throw new DuelError("not_same_subject", "Ce joueur n'est pas dans la même matière que toi");
    if ((await this.playableChapters(subjectId)).length === 0) {
      throw new DuelError("no_questions", "Cette matière ne contient pas encore de questions");
    }

    // Plusieurs appels simultanés : on revérifie après les attentes en base.
    if (this.challengeByUser.has(fromId) || this.challengeByUser.has(toId) || this.gameByUser.has(fromId) || this.gameByUser.has(toId)) {
      throw new DuelError("opponent_busy", "Ce joueur est occupé");
    }

    const id = randomUUID();
    const expiresAt = Date.now() + this.timings.challengeTtlMs;
    const timer = setTimeout(() => this.expireChallenge(id), this.timings.challengeTtlMs);
    this.challenges.set(id, { id, subjectId, from: fromId, to: toId, expiresAt, timer });
    this.challengeByUser.set(fromId, id);
    this.challengeByUser.set(toId, id);

    this.hub.emit(toId, "duel:invited", {
      challengeId: id,
      subjectId,
      from: { id: me.user.id, username: me.user.username, avatar: safeJson(me.user.avatar) },
      expiresAt,
    });
    return { challengeId: id, expiresAt };
  }

  async respondChallenge(userId: string, challengeId: string, accept: boolean): Promise<{ gameId?: string }> {
    const c = this.challenges.get(challengeId);
    if (!c || c.to !== userId) throw new DuelError("challenge_not_found", "Défi introuvable ou expiré");
    this.dropChallenge(c);

    if (!accept) {
      this.hub.emit(c.from, "duel:challenge_declined", { challengeId, by: userId });
      return {};
    }
    if (!this.hub.isOnline(c.from)) throw new DuelError("opponent_offline", "Le joueur qui t'a défié s'est déconnecté");
    if (this.gameByUser.has(c.from) || this.gameByUser.has(c.to)) throw new DuelError("opponent_busy", "Un des joueurs est déjà en duel");

    const game = await this.startGame(c);
    return { gameId: game.id };
  }

  cancelChallenge(userId: string, challengeId: string): void {
    const c = this.challenges.get(challengeId);
    if (!c || c.from !== userId) throw new DuelError("challenge_not_found", "Défi introuvable ou expiré");
    this.dropChallenge(c);
    this.hub.emit(c.to, "duel:challenge_cancelled", { challengeId });
  }

  private expireChallenge(challengeId: string): void {
    const c = this.challenges.get(challengeId);
    if (!c) return;
    this.dropChallenge(c);
    this.hub.emit(c.from, "duel:challenge_expired", { challengeId });
    this.hub.emit(c.to, "duel:challenge_expired", { challengeId });
  }

  private dropChallenge(c: Challenge): void {
    clearTimeout(c.timer);
    this.challenges.delete(c.id);
    if (this.challengeByUser.get(c.from) === c.id) this.challengeByUser.delete(c.from);
    if (this.challengeByUser.get(c.to) === c.id) this.challengeByUser.delete(c.to);
  }

  // ───────────── Présence ─────────────

  /** À appeler quand un joueur passe de 0 à 1 connexion. Renvoie l'état de sa partie en cours s'il y en a une. */
  async onConnect(userId: string): Promise<void> {
    const game = this.gameOf(userId);
    if (!game) return;
    await game.lock.run(async () => {
      if (game.phase === "DONE") return;
      const me = this.playerOf(game, userId);
      me.connected = true;
      if (me.absenceTimer) clearTimeout(me.absenceTimer);
      me.absenceTimer = undefined;
      this.hub.emit(this.opponentOf(game, userId).userId, "duel:opponent_status", { gameId: game.id, connected: true });
      this.hub.emit(userId, "duel:state", this.snapshot(userId));
    });
  }

  /** À appeler quand un joueur n'a plus aucune connexion. */
  async onDisconnect(userId: string): Promise<void> {
    const pending = this.challengeByUser.get(userId);
    const c = pending ? this.challenges.get(pending) : undefined;
    if (c) {
      this.dropChallenge(c);
      if (c.from === userId) this.hub.emit(c.to, "duel:challenge_cancelled", { challengeId: c.id });
      else this.hub.emit(c.from, "duel:challenge_expired", { challengeId: c.id });
    }

    const game = this.gameOf(userId);
    if (!game) return;
    await game.lock.run(async () => {
      if (game.phase === "DONE") return;
      const me = this.playerOf(game, userId);
      me.connected = false;
      const graceMs = game.cfg.reconnectSec * 1000;
      this.hub.emit(this.opponentOf(game, userId).userId, "duel:opponent_status", { gameId: game.id, connected: false, graceMs });
      if (me.absenceTimer) clearTimeout(me.absenceTimer);
      me.absenceTimer = setTimeout(() => {
        game.lock.run(() => this.onAbsenceExpired(game, userId)).catch((e) => this.fail(game, e));
      }, graceMs);
      // L'autre joueur n'a plus à attendre un absent.
      if (game.phase === "QUESTION" && game.current && this.everyoneDone(game, game.current)) {
        await this.closeQuestion(game, game.current);
      }
    });
  }

  private async onAbsenceExpired(game: Game, userId: string): Promise<void> {
    if (game.phase === "DONE") return;
    const me = this.playerOf(game, userId);
    if (me.connected) return;
    const opp = this.opponentOf(game, userId);
    await this.finishGame(game, opp.connected ? "forfeit" : "abandoned", userId);
  }

  // ───────────── Actions de jeu ─────────────

  async pickChapter(userId: string, gameId: string, chapterId: string): Promise<void> {
    const game = this.mustGame(userId, gameId);
    return game.lock.run(async () => {
      if (game.phase !== "PICKING" || !game.pick) throw new DuelError("not_picking", "Ce n'est pas le moment de choisir un chapitre");
      if (game.pick.picker !== userId) throw new DuelError("not_your_turn", "Ce n'est pas à toi de choisir le chapitre");
      if (!game.pick.chapters.some((c) => c.id === chapterId)) throw new DuelError("invalid_chapter", "Chapitre non proposé");
      await this.beginRound(game, chapterId);
    });
  }

  async answer(userId: string, gameId: string, gameQuestionId: string, choiceIndex: number): Promise<void> {
    const game = this.mustGame(userId, gameId);
    return game.lock.run(async () => {
      const q = game.current;
      if (game.phase !== "QUESTION" || !q || q.gameQuestionId !== gameQuestionId) throw new DuelError("not_current", "Ce n'est pas la question en cours");
      if (q.answers.has(userId)) throw new DuelError("already_answered", "Tu as déjà répondu à cette question");
      const now = Date.now();
      if (q.deadline > 0 && now > q.deadline + this.timings.graceMs) throw new DuelError("too_late", "Temps écoulé");
      if (choiceIndex >= q.choices.length) throw new DuelError("invalid_choice", `choiceIndex doit être compris entre 0 et ${q.choices.length - 1}`);

      q.answers.set(userId, { choiceIndex, correct: choiceIndex === q.answerIndex, timeMs: q.deadline > 0 ? Math.min(now - q.servedAt, q.deadline - q.servedAt) : now - q.servedAt });
      this.hub.emit(this.opponentOf(game, userId).userId, "duel:opponent_answered", { gameId: game.id, gameQuestionId });
      if (this.everyoneDone(game, q)) await this.closeQuestion(game, q);
    });
  }

  forfeit(userId: string, gameId: string): Promise<void> {
    const game = this.mustGame(userId, gameId);
    return game.lock.run(async () => {
      if (game.phase === "DONE") return;
      await this.finishGame(game, "forfeit", userId);
    });
  }

  /** État de la partie en cours, pour reprendre après une déconnexion ou un rechargement de page. */
  snapshot(userId: string): unknown {
    const game = this.gameOf(userId);
    if (!game) return null;
    const me = this.playerOf(game, userId);
    const opp = this.opponentOf(game, userId);
    const base = {
      gameId: game.id,
      subjectId: game.subjectId,
      phase: game.phase,
      round: game.round,
      rounds: game.cfg.roundsPerDuel,
      you: { id: me.userId, username: me.username, avatar: me.avatar, level: this.level(game, me.totalXp).level },
      opponent: { id: opp.userId, username: opp.username, avatar: opp.avatar, connected: opp.connected, level: this.level(game, opp.totalXp).level },
      scores: { you: me.correct, opponent: opp.correct },
    };
    if (game.phase === "PICKING" && game.pick) return { ...base, pick: game.pick };
    if (game.phase === "QUESTION" && game.current) {
      return { ...base, question: { ...this.questionPayload(game, game.current), answered: game.current.answers.has(userId) } };
    }
    if (game.phase === "REVEAL") return { ...base, reveal: game.lastReveal.get(userId) ?? null };
    return base;
  }

  // ───────────── Déroulement ─────────────

  private async startGame(c: Challenge): Promise<Game> {
    const subject = await this.prisma.subject.findUniqueOrThrow({ where: { id: c.subjectId } });
    const s = await loadEffectiveSettings(this.prisma, subject.settings);
    const cfg: DuelConfig = {
      // Les duels en direct ont leurs propres réglages, indépendants du solo et des duels différés.
      timePerQuestionSec: s.liveTimePerQuestionSec,
      roundsPerDuel: s.liveRoundsPerDuel,
      questionsPerRound: s.liveQuestionsPerRound,
      xpPerCorrect: s.xpPerCorrect,
      friendlyWinBonus: s.friendlyWinBonus,
      friendlyDrawBonus: s.friendlyDrawBonus,
      levelBase: s.levelBase,
      levelExponent: s.levelExponent,
      reconnectSec: s.reconnectSec,
      chapterPickSec: s.chapterPickSec,
      shuffleChoices: s.shuffleChoices,
    };

    const members = await this.prisma.membership.findMany({
      where: { subjectId: c.subjectId, userId: { in: [c.from, c.to] } },
      include: { user: { select: { username: true, avatar: true } } },
    });
    const build = (userId: string): PlayerState => {
      const m = members.find((x) => x.userId === userId);
      if (!m) throw new DuelError("not_a_member", "Joueur introuvable dans cette matière");
      return {
        userId,
        username: m.user.username,
        avatar: safeJson(m.user.avatar),
        startXp: m.xp,
        totalXp: m.xp,
        correct: 0,
        xpEarned: 0,
        connected: this.hub.isOnline(userId),
      };
    };
    const players: [PlayerState, PlayerState] = [build(c.from), build(c.to)];

    const row = await this.prisma.$transaction(async (tx) => {
      const g = await tx.game.create({
        data: { subjectId: c.subjectId, mode: "FRIENDLY", status: "IN_PROGRESS", config: JSON.stringify({ ...cfg, players: [c.from, c.to] }) },
      });
      await tx.gamePlayer.createMany({ data: players.map((p) => ({ gameId: g.id, userId: p.userId })) });
      return g;
    });

    const game: Game = {
      id: row.id,
      subjectId: c.subjectId,
      cfg,
      players,
      phase: "PICKING",
      round: 0,
      used: new Set(),
      roundQuestions: [],
      qIndex: 0,
      current: null,
      questionsClosed: 0,
      positionCounter: 0,
      pick: null,
      lastReveal: new Map(),
      lock: new Mutex(),
    };
    this.games.set(game.id, game);
    for (const p of players) this.gameByUser.set(p.userId, game.id);

    for (const p of players) {
      const opp = players[0] === p ? players[1] : players[0];
      this.hub.emit(p.userId, "duel:started", {
        gameId: game.id,
        subjectId: game.subjectId,
        rounds: cfg.roundsPerDuel,
        questionsPerRound: cfg.questionsPerRound,
        timePerQuestionSec: this.limitMs(game) / 1000,
        you: { id: p.userId, username: p.username, avatar: p.avatar, level: this.level(game, p.startXp).level },
        opponent: { id: opp.userId, username: opp.username, avatar: opp.avatar, level: this.level(game, opp.startXp).level },
      });
    }
    game.lock.run(() => this.beginPicking(game, 1)).catch((e) => this.fail(game, e));
    return game;
  }

  /** Chapitres proposés pour une manche : ceux de la matière qui contiennent au moins une question. */
  private async playableChapters(subjectId: string): Promise<ChapterOption[]> {
    const rows = await this.prisma.chapter.findMany({
      where: { subjectId, deletedAt: null, locked: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true, _count: { select: { questions: { where: { deletedAt: null } } } } },
    });
    return rows.filter((r) => r._count.questions > 0).map((r) => ({ id: r.id, name: r.name, color: r.color, questionCount: r._count.questions }));
  }

  private async beginPicking(game: Game, round: number): Promise<void> {
    if (game.phase === "DONE") return;
    const chapters = await this.playableChapters(game.subjectId);
    if (chapters.length === 0) {
      await this.finishGame(game, "abandoned");
      return;
    }
    game.round = round;
    game.phase = "PICKING";
    game.current = null;
    // Tour de rôle : le joueur qui a lancé le défi choisit les manches impaires, son adversaire les manches paires.
    const picker = game.players[(round - 1) % 2];
    const pickMs = this.timings.pickMs ?? game.cfg.chapterPickSec * 1000;
    game.pick = { picker: picker.userId, chapters, deadline: Date.now() + pickMs };
    for (const p of game.players) {
      this.hub.emit(p.userId, "duel:pick_chapter", { gameId: game.id, round, rounds: game.cfg.roundsPerDuel, ...game.pick });
    }
    game.pickTimer = setTimeout(() => {
      game.lock
        .run(async () => {
          if (game.phase !== "PICKING" || game.round !== round || !game.pick) return;
          const choice = shuffle(game.pick.chapters)[0];
          await this.beginRound(game, choice.id);
        })
        .catch((e) => this.fail(game, e));
    }, pickMs);
  }

  private async pickQuestionIds(game: Game, chapterId: string): Promise<string[]> {
    const need = game.cfg.questionsPerRound;
    const rows = await this.prisma.question.findMany({ where: { chapterId, deletedAt: null }, select: { id: true } });
    const fresh = shuffle(rows.filter((r) => !game.used.has(r.id)).map((r) => r.id)).slice(0, need);
    if (fresh.length >= need) return fresh;
    // Chapitre déjà bien utilisé dans cette partie : on complète avec des questions déjà posées plutôt que de raccourcir la manche.
    const again = shuffle(rows.filter((r) => game.used.has(r.id)).map((r) => r.id)).slice(0, need - fresh.length);
    return [...fresh, ...again];
  }

  private async beginRound(game: Game, chapterId: string): Promise<void> {
    if (game.pickTimer) clearTimeout(game.pickTimer);
    game.pickTimer = undefined;
    game.pick = null;

    let chosen = chapterId;
    let ids = await this.pickQuestionIds(game, chosen);
    if (ids.length === 0) {
      // Le chapitre a été vidé entre-temps : on en prend un autre.
      for (const c of shuffle(await this.playableChapters(game.subjectId))) {
        ids = await this.pickQuestionIds(game, c.id);
        if (ids.length > 0) {
          chosen = c.id;
          break;
        }
      }
    }
    if (ids.length === 0) {
      await this.finishGame(game, "abandoned");
      return;
    }

    const chapter = await this.prisma.chapter.findUniqueOrThrow({ where: { id: chosen }, select: { id: true, name: true } });
    const rows = await this.prisma.$transaction(async (tx) => {
      const round = await tx.round.create({ data: { gameId: game.id, number: game.round, chapterId: chosen } });
      await tx.gameQuestion.createMany({
        data: ids.map((questionId, i) => ({ gameId: game.id, roundId: round.id, position: game.positionCounter + i + 1, questionId })),
      });
      return tx.gameQuestion.findMany({ where: { roundId: round.id }, orderBy: { position: "asc" }, include: { question: true } });
    });

    game.positionCounter += rows.length;
    for (const id of ids) game.used.add(id);
    game.roundQuestions = rows.map((gq) => {
      const raw = JSON.parse(gq.question.choices) as string[];
      const order = choiceOrder(gq.id, game.id, raw.length, game.cfg.shuffleChoices);
      return {
        gameQuestionId: gq.id,
        position: gq.position,
        text: gq.question.text,
        choices: displayChoices(raw, order),
        answerIndex: toDisplayed(order, gq.question.answerIndex)!,
        order,
        explanation: gq.question.explanation,
        servedAt: 0,
        deadline: 0,
        answers: new Map(),
        closed: false,
      };
    });
    game.qIndex = 0;

    for (const p of game.players) {
      this.hub.emit(p.userId, "duel:round_started", { gameId: game.id, round: game.round, rounds: game.cfg.roundsPerDuel, chapter, totalQuestions: rows.length });
    }
    await this.serveQuestion(game);
  }

  private limitMs(game: Game): number {
    // 0 = temps illimité : pas de minuteur, la manche attend les réponses.
    return Math.max(0, game.cfg.timePerQuestionSec) * 1000;
  }

  private questionPayload(game: Game, q: QuestionState) {
    return {
      gameId: game.id,
      round: game.round,
      indexInRound: game.qIndex + 1,
      questionsInRound: game.roundQuestions.length,
      gameQuestionId: q.gameQuestionId,
      position: q.position,
      text: q.text,
      choices: q.choices,
      deadline: q.deadline,
      timeLimitSec: this.limitMs(game) / 1000,
    };
  }

  private async serveQuestion(game: Game): Promise<void> {
    const q = game.roundQuestions[game.qIndex];
    const now = Date.now();
    q.servedAt = now;
    q.deadline = this.limitMs(game) > 0 ? now + this.limitMs(game) : 0;
    game.current = q;
    game.phase = "QUESTION";
    await this.prisma.gameQuestion.update({ where: { id: q.gameQuestionId }, data: { servedAt: new Date(now) } });

    // Un joueur déjà absent ne retient pas l'autre.
    for (const p of game.players) this.hub.emit(p.userId, "duel:question", this.questionPayload(game, q));
    if (this.limitMs(game) > 0) {
      q.timer = setTimeout(() => {
        game.lock.run(() => this.closeQuestion(game, q)).catch((e) => this.fail(game, e));
      }, this.limitMs(game) + this.timings.graceMs);
    }
    if (this.everyoneDone(game, q)) await this.closeQuestion(game, q);
  }

  /** Tous les joueurs connectés ont répondu (un absent n'est pas attendu). */
  private everyoneDone(game: Game, q: QuestionState): boolean {
    // Si plus personne n'est connecté, on n'enchaîne pas : le délai de reconnexion décide (forfait ou abandon).
    if (!game.players.some((p) => p.connected)) return false;
    return game.players.every((p) => q.answers.has(p.userId) || !p.connected);
  }

  private async closeQuestion(game: Game, q: QuestionState): Promise<void> {
    if (q.closed || game.phase !== "QUESTION" || game.current !== q) return;
    q.closed = true;
    if (q.timer) clearTimeout(q.timer);
    const limit = this.limitMs(game);
    for (const p of game.players) {
      if (!q.answers.has(p.userId)) q.answers.set(p.userId, { choiceIndex: null, correct: false, timeMs: limit > 0 ? limit : Date.now() - q.servedAt });
    }

    // Écriture en base : réponses, bonnes réponses comptées, XP.
    const totals = await this.prisma.$transaction(async (tx) => {
      const out = new Map<string, number>();
      for (const p of game.players) {
        const a = q.answers.get(p.userId)!;
        await tx.answer.create({
          data: { gameQuestionId: q.gameQuestionId, userId: p.userId, choiceIndex: a.choiceIndex === null ? null : toOriginal(q.order, a.choiceIndex), isCorrect: a.correct, timeMs: a.timeMs },
        });
        if (a.correct) {
          await tx.gamePlayer.update({
            where: { gameId_userId: { gameId: game.id, userId: p.userId } },
            data: { correctCount: { increment: 1 }, xpEarned: { increment: game.cfg.xpPerCorrect } },
          });
          out.set(
            p.userId,
            await awardXp(tx, { userId: p.userId, subjectId: game.subjectId, source: "CORRECT_ANSWER", amount: game.cfg.xpPerCorrect, gameId: game.id }),
          );
        }
      }
      return out;
    });

    for (const p of game.players) {
      const a = q.answers.get(p.userId)!;
      if (a.correct) {
        p.correct += 1;
        p.xpEarned += game.cfg.xpPerCorrect;
        p.totalXp = totals.get(p.userId) ?? p.totalXp;
      }
    }
    game.questionsClosed += 1;
    game.phase = "REVEAL";

    for (const p of game.players) {
      const opp = this.opponentOf(game, p.userId);
      const mine = q.answers.get(p.userId)!;
      const theirs = q.answers.get(opp.userId)!;
      const payload = {
        gameId: game.id,
        gameQuestionId: q.gameQuestionId,
        correctIndex: q.answerIndex,
        explanation: q.explanation,
        you: { choiceIndex: mine.choiceIndex, correct: mine.correct, timedOut: mine.choiceIndex === null, xpGained: mine.correct ? game.cfg.xpPerCorrect : 0, totalXp: p.totalXp, level: this.level(game, p.totalXp) },
        opponent: { choiceIndex: theirs.choiceIndex, correct: theirs.correct, timedOut: theirs.choiceIndex === null },
        scores: { you: p.correct, opponent: opp.correct },
      };
      game.lastReveal.set(p.userId, payload);
      this.hub.emit(p.userId, "duel:reveal", payload);
    }

    game.revealTimer = setTimeout(() => {
      game.lock.run(() => this.advance(game, q)).catch((e) => this.fail(game, e));
    }, this.timings.revealMs);
  }

  private async advance(game: Game, closed: QuestionState): Promise<void> {
    if (game.phase !== "REVEAL" || game.current !== closed) return;
    game.revealTimer = undefined;
    if (game.qIndex + 1 < game.roundQuestions.length) {
      game.qIndex += 1;
      await this.serveQuestion(game);
    } else if (game.round < game.cfg.roundsPerDuel) {
      await this.beginPicking(game, game.round + 1);
    } else {
      await this.finishGame(game, "completed");
    }
  }

  private async finishGame(game: Game, requested: FinishReason, forfeiterId?: string): Promise<void> {
    if (game.phase === "DONE") return;
    game.phase = "DONE";
    this.clearGameTimers(game);

    // Un forfait avant la première question terminée ne donne rien : sinon deux comptes pourraient se faire gagner de l'XP.
    const reason: FinishReason = requested === "forfeit" && game.questionsClosed === 0 ? "abandoned" : requested;
    const [a, b] = game.players;
    const results = new Map<string, Result | null>([[a.userId, null], [b.userId, null]]);
    if (reason === "completed") {
      if (a.correct === b.correct) {
        results.set(a.userId, "DRAW");
        results.set(b.userId, "DRAW");
      } else {
        const winner = a.correct > b.correct ? a : b;
        results.set(winner.userId, "WIN");
        results.set(winner === a ? b.userId : a.userId, "LOSS");
      }
    } else if (reason === "forfeit" && forfeiterId) {
      for (const p of game.players) results.set(p.userId, p.userId === forfeiterId ? "FORFEIT" : "WIN");
    }

    const status = reason === "completed" || reason === "forfeit" ? "FINISHED" : "ABANDONED";
    let outcome = new Map<string, { bonus: number; totalXp: number }>();
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        const out = new Map<string, { bonus: number; totalXp: number }>();
        for (const p of game.players) {
          const r = results.get(p.userId) ?? null;
          const bonus = r === "WIN" ? game.cfg.friendlyWinBonus : r === "DRAW" ? game.cfg.friendlyDrawBonus : 0;
          let total = p.totalXp;
          if (bonus > 0) {
            total = await awardXp(tx, { userId: p.userId, subjectId: game.subjectId, source: r === "WIN" ? "FRIENDLY_WIN" : "FRIENDLY_DRAW", amount: bonus, gameId: game.id });
          }
          await tx.gamePlayer.update({ where: { gameId_userId: { gameId: game.id, userId: p.userId } }, data: { result: r, xpEarned: { increment: bonus } } });
          out.set(p.userId, { bonus, totalXp: total });
        }
        await tx.game.update({ where: { id: game.id }, data: { status, finishedAt: new Date() } });
        return out;
      });
    } catch (e) {
      this.logger.error(e);
    }

    for (const p of game.players) {
      const opp = this.opponentOf(game, p.userId);
      const o = outcome.get(p.userId) ?? { bonus: 0, totalXp: p.totalXp };
      this.hub.emit(p.userId, "duel:finished", {
        gameId: game.id,
        reason,
        result: results.get(p.userId) ?? null,
        you: {
          correct: p.correct,
          xpFromAnswers: p.xpEarned,
          bonus: o.bonus,
          totalXp: o.totalXp,
          level: this.level(game, o.totalXp),
          leveledUp: this.level(game, o.totalXp).level > this.level(game, p.startXp).level,
        },
        opponent: { username: opp.username, correct: opp.correct },
        totalQuestions: game.positionCounter,
      });
    }

    this.games.delete(game.id);
    for (const p of game.players) if (this.gameByUser.get(p.userId) === game.id) this.gameByUser.delete(p.userId);
  }

  /** Erreur inattendue en cours de partie : on la ferme proprement, sans bonus, plutôt que de la laisser bloquée. */
  private fail(game: Game, error: unknown): void {
    this.logger.error(error);
    game.lock.run(() => this.finishGame(game, "error")).catch((e) => this.logger.error(e));
  }

  // ───────────── Utilitaires ─────────────

  private level(game: Game, xp: number): LevelInfo {
    return levelFromXp(xp, { base: game.cfg.levelBase, exponent: game.cfg.levelExponent });
  }

  private clearGameTimers(game: Game): void {
    if (game.pickTimer) clearTimeout(game.pickTimer);
    if (game.revealTimer) clearTimeout(game.revealTimer);
    if (game.current?.timer) clearTimeout(game.current.timer);
    for (const p of game.players) if (p.absenceTimer) clearTimeout(p.absenceTimer);
  }

  private gameOf(userId: string): Game | undefined {
    const id = this.gameByUser.get(userId);
    return id ? this.games.get(id) : undefined;
  }

  private mustGame(userId: string, gameId: string): Game {
    const game = this.games.get(gameId);
    if (!game || !game.players.some((p) => p.userId === userId)) throw new DuelError("no_game", "Partie introuvable");
    return game;
  }

  private playerOf(game: Game, userId: string): PlayerState {
    return game.players[0].userId === userId ? game.players[0] : game.players[1];
  }

  private opponentOf(game: Game, userId: string): PlayerState {
    return game.players[0].userId === userId ? game.players[1] : game.players[0];
  }
}
