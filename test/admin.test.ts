import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
let counter = 0;

before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
});
after(() => env.close());

async function newSubject(name: string, accessName: string) {
  const id = (await call(env, admin, "POST", "/api/subjects", { name, accessName, accessPassword: "acces-123" })).json().subject.id as string;
  const chapterId = (await call(env, admin, "POST", `/api/subjects/${id}/import/commit`, { raw: sampleBlock(12, name), newChapterName: "Ch" })).json().chapterId as string;
  return { id, chapterId, name, accessName };
}
async function member(accessName: string) {
  const u = await register(env, `adm-${++counter}`);
  await call(env, u.cookie, "POST", "/api/subjects/join", { accessName, accessPassword: "acces-123" });
  return u;
}

test("suppression d'une matière : confirmation, droits, tout est effacé, le reste est intact", async () => {
  const s = await newSubject("A supprimer", "a-supprimer");
  const keep = await newSubject("A garder", "a-garder");
  const [u1, u2] = [await member(s.accessName), await member(s.accessName)];
  const keeper = await member(keep.accessName);
  await call(env, keeper.cookie, "POST", "/api/subjects/join", { accessName: s.accessName, accessPassword: "acces-123" });

  // contenu : solo, duel différé, XP, titres, responsable
  await call(env, admin, "PATCH", `/api/subjects/${s.id}`, { settings: { soloGamesPerDay: 0, soloQuestions: 3, roundsPerDuel: 2, questionsPerRound: 2 } });
  const start = (await call(env, u1.cookie, "POST", "/api/solo/start", { subjectId: s.id, chapterId: s.chapterId })).json();
  const gq = await env.prisma.gameQuestion.findUniqueOrThrow({ where: { id: start.question.gameQuestionId }, include: { question: true } });
  await call(env, u1.cookie, "POST", `/api/solo/${start.game.id}/answer`, { gameQuestionId: gq.id, choiceIndex: gq.question.answerIndex });
  const duel = await call(env, u1.cookie, "POST", "/api/duels", { subjectId: s.id, opponentId: u2.id, chapterId: s.chapterId });
  assert.equal(duel.statusCode, 201);
  await call(env, u1.cookie, "GET", `/api/duels/${duel.json().duel.id}/current`); // crée un QuestionServe
  await call(env, admin, "PUT", `/api/subjects/${s.id}/tiers`, { tiers: [{ name: "T", minLevel: 1 }] });
  const mgr = await member(s.accessName);
  await call(env, admin, "PUT", `/api/subjects/${s.id}/managers/${mgr.id}`);
  await call(env, u1.cookie, "POST", "/api/me/active-subject", { subjectId: s.id });
  const keepGame = (await call(env, keeper.cookie, "POST", "/api/solo/start", { subjectId: keep.id, chapterId: keep.chapterId })).json().game.id;

  // refus
  assert.equal((await call(env, u1.cookie, "DELETE", `/api/subjects/${s.id}`, { confirmName: s.name })).statusCode, 403);
  const mgrCookie = await login(env, `adm-${counter}`, "password-123");
  assert.equal((await call(env, mgrCookie, "DELETE", `/api/subjects/${s.id}`, { confirmName: s.name })).statusCode, 403);
  assert.equal((await call(env, admin, "DELETE", `/api/subjects/${s.id}`, {})).statusCode, 400);
  const bad = await call(env, admin, "DELETE", `/api/subjects/${s.id}`, { confirmName: "autre chose" });
  assert.equal(bad.statusCode, 422);
  assert.equal(bad.json().error.code, "confirmation_mismatch");
  assert.ok(await env.prisma.subject.findUnique({ where: { id: s.id } }));
  assert.equal((await call(env, admin, "DELETE", `/api/subjects/inconnue`, { confirmName: "x" })).statusCode, 404);

  // suppression
  const res = await call(env, admin, "DELETE", `/api/subjects/${s.id}`, { confirmName: s.name });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().deleted.chapters, 1);
  assert.equal(res.json().deleted.questions, 12);
  assert.ok(res.json().deleted.members >= 4);

  const gone = async (m: string, where: object) => assert.equal(await (env.prisma as any)[m].count({ where }), 0, m);
  await gone("subject", { id: s.id });
  await gone("chapter", { subjectId: s.id });
  await gone("question", { chapterId: s.chapterId });
  await gone("membership", { subjectId: s.id });
  await gone("game", { subjectId: s.id });
  await gone("xpEvent", { subjectId: s.id });
  await gone("tier", { subjectId: s.id });
  await gone("subjectManager", { subjectId: s.id });
  await gone("questionServe", { gameQuestion: { game: { subjectId: s.id } } });
  await gone("answer", { gameQuestion: { game: { subjectId: s.id } } });

  // effets sur les comptes
  assert.equal((await env.prisma.user.findUniqueOrThrow({ where: { id: u1.id } })).activeSubjectId, null);
  assert.equal((await env.prisma.user.findUniqueOrThrow({ where: { id: mgr.id } })).role, "USER");
  assert.equal((await call(env, u1.cookie, "GET", "/api/me")).statusCode, 200);
  assert.equal((await call(env, u1.cookie, "POST", "/api/solo/start", { subjectId: s.id, chapterId: s.chapterId })).statusCode, 403);
  assert.equal((await call(env, admin, "DELETE", `/api/subjects/${s.id}`, { confirmName: s.name })).statusCode, 404);

  // l'autre matière n'est pas touchée
  assert.ok(await env.prisma.subject.findUnique({ where: { id: keep.id } }));
  assert.equal(await env.prisma.question.count({ where: { chapterId: keep.chapterId } }), 12);
  assert.ok(await env.prisma.game.findUnique({ where: { id: keepGame } }));
  assert.ok(await env.prisma.membership.findFirst({ where: { userId: keeper.id, subjectId: keep.id } }));
  // le nom d'accès peut être réutilisé
  assert.equal((await call(env, admin, "POST", "/api/subjects", { name: "A supprimer", accessName: "a-supprimer", accessPassword: "acces-123" })).statusCode, 201);
});

test("suppression refusée tant qu'un duel en direct est en cours", async () => {
  const s = await newSubject("Direct", "direct");
  await env.prisma.game.create({ data: { subjectId: s.id, mode: "FRIENDLY", status: "IN_PROGRESS" } });
  const r = await call(env, admin, "DELETE", `/api/subjects/${s.id}`, { confirmName: s.name });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error.code, "live_duels_active");
});

test("journal : l'administrateur voit tout, filtres, pagination, trace de la suppression", async () => {
  const s = await newSubject("Journal", "journal");
  await call(env, admin, "PATCH", `/api/subjects/${s.id}`, { settings: { soloQuestions: 5 } });

  assert.equal((await call(env, null, "GET", "/api/logs")).statusCode, 401);
  const all = (await call(env, admin, "GET", "/api/logs?limit=200")).json();
  assert.ok(all.logs.length >= 3);
  const first = all.logs[0];
  assert.ok(first.actor.username);
  assert.equal(typeof first.details, "object");
  assert.equal(JSON.stringify(all).includes("passwordHash"), false);
  // du plus récent au plus ancien
  for (let i = 1; i < all.logs.length; i++) assert.ok(new Date(all.logs[i - 1].createdAt) >= new Date(all.logs[i].createdAt));

  const bySubject = (await call(env, admin, "GET", `/api/logs?subjectId=${s.id}`)).json().logs;
  assert.ok(bySubject.length >= 2);
  assert.ok(bySubject.every((l: any) => l.subjectId === s.id && l.subjectName === "Journal"));
  const byAction = (await call(env, admin, "GET", `/api/logs?subjectId=${s.id}&action=UPDATE_SUBJECT`)).json().logs;
  assert.deepEqual([...new Set(byAction.map((l: any) => l.action))], ["UPDATE_SUBJECT"]);

  // pagination sans doublon ni trou
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const page: any = (await call(env, admin, "GET", `/api/logs?limit=2${cursor ? `&cursor=${cursor}` : ""}`)).json();
    seen.push(...page.logs.map((l: any) => l.id));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, all.logs.length);

  // la suppression laisse une trace, avec le nom de la matière disparue
  await call(env, admin, "DELETE", `/api/subjects/${s.id}`, { confirmName: s.name });
  const del = (await call(env, admin, "GET", "/api/logs?action=DELETE_SUBJECT")).json().logs.find((l: any) => l.subjectId === s.id);
  assert.equal(del.subjectName, "Journal");
  assert.equal(del.details.questions, 12);
});

test("journal : un responsable ne voit que ses matières ; un joueur rien", async () => {
  const a = await newSubject("Mienne", "mienne");
  const b = await newSubject("Autre", "autre");
  const mgr = await member(a.accessName);
  await call(env, admin, "PUT", `/api/subjects/${a.id}/managers/${mgr.id}`);
  const player = await member(a.accessName);
  const mgrCookie = await login(env, `adm-${counter - 1}`, "password-123");

  const mine = (await call(env, mgrCookie, "GET", "/api/logs?limit=200")).json().logs;
  assert.ok(mine.length > 0);
  assert.ok(mine.every((l: any) => l.subjectId === a.id));
  assert.equal((await call(env, mgrCookie, "GET", `/api/logs?subjectId=${a.id}`)).statusCode, 200);
  assert.equal((await call(env, mgrCookie, "GET", `/api/logs?subjectId=${b.id}`)).statusCode, 403);
  assert.equal((await call(env, player.cookie, "GET", "/api/logs")).statusCode, 403);
  assert.equal((await call(env, player.cookie, "GET", `/api/logs?subjectId=${a.id}`)).statusCode, 403);
});
