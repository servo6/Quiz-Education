import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, joinSubject, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
let subjectId: string;
let chapter: string;

before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Chimie" })).json().subject.id;
  chapter = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(20, "G"), newChapterName: "G" })).json().chapterId;
  await call(env, admin, "PATCH", `/api/subjects/${subjectId}`, { settings: { soloGamesPerDay: 0, timePerQuestionSec: 0, survivalTimePerQuestionSec: 0 } });
});
after(() => env.close());

async function player(name: string) {
  const u = await register(env, name);
  await joinSubject(env, u.cookie, "chimie");
  return u;
}
const start = (cookie: string, mode?: string) => call(env, cookie, "POST", "/api/solo/start", { subjectId, chapterId: chapter, mode });
const good = async (gq: string) => (await env.prisma.gameQuestion.findUniqueOrThrow({ where: { id: gq }, include: { question: true } })).question.answerIndex;
const bad = async (gq: string) => ((await good(gq)) + 1) % 4;

test("survie : 3 cœurs, 15 questions, la partie s'arrête au 3e cœur perdu", async () => {
  const p = await player("surv1");
  const r = (await start(p.cookie, "SURVIVAL")).json();
  assert.equal(r.game.total, 15);
  assert.equal(r.question.hearts, 3);
  let q = r.question;
  for (let i = 1; i <= 3; i++) {
    const a = (await call(env, p.cookie, "POST", `/api/solo/${r.game.id}/answer`, { gameQuestionId: q.gameQuestionId, choiceIndex: await bad(q.gameQuestionId) })).json();
    assert.equal(a.hearts, 3 - i);
    assert.equal(a.finished, i === 3);
    q = a.next;
    if (q) await call(env, p.cookie, "GET", `/api/solo/${r.game.id}/current`);
  }
  assert.equal(q, null);
  const res = (await call(env, p.cookie, "GET", `/api/solo/${r.game.id}/result`)).json();
  assert.equal(res.variant, "SURVIVAL");
  assert.equal(res.answered, 3);
});

test("survie : les bonnes réponses ne coûtent pas de cœur, XP propre au mode", async () => {
  await call(env, admin, "PATCH", `/api/subjects/${subjectId}`, { settings: { survivalXpPerCorrect: 7, survivalQuestions: 4 } });
  const p = await player("surv2");
  const r = (await start(p.cookie, "SURVIVAL")).json();
  let q = r.question; let last: any;
  while (q) {
    last = (await call(env, p.cookie, "POST", `/api/solo/${r.game.id}/answer`, { gameQuestionId: q.gameQuestionId, choiceIndex: await good(q.gameQuestionId) })).json();
    assert.equal(last.xpGained, 7);
    assert.equal(last.hearts, 3);
    q = last.next;
    if (q) await call(env, p.cookie, "GET", `/api/solo/${r.game.id}/current`);
  }
  assert.equal(last.finished, true);
});

test("contre la montre : chrono global, pas de total fixe, clôture automatique", async () => {
  await call(env, admin, "PATCH", `/api/subjects/${subjectId}`, { settings: { attackDurationSec: 10, attackMaxQuestions: 5 } });
  const p = await player("att1");
  const r = (await start(p.cookie, "TIMEATTACK")).json();
  assert.equal(r.question.variant, "TIMEATTACK");
  assert.ok(r.question.remainingMs > 8000 && r.question.remainingMs <= 10000);
  const a = (await call(env, p.cookie, "POST", `/api/solo/${r.game.id}/answer`, { gameQuestionId: r.question.gameQuestionId, choiceIndex: await good(r.question.gameQuestionId) })).json();
  assert.equal(a.correct, true);
  assert.equal(a.finished, false);
  // le temps est écoulé : la partie est clôturée dès qu'on regarde l'état ou le résultat
  const game = await env.prisma.game.findUniqueOrThrow({ where: { id: r.game.id } });
  const cfg = JSON.parse(game.config);
  cfg.deadlineAt = Date.now() - 5000;
  await env.prisma.game.update({ where: { id: game.id }, data: { config: JSON.stringify(cfg) } });
  const { runningGameListeners } = await import("../src/runningGames.ts");
  for (const f of runningGameListeners) f();
  const res = (await call(env, p.cookie, "GET", `/api/solo/${r.game.id}/result`)).json();
  assert.equal(res.variant, "TIMEATTACK");
  assert.equal(res.correct, 1);
  assert.equal(res.total, 1);
});

test("contre la montre : une réponse tardive est comptée hors délai", async () => {
  const p = await player("att2");
  const r = (await start(p.cookie, "TIMEATTACK")).json();
  const game = await env.prisma.game.findUniqueOrThrow({ where: { id: r.game.id } });
  const cfg = JSON.parse(game.config);
  cfg.deadlineAt = Date.now() - 5000;
  await env.prisma.game.update({ where: { id: game.id }, data: { config: JSON.stringify(cfg) } });
  const { runningGameListeners } = await import("../src/runningGames.ts");
  for (const f of runningGameListeners) f();
  const a = (await call(env, p.cookie, "POST", `/api/solo/${r.game.id}/answer`, { gameQuestionId: r.question.gameQuestionId, choiceIndex: await good(r.question.gameQuestionId) })).json();
  assert.equal(a.correct, false);
  assert.equal(a.timedOut, true);
  assert.equal(a.finished, true);
});

test("mode désactivé : 403 ; aventure inchangée par défaut ; statut expose les modes", async () => {
  const p = await player("modes1");
  const st = (await call(env, p.cookie, "GET", `/api/subjects/${subjectId}/solo/status`)).json();
  assert.equal(st.modes.SURVIVAL.hearts, 3);
  assert.equal(st.modes.TIMEATTACK.enabled, true);
  await call(env, admin, "PATCH", `/api/subjects/${subjectId}`, { settings: { survivalEnabled: false } });
  assert.equal((await start(p.cookie, "SURVIVAL")).statusCode, 403);
  const adv = await start(p.cookie);
  assert.equal(adv.statusCode, 201);
  assert.equal(adv.json().question.variant, "ADVENTURE");
  assert.equal(adv.json().game.total, 10);
});
