import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, joinSubject, login, register, seedAdmin, type TestEnv } from "./helpers.ts";
import { DEFAULT_TIMEZONE, startOfPeriod } from "../src/time.ts";
import { zoneSize } from "../src/routes/league.ts";

let env: TestEnv;
let subjectId: string;
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  const admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Chimie" })).json().subject.id;
});
after(() => env.close());

test("zones de promotion et de relégation", () => {
  assert.equal(zoneSize(3), 0);
  assert.equal(zoneSize(4), 1);
  assert.equal(zoneSize(10), 2);
  assert.equal(zoneSize(30), 6);
});

test("ligue : tout le monde commence en Bronze, puis la clôture de la semaine fait monter le meilleur", async () => {
  const ps = [];
  for (let i = 0; i < 5; i++) { const u = await register(env, `lg${i}`); await joinSubject(env, u.cookie, "chimie"); ps.push(u); }
  const first = (await call(env, ps[0].cookie, "GET", `/api/subjects/${subjectId}/league`)).json();
  assert.equal(first.tierName, "Bronze");
  assert.equal(first.standings.length, 5);
  assert.equal(first.lastMove, null);
  assert.equal((await call(env, null, "GET", `/api/subjects/${subjectId}/league`)).statusCode, 401);

  // XP de la semaine dernière : lg0 = 50, lg1 = 40, …, lg4 = 10 (la ligue a été « initialisée » juste avant)
  const lastWeek = startOfPeriod("week", new Date(Date.now() - 7 * 86_400_000), DEFAULT_TIMEZONE);
  const when = new Date(lastWeek.getTime() + 36 * 3600_000);
  for (let i = 0; i < 5; i++) await env.prisma.xpEvent.create({ data: { userId: ps[i].id, subjectId, source: "CORRECT_ANSWER", amount: 50 - i * 10, createdAt: when } });
  // on « recule » l'horloge de clôture : la semaine d'avant est la dernière close, celle de la semaine dernière reste à faire
  await env.prisma.leagueWeek.deleteMany({ where: { subjectId } });
  const before2 = new Date(lastWeek.getTime() - 3 * 86_400_000);
  const key = (d: Date) => d.toISOString().slice(0, 10);
  await env.prisma.leagueWeek.create({ data: { subjectId, weekKey: key(startOfPeriod("week", before2, DEFAULT_TIMEZONE)) } });

  const r = (await call(env, ps[0].cookie, "GET", `/api/subjects/${subjectId}/league`)).json();
  assert.equal(r.tierName, "Argent", "le premier de la semaine monte");
  assert.equal(r.lastMove.result, "UP");
  assert.equal(r.lastMove.rank, 1);
  const bottom = (await call(env, ps[4].cookie, "GET", `/api/subjects/${subjectId}/league`)).json();
  assert.equal(bottom.tierName, "Bronze", "le dernier ne descend pas plus bas que Bronze");
  assert.equal(bottom.lastMove.result, "STAY");
  // une seule clôture, même si on redemande
  const again = (await call(env, ps[0].cookie, "GET", `/api/subjects/${subjectId}/league`)).json();
  assert.equal(again.tierName, "Argent");
  assert.equal(await env.prisma.leagueWeek.count({ where: { subjectId } }) >= 2, true);
  // dans Argent il est seul : classement de sa nouvelle ligue
  assert.equal(again.standings.length, 1);
});
