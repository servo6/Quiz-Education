import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv, joinSubject } from "./helpers.ts";

let env: TestEnv;
let subjectId: string;
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  const admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Chimie" })).json().subject.id;
  await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(12, "A"), newChapterName: "A" });
});
after(async () => { await env.close(); });

async function member(name: string) { const u = await register(env, name); await joinSubject(env, u.cookie, "chimie"); return u; }

test("examen : démarrage, reprise, sauvegarde, remise, note et correction", async () => {
  const u = await member("exam_u");
  const info = (await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/exam`)).json();
  assert.deepEqual(info.sizes, [10]);
  assert.equal((await call(env, u.cookie, "POST", `/api/subjects/${subjectId}/exam`, { size: 3 })).statusCode, 400);
  assert.equal(info.chapters.length >= 1 && info.chapters[0].count >= 5, true);
  const e = (await call(env, u.cookie, "POST", `/api/subjects/${subjectId}/exam`, { size: 10 })).json();
  assert.equal(e.questions.length, 10);
  assert.equal(e.durationSec, 600);
  assert.equal("answerIndex" in e.questions[0], false);
  // une seconde demande reprend le même examen
  assert.equal((await call(env, u.cookie, "POST", `/api/subjects/${subjectId}/exam`, { size: 10 })).json().id, e.id);
  // pas de correction avant la remise
  assert.equal((await call(env, u.cookie, "GET", `/api/exam/${e.id}`)).statusCode, 409);
  // un autre joueur n'y a pas accès
  const other = await member("exam_o");
  assert.equal((await call(env, other.cookie, "GET", `/api/exam/${e.id}`)).statusCode, 404);
  const answers: Record<string, number | null> = {};
  e.questions.forEach((q: { id: string }, i: number) => { answers[q.id] = i < 5 ? 0 : null; });
  assert.equal((await call(env, u.cookie, "PUT", `/api/exam/${e.id}/answers`, { answers })).statusCode, 200);
  assert.deepEqual((await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/exam/current`)).json().answers, answers);
  const res = (await call(env, u.cookie, "POST", `/api/exam/${e.id}/submit`, {})).json();
  assert.equal(res.total, 10);
  assert.equal(res.blank, 5);
  assert.equal(res.corrections.length, 10);
  assert.equal(res.grade, Math.round((res.correct / 10) * 200) / 10);
  assert.equal(res.corrections.filter((c: { correct: boolean }) => c.correct).length, res.correct);
  assert.equal((await call(env, u.cookie, "PUT", `/api/exam/${e.id}/answers`, { answers })).statusCode, 409);
  assert.equal((await call(env, u.cookie, "GET", `/api/exam/${e.id}`)).statusCode, 200);
  assert.equal((await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/exam`)).json().history[0].id, e.id);
});

test("examen : le temps écoulé remet l'examen automatiquement", async () => {
  const u = await member("exam_t");
  const e = (await call(env, u.cookie, "POST", `/api/subjects/${subjectId}/exam`, { size: 10 })).json();
  await env.prisma.examAttempt.update({ where: { id: e.id }, data: { startedAt: new Date(Date.now() - 700_000) } });
  assert.equal((await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/exam/current`)).json().id, null);
  const r = (await call(env, u.cookie, "GET", `/api/exam/${e.id}`)).json();
  assert.equal(r.blank, 10);
  assert.equal(r.grade, 0);
});

test("examen : limité aux chapitres choisis", async () => {
  const admin = await login(env, ADMIN.username, ADMIN.password);
  const second = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(6, "B"), newChapterName: "Seconde" })).json().chapterId;
  const u = await member("exam_c");
  const info = (await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/exam`)).json();
  assert.equal(info.chapters.length, 2);
  const e = (await call(env, u.cookie, "POST", `/api/subjects/${subjectId}/exam`, { size: 5, chapterIds: [second] })).json();
  assert.equal(e.questions.length, 5);
  const rows = await env.prisma.question.findMany({ where: { id: { in: e.questions.map((q: { id: string }) => q.id) } } });
  assert.ok(rows.every((q) => q.chapterId === second));
});
