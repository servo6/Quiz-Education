import { randomInt } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { loadEffectiveSettings } from "../settingsStore.ts";
import { awardXp } from "../xpService.ts";
import { DuelError, type Hub } from "./engine.ts";

/**
 * Salons privés en direct : un joueur crée un salon (code à 5 caractères), 2 à 8 membres de la même matière le rejoignent,
 * puis l'hôte lance la partie. Tout le monde reçoit les mêmes questions en même temps ; le classement final se fait aux
 * points (100 par bonne réponse + jusqu'à 100 de bonus de rapidité). Le salon vit en mémoire et ne rapporte pas d'XP
 * (c'est une partie entre amis, pas un classement officiel).
 */

export const ROOM_MIN = 2;
export const ROOM_MAX = 8;
export const ROOM_SIZES = [5, 8, 10, 15] as const;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const IDLE_MS = 15 * 60_000;
/** Récompenses : au plus 5 parties par 24 h rapportent de l'XP et des pièces (contre le farm entre amis). */
export const REWARDED_PER_DAY = 5;
export const COINS_PARTICIPATION = 5;
export const COINS_WIN_BONUS = 10;

export interface RoomTimings { revealMs: number; graceMs: number }
const DEFAULT: RoomTimings = { revealMs: 4000, graceMs: 800 };

export interface Reward { xp: number; coins: number; capped: boolean }
interface Member { userId: string; username: string; avatar: unknown; score: number; correct: number; answered: boolean; pick: number | null; gained: number }
interface Q { id: string; text: string; choices: string[]; answerIndex: number; explanation: string | null }
type Phase = "LOBBY" | "QUESTION" | "REVEAL" | "DONE";

interface Room {
  code: string; subjectId: string; hostId: string; size: number; phase: Phase;
  members: Map<string, Member>; questions: Q[]; index: number; limitMs: number; startedAt: number; deadline: number;
  timer?: ReturnType<typeof setTimeout>; touched: number; xpPerCorrect?: number; rewards?: Map<string, Reward>; saving?: Promise<unknown>;
}

const safeJson = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export class RoomEngine {
  private readonly rooms = new Map<string, Room>();
  private readonly byUser = new Map<string, string>();
  private readonly t: RoomTimings;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(private readonly o: { prisma: PrismaClient; hub: Hub; timings?: Partial<RoomTimings>; logger?: { error: (...a: unknown[]) => void } }) {
    this.t = { ...DEFAULT, ...o.timings };
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  shutdown(): void {
    clearInterval(this.sweeper);
    for (const r of this.rooms.values()) if (r.timer) clearTimeout(r.timer);
    this.rooms.clear();
    this.byUser.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const r of [...this.rooms.values()]) if (now - r.touched > IDLE_MS) this.close(r, "Salon fermé pour inactivité");
  }

  private close(r: Room, reason?: string): void {
    if (r.timer) clearTimeout(r.timer);
    for (const id of r.members.keys()) { this.byUser.delete(id); if (reason) this.o.hub.emit(id, "room:closed", { reason }); }
    this.rooms.delete(r.code);
    r.saving = (r.saving ?? Promise.resolve()).then(() => this.o.prisma.roomSnapshot.deleteMany({ where: { code: r.code } })).catch((e) => this.o.logger?.error(e, "salon : suppression"));
  }

  /** Enregistre l'état du salon (écritures successives dans l'ordre) pour pouvoir le reprendre après un redémarrage. */
  private save(r: Room): void {
    if (!this.rooms.has(r.code)) return;
    const data = JSON.stringify({
      code: r.code, subjectId: r.subjectId, hostId: r.hostId, size: r.size, phase: r.phase, questions: r.questions, index: r.index, limitMs: r.limitMs,
      startedAt: r.startedAt, deadline: r.deadline, xpPerCorrect: r.xpPerCorrect ?? null, members: [...r.members.values()],
      rewards: r.rewards ? [...r.rewards.entries()] : null,
    });
    r.saving = (r.saving ?? Promise.resolve()).then(() => this.o.prisma.roomSnapshot.upsert({ where: { code: r.code }, create: { code: r.code, data }, update: { data } })).catch((e) => this.o.logger?.error(e, "salon : sauvegarde"));
  }

  /** Reprend les salons enregistrés (après un redémarrage) et relance leurs chronomètres. */
  async restore(): Promise<number> {
    const rows = await this.o.prisma.roomSnapshot.findMany();
    let n = 0;
    for (const row of rows) {
      try {
        if (Date.now() - row.updatedAt.getTime() > IDLE_MS) { await this.o.prisma.roomSnapshot.deleteMany({ where: { code: row.code } }); continue; }
        const d = JSON.parse(row.data);
        const r: Room = {
          code: d.code, subjectId: d.subjectId, hostId: d.hostId, size: d.size, phase: d.phase, members: new Map((d.members as Member[]).map((m) => [m.userId, m])),
          questions: d.questions, index: d.index, limitMs: d.limitMs, startedAt: d.startedAt, deadline: d.deadline, touched: Date.now(), xpPerCorrect: d.xpPerCorrect ?? undefined,
          rewards: d.rewards ? new Map(d.rewards) : undefined,
        };
        if (this.rooms.has(r.code) || r.members.size === 0) continue;
        this.rooms.set(r.code, r);
        for (const id of r.members.keys()) this.byUser.set(id, r.code);
        n++;
        if (r.phase === "QUESTION") {
          const left = r.deadline + this.t.graceMs - Date.now();
          if (left <= 0 || [...r.members.values()].every((m) => m.answered)) void this.reveal(r);
          else r.timer = setTimeout(() => void this.reveal(r), left);
        } else if (r.phase === "REVEAL") {
          r.timer = setTimeout(() => this.next(r), this.t.revealMs);
        } else if (r.phase === "DONE") {
          r.timer = setTimeout(() => this.close(r), 5 * 60_000);
          r.timer.unref?.();
        }
      } catch (e) { this.o.logger?.error(e, "salon : reprise"); }
    }
    return n;
  }

  private broadcast(r: Room, event: string, payload: unknown): void {
    r.touched = Date.now();
    this.save(r);
    for (const id of r.members.keys()) this.o.hub.emit(id, event, payload);
  }

  private roomOf(userId: string): Room {
    const code = this.byUser.get(userId);
    const r = code ? this.rooms.get(code) : undefined;
    if (!r) throw new DuelError("no_room", "Tu n'es dans aucun salon");
    return r;
  }

  private lobby(r: Room) {
    return {
      code: r.code, subjectId: r.subjectId, hostId: r.hostId, size: r.size, phase: r.phase, max: ROOM_MAX, min: ROOM_MIN,
      members: [...r.members.values()].map((m) => ({ id: m.userId, username: m.username, avatar: m.avatar, score: m.score })),
    };
  }

  private ranking(r: Room) {
    const list = [...r.members.values()].sort((a, b) => b.score - a.score || b.correct - a.correct || a.username.localeCompare(b.username));
    let rank = 0, prev: Member | null = null;
    return list.map((m, i) => {
      if (!prev || m.score !== prev.score || m.correct !== prev.correct) rank = i + 1;
      prev = m;
      return { rank, id: m.userId, username: m.username, avatar: m.avatar, score: m.score, correct: m.correct };
    });
  }

  private publicQuestion(r: Room) {
    const q = r.questions[r.index];
    return { index: r.index, total: r.questions.length, text: q.text, choices: q.choices, deadline: r.deadline, timeLimitSec: Math.round(r.limitMs / 1000) };
  }

  private async player(userId: string, subjectId: string) {
    const u = await this.o.prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, avatar: true, role: true, bannedAt: true } });
    if (!u || u.bannedAt) throw new DuelError("forbidden", "Compte indisponible");
    if (u.role !== "USER") throw new DuelError("admin_cannot_play", "Un administrateur ne joue pas");
    const m = await this.o.prisma.membership.findUnique({ where: { userId_subjectId: { userId, subjectId } } });
    if (!m || m.revokedAt) throw new DuelError("not_a_member", "Tu n'as pas accès à cette matière");
    return { userId: u.id, username: u.username, avatar: safeJson(u.avatar), score: 0, correct: 0, answered: false, pick: null, gained: 0 } as Member;
  }

  async create(userId: string, subjectId: string, size: number) {
    if (this.byUser.has(userId)) throw new DuelError("already_in_room", "Tu es déjà dans un salon : quitte-le d'abord");
    if (!(ROOM_SIZES as readonly number[]).includes(size)) throw new DuelError("bad_size", "Nombre de questions invalide");
    const me = await this.player(userId, subjectId);
    let code = "";
    for (let i = 0; i < 20; i++) {
      code = Array.from({ length: 5 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
      if (!this.rooms.has(code)) break;
    }
    if (this.rooms.has(code)) throw new DuelError("busy", "Réessaie dans un instant");
    const r: Room = { code, subjectId, hostId: userId, size, phase: "LOBBY", members: new Map([[userId, me]]), questions: [], index: 0, limitMs: 0, startedAt: 0, deadline: 0, touched: Date.now() };
    this.rooms.set(code, r);
    this.byUser.set(userId, code);
    this.save(r);
    return { room: this.lobby(r) };
  }

  async join(userId: string, rawCode: string) {
    const code = rawCode.trim().toUpperCase();
    if (this.byUser.has(userId)) {
      if (this.byUser.get(userId) === code) return { room: this.lobby(this.roomOf(userId)) };
      throw new DuelError("already_in_room", "Tu es déjà dans un salon : quitte-le d'abord");
    }
    const r = this.rooms.get(code);
    if (!r) throw new DuelError("room_not_found", "Salon introuvable : vérifie le code");
    if (r.phase !== "LOBBY") throw new DuelError("room_started", "La partie a déjà commencé");
    if (r.members.size >= ROOM_MAX) throw new DuelError("room_full", `Salon complet (${ROOM_MAX} joueurs)`);
    const me = await this.player(userId, r.subjectId);
    if (r.phase !== "LOBBY" || r.members.size >= ROOM_MAX || this.byUser.has(userId)) throw new DuelError("room_unavailable", "Salon indisponible");
    r.members.set(userId, me);
    this.byUser.set(userId, code);
    this.broadcast(r, "room:state", { room: this.lobby(r) });
    return { room: this.lobby(r) };
  }

  leave(userId: string) {
    const code = this.byUser.get(userId);
    const r = code ? this.rooms.get(code) : undefined;
    if (!r) return {};
    r.members.delete(userId);
    this.byUser.delete(userId);
    if (r.members.size === 0 || (r.phase === "LOBBY" && r.hostId === userId && r.members.size < 1)) { this.close(r); return {}; }
    if (r.hostId === userId) r.hostId = r.members.keys().next().value as string;
    if (r.phase === "QUESTION" && [...r.members.values()].every((m) => m.answered)) void this.reveal(r);
    else this.broadcast(r, "room:state", { room: this.lobby(r) });
    return {};
  }

  async start(userId: string) {
    const r = this.roomOf(userId);
    if (r.hostId !== userId) throw new DuelError("not_host", "Seul le créateur du salon peut lancer la partie");
    if (r.phase !== "LOBBY") throw new DuelError("room_started", "La partie a déjà commencé");
    if (r.members.size < ROOM_MIN) throw new DuelError("not_enough", `Il faut au moins ${ROOM_MIN} joueurs`);
    const rows = await this.o.prisma.question.findMany({ where: { deletedAt: null, chapter: { subjectId: r.subjectId, deletedAt: null, locked: false } }, select: { id: true, text: true, choices: true, answerIndex: true, explanation: true } });
    if (rows.length < 3) throw new DuelError("no_questions", "Pas assez de questions dans cette matière");
    if (r.phase !== "LOBBY") return {};
    for (let i = rows.length - 1; i > 0; i--) { const j = randomInt(i + 1); [rows[i], rows[j]] = [rows[j], rows[i]]; }
    r.questions = rows.slice(0, r.size).map((q) => ({ id: q.id, text: q.text, choices: JSON.parse(q.choices) as string[], answerIndex: q.answerIndex, explanation: q.explanation }));
    const subject = await this.o.prisma.subject.findUniqueOrThrow({ where: { id: r.subjectId } });
    const settings = await loadEffectiveSettings(this.o.prisma, subject.settings, subject.organizationId);
    r.xpPerCorrect = settings.xpPerCorrect;
    r.limitMs = (settings.timePerQuestionSec > 0 ? settings.timePerQuestionSec : 20) * 1000;
    r.index = -1;
    this.broadcast(r, "room:started", { room: this.lobby(r), total: r.questions.length });
    this.next(r);
    return {};
  }

  private next(r: Room): void {
    r.index += 1;
    if (r.index >= r.questions.length) return this.finish(r);
    r.phase = "QUESTION";
    for (const m of r.members.values()) { m.answered = false; m.pick = null; m.gained = 0; }
    r.startedAt = Date.now();
    r.deadline = r.startedAt + r.limitMs;
    this.broadcast(r, "room:question", this.publicQuestion(r));
    r.timer = setTimeout(() => void this.reveal(r), r.limitMs + this.t.graceMs);
  }

  answer(userId: string, index: number, choiceIndex: number) {
    const r = this.roomOf(userId);
    const m = r.members.get(userId)!;
    if (r.phase !== "QUESTION" || r.index !== index) throw new DuelError("not_now", "Cette question est terminée");
    if (m.answered) throw new DuelError("already_answered", "Tu as déjà répondu");
    const q = r.questions[r.index];
    if (choiceIndex >= q.choices.length) throw new DuelError("bad_choice", "Choix invalide");
    const now = Date.now();
    if (now > r.deadline + this.t.graceMs) throw new DuelError("too_late", "Temps écoulé");
    m.answered = true;
    m.pick = choiceIndex;
    if (choiceIndex === q.answerIndex) {
      const left = Math.max(0, r.deadline - now);
      m.gained = 100 + Math.round((100 * left) / r.limitMs);
      m.score += m.gained;
      m.correct += 1;
    }
    this.broadcast(r, "room:answered", { userId, answered: [...r.members.values()].filter((x) => x.answered).length, total: r.members.size });
    if ([...r.members.values()].every((x) => x.answered)) void this.reveal(r);
    return {};
  }

  private async reveal(r: Room): Promise<void> {
    if (r.phase !== "QUESTION") return;
    r.phase = "REVEAL";
    if (r.timer) clearTimeout(r.timer);
    const q = r.questions[r.index];
    this.broadcast(r, "room:reveal", {
      index: r.index, correctIndex: q.answerIndex, explanation: q.explanation,
      results: [...r.members.values()].map((m) => ({ id: m.userId, pick: m.pick, correct: m.pick === q.answerIndex, gained: m.gained })),
      ranking: this.ranking(r),
    });
    r.timer = setTimeout(() => this.next(r), this.t.revealMs);
  }

  private finish(r: Room): void {
    r.phase = "DONE";
    if (r.timer) clearTimeout(r.timer);
    const ranking = this.ranking(r);
    this.persist(r, ranking)
      .catch((e) => { this.o.logger?.error(e, "salon : enregistrement"); return new Map<string, Reward>(); })
      .then((rewards) => {
        r.rewards = rewards;
        this.save(r);
        for (const id of r.members.keys()) this.o.hub.emit(id, "room:finished", { code: r.code, total: r.questions.length, ranking, reward: rewards.get(id) ?? null });
      });
    // Le salon reste consultable un court instant (reconnexion), puis disparaît.
    r.timer = setTimeout(() => this.close(r), 5 * 60_000);
    r.timer.unref?.();
  }

  /** Enregistre la partie et attribue XP et pièces (parties à 2 joueurs ou plus, dans la limite quotidienne). */
  private async persist(r: Room, ranking: ReturnType<RoomEngine["ranking"]>): Promise<Map<string, Reward>> {
    const prisma = this.o.prisma;
    const rewards = new Map<string, Reward>();
    const since = new Date(Date.now() - 24 * 3600_000);
    const perCorrect = Math.max(1, Math.floor((r.xpPerCorrect ?? 10) / 2));
    const played = ranking.length >= ROOM_MIN;
    await prisma.$transaction(async (tx) => {
      const game = await tx.roomGame.create({ data: { subjectId: r.subjectId, code: r.code, size: r.questions.length } });
      for (const p of ranking) {
        let xp = 0, coins = 0, capped = false;
        if (played) {
          const done = await tx.roomPlayer.count({ where: { userId: p.id, OR: [{ xpEarned: { gt: 0 } }, { coinsEarned: { gt: 0 } }], game: { finishedAt: { gte: since } } } });
          if (done >= REWARDED_PER_DAY) capped = true;
          else {
            xp = p.correct * perCorrect;
            coins = COINS_PARTICIPATION + Math.round(p.score / 10) + (p.rank === 1 && ranking.length >= 3 && p.score > 0 ? COINS_WIN_BONUS : 0);
          }
        }
        await tx.roomPlayer.create({ data: { gameId: game.id, userId: p.id, username: p.username, rank: p.rank, score: p.score, correct: p.correct, xpEarned: xp, coinsEarned: coins } });
        if (xp > 0) await awardXp(tx, { userId: p.id, subjectId: r.subjectId, source: "ROOM", amount: xp });
        if (coins > 0) await tx.coinLedger.create({ data: { userId: p.id, amount: coins, reason: "ROOM", refId: game.id } });
        rewards.set(p.id, { xp, coins, capped });
      }
    });
    return rewards;
  }

  /** Fin de partie : le créateur relance une partie avec les mêmes joueurs (scores remis à zéro). */
  rematch(userId: string) {
    const r = this.roomOf(userId);
    if (r.hostId !== userId) throw new DuelError("not_host", "Seul le créateur du salon peut relancer une partie");
    if (r.phase !== "DONE") throw new DuelError("not_finished", "La partie n'est pas terminée");
    if (r.timer) clearTimeout(r.timer);
    r.phase = "LOBBY"; r.questions = []; r.index = 0; r.rewards = undefined;
    for (const m of r.members.values()) { m.score = 0; m.correct = 0; m.answered = false; m.pick = null; m.gained = 0; }
    this.broadcast(r, "room:state", { room: this.lobby(r) });
    return {};
  }

  /** État complet pour un joueur qui (re)charge la page. */
  snapshot(userId: string) {
    const code = this.byUser.get(userId);
    const r = code ? this.rooms.get(code) : undefined;
    if (!r) return null;
    const base: Record<string, unknown> = { room: this.lobby(r), me: userId };
    if (r.phase === "QUESTION" || r.phase === "REVEAL") {
      base.question = { ...this.publicQuestion(r), answered: r.members.get(userId)!.answered, myPick: r.members.get(userId)!.pick };
      base.ranking = this.ranking(r);
      if (r.phase === "REVEAL") { const q = r.questions[r.index]; base.reveal = { index: r.index, correctIndex: q.answerIndex, explanation: q.explanation, results: [...r.members.values()].map((m) => ({ id: m.userId, pick: m.pick, correct: m.pick === q.answerIndex, gained: m.gained })), ranking: this.ranking(r) }; }
    }
    if (r.phase === "DONE") base.finished = { code: r.code, total: r.questions.length, ranking: this.ranking(r), reward: r.rewards?.get(userId) ?? null };
    return base;
  }
}
