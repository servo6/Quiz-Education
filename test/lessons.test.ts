import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv, joinSubject } from "./helpers.ts";

let env: TestEnv;
let subjectId: string;
let chapterId: string;
let admin: string;
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Chimie" })).json().subject.id;
  chapterId = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(4, "A"), newChapterName: "A" })).json().chapterId;
});
after(async () => { await env.close(); });

test("cours : rédigé par un responsable, lu par un membre via une question, refusé aux joueurs", async () => {
  const u = await register(env, "less_u");
  await joinSubject(env, u.cookie, "chimie");
  const q = await env.prisma.question.findFirstOrThrow({ where: { chapterId } });
  assert.equal((await call(env, u.cookie, "GET", `/api/questions/${q.id}/lesson`)).json().lesson, null);
  assert.equal((await call(env, u.cookie, "PUT", `/api/chapters/${chapterId}/lesson`, { lesson: "x" })).statusCode, 403);
  assert.equal((await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/lessons`)).statusCode, 403);
  assert.equal((await call(env, admin, "PUT", `/api/chapters/${chapterId}/lesson`, { lesson: "  Rappel : $n = CV$  " })).statusCode, 200);
  const r = (await call(env, u.cookie, "GET", `/api/questions/${q.id}/lesson`)).json();
  assert.equal(r.lesson, "Rappel : $n = CV$");
  assert.equal(r.chapter.name, "A");
  const list = (await call(env, admin, "GET", `/api/subjects/${subjectId}/lessons`)).json();
  assert.equal(list.chapters[0].lesson, "Rappel : $n = CV$");
  assert.equal((await call(env, admin, "PUT", `/api/chapters/${chapterId}/lesson`, { lesson: "" })).statusCode, 200);
  assert.equal((await call(env, u.cookie, "GET", `/api/questions/${q.id}/lesson`)).json().lesson, null);
});
