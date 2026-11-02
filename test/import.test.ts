import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv, joinSubject, assignManager } from "./helpers.ts";

let env: TestEnv;
let admin: string;
let subjectId: string;
let otherSubjectId: string;
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Chimie" })).json().subject.id;
  otherSubjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Histoire" })).json().subject.id;
});
after(() => env.close());

const importUrl = (id: string, step: "preview" | "commit") => `/api/subjects/${id}/import/${step}`;
const countQuestions = (chapterId: string) => env.prisma.question.count({ where: { chapterId, deletedAt: null } });

test("prévisualisation : ne modifie rien, annonce un nouveau chapitre", async () => {
  const res = await call(env, admin, "POST", importUrl(subjectId, "preview"), { raw: sampleBlock(12), newChapterName: "Atomes" });
  assert.equal(res.statusCode, 200);
  const r = res.json();
  assert.equal(r.canImport, true);
  assert.equal(r.validCount, 12);
  assert.equal(r.chapter.isNew, true);
  assert.equal(r.sample.length, 3);
  assert.equal(await env.prisma.chapter.count(), 0);
  assert.equal(await env.prisma.question.count(), 0);
});

test("import de 300 questions dans un nouveau chapitre", async () => {
  const res = await call(env, admin, "POST", importUrl(subjectId, "commit"), { raw: sampleBlock(300, "Atomes"), newChapterName: "Atomes" });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().imported, 300);
  assert.equal(await countQuestions(res.json().chapterId), 300);

  const q = await env.prisma.question.findFirstOrThrow({ where: { chapterId: res.json().chapterId } });
  assert.equal(q.choices, JSON.stringify(["A", "B", "C", "D"]));
  assert.equal(q.batchId, res.json().batchId);
});

test("réimporter le même bloc : tout est signalé comme doublon et rien n'est ajouté", async () => {
  const chapter = await env.prisma.chapter.findFirstOrThrow({ where: { name: "Atomes" } });
  const preview = (await call(env, admin, "POST", importUrl(subjectId, "preview"), { raw: sampleBlock(300, "Atomes"), chapterId: chapter.id })).json();
  assert.equal(preview.duplicateCount, 300);
  assert.equal(preview.canImport, false);
  const res = await call(env, admin, "POST", importUrl(subjectId, "commit"), { raw: sampleBlock(300, "Atomes"), chapterId: chapter.id });
  assert.equal(res.statusCode, 422);
  assert.equal(await countQuestions(chapter.id), 300);
});

test("nom de chapitre déjà existant : ajoute au chapitre existant", async () => {
  const chapter = await env.prisma.chapter.findFirstOrThrow({ where: { name: "Atomes" } });
  const res = await call(env, admin, "POST", importUrl(subjectId, "commit"), { raw: sampleBlock(5, "Nouveau"), newChapterName: "Atomes" });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().chapterId, chapter.id);
  assert.equal(await countQuestions(chapter.id), 305);
});

test("import partiel : les questions valides passent, les erreurs sont détaillées", async () => {
  const block = JSON.stringify([
    { question: "Valide 1 ?", choices: ["a", "b"], answer: 0 },
    { question: "Cassée ?", choices: ["a", "b"], answer: 7 },
    { question: "Valide 2 ?", choices: ["a", "b", "c"], answer: 2 },
  ]);
  const preview = (await call(env, admin, "POST", importUrl(subjectId, "preview"), { raw: block, newChapterName: "Partiel" })).json();
  assert.equal(preview.validCount, 2);
  assert.equal(preview.errorCount, 1);
  assert.equal(preview.errors[0].index, 2);
  assert.match(preview.errors[0].messages[0], /positions valides/);

  const strict = await call(env, admin, "POST", importUrl(subjectId, "commit"), { raw: block, newChapterName: "Partiel", mode: "all_or_nothing" });
  assert.equal(strict.statusCode, 422);
  assert.equal(await env.prisma.chapter.count({ where: { name: "Partiel" } }), 0); // rien créé

  const partial = await call(env, admin, "POST", importUrl(subjectId, "commit"), { raw: block, newChapterName: "Partiel" });
  assert.equal(partial.statusCode, 201);
  assert.equal(partial.json().imported, 2);
  assert.equal(partial.json().skippedInvalid, 1);
});

test("JSON cassé : erreur claire, rien d'importé", async () => {
  const res = await call(env, admin, "POST", importUrl(subjectId, "preview"), { raw: '[{ "question": "x", }]', newChapterName: "Cassé" });
  assert.equal(res.json().canImport, false);
  assert.match(res.json().fatalError, /pas un JSON valide/);
  assert.equal((await call(env, admin, "POST", importUrl(subjectId, "commit"), { raw: "pas du json", newChapterName: "Cassé" })).statusCode, 422);
});

test("il faut un chapitre existant OU un nouveau nom, pas les deux, pas aucun", async () => {
  const chapter = await env.prisma.chapter.findFirstOrThrow({ where: { name: "Atomes" } });
  assert.equal((await call(env, admin, "POST", importUrl(subjectId, "commit"), { raw: sampleBlock(1) })).statusCode, 400);
  assert.equal((await call(env, admin, "POST", importUrl(subjectId, "commit"), { raw: sampleBlock(1), chapterId: chapter.id, newChapterName: "X" })).statusCode, 400);
});

test("un chapitre d'une autre matière est refusé", async () => {
  const chapter = await env.prisma.chapter.findFirstOrThrow({ where: { name: "Atomes" } });
  const res = await call(env, admin, "POST", importUrl(otherSubjectId, "commit"), { raw: sampleBlock(2, "Autre"), chapterId: chapter.id });
  assert.equal(res.statusCode, 404);
});

test("permissions : utilisateur simple 403, responsable de la matière oui, responsable d'une autre matière non", async () => {
  const plain = await register(env, "simple");
  assert.equal((await call(env, plain.cookie, "POST", importUrl(subjectId, "preview"), { raw: sampleBlock(1), newChapterName: "Z" })).statusCode, 403);

  const mgr = await register(env, "resp");
  await assignManager(env, subjectId, mgr.id);
  const ok = await call(env, mgr.cookie, "POST", importUrl(subjectId, "commit"), { raw: sampleBlock(3, "Resp"), newChapterName: "Par le responsable" });
  assert.equal(ok.statusCode, 201);
  assert.equal((await call(env, mgr.cookie, "POST", importUrl(otherSubjectId, "commit"), { raw: sampleBlock(3, "Resp"), newChapterName: "Interdit" })).statusCode, 403);

  const log = await env.prisma.adminLog.findFirstOrThrow({ where: { action: "IMPORT_QUESTIONS", adminId: mgr.id } });
  assert.equal(log.subjectId, subjectId);
});

test("liste des chapitres : membres et responsables seulement, avec le nombre de questions", async () => {
  const outsider = await register(env, "dehors");
  assert.equal((await call(env, outsider.cookie, "GET", `/api/subjects/${subjectId}/chapters`)).statusCode, 403);

  const member = await register(env, "membre");
  await joinSubject(env, member.cookie, "chimie");
  const res = await call(env, member.cookie, "GET", `/api/subjects/${subjectId}/chapters`);
  assert.equal(res.statusCode, 200);
  const atomes = res.json().chapters.find((c: { name: string }) => c.name === "Atomes");
  assert.equal(atomes.questionCount, 305);
  // Les chapitres des autres matières n'apparaissent pas
  assert.equal(res.json().chapters.some((c: { name: string }) => c.name === "Interdit"), false);
});

test("suppression à partir d'une date et heure", async () => {
  const ch = (await call(env, admin, "POST", `/api/subjects/${subjectId}/chapters`, { name: "Par date" })).json().chapter;
  // Trois questions "anciennes", puis trois "récentes"
  const old = new Date("2026-01-01T10:00:00Z");
  const recent = new Date("2026-06-01T10:00:00Z");
  const batch = await env.prisma.importBatch.create({ data: { chapterId: ch.id, adminId: (await env.prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } })).id, questionCount: 6 } });
  const mk = (i: number, createdAt: Date) => ({ chapterId: ch.id, batchId: batch.id, text: `Q${i}`, choices: '["a","b"]', answerIndex: 0, hash: `h${i}`, createdAt });
  await env.prisma.question.createMany({ data: [1, 2, 3].map((i) => mk(i, old)).concat([4, 5, 6].map((i) => mk(i, recent))) });

  const bad = await call(env, admin, "POST", `/api/chapters/${ch.id}/questions/delete-since`, { since: "hier" });
  assert.equal(bad.statusCode, 400);

  const res = await call(env, admin, "POST", `/api/chapters/${ch.id}/questions/delete-since`, { since: "2026-03-01T00:00:00+01:00" });
  assert.equal(res.json().deletedQuestions, 3);
  assert.equal(await countQuestions(ch.id), 3);
  const left = await env.prisma.question.findMany({ where: { chapterId: ch.id, deletedAt: null }, select: { text: true } });
  assert.deepEqual(left.map((q) => q.text).sort(), ["Q1", "Q2", "Q3"]);

  // Un nouvel import de questions supprimées est de nouveau possible (les doublons ne comptent que parmi les questions actives)
  const again = await call(env, admin, "POST", importUrl(subjectId, "commit"), {
    raw: JSON.stringify([{ question: "Q4", choices: ["a", "b"], answer: 0 }]),
    chapterId: ch.id,
  });
  assert.equal(again.statusCode, 201);
});

test("annuler un import précis", async () => {
  const first = (await call(env, admin, "POST", importUrl(subjectId, "commit"), { raw: sampleBlock(4, "Lot A"), newChapterName: "Lots" })).json();
  const second = (await call(env, admin, "POST", importUrl(subjectId, "commit"), { raw: sampleBlock(6, "Lot B"), chapterId: first.chapterId })).json();
  assert.equal(await countQuestions(first.chapterId), 10);

  const res = await call(env, admin, "DELETE", `/api/batches/${second.batchId}`);
  assert.equal(res.json().deletedQuestions, 6);
  assert.equal(await countQuestions(first.chapterId), 4);
  assert.equal((await call(env, admin, "DELETE", `/api/batches/${second.batchId}`)).statusCode, 404);
});

test("supprimer un chapitre supprime ses questions ; le nom peut être réutilisé", async () => {
  const made = (await call(env, admin, "POST", importUrl(subjectId, "commit"), { raw: sampleBlock(7, "Temp"), newChapterName: "Temporaire" })).json();
  const del = await call(env, admin, "DELETE", `/api/chapters/${made.chapterId}`);
  assert.equal(del.json().deletedQuestions, 7);
  assert.equal(await countQuestions(made.chapterId), 0);

  const list = (await call(env, admin, "GET", `/api/subjects/${subjectId}/chapters`)).json().chapters;
  assert.equal(list.some((c: { name: string }) => c.name === "Temporaire"), false);
  assert.equal((await call(env, admin, "DELETE", `/api/chapters/${made.chapterId}`)).statusCode, 404);

  // Réimporter sous le même nom réactive le chapitre, avec uniquement les nouvelles questions
  const back = await call(env, admin, "POST", importUrl(subjectId, "commit"), { raw: sampleBlock(2, "Temp"), newChapterName: "Temporaire" });
  assert.equal(back.statusCode, 201);
  assert.equal(back.json().chapterId, made.chapterId);
  assert.equal(await countQuestions(made.chapterId), 2);
});

test("responsable : ne peut pas supprimer dans une autre matière", async () => {
  const mgr = await register(env, "resp2");
  await assignManager(env, otherSubjectId, mgr.id);
  const chapter = await env.prisma.chapter.findFirstOrThrow({ where: { name: "Atomes" } });
  assert.equal((await call(env, mgr.cookie, "DELETE", `/api/chapters/${chapter.id}`)).statusCode, 403);
  assert.equal((await call(env, mgr.cookie, "POST", `/api/chapters/${chapter.id}/questions/delete-since`, { since: "2020-01-01T00:00:00Z" })).statusCode, 403);
  assert.equal(await countQuestions(chapter.id), 305);
});

test("renommer un chapitre : conflit détecté", async () => {
  const a = (await call(env, admin, "POST", `/api/subjects/${otherSubjectId}/chapters`, { name: "Antiquité" })).json().chapter;
  await call(env, admin, "POST", `/api/subjects/${otherSubjectId}/chapters`, { name: "Moyen Âge" });
  assert.equal((await call(env, admin, "PATCH", `/api/chapters/${a.id}`, { name: "Moyen Âge" })).statusCode, 409);
  assert.equal((await call(env, admin, "PATCH", `/api/chapters/${a.id}`, { name: "Rome" })).json().chapter.name, "Rome");
});
