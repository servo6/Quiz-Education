import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { expireDueDuels } from "../src/routes/duelAsync.ts";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv, joinSubject } from "./helpers.ts";

let env: TestEnv;
let admin: string;
let subjectId: string;
let otherSubjectId: string;
let chA: string;
let chB: string;
let chForeign: string;
let counter = 0;

before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
  const mk = async (name: string, accessName: string) =>
    (await call(env, admin, "POST", "/api/subjects", { name })).json().subject.id as string;
  subjectId = await mk("Chimie", "chimie");
  otherSubjectId = await mk("Histoire", "histoire");
  const imp = async (sid: string, name: string, n: number) =>
    (await call(env, admin, "POST", `/api/subjects/${sid}/import/commit`, { raw: sampleBlock(n, name), newChapterName: name })).json().chapterId as string;
  chA = await imp(subjectId, "A", 20);
  chB = await imp(subjectId, "B", 20);
  chForeign = await imp(otherSubjectId, "Ailleurs", 10);
  await settings({ roundsPerDuel: 4, questionsPerRound: 2, timePerQuestionSec: 30 });
});
after(() => env.close());

const settings = (s: Record<string, unknown>) => call(env, admin, "PATCH", `/api/subjects/${subjectId}`, { settings: s });

async function player(sid = "chimie") {
  const u = await register(env, `async-${++counter}`);
  await joinSubject(env, u.cookie, sid);
  return u;
}
const create = (cookie: string, opponentId: string, chapterId = chA, sid = subjectId) => call(env, cookie, "POST", "/api/duels", { subjectId: sid, opponentId, chapterId });
const detail = async (cookie: string, id: string) => (await call(env, cookie, "GET", `/api/duels/${id}`)).json();
const nextOf = async (cookie: string, id: string) => (await detail(cookie, id)).duel.next;

const correctOf = async (gqId: string) => (await env.prisma.gameQuestion.findUniqueOrThrow({ where: { id: gqId }, include: { question: true } })).question.answerIndex;

/** Joue toute la manche en cours ; `wrong` = nombre de mauvaises réponses (les premières). */
async function playRound(cookie: string, id: string, wrong = 0) {
  let last: any = null;
  let i = 0;
  for (;;) {
    const cur = (await call(env, cookie, "GET", `/api/duels/${id}/current`)).json();
    if (cur.status !== "IN_PROGRESS") return last;
    const q = cur.question;
    assert.equal(/answerIndex|correctIndex|explanation/.test(JSON.stringify(cur)), false);
    const right = await correctOf(q.gameQuestionId);
    const choice = i++ < wrong ? (right + 1) % q.choices.length : right;
    const res = await call(env, cookie, "POST", `/api/duels/${id}/answer`, { gameQuestionId: q.gameQuestionId, choiceIndex: choice });
    assert.equal(res.statusCode, 200, res.body);
    last = res.json();
  }
}
const pick = (cookie: string, id: string, chapterId: string) => call(env, cookie, "POST", `/api/duels/${id}/pick`, { chapterId });
const xpOf = async (userId: string) => (await env.prisma.membership.findUniqueOrThrow({ where: { userId_subjectId: { userId, subjectId } } })).xp;

test("création : refus (soi-même, non-membre, autre matière, chapitre étranger, doublon)", async () => {
  const [a, b, stranger] = [await player(), await player(), await player("histoire")];
  assert.equal((await call(env, null, "POST", "/api/duels", {})).statusCode, 401);
  assert.equal((await create(a.cookie, a.id)).statusCode, 422);
  assert.equal((await create(a.cookie, stranger.id)).statusCode, 422);
  assert.equal((await create(stranger.cookie, a.id)).statusCode, 403); // pas membre de Chimie
  assert.equal((await create(a.cookie, b.id, chForeign)).statusCode, 404);
  const ok = await create(a.cookie, b.id);
  assert.equal(ok.statusCode, 201);
  const dup = await create(b.cookie, a.id);
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().error.code, "duel_exists");
});

test("duel complet : A1 / B1+B2 / A2+A3 / B3+B4 / A4, XP et victoire", async () => {
  const [a, b] = [await player(), await player()];
  const res = await create(a.cookie, b.id, chA);
  const id = res.json().duel.id as string;
  assert.equal(res.json().duel.next.action, "play");
  assert.equal(res.json().duel.next.round, 1);

  // B ne peut rien jouer tant que A n'a pas fini la manche 1
  assert.equal((await nextOf(b.cookie, id)).action, "wait");
  assert.equal((await call(env, b.cookie, "GET", `/api/duels/${id}/current`)).json().status, "NOTHING_TO_PLAY");
  assert.equal((await pick(b.cookie, id, chB)).statusCode, 409);

  await playRound(a.cookie, id); // A : manche 1, 2/2
  assert.deepEqual(await nextOf(a.cookie, id), { action: "wait", round: 2, reason: "opponent_pick" });
  assert.equal((await pick(a.cookie, id, chB)).statusCode, 409); // pas à A de choisir

  await playRound(b.cookie, id, 1); // B : manche 1, 1/2
  let n = await nextOf(b.cookie, id);
  assert.deepEqual(n, { action: "pick", round: 2 });
  const d = await detail(b.cookie, id);
  assert.deepEqual(d.chapters.map((c: any) => c.name).sort(), ["A", "B"]); // seulement les chapitres de la matière
  assert.equal((await pick(b.cookie, id, chForeign)).statusCode, 404);
  const p2 = await pick(b.cookie, id, chB);
  assert.equal(p2.statusCode, 201);
  assert.equal(p2.json().round, 2);
  await playRound(b.cookie, id); // B : manche 2, 2/2

  assert.equal((await nextOf(b.cookie, id)).action, "wait");
  assert.deepEqual(await nextOf(a.cookie, id), { action: "play", round: 2 });
  await playRound(a.cookie, id, 1); // A : manche 2, 1/2
  assert.deepEqual(await nextOf(a.cookie, id), { action: "pick", round: 3 });
  assert.equal((await pick(a.cookie, id, chA)).statusCode, 201);
  await playRound(a.cookie, id); // A : manche 3, 2/2

  await playRound(b.cookie, id); // B : manche 3, 2/2
  assert.deepEqual(await nextOf(b.cookie, id), { action: "pick", round: 4 });
  assert.equal((await pick(b.cookie, id, chB)).statusCode, 201);
  await playRound(b.cookie, id); // B : manche 4, 2/2

  assert.deepEqual(await nextOf(a.cookie, id), { action: "play", round: 4 });
  const last = await playRound(a.cookie, id); // A : manche 4, 2/2
  assert.equal(last.duel.status, "FINISHED");

  // A : 2+1+2+2 = 7 ; B : 1+2+2+2 = 7 → nul
  assert.equal(last.duel.result, "DRAW");
  assert.equal(await xpOf(a.id), 70 + 20);
  assert.equal(await xpOf(b.id), 70 + 20);

  // 16 questions distinctes sur la partie, mêmes questions pour les deux joueurs
  const gqs = await env.prisma.gameQuestion.findMany({ where: { gameId: id } });
  assert.equal(gqs.length, 8);
  assert.equal(new Set(gqs.map((g) => g.questionId)).size, 8);
  assert.equal(await env.prisma.answer.count({ where: { gameQuestion: { gameId: id } } }), 16);

  const result = (await call(env, a.cookie, "GET", `/api/duels/${id}/result`)).json();
  assert.equal(result.review.length, 8);
  assert.equal(result.xpEarned, 90);
  assert.equal(result.duel.score.opponent, 7);
  assert.equal((await call(env, a.cookie, "POST", `/api/duels/${id}/answer`, { gameQuestionId: gqs[0].id, choiceIndex: 0 })).statusCode, 409);
});

test("victoire : +40 au gagnant, et le score adverse reste caché pendant la partie", async () => {
  await settings({ roundsPerDuel: 2, questionsPerRound: 3 });
  const [a, b] = [await player(), await player()];
  const id = (await create(a.cookie, b.id)).json().duel.id as string;
  await playRound(a.cookie, id); // 3/3
  let d = await detail(a.cookie, id);
  assert.equal(d.duel.score.opponent, null);
  assert.equal(d.rounds[0].opponent, null); // B n'a pas encore joué
  await playRound(b.cookie, id, 2); // 1/3
  d = await detail(a.cookie, id);
  assert.deepEqual(d.rounds[0].opponent, { correct: 1 }); // les deux ont joué la manche 1 : visible
  assert.equal(d.duel.score.opponent, null); // mais pas le total tant que le duel court
  await pick(b.cookie, id, chB);
  await playRound(b.cookie, id, 3); // 0/3
  await playRound(a.cookie, id); // A : manche 2 3/3
  await pick(a.cookie, id, chA).catch(() => {}); // pas de manche 3 : rien à choisir
  const res = (await call(env, a.cookie, "GET", `/api/duels/${id}/result`)).json();
  assert.equal(res.result, "WIN");
  assert.equal(await xpOf(a.id), 60 + 40);
  assert.equal(await xpOf(b.id), 10);
  const rb = (await call(env, b.cookie, "GET", `/api/duels/${id}/result`)).json();
  assert.equal(rb.result, "LOSS");
  await settings({ roundsPerDuel: 4, questionsPerRound: 2 });
});

test("délai dépassé : le plus de bonnes réponses gagne ; égalité = nul ; personne n'a joué = abandon", async () => {
  const expire = async (id: string) => {
    const g = await env.prisma.game.findUniqueOrThrow({ where: { id } });
    const cfg = JSON.parse(g.config);
    cfg.deadlineAt = new Date(Date.now() - 1000).toISOString();
    await env.prisma.game.update({ where: { id }, data: { config: JSON.stringify(cfg) } });
    return expireDueDuels(env.prisma);
  };

  // A joue sa manche (2/2), B n'a rien joué → A gagne
  const [a, b] = [await player(), await player()];
  const id1 = (await create(a.cookie, b.id)).json().duel.id as string;
  await playRound(a.cookie, id1);
  assert.ok((await expire(id1)) >= 1);
  assert.equal((await env.prisma.game.findUniqueOrThrow({ where: { id: id1 } })).status, "FINISHED");
  assert.equal((await call(env, b.cookie, "GET", `/api/duels/${id1}/result`)).json().result, "LOSS");
  assert.equal(await xpOf(a.id), 20 + 40);
  assert.equal(await xpOf(b.id), 0);
  assert.equal((await call(env, b.cookie, "POST", `/api/duels/${id1}/answer`, { gameQuestionId: "x", choiceIndex: 0 })).statusCode, 409);

  // Égalité 1-1
  const [c, d] = [await player(), await player()];
  const id2 = (await create(c.cookie, d.id)).json().duel.id as string;
  await playRound(c.cookie, id2, 1);
  await playRound(d.cookie, id2, 1);
  await expire(id2);
  assert.equal((await call(env, c.cookie, "GET", `/api/duels/${id2}/result`)).json().result, "DRAW");
  assert.equal(await xpOf(c.id), 10 + 20);
  assert.equal(await xpOf(d.id), 10 + 20);

  // Personne n'a répondu
  const [e, f] = [await player(), await player()];
  const id3 = (await create(e.cookie, f.id)).json().duel.id as string;
  await expire(id3);
  assert.equal((await env.prisma.game.findUniqueOrThrow({ where: { id: id3 } })).status, "ABANDONED");
  assert.equal(await xpOf(e.id), 0);

  // Idempotent : une seconde exécution ne redistribue rien
  assert.equal(await expireDueDuels(env.prisma), 0);
  assert.equal(await xpOf(a.id), 60);
});

test("l'expiration s'applique aussi à la lecture, sans balayage préalable", async () => {
  const [a, b] = [await player(), await player()];
  const id = (await create(a.cookie, b.id)).json().duel.id as string;
  const g = await env.prisma.game.findUniqueOrThrow({ where: { id } });
  await env.prisma.game.update({ where: { id }, data: { config: JSON.stringify({ ...JSON.parse(g.config), deadlineAt: new Date(Date.now() - 1000).toISOString() }) } });
  const d = await detail(a.cookie, id);
  assert.notEqual(d.duel.status, "IN_PROGRESS");
});

test("abandon : l'adversaire gagne +40 s'il a joué ; sinon aucun bonus", async () => {
  const [a, b] = [await player(), await player()];
  const id = (await create(a.cookie, b.id)).json().duel.id as string;
  await playRound(a.cookie, id); // 2 bonnes réponses = 20 XP
  const r = await call(env, b.cookie, "POST", `/api/duels/${id}/forfeit`);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().duel.result, "FORFEIT");
  assert.equal(await xpOf(a.id), 20 + 40);
  assert.equal(await xpOf(b.id), 0);
  assert.equal((await call(env, b.cookie, "POST", `/api/duels/${id}/forfeit`)).statusCode, 409);

  const [c, d] = [await player(), await player()];
  const id2 = (await create(c.cookie, d.id)).json().duel.id as string;
  await call(env, c.cookie, "POST", `/api/duels/${id2}/forfeit`);
  assert.equal((await env.prisma.game.findUniqueOrThrow({ where: { id: id2 } })).status, "ABANDONED");
  assert.equal(await xpOf(d.id), 0);
});

test("chronomètre propre à chaque joueur : temps écoulé = faux, même après un rechargement", async () => {
  await settings({ roundsPerDuel: 1, questionsPerRound: 1, timePerQuestionSec: 1 });
  const [a, b] = [await player(), await player()];
  const id = (await create(a.cookie, b.id)).json().duel.id as string;
  const cur = (await call(env, a.cookie, "GET", `/api/duels/${id}/current`)).json();
  assert.ok(cur.question.remainingMs <= 1000);
  await new Promise((r) => setTimeout(r, 2700));
  const late = await call(env, a.cookie, "POST", `/api/duels/${id}/answer`, { gameQuestionId: cur.question.gameQuestionId, choiceIndex: await correctOf(cur.question.gameQuestionId) });
  assert.equal(late.json().timedOut, true);
  assert.equal(late.json().correct, false);
  // B n'a pas vu la question : son chrono démarre à sa propre première consultation
  const curB = (await call(env, b.cookie, "GET", `/api/duels/${id}/current`)).json();
  assert.ok(curB.question.remainingMs > 500);
  await settings({ roundsPerDuel: 4, questionsPerRound: 2, timePerQuestionSec: 30 });
});

test("liste de mes duels : à mon tour / en attente, accès réservé aux membres", async () => {
  const [a, b] = [await player(), await player()];
  await create(a.cookie, b.id);
  const la = (await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/duels`)).json();
  const lb = (await call(env, b.cookie, "GET", `/api/subjects/${subjectId}/duels`)).json();
  assert.equal(la.yourTurnCount, 1);
  assert.equal(lb.yourTurnCount, 0);
  assert.equal(lb.duels[0].opponent.username, (await env.prisma.user.findUniqueOrThrow({ where: { id: a.id } })).username);
  const outsider = await player("histoire");
  assert.equal((await call(env, outsider.cookie, "GET", `/api/subjects/${subjectId}/duels`)).statusCode, 403);
  assert.equal((await call(env, outsider.cookie, "GET", `/api/duels/${la.duels[0].id}`)).statusCode, 404);
});
