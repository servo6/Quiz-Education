import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, joinSubject, login, register, sampleBlock, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
let subjectId: string;
let qid: string;
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Chimie" })).json().subject.id;
  await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(5, "Q"), newChapterName: "Grand" });
  qid = (await env.prisma.question.findFirstOrThrow({ where: { chapter: { subjectId } } })).id;
});
after(() => env.close());

test("un joueur signale, le responsable voit la liste regroupée et la clôt", async () => {
  const a = await register(env, "rep-a"), b = await register(env, "rep-b"), out = await register(env, "rep-out");
  await joinSubject(env, a.cookie, "chimie"); await joinSubject(env, b.cookie, "chimie");
  const url = `/api/questions/${qid}/report`;
  assert.equal((await call(env, null, "POST", url, { reason: "TYPO" })).statusCode, 401);
  assert.equal((await call(env, out.cookie, "POST", url, { reason: "TYPO" })).statusCode, 403);
  assert.equal((await call(env, a.cookie, "POST", url, { reason: "NOPE" })).statusCode, 400);
  assert.equal((await call(env, a.cookie, "POST", url, { reason: "WRONG_ANSWER", comment: "La bonne réponse est B" })).statusCode, 200);
  assert.equal((await call(env, a.cookie, "POST", url, { reason: "WRONG_ANSWER", comment: "Après relecture, B" })).statusCode, 200); // pas de doublon
  assert.equal((await call(env, b.cookie, "POST", url, { reason: "AMBIGUOUS" })).statusCode, 200);
  assert.equal(await env.prisma.questionReport.count({ where: { questionId: qid } }), 2);
  assert.equal((await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/reports`)).statusCode, 403); // réservé aux responsables

  const list = (await call(env, admin, "GET", `/api/subjects/${subjectId}/reports`)).json();
  assert.equal(list.openCount, 2);
  assert.equal(list.reports.length, 1);
  assert.equal(list.reports[0].count, 2);
  assert.deepEqual(list.reports[0].reasons, { WRONG_ANSWER: 1, AMBIGUOUS: 1 });
  assert.equal(list.reports[0].comments[0].comment.length > 0, true);

  const closed = (await call(env, admin, "POST", `/api/subjects/${subjectId}/reports/${qid}/resolve`, { status: "RESOLVED" })).json();
  assert.equal(closed.closed, 2);
  assert.equal((await call(env, admin, "GET", `/api/subjects/${subjectId}/reports`)).json().reports.length, 0);
  assert.equal((await call(env, admin, "GET", `/api/subjects/${subjectId}/reports?status=all`)).json().reports.length, 1);
  // un nouveau signalement rouvre le dossier
  await call(env, a.cookie, "POST", url, { reason: "TYPO" });
  assert.equal((await call(env, admin, "GET", `/api/subjects/${subjectId}/reports`)).json().openCount, 1);
});

test("on peut aussi signaler via l'identifiant de question de partie", async () => {
  const u = await register(env, "rep-gq");
  await joinSubject(env, u.cookie, "chimie");
  const chapterId = (await env.prisma.chapter.findFirstOrThrow({ where: { subjectId } })).id;
  await call(env, admin, "PATCH", `/api/subjects/${subjectId}`, { settings: { soloQuestions: 3, soloGamesPerDay: 0 } });
  const s = (await call(env, u.cookie, "POST", "/api/solo/start", { subjectId, chapterId })).json();
  const r = await call(env, u.cookie, "POST", `/api/questions/${s.question.gameQuestionId}/report`, { reason: "OTHER" });
  assert.equal(r.statusCode, 200);
  assert.equal((await call(env, u.cookie, "POST", `/api/questions/inconnue/report`, { reason: "OTHER" })).statusCode, 404);
});
