import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
let subjectId: string;
let chapterId: string;

before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Chimie", accessName: "chimie", accessPassword: "acces-123" })).json().subject.id;
  chapterId = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(20, "A"), newChapterName: "A" })).json().chapterId;
});
after(() => env.close());

async function player(name: string) {
  const u = await register(env, name);
  await call(env, u.cookie, "POST", "/api/subjects/join", { accessName: "chimie", accessPassword: "acces-123" });
  return u;
}

test("l'administrateur n'est membre d'aucune matière et voit toutes les matières sans XP", async () => {
  assert.equal(await env.prisma.membership.count({ where: { user: { role: "ADMIN" } } }), 0);
  const me = (await call(env, admin, "GET", "/api/me")).json();
  assert.equal(me.user.role, "ADMIN");
  assert.deepEqual(me.subjects.map((s: any) => s.name), ["Chimie"]);
  assert.equal(me.subjects[0].xp, undefined);
  assert.equal((await call(env, admin, "POST", "/api/me/active-subject", { subjectId })).statusCode, 200);
  assert.equal(await env.prisma.membership.count({ where: { user: { role: "ADMIN" } } }), 0);
});

test("l'administrateur ne peut ni rejoindre, ni jouer, ni défier", async () => {
  const p = await player("joueur-a");
  assert.equal((await call(env, admin, "POST", "/api/subjects/join", { accessName: "chimie", accessPassword: "acces-123" })).statusCode, 403);
  assert.equal((await call(env, admin, "POST", "/api/solo/start", { subjectId, chapterId })).statusCode, 403);
  assert.equal((await call(env, admin, "POST", "/api/duels", { subjectId, opponentId: p.id, chapterId })).statusCode, 403);
  assert.equal((await call(env, admin, "GET", `/api/subjects/${subjectId}/leaderboard`)).statusCode, 403);
  assert.equal((await call(env, admin, "GET", "/api/me/summary")).statusCode, 403);
  assert.equal((await call(env, admin, "GET", "/api/me/badges")).statusCode, 403);
});

test("un ancien administrateur-membre n'apparaît ni au classement, ni parmi les adversaires, ni dans les membres", async () => {
  const p = await player("joueur-b");
  const q = await player("joueur-c");
  const ghost = await register(env, "ex-membre");
  await call(env, ghost.cookie, "POST", "/api/subjects/join", { accessName: "chimie", accessPassword: "acces-123" });
  await env.prisma.user.update({ where: { id: ghost.id }, data: { role: "ADMIN" } });

  const board = (await call(env, p.cookie, "GET", `/api/subjects/${subjectId}/leaderboard`)).json();
  assert.ok(!JSON.stringify(board).includes("ex-membre"));
  const opp = (await call(env, p.cookie, "GET", `/api/subjects/${subjectId}/players`)).json();
  assert.ok(opp.players.some((x: any) => x.id === q.id));
  assert.ok(!opp.players.some((x: any) => x.id === ghost.id));
  const members = (await call(env, admin, "GET", `/api/subjects/${subjectId}/members`)).json().members;
  assert.ok(!members.some((m: any) => m.userId === ghost.id));
  assert.equal((await call(env, p.cookie, "POST", "/api/duels", { subjectId, opponentId: ghost.id, chapterId })).statusCode, 422);
  const list = (await call(env, admin, "GET", "/api/subjects")).json().subjects[0];
  assert.equal(list.memberCount, 3); // joueur-a, b, c — l'ex-membre devenu admin n'est pas compté
});

test("thème : lecture publique, modification réservée à l'administrateur", async () => {
  const pub = (await call(env, null, "GET", "/api/theme")).json();
  assert.equal(pub.theme, "graphite");
  assert.equal(pub.allowUserChoice, true);
  assert.ok(pub.themes.length >= 10);
  const p = await player("joueur-d");
  assert.equal((await call(env, p.cookie, "PUT", "/api/admin/theme", { theme: "nord" })).statusCode, 403);
  assert.equal((await call(env, null, "PUT", "/api/admin/theme", { theme: "nord" })).statusCode, 401);
  assert.equal((await call(env, admin, "PUT", "/api/admin/theme", { theme: "inconnu" })).statusCode, 400);
  const r = (await call(env, admin, "PUT", "/api/admin/theme", { theme: "nord", allowUserChoice: false })).json();
  assert.equal(r.theme, "nord");
  assert.equal(r.allowUserChoice, false);
  assert.equal((await call(env, null, "GET", "/api/theme")).json().theme, "nord");
  // les paramètres de jeu ne sont pas perturbés par les lignes « ui.* »
  assert.equal((await call(env, admin, "GET", "/api/settings")).statusCode, 200);
  assert.equal((await call(env, p.cookie, "GET", "/api/me")).statusCode, 200);
});
