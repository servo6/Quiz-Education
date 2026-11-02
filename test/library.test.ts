import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
let subjectId: string;
let otherId: string;
let chapterId: string;
let chapter2Id: string;
let counter = 0;

before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
  const mk = async (name: string, accessName: string) =>
    (await call(env, admin, "POST", "/api/subjects", { name, accessName, accessPassword: "acces-123" })).json().subject.id as string;
  subjectId = await mk("Chimie", "chimie");
  otherId = await mk("Histoire", "histoire");
  const imp = async (sid: string, name: string, n: number) =>
    (await call(env, admin, "POST", `/api/subjects/${sid}/import/commit`, { raw: sampleBlock(n, name), newChapterName: name })).json();
  chapterId = (await imp(subjectId, "A", 6)).chapterId;
  chapter2Id = (await imp(subjectId, "B", 4)).chapterId;
});
after(() => env.close());

const list = async (cookie: string, id: string, query = "") => (await call(env, cookie, "GET", `/api/chapters/${id}/questions${query}`)).json();
async function manager(sid = subjectId) {
  const u = await register(env, `lib-${++counter}`);
  await call(env, admin, "PUT", `/api/subjects/${sid}/managers/${u.id}`);
  return { ...u, cookie: await login(env, `lib-${counter}`, "password-123") };
}

test("liste des questions : pagination, recherche, droits", async () => {
  const mgr = await manager();
  const foreign = await manager(otherId);
  const player = await register(env, `lib-${++counter}`);
  assert.equal((await call(env, player.cookie, "GET", `/api/chapters/${chapterId}/questions`)).statusCode, 403);
  assert.equal((await call(env, foreign.cookie, "GET", `/api/chapters/${chapterId}/questions`)).statusCode, 403);
  assert.equal((await call(env, mgr.cookie, "GET", `/api/chapters/inconnu/questions`)).statusCode, 404);

  const all = await list(mgr.cookie, chapterId);
  assert.equal(all.questions.length, 6);
  assert.equal(all.nextCursor, null);
  assert.deepEqual(Object.keys(all.questions[0]).sort(), ["answer", "batchId", "choices", "createdAt", "deletedAt", "explanation", "id", "question", "stats"]);

  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const p: any = await list(mgr.cookie, chapterId, `?limit=4${cursor ? `&cursor=${cursor}` : ""}`);
    seen.push(...p.questions.map((q: any) => q.id));
    cursor = p.nextCursor;
  } while (cursor);
  assert.equal(new Set(seen).size, 6);

  const needle = all.questions[2].question.slice(0, 20).toUpperCase();
  assert.ok((await list(mgr.cookie, chapterId, `?q=${encodeURIComponent(needle)}`)).questions.length >= 1);
  assert.equal((await list(mgr.cookie, chapterId, "?q=zzzzzzzzzz")).questions.length, 0);
});

test("modification d'une question : validation, doublon, déplacement, journal", async () => {
  const mgr = await manager();
  const qs = (await list(mgr.cookie, chapterId)).questions;
  const q = qs[0];

  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/questions/${q.id}`, {})).statusCode, 400);
  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/questions/${q.id}`, { inconnu: 1 })).statusCode, 400);
  const bad = await call(env, mgr.cookie, "PATCH", `/api/questions/${q.id}`, { answer: 9 });
  assert.equal(bad.statusCode, 422);
  assert.equal(bad.json().error.code, "invalid_question");
  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/questions/${q.id}`, { choices: ["seul"] })).statusCode, 422);
  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/questions/${q.id}`, { question: qs[1].question })).statusCode, 409);

  const ok = await call(env, mgr.cookie, "PATCH", `/api/questions/${q.id}`, { question: "  Nouvelle   question ? ", choices: ["a", "b", "c"], answer: 2, explanation: "Parce que." });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().question.question, "Nouvelle question ?");
  assert.equal(ok.json().question.answer, 2);
  assert.equal(ok.json().question.explanation, "Parce que.");
  // effacer l'explication
  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/questions/${q.id}`, { explanation: null })).json().question.explanation, null);
  // la question modifiée n'est plus un doublon de son ancien texte
  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/questions/${qs[1].id}`, { question: q.question })).statusCode, 200);

  // déplacement
  const moved = await call(env, mgr.cookie, "PATCH", `/api/questions/${q.id}`, { chapterId: chapter2Id });
  assert.equal(moved.json().question.chapterId, chapter2Id);
  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/questions/${q.id}`, { chapterId: "inconnu" })).statusCode, 404);
  const foreignChapter = (await call(env, admin, "POST", `/api/subjects/${otherId}/chapters`, { name: "Autre" })).json().chapter.id;
  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/questions/${q.id}`, { chapterId: foreignChapter })).statusCode, 404);

  const foreign = await manager(otherId);
  assert.equal((await call(env, foreign.cookie, "PATCH", `/api/questions/${q.id}`, { answer: 0 })).statusCode, 403);
  assert.ok(await env.prisma.adminLog.findFirst({ where: { action: "UPDATE_QUESTION", subjectId } }));
});

test("suppression et restauration d'une question", async () => {
  const mgr = await manager();
  const q = (await list(mgr.cookie, chapter2Id)).questions[1];
  assert.equal((await call(env, mgr.cookie, "DELETE", `/api/questions/${q.id}`)).statusCode, 200);
  assert.equal((await call(env, mgr.cookie, "DELETE", `/api/questions/${q.id}`)).statusCode, 409);
  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/questions/${q.id}`, { answer: 0 })).statusCode, 409);
  assert.ok(!(await list(mgr.cookie, chapter2Id)).questions.some((x: any) => x.id === q.id));
  assert.ok((await list(mgr.cookie, chapter2Id, "?deleted=only")).questions.some((x: any) => x.id === q.id));
  assert.ok((await list(mgr.cookie, chapter2Id, "?deleted=all")).questions.some((x: any) => x.id === q.id));

  assert.equal((await call(env, mgr.cookie, "POST", `/api/questions/${q.id}/restore`)).statusCode, 200);
  assert.equal((await call(env, mgr.cookie, "POST", `/api/questions/${q.id}/restore`)).statusCode, 409);

  // restauration impossible si un doublon actif existe entre-temps
  await call(env, mgr.cookie, "DELETE", `/api/questions/${q.id}`);
  await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: JSON.stringify([{ question: q.question, choices: ["x", "y"], answer: 0 }]), chapterId: chapter2Id });
  const dup = await call(env, mgr.cookie, "POST", `/api/questions/${q.id}/restore`);
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().error.code, "duplicate_question");
});

test("lots, restauration d'un lot et d'un chapitre, corbeille, purge", async () => {
  const mgr = await manager();
  const ch = (await call(env, admin, "POST", `/api/subjects/${subjectId}/chapters`, { name: "Temporaire" })).json().chapter.id;
  const imp1 = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(3, "lot1"), chapterId: ch })).json();
  const imp2 = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(2, "lot2"), chapterId: ch })).json();
  const batches = (await call(env, mgr.cookie, "GET", `/api/chapters/${ch}/batches`)).json().batches;
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((b: any) => b.activeCount).sort(), [2, 3]);
  assert.ok(batches[0].importedBy.username);

  // lot supprimé puis restauré
  const b1 = imp1.batchId as string;
  await call(env, mgr.cookie, "DELETE", `/api/batches/${b1}`);
  assert.equal((await list(mgr.cookie, ch)).questions.length, 2);
  const trash = (await call(env, mgr.cookie, "GET", `/api/subjects/${subjectId}/trash`)).json();
  assert.equal(trash.batches.length, 1);
  const r = await call(env, mgr.cookie, "POST", `/api/batches/${b1}/restore`);
  assert.deepEqual(r.json(), { restored: 3, skippedDuplicates: 0 });
  assert.equal((await call(env, mgr.cookie, "POST", `/api/batches/${b1}/restore`)).statusCode, 409);
  assert.equal((await list(mgr.cookie, ch)).questions.length, 5);
  void imp2;

  // chapitre supprimé puis restauré
  await call(env, mgr.cookie, "DELETE", `/api/chapters/${ch}`);
  const t2 = (await call(env, mgr.cookie, "GET", `/api/subjects/${subjectId}/trash`)).json();
  assert.equal(t2.chapters.find((c: any) => c.id === ch).questions, 5);
  const rc = await call(env, mgr.cookie, "POST", `/api/chapters/${ch}/restore`);
  assert.deepEqual(rc.json(), { restored: 5, skippedDuplicates: 0 });
  assert.equal((await call(env, mgr.cookie, "POST", `/api/chapters/${ch}/restore`)).statusCode, 409);
  assert.equal((await list(mgr.cookie, ch)).questions.length, 5);
  assert.equal((await call(env, mgr.cookie, "GET", "/api/subjects/" + subjectId + "/chapters")).json().chapters.some((c: any) => c.id === ch), true);

  // purge : on supprime des questions, l'une d'elles a été jouée et doit rester
  const qs = (await list(mgr.cookie, ch)).questions;
  const played = qs[0];
  const g = await env.prisma.game.create({ data: { subjectId, mode: "SOLO", status: "FINISHED" } });
  const round = await env.prisma.round.create({ data: { gameId: g.id, number: 1, chapterId: ch } });
  await env.prisma.gameQuestion.create({ data: { gameId: g.id, roundId: round.id, position: 1, questionId: played.id } });
  for (const q of qs.slice(0, 3)) await call(env, mgr.cookie, "DELETE", `/api/questions/${q.id}`);

  const none = await call(env, mgr.cookie, "POST", `/api/subjects/${subjectId}/trash/purge`, {}); // 30 jours par défaut : rien n'est assez vieux
  assert.equal(none.json().questions, 0);
  const player = await register(env, `lib-${++counter}`);
  assert.equal((await call(env, player.cookie, "POST", `/api/subjects/${subjectId}/trash/purge`, { olderThanDays: 0 })).statusCode, 403);
  const purged = await call(env, mgr.cookie, "POST", `/api/subjects/${subjectId}/trash/purge`, { olderThanDays: 0 });
  assert.ok(purged.json().questions >= 2);
  assert.ok(await env.prisma.question.findUnique({ where: { id: played.id } })); // jouée : conservée
  assert.equal(await env.prisma.question.findUnique({ where: { id: qs[1].id } }), null);
  assert.equal(await env.prisma.question.findUnique({ where: { id: qs[2].id } }), null);
  assert.ok(purged.json().keptBecausePlayed >= 1);
  assert.ok(await env.prisma.adminLog.findFirst({ where: { action: "PURGE_TRASH" } }));
});

test("export au format d'import, ré-importable", async () => {
  const mgr = await manager();
  const exp = (await call(env, mgr.cookie, "GET", `/api/subjects/${subjectId}/export`)).json();
  assert.equal(exp.subject, "Chimie");
  const a = exp.chapters.find((c: any) => c.name === "A");
  assert.ok(a.questions.length >= 4);
  assert.deepEqual(Object.keys(a.questions[0]).sort().filter((k) => k !== "explanation"), ["answer", "choices", "question"]);

  // ré-import dans une autre matière : tout est accepté
  const re = await call(env, admin, "POST", `/api/subjects/${otherId}/import/commit`, { raw: JSON.stringify({ questions: a.questions }), newChapterName: "Copie" });
  assert.equal(re.statusCode, 201, re.body);
  assert.equal(re.json().imported, a.questions.length);

  const one = (await call(env, mgr.cookie, "GET", `/api/subjects/${subjectId}/export?chapterId=${chapterId}`)).json();
  assert.equal(one.chapters.length, 1);
  assert.equal((await call(env, mgr.cookie, "GET", `/api/subjects/${subjectId}/export?chapterId=inconnu`)).statusCode, 404);
  const foreign = await manager(otherId);
  assert.equal((await call(env, foreign.cookie, "GET", `/api/subjects/${subjectId}/export`)).statusCode, 403);
  assert.equal(JSON.stringify(exp).includes("passwordHash"), false);
});

test("statistiques par question : taux de réussite visible dans la liste", async () => {
  const mgr = await manager();
  const q = (await list(mgr.cookie, chapterId)).questions[0];
  const u = await register(env, `lib-${++counter}`);
  const g = await env.prisma.game.create({ data: { subjectId, mode: "SOLO", status: "FINISHED" } });
  const round = await env.prisma.round.create({ data: { gameId: g.id, number: 1, chapterId } });
  const gq = await env.prisma.gameQuestion.create({ data: { gameId: g.id, roundId: round.id, position: 1, questionId: q.id } });
  await env.prisma.answer.create({ data: { gameQuestionId: gq.id, userId: u.id, choiceIndex: 0, isCorrect: true, timeMs: 1000 } });
  const u2 = await register(env, `lib-${++counter}`);
  await env.prisma.answer.create({ data: { gameQuestionId: gq.id, userId: u2.id, choiceIndex: 1, isCorrect: false, timeMs: 1000 } });
  const again = (await list(mgr.cookie, chapterId)).questions.find((x: any) => x.id === q.id);
  assert.deepEqual(again.stats, { answered: 2, correct: 1, accuracy: 50 });
});
