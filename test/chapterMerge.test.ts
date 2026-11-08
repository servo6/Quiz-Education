import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
let subjectId: string;
before(async () => { env = await createTestEnv(); await seedAdmin(env); admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Chimie" })).json().subject.id; });
after(async () => { await env.close(); });

test("chapitres : fusion en un seul chapitre, questions déplacées, doublons retirés", async () => {
  const a = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(5, "A"), newChapterName: "Acides" })).json().chapterId;
  const b = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(5, "B"), newChapterName: "Bases" })).json().chapterId;
  const c = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(3, "C"), newChapterName: "Sels" })).json().chapterId;
  await call(env, admin, "PUT", `/api/chapters/${a}/lesson`, { lesson: "Cours acides" });
  await call(env, admin, "PUT", `/api/chapters/${b}/lesson`, { lesson: "Cours bases" });
  // un seul chapitre ou un nom déjà pris : refusé
  assert.equal((await call(env, admin, "POST", `/api/subjects/${subjectId}/chapters/merge`, { chapterIds: [a], name: "X" })).statusCode, 400);
  assert.equal((await call(env, admin, "POST", `/api/subjects/${subjectId}/chapters/merge`, { chapterIds: [a, b], name: "Sels" })).statusCode, 409);
  // un joueur ne peut pas fusionner
  const u = await register(env, "merge_u");
  assert.equal((await call(env, u.cookie, "POST", `/api/subjects/${subjectId}/chapters/merge`, { chapterIds: [a, b], name: "X" })).statusCode, 403);
  const r = await call(env, admin, "POST", `/api/subjects/${subjectId}/chapters/merge`, { chapterIds: [a, b], name: "Acides et bases" });
  assert.equal(r.statusCode, 200);
  const merged = r.json();
  assert.equal(merged.chapter.name, "Acides et bases");
  assert.equal(merged.questions + merged.duplicatesRemoved, 10);
  const list = (await call(env, admin, "GET", `/api/subjects/${subjectId}/chapters`)).json().chapters;
  assert.deepEqual(list.map((x: { name: string }) => x.name).sort(), ["Acides et bases", "Sels"]);
  assert.equal(list.find((x: { name: string }) => x.name === "Acides et bases").questionCount, merged.questions);
  const lessons = (await call(env, admin, "GET", `/api/subjects/${subjectId}/lessons`)).json().chapters;
  assert.equal(lessons.find((x: { name: string }) => x.name === "Acides et bases").lesson, "Cours acides\n\nCours bases");
  // fusion vers le nom d'un des chapitres : on garde ce chapitre
  const r2 = await call(env, admin, "POST", `/api/subjects/${subjectId}/chapters/merge`, { chapterIds: [merged.chapter.id, c], name: "Sels" });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().chapter.id, c);
  assert.equal(r2.json().questions, merged.questions + 3);
});
