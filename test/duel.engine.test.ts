import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { DuelEngine, type Hub, type Timings } from "../src/duel/engine.ts";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv, joinSubject } from "./helpers.ts";

// ───────────── Outils ─────────────

interface Ev {
  userId: string;
  event: string;
  payload: any;
}

class FakeHub implements Hub {
  online = new Set<string>();
  events: Ev[] = [];
  listeners: Array<(e: Ev) => void> = [];
  emit(userId: string, event: string, payload: unknown) {
    const e = { userId, event, payload } as Ev;
    this.events.push(e);
    for (const l of this.listeners) l(e);
  }
  isOnline(userId: string) {
    return this.online.has(userId);
  }
  of(userId: string, event: string) {
    return this.events.filter((e) => e.userId === userId && e.event === event).map((e) => e.payload);
  }
  waitFor(userId: string, event: string, timeoutMs = 8000): Promise<any> {
    const done = this.of(userId, event);
    if (done.length) return Promise.resolve(done[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout en attendant ${event} pour ${userId}`)), timeoutMs);
      const l = (e: Ev) => {
        if (e.userId === userId && e.event === event) {
          clearTimeout(timer);
          this.listeners = this.listeners.filter((x) => x !== l);
          resolve(e.payload);
        }
      };
      this.listeners.push(l);
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAST: Partial<Timings> = { revealMs: 30, graceMs: 100, challengeTtlMs: 400 };

let env: TestEnv;
let subjectId: string;
let otherSubjectId: string;
let chA: string;
let chB: string;
let chSmall: string;
let chForeign: string;
let counter = 0;

before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  const admin = await login(env, ADMIN.username, ADMIN.password);
  const mk = async (name: string, access: string) =>
    (await call(env, admin, "POST", "/api/subjects", { name })).json().subject.id as string;
  subjectId = await mk("Chimie", "chimie");
  otherSubjectId = await mk("Histoire", "histoire");
  const imp = async (sid: string, name: string, n: number) =>
    (await call(env, admin, "POST", `/api/subjects/${sid}/import/commit`, { raw: sampleBlock(n, name), newChapterName: name })).json().chapterId as string;
  chA = await imp(subjectId, "A", 20);
  chB = await imp(subjectId, "B", 20);
  chSmall = await imp(subjectId, "Petit", 2);
  chForeign = await imp(otherSubjectId, "Ailleurs", 10);
});
after(() => env.close());

async function setSettings(settings: Record<string, unknown>) {
  await env.prisma.subject.update({ where: { id: subjectId }, data: { settings: JSON.stringify(settings) } });
}

async function player(subject = subjectId) {
  const u = await env.prisma.user.create({ data: { username: `duel-${++counter}`, passwordHash: "x" } });
  await env.prisma.membership.create({ data: { userId: u.id, subjectId: subject } });
  return u;
}

interface Setup {
  hub: FakeHub;
  engine: DuelEngine;
}
function setup(timings: Partial<Timings> = FAST): Setup {
  const hub = new FakeHub();
  return { hub, engine: new DuelEngine({ prisma: env.prisma, hub, timings, logger: { error: () => {} } }) };
}
const online = (s: Setup, ...users: { id: string }[]) => users.forEach((u) => s.hub.online.add(u.id));

type Strategy = (q: { n: number; correctIndex: number; choices: number }) => number | null;
const always: Strategy = (q) => q.correctIndex;
const wrongOn = (...ns: number[]): Strategy => (q) => (ns.includes(q.n) ? (q.correctIndex + 1) % q.choices : q.correctIndex);

function bot(s: Setup, userId: string, o: { strategy?: Strategy; pick?: (chapters: { id: string }[], round: number) => string }) {
  s.hub.listeners.push((ev) => {
    if (ev.userId !== userId) return;
    if (ev.event === "duel:pick_chapter" && ev.payload.picker === userId && o.pick) {
      const id = o.pick(ev.payload.chapters, ev.payload.round);
      setImmediate(() => s.engine.pickChapter(userId, ev.payload.gameId, id).catch(() => {}));
    }
    if (ev.event === "duel:question" && o.strategy) {
      const p = ev.payload;
      void env.prisma.gameQuestion.findUniqueOrThrow({ where: { id: p.gameQuestionId }, include: { question: true } }).then((gq) => {
        const choice = o.strategy!({ n: p.position, correctIndex: gq.question.answerIndex, choices: p.choices.length });
        if (choice !== null) s.engine.answer(userId, p.gameId, p.gameQuestionId, choice).catch(() => {});
      });
    }
  });
}

async function startDuel(s: Setup, a: { id: string }, b: { id: string }): Promise<string> {
  const { challengeId } = await s.engine.createChallenge(a.id, subjectId, b.id);
  const r = await s.engine.respondChallenge(b.id, challengeId, true);
  return r.gameId!;
}

const rejectsWith = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: any) => {
    assert.equal(e.code, code, `code attendu ${code}, reçu ${e.code}`);
    return true;
  });

const xpOf = async (userId: string, sid = subjectId) => (await env.prisma.membership.findUniqueOrThrow({ where: { userId_subjectId: { userId, subjectId: sid } } })).xp;

// ───────────── Défis ─────────────

test("défi : refusé si adversaire hors ligne, d'une autre matière, soi-même, matière sans question", async () => {
  const s = setup();
  const [a, b, c] = [await player(), await player(), await player(otherSubjectId)];
  online(s, a, c);
  await rejectsWith(s.engine.createChallenge(a.id, subjectId, a.id), "self_challenge");
  await rejectsWith(s.engine.createChallenge(a.id, subjectId, b.id), "opponent_offline");
  online(s, b);
  await rejectsWith(s.engine.createChallenge(a.id, subjectId, c.id), "not_same_subject");

  // Accès révoqué : l'adversaire n'est plus dans la matière
  await env.prisma.membership.updateMany({ where: { userId: b.id }, data: { revokedAt: new Date() } });
  await rejectsWith(s.engine.createChallenge(a.id, subjectId, b.id), "not_same_subject");

  // Matière sans aucune question
  const empty = await env.prisma.subject.create({ data: { name: "Vide", accessName: "vide", accessPasswordHash: "x", organizationId: (await env.prisma.organization.findFirstOrThrow()).id } });
  const [d, e] = [await player(empty.id), await player(empty.id)];
  online(s, d, e);
  await rejectsWith(s.engine.createChallenge(d.id, empty.id, e.id), "no_questions");
  s.engine.shutdown();
});

test("défi : refus, annulation, expiration, un seul défi à la fois", async () => {
  const s = setup();
  const [a, b, c] = [await player(), await player(), await player()];
  online(s, a, b, c);

  const first = await s.engine.createChallenge(a.id, subjectId, b.id);
  assert.equal(s.hub.of(b.id, "duel:invited")[0].challengeId, first.challengeId);
  assert.equal(s.hub.of(b.id, "duel:invited")[0].from.username, a.username);
  await rejectsWith(s.engine.createChallenge(a.id, subjectId, c.id), "challenge_pending");
  await rejectsWith(s.engine.createChallenge(c.id, subjectId, b.id), "opponent_busy");
  await rejectsWith(s.engine.respondChallenge(c.id, first.challengeId, true), "challenge_not_found"); // pas le destinataire

  await s.engine.respondChallenge(b.id, first.challengeId, false);
  assert.equal(s.hub.of(a.id, "duel:challenge_declined").length, 1);
  assert.equal(s.engine.isBusy(a.id), false);

  const second = await s.engine.createChallenge(a.id, subjectId, b.id);
  s.engine.cancelChallenge(a.id, second.challengeId);
  assert.equal(s.hub.of(b.id, "duel:challenge_cancelled").length, 1);
  await rejectsWith(s.engine.respondChallenge(b.id, second.challengeId, true), "challenge_not_found");

  const third = await s.engine.createChallenge(a.id, subjectId, b.id);
  await sleep(550);
  assert.equal(s.hub.of(a.id, "duel:challenge_expired").length, 1);
  assert.equal(s.hub.of(b.id, "duel:challenge_expired").length, 1);
  await rejectsWith(s.engine.respondChallenge(b.id, third.challengeId, true), "challenge_not_found");
  assert.equal(s.engine.isBusy(a.id) || s.engine.isBusy(b.id), false);
  s.engine.shutdown();
});

test("défi : le joueur qui se déconnecte voit son défi annulé", async () => {
  const s = setup();
  const [a, b] = [await player(), await player()];
  online(s, a, b);
  const c = await s.engine.createChallenge(a.id, subjectId, b.id);
  s.hub.online.delete(a.id);
  await s.engine.onDisconnect(a.id);
  assert.equal(s.hub.of(b.id, "duel:challenge_cancelled").length, 1);
  await rejectsWith(s.engine.respondChallenge(b.id, c.challengeId, true), "challenge_not_found");
  s.engine.shutdown();
});

// ───────────── Partie complète ─────────────

test("duel complet 4 manches de 4 : tour de rôle, XP, victoire, rien ne fuit", async () => {
  await setSettings({ liveTimePerQuestionSec: 10 });
  const s = setup();
  const [p1, p2] = [await player(), await player()];
  online(s, p1, p2);
  bot(s, p1.id, { strategy: always, pick: () => chA });
  bot(s, p2.id, { strategy: wrongOn(3, 7, 11, 15), pick: () => chB });

  const gameId = await startDuel(s, p1, p2);
  const [f1, f2] = await Promise.all([s.hub.waitFor(p1.id, "duel:finished"), s.hub.waitFor(p2.id, "duel:finished")]);

  assert.equal(f1.result, "WIN");
  assert.equal(f2.result, "LOSS");
  assert.equal(f1.reason, "completed");
  assert.equal(f1.you.correct, 16);
  assert.equal(f2.you.correct, 12);
  assert.equal(f1.you.bonus, 40);
  assert.equal(f2.you.bonus, 0);
  assert.equal(f1.totalQuestions, 16);

  // Tour de rôle : p1 choisit les manches 1 et 3, p2 les manches 2 et 4
  const pickers = s.hub.of(p1.id, "duel:pick_chapter").map((e) => e.picker);
  assert.deepEqual(pickers, [p1.id, p2.id, p1.id, p2.id]);
  const rounds = await env.prisma.round.findMany({ where: { gameId }, orderBy: { number: "asc" } });
  assert.deepEqual(rounds.map((r) => r.chapterId), [chA, chB, chA, chB]);

  // 16 questions distinctes, 32 réponses, chacune dans le chapitre de sa manche
  const gqs = await env.prisma.gameQuestion.findMany({ where: { gameId }, include: { question: true, round: true } });
  assert.equal(gqs.length, 16);
  assert.equal(new Set(gqs.map((g) => g.questionId)).size, 16);
  assert.ok(gqs.every((g) => g.question.chapterId === g.round.chapterId));
  assert.equal(await env.prisma.answer.count({ where: { gameQuestion: { gameId } } }), 32);

  // XP : 10 par bonne réponse + 40 au vainqueur
  assert.equal(await xpOf(p1.id), 16 * 10 + 40);
  assert.equal(await xpOf(p2.id), 12 * 10);
  assert.equal(await env.prisma.xpEvent.count({ where: { userId: p1.id, source: "FRIENDLY_WIN" } }), 1);
  assert.equal(await env.prisma.xpEvent.count({ where: { userId: p2.id, source: { in: ["FRIENDLY_WIN", "FRIENDLY_DRAW"] } } }), 0);
  assert.equal(f1.you.totalXp, 200);
  assert.equal(f1.you.level.level, 2);

  const game = await env.prisma.game.findUniqueOrThrow({ where: { id: gameId }, include: { players: true } });
  assert.equal(game.status, "FINISHED");
  assert.equal(game.mode, "FRIENDLY");
  assert.equal(game.players.find((p) => p.userId === p1.id)!.result, "WIN");
  assert.equal(game.players.find((p) => p.userId === p2.id)!.result, "LOSS");

  // Confidentialité : pas de bonne réponse avant la correction, pas de choix adverse avant la correction
  for (const e of s.hub.events.filter((x) => x.event === "duel:question")) {
    assert.equal(/answerIndex|correctIndex|explanation|isCorrect/.test(JSON.stringify(e.payload)), false);
  }
  const early = s.hub.events.filter((x) => x.event === "duel:opponent_answered");
  assert.ok(early.length > 0);
  assert.ok(early.every((e) => Object.keys(e.payload).sort().join() === "gameId,gameQuestionId"));
  const reveal = s.hub.of(p1.id, "duel:reveal")[0];
  assert.equal(typeof reveal.correctIndex, "number");
  assert.equal(reveal.scores.you, 1);

  assert.equal(s.engine.isBusy(p1.id), false); // libérés après la partie
  s.engine.shutdown();
});

test("match nul : +20 XP pour chacun", async () => {
  await setSettings({ liveTimePerQuestionSec: 10, liveRoundsPerDuel: 1, liveQuestionsPerRound: 3 });
  const s = setup();
  const [p1, p2] = [await player(), await player()];
  online(s, p1, p2);
  bot(s, p1.id, { strategy: always, pick: () => chA });
  bot(s, p2.id, { strategy: always });
  const gameId = await startDuel(s, p1, p2);
  const f = await s.hub.waitFor(p2.id, "duel:finished");
  assert.equal(f.result, "DRAW");
  assert.equal(await xpOf(p1.id), 3 * 10 + 20);
  assert.equal(await xpOf(p2.id), 3 * 10 + 20);
  assert.equal(await env.prisma.xpEvent.count({ where: { gameId, source: "FRIENDLY_DRAW" } }), 2);
  const players = await env.prisma.gamePlayer.findMany({ where: { gameId } });
  assert.deepEqual(players.map((p) => p.result), ["DRAW", "DRAW"]);
  s.engine.shutdown();
});

test("chapitre non choisi à temps : le serveur en tire un parmi ceux de la matière", async () => {
  await setSettings({ liveTimePerQuestionSec: 10, liveRoundsPerDuel: 1, liveQuestionsPerRound: 1 });
  const s = setup({ ...FAST, pickMs: 120 });
  const [p1, p2] = [await player(), await player()];
  online(s, p1, p2);
  bot(s, p1.id, { strategy: always });
  bot(s, p2.id, { strategy: always });
  await startDuel(s, p1, p2);
  const pick = await s.hub.waitFor(p1.id, "duel:pick_chapter");
  assert.deepEqual(pick.chapters.map((c: { name: string }) => c.name).sort(), ["A", "B", "Petit"]); // jamais les chapitres d'une autre matière
  const started = await s.hub.waitFor(p1.id, "duel:round_started");
  assert.ok([chA, chB, chSmall].includes(started.chapter.id));
  await s.hub.waitFor(p1.id, "duel:finished");
  s.engine.shutdown();
});

test("question sans réponse : temps écoulé, erreur pour les deux", async () => {
  await setSettings({ liveTimePerQuestionSec: 1, liveRoundsPerDuel: 1, liveQuestionsPerRound: 1 });
  const s = setup();
  const [p1, p2] = [await player(), await player()];
  online(s, p1, p2);
  bot(s, p1.id, { pick: () => chA });
  const t0 = Date.now();
  await startDuel(s, p1, p2);
  const r = await s.hub.waitFor(p1.id, "duel:reveal");
  assert.ok(Date.now() - t0 >= 1000, "la correction ne doit pas arriver avant la fin du temps");
  assert.equal(r.you.timedOut, true);
  assert.equal(r.opponent.timedOut, true);
  assert.equal(r.you.correct, false);
  const f = await s.hub.waitFor(p1.id, "duel:finished");
  assert.equal(f.result, "DRAW");
  s.engine.shutdown();
});

test("temps illimité (0) : pas de minuteur, personne n'est répondu automatiquement", async () => {
  await setSettings({ liveTimePerQuestionSec: 0, liveRoundsPerDuel: 1, liveQuestionsPerRound: 1 });
  const s = setup();
  const [p1, p2] = [await player(), await player()];
  online(s, p1, p2);
  bot(s, p1.id, { pick: () => chA });
  await startDuel(s, p1, p2);
  const q = await s.hub.waitFor(p1.id, "duel:question");
  assert.equal(q.timeLimitSec, 0);
  assert.equal(q.deadline, 0);
  await new Promise((r) => setTimeout(r, 1500)); // bien au-delà du délai de grâce
  assert.equal(s.hub.of(p1.id, "duel:reveal").length, 0, "la question ne doit pas se clore seule");
  s.engine.shutdown();
});

test("duel en direct : manches, questions et temps viennent des réglages « direct », pas des réglages différés", async () => {
  await setSettings({ liveTimePerQuestionSec: 15, liveRoundsPerDuel: 3, liveQuestionsPerRound: 2, timePerQuestionSec: 99, roundsPerDuel: 7, questionsPerRound: 5 });
  const s = setup();
  const [p1, p2] = [await player(), await player()];
  online(s, p1, p2);
  bot(s, p1.id, { pick: () => chA });
  await startDuel(s, p1, p2);
  const q = await s.hub.waitFor(p1.id, "duel:question");
  assert.equal(q.timeLimitSec, 15);
  assert.equal(q.questionsInRound, 2);
  const rs = await s.hub.waitFor(p1.id, "duel:round_started");
  assert.equal(rs.rounds, 3);
  s.engine.shutdown();
});

// ───────────── Règles et erreurs ─────────────

test("erreurs de jeu : mauvaise question, double réponse, choix invalide, étranger, pas son tour", async () => {
  await setSettings({ liveTimePerQuestionSec: 10, liveRoundsPerDuel: 2, liveQuestionsPerRound: 2 });
  const s = setup();
  const [p1, p2, out] = [await player(), await player(), await player()];
  online(s, p1, p2, out);
  const gameId = await startDuel(s, p1, p2);

  const pick = await s.hub.waitFor(p1.id, "duel:pick_chapter");
  assert.equal(pick.picker, p1.id);
  await rejectsWith(s.engine.pickChapter(p2.id, gameId, chA), "not_your_turn");
  await rejectsWith(s.engine.pickChapter(p1.id, gameId, chForeign), "invalid_chapter");
  await rejectsWith(s.engine.pickChapter(out.id, gameId, chA), "no_game");
  await rejectsWith(s.engine.answer(p1.id, gameId, "x", 0), "not_current");
  await s.engine.pickChapter(p1.id, gameId, chA);
  await rejectsWith(s.engine.pickChapter(p1.id, gameId, chA), "not_picking");

  const q = await s.hub.waitFor(p1.id, "duel:question");
  await rejectsWith(s.engine.answer(out.id, gameId, q.gameQuestionId, 0), "no_game");
  await rejectsWith(s.engine.answer(p1.id, gameId, "inconnue", 0), "not_current");
  await rejectsWith(s.engine.answer(p1.id, gameId, q.gameQuestionId, 9), "invalid_choice");
  await s.engine.answer(p1.id, gameId, q.gameQuestionId, 0);
  await rejectsWith(s.engine.answer(p1.id, gameId, q.gameQuestionId, 1), "already_answered");

  // Un joueur ne peut être que dans un duel à la fois
  await rejectsWith(s.engine.createChallenge(p1.id, subjectId, out.id), "already_in_duel");
  await rejectsWith(s.engine.createChallenge(out.id, subjectId, p2.id), "opponent_busy");
  s.engine.shutdown();
});

test("reprise : l'état de la partie est renvoyé, sans la bonne réponse", async () => {
  await setSettings({ liveTimePerQuestionSec: 10, liveRoundsPerDuel: 1, liveQuestionsPerRound: 2 });
  const s = setup();
  const [p1, p2] = [await player(), await player()];
  online(s, p1, p2);
  assert.equal(s.engine.snapshot(p1.id), null);
  const gameId = await startDuel(s, p1, p2);

  await s.hub.waitFor(p1.id, "duel:pick_chapter");
  const picking: any = s.engine.snapshot(p2.id);
  assert.equal(picking.phase, "PICKING");
  assert.equal(picking.pick.picker, p1.id);
  assert.equal(picking.opponent.username, p1.username);

  await s.engine.pickChapter(p1.id, gameId, chA);
  const q = await s.hub.waitFor(p1.id, "duel:question");
  let snap: any = s.engine.snapshot(p1.id);
  assert.equal(snap.phase, "QUESTION");
  assert.equal(snap.question.answered, false);
  assert.equal(snap.question.gameQuestionId, q.gameQuestionId);
  assert.equal(/answerIndex|correctIndex|explanation/.test(JSON.stringify(snap)), false);
  await s.engine.answer(p1.id, gameId, q.gameQuestionId, 0);
  snap = s.engine.snapshot(p1.id);
  assert.equal(snap.question.answered, true);
  await s.engine.forfeit(p1.id, gameId);
  s.engine.shutdown();
});

// ───────────── Déconnexions et forfaits ─────────────

test("déconnexion puis retour : la partie continue, l'état est renvoyé", async () => {
  await setSettings({ liveTimePerQuestionSec: 10, liveRoundsPerDuel: 1, liveQuestionsPerRound: 2, reconnectSec: 5 });
  const s = setup();
  const [p1, p2] = [await player(), await player()];
  online(s, p1, p2);
  bot(s, p1.id, { strategy: always, pick: () => chA });
  const gameId = await startDuel(s, p1, p2);

  await s.hub.waitFor(p1.id, "duel:question");
  s.hub.online.delete(p2.id);
  await s.engine.onDisconnect(p2.id);
  const status = s.hub.of(p1.id, "duel:opponent_status")[0];
  assert.equal(status.connected, false);
  assert.equal(status.graceMs, 5000);

  // p1 répond : l'absent n'est pas attendu, la correction arrive tout de suite
  const reveal = await s.hub.waitFor(p1.id, "duel:reveal");
  assert.equal(reveal.opponent.timedOut, true);

  s.hub.online.add(p2.id);
  await s.engine.onConnect(p2.id);
  assert.equal(s.hub.of(p1.id, "duel:opponent_status").at(-1).connected, true);
  const state = s.hub.of(p2.id, "duel:state").at(-1);
  assert.equal(state.gameId, gameId);
  assert.ok(["REVEAL", "QUESTION"].includes(state.phase));

  bot(s, p2.id, { strategy: always });
  const f = await s.hub.waitFor(p1.id, "duel:finished");
  assert.equal(f.reason, "completed");
  s.engine.shutdown();
});

test("absent trop longtemps : forfait, l'adversaire gagne +40 ; le fautif ne reçoit aucun bonus", async () => {
  await setSettings({ liveTimePerQuestionSec: 10, liveRoundsPerDuel: 1, liveQuestionsPerRound: 3, reconnectSec: 1 });
  const s = setup();
  const [p1, p2] = [await player(), await player()];
  online(s, p1, p2);
  // p1 ne répond qu'à la première question
  bot(s, p1.id, { strategy: (q) => (q.n === 1 ? q.correctIndex : null), pick: () => chA });
  const gameId = await startDuel(s, p1, p2);
  await s.hub.waitFor(p1.id, "duel:question");
  s.hub.online.delete(p2.id);
  await s.engine.onDisconnect(p2.id);

  const f1 = await s.hub.waitFor(p1.id, "duel:finished");
  const f2 = await s.hub.waitFor(p2.id, "duel:finished");
  assert.equal(f1.reason, "forfeit");
  assert.equal(f1.result, "WIN");
  assert.equal(f2.result, "FORFEIT");
  assert.equal(await xpOf(p1.id), 10 + 40); // 1 bonne réponse + bonus de victoire
  assert.equal(await xpOf(p2.id), 0);
  const game = await env.prisma.game.findUniqueOrThrow({ where: { id: gameId } });
  assert.equal(game.status, "FINISHED");
  assert.equal(s.engine.isBusy(p1.id), false);
  s.engine.shutdown();
});

test("retour avant la fin du délai : pas de forfait", async () => {
  await setSettings({ liveTimePerQuestionSec: 10, liveRoundsPerDuel: 1, liveQuestionsPerRound: 1, reconnectSec: 1 });
  const s = setup();
  const [p1, p2] = [await player(), await player()];
  online(s, p1, p2);
  bot(s, p1.id, { pick: () => chA });
  await startDuel(s, p1, p2);
  await s.hub.waitFor(p1.id, "duel:question");
  s.hub.online.delete(p2.id);
  await s.engine.onDisconnect(p2.id);
  await sleep(300);
  s.hub.online.add(p2.id);
  await s.engine.onConnect(p2.id);
  await sleep(1200);
  assert.equal(s.hub.of(p1.id, "duel:finished").length, 0);
  assert.equal(s.engine.hasGame(p2.id), true);
  s.engine.shutdown();
});

test("les deux joueurs absents : partie abandonnée, aucun bonus", async () => {
  await setSettings({ liveTimePerQuestionSec: 10, liveRoundsPerDuel: 1, liveQuestionsPerRound: 2, reconnectSec: 1 });
  const s = setup();
  const [p1, p2] = [await player(), await player()];
  online(s, p1, p2);
  bot(s, p1.id, { pick: () => chA }); // personne ne répond
  const gameId = await startDuel(s, p1, p2);
  await s.hub.waitFor(p1.id, "duel:question");
  await sleep(50);
  s.hub.online.clear();
  await s.engine.onDisconnect(p1.id);
  await s.engine.onDisconnect(p2.id);
  const f = await s.hub.waitFor(p1.id, "duel:finished", 6000);
  assert.equal(f.reason, "abandoned");
  assert.equal(f.result, null);
  assert.equal(f.you.bonus, 0);
  assert.equal((await env.prisma.game.findUniqueOrThrow({ where: { id: gameId } })).status, "ABANDONED");
  s.engine.shutdown();
});

test("abandon volontaire : l'adversaire gagne +40 s'il y a eu au moins une question jouée", async () => {
  await setSettings({ liveTimePerQuestionSec: 10, liveRoundsPerDuel: 1, liveQuestionsPerRound: 3 });
  const s = setup({ ...FAST, revealMs: 5000 });
  const [p1, p2] = [await player(), await player()];
  online(s, p1, p2);
  bot(s, p1.id, { strategy: always, pick: () => chA });
  bot(s, p2.id, { strategy: wrongOn(1) });
  const gameId = await startDuel(s, p1, p2);
  await s.hub.waitFor(p1.id, "duel:reveal");
  await s.engine.forfeit(p2.id, gameId);
  const f1 = await s.hub.waitFor(p1.id, "duel:finished");
  assert.equal(f1.result, "WIN");
  assert.equal(await xpOf(p1.id), 10 + 40);
  assert.equal(await xpOf(p2.id), 0);
  s.engine.shutdown();
});

test("abandon avant la première question terminée : rien n'est attribué", async () => {
  await setSettings({ liveTimePerQuestionSec: 10, liveRoundsPerDuel: 1, liveQuestionsPerRound: 2 });
  const s = setup();
  const [p1, p2] = [await player(), await player()];
  online(s, p1, p2);
  const gameId = await startDuel(s, p1, p2);
  await s.hub.waitFor(p1.id, "duel:pick_chapter");
  await s.engine.forfeit(p1.id, gameId);
  const f = await s.hub.waitFor(p2.id, "duel:finished");
  assert.equal(f.reason, "abandoned");
  assert.equal(f.result, null);
  assert.equal(await xpOf(p2.id), 0);
  assert.equal((await env.prisma.game.findUniqueOrThrow({ where: { id: gameId } })).status, "ABANDONED");
  s.engine.shutdown();
});

test("redémarrage du serveur : les duels en cours sont marqués abandonnés", async () => {
  const g = await env.prisma.game.create({ data: { subjectId, mode: "FRIENDLY", status: "IN_PROGRESS" } });
  const solo = await env.prisma.game.create({ data: { subjectId, mode: "SOLO", status: "IN_PROGRESS" } });
  const s = setup();
  assert.ok((await s.engine.recoverOrphans()) >= 1);
  assert.equal((await env.prisma.game.findUniqueOrThrow({ where: { id: g.id } })).status, "ABANDONED");
  assert.equal((await env.prisma.game.findUniqueOrThrow({ where: { id: solo.id } })).status, "IN_PROGRESS"); // le solo n'est pas concerné
  s.engine.shutdown();
});

test("liste des adversaires : même matière seulement, avec présence et niveau", async () => {
  const [me, a, b, other] = [await player(), await player(), await player(), await player(otherSubjectId)];
  await env.prisma.membership.updateMany({ where: { userId: a.id }, data: { xp: 150 } });
  const { cookie } = await register(env, "liste-duel");
  await joinSubject(env, cookie, "chimie");

  assert.equal((await call(env, null, "GET", `/api/subjects/${subjectId}/players`)).statusCode, 401);
  const res = await call(env, cookie, "GET", `/api/subjects/${subjectId}/players?q=${a.username}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().players.map((p: { id: string }) => p.id), [a.id]);
  assert.equal(res.json().players[0].level, 2);
  assert.equal(res.json().players[0].online, false);

  const all = (await call(env, cookie, "GET", `/api/subjects/${subjectId}/players`)).json().players.map((p: { id: string }) => p.id);
  assert.ok(all.includes(a.id) && all.includes(b.id));
  assert.equal(all.includes(other.id), false); // autre matière
  assert.equal(all.includes(me.id), true); // les autres membres de la matière apparaissent
  const hist = await call(env, cookie, "GET", `/api/subjects/${otherSubjectId}/players`);
  assert.equal(hist.statusCode, 403); // pas membre de cette matière
});
