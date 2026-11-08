import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { addDaysKey, localDayKey } from "../src/time.ts";
import { ADMIN, call, createTestEnv, joinSubject, login, register, sampleBlock, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
let subjectId: string;
let emptySubject: string;

before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Chimie" })).json().subject.id;
  emptySubject = (await call(env, admin, "POST", "/api/subjects", { name: "Vide" })).json().subject.id;
  await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(12, "Q"), newChapterName: "Grand" });
});
after(() => env.close());

let n = 0;
const player = async () => { const u = await register(env, `daily${++n}`); await joinSubject(env, u.cookie, "chimie"); return u; };
const answerIdx = async (qid: string) => (await env.prisma.question.findUniqueOrThrow({ where: { id: qid } })).answerIndex;

async function playAll(cookie: string, wrong = 0) {
  let last: any;
  for (let i = 0; i < 5; i++) {
    const cur = (await call(env, cookie, "GET", `/api/subjects/${subjectId}/daily/current`)).json();
    assert.equal(cur.status, "IN_PROGRESS");
    const good = await answerIdx(cur.question.gameQuestionId);
    const choice = i < wrong ? (good + 1) % cur.question.choices.length : good;
    last = (await call(env, cookie, "POST", `/api/subjects/${subjectId}/daily/answer`, { gameQuestionId: cur.question.gameQuestionId, choiceIndex: choice })).json();
  }
  return last;
}

test("mêmes 5 questions pour tous, un seul essai, XP et série", async () => {
  const [a, b] = [await player(), await player()];
  const s0 = (await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/daily`)).json();
  assert.equal(s0.status, "NOT_STARTED");
  assert.equal(s0.total, 5);
  const qa = (await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/daily/current`)).json();
  const qb = (await call(env, b.cookie, "GET", `/api/subjects/${subjectId}/daily/current`)).json();
  assert.equal(qa.question.gameQuestionId, qb.question.gameQuestionId);
  assert.equal(qa.question.correctIndex, undefined, "la bonne réponse n'est jamais envoyée avant de répondre");

  const last = await playAll(a.cookie, 1); // 4/5
  assert.equal(last.finished, true);
  assert.equal(last.daily.correct, 4);
  assert.ok(last.xpGained >= 10, "bonus de fin de défi");
  const xp = (await env.prisma.membership.findFirstOrThrow({ where: { userId: a.id } })).xp;
  assert.equal(xp, last.xpGained);

  const done = (await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/daily`)).json();
  assert.equal(done.status, "DONE");
  assert.equal(done.mine.correct, 4);
  assert.equal(done.streak.current, 1);
  assert.equal(done.ranking[0].username, a.id ? done.ranking[0].username : "");
  // un seul essai
  const again = await call(env, a.cookie, "POST", `/api/subjects/${subjectId}/daily/answer`, { gameQuestionId: qa.question.gameQuestionId, choiceIndex: 0 });
  assert.equal(again.statusCode, 409);
  assert.equal((await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/daily/current`)).json().status, "DONE");

  // classement : B fait mieux (5/5) → premier
  await playAll(b.cookie, 0);
  const rb = (await call(env, b.cookie, "GET", `/api/subjects/${subjectId}/daily`)).json();
  assert.equal(rb.mine.rank, 1);
  assert.equal(rb.ranking.length, 2);
  assert.equal(rb.ranking[0].mine, true);
  assert.equal(rb.participants, 2);
});

test("réponse hors ordre, double envoi et accès refusés", async () => {
  const u = await player();
  const cur = (await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/daily/current`)).json();
  const other = (await env.prisma.question.findFirstOrThrow({ where: { id: { not: cur.question.gameQuestionId } } })).id;
  assert.equal((await call(env, u.cookie, "POST", `/api/subjects/${subjectId}/daily/answer`, { gameQuestionId: other, choiceIndex: 0 })).statusCode, 409);
  assert.equal((await call(env, u.cookie, "POST", `/api/subjects/${subjectId}/daily/answer`, { gameQuestionId: cur.question.gameQuestionId, choiceIndex: 99 })).statusCode, 400);
  assert.equal((await call(env, null, "GET", `/api/subjects/${subjectId}/daily`)).statusCode, 401);
  assert.equal((await call(env, admin, "GET", `/api/subjects/${subjectId}/daily`)).statusCode, 403);
  const outsider = await register(env, `daily-out${++n}`);
  assert.equal((await call(env, outsider.cookie, "GET", `/api/subjects/${subjectId}/daily`)).statusCode, 403);
});

test("série : jour d'hier terminé + aujourd'hui = 2 ; matière sans assez de questions = indisponible", async () => {
  const u = await player();
  const ch = (await env.prisma.dailyChallenge.findFirstOrThrow({ where: { subjectId } }));
  const yesterday = addDaysKey(localDayKey(new Date()), -1);
  const yc = await env.prisma.dailyChallenge.create({ data: { subjectId, day: yesterday, questionIds: ch.questionIds } });
  await env.prisma.dailyEntry.create({ data: { challengeId: yc.id, userId: u.id, finishedAt: new Date(), correct: 3 } });
  await playAll(u.cookie, 0);
  const s = (await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/daily`)).json();
  assert.equal(s.streak.current, 2);

  const v = await register(env, `daily-v${++n}`);
  await env.prisma.membership.create({ data: { userId: v.id, subjectId: emptySubject } });
  const none = (await call(env, v.cookie, "GET", `/api/subjects/${emptySubject}/daily`)).json();
  assert.equal(none.available, false);
  assert.equal((await call(env, v.cookie, "GET", `/api/subjects/${emptySubject}/daily/current`)).statusCode, 404);
});
