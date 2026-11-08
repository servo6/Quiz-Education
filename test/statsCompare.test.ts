import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, joinSubject, login, register, sampleBlock, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let subjectId: string;
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  const admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Chimie" })).json().subject.id;
  await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(12, "Q"), newChapterName: "Grand" });
});
after(() => env.close());

test("comparaison : seulement entre amis, avec bilan des duels et synthèse de la semaine", async () => {
  const a = await register(env, "cmp-a"), b = await register(env, "cmp-b"), c = await register(env, "cmp-c");
  for (const u of [a, b, c]) await joinSubject(env, u.cookie, "chimie");
  assert.equal((await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/stats/compare/${b.id}`)).statusCode, 403);

  await env.prisma.friendship.create({ data: { subjectId, requesterId: a.id, addresseeId: b.id, status: "ACCEPTED" } });
  const r = await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/stats/compare/${b.id}`);
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.me.player.username, "cmp-a");
  assert.equal(j.friend.player.username, "cmp-b");
  assert.deepEqual(j.headToHead, { played: 0, wins: 0, draws: 0, losses: 0 });
  // dans l'autre sens aussi, mais pas avec un tiers
  assert.equal((await call(env, b.cookie, "GET", `/api/subjects/${subjectId}/stats/compare/${a.id}`)).statusCode, 200);
  assert.equal((await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/stats/compare/${c.id}`)).statusCode, 403);
  assert.equal((await call(env, null, "GET", `/api/subjects/${subjectId}/stats/compare/${b.id}`)).statusCode, 401);

  // un duel terminé entre eux compte dans le bilan
  const g = await env.prisma.game.create({ data: { subjectId, mode: "DUEL", status: "FINISHED", finishedAt: new Date() } });
  await env.prisma.gamePlayer.createMany({ data: [{ gameId: g.id, userId: a.id, result: "WIN" }, { gameId: g.id, userId: b.id, result: "LOSS" }] });
  const j2 = (await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/stats/compare/${b.id}`)).json();
  assert.deepEqual(j2.headToHead, { played: 1, wins: 1, draws: 0, losses: 0 });
  const j3 = (await call(env, b.cookie, "GET", `/api/subjects/${subjectId}/stats/compare/${a.id}`)).json();
  assert.deepEqual(j3.headToHead, { played: 1, wins: 0, draws: 0, losses: 1 });

  const full = (await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/stats/full`)).json();
  assert.ok(full.insights && "recent" in full.insights && Array.isArray(full.insights.strong) && Array.isArray(full.insights.weak));
});
