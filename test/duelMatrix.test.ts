import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
let subjectId: string;
let chapterId: string;
let n = 0;
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Matiere", accessName: "matiere", accessPassword: "acces-123" })).json().subject.id;
  chapterId = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(3, "A"), newChapterName: "A" })).json().chapterId;
});
after(() => env.close());

async function player() {
  const u = await register(env, `mx-${++n}`);
  await call(env, u.cookie, "POST", "/api/subjects/join", { accessName: "matiere", accessPassword: "acces-123" });
  return u;
}

for (const cfg of [
  { roundsPerDuel: 4, questionsPerRound: 4, timePerQuestionSec: 20 },
  { roundsPerDuel: 4, questionsPerRound: 4, timePerQuestionSec: 0 },
  { roundsPerDuel: 1, questionsPerRound: 10, timePerQuestionSec: 0 },
  { roundsPerDuel: 3, questionsPerRound: 1, timePerQuestionSec: 5, shuffleChoices: true },
  { roundsPerDuel: 5, questionsPerRound: 6, timePerQuestionSec: 600, maxActiveDuels: 0 },
]) {
  test(`duel différé complet avec ${JSON.stringify(cfg)}`, async () => {
    assert.equal((await call(env, admin, "PATCH", `/api/subjects/${subjectId}`, { settings: cfg })).statusCode, 200);
    const a = await player(), b = await player();
    const created = await call(env, a.cookie, "POST", "/api/duels", { subjectId, opponentId: b.id, chapterId });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().duel.id;
    for (let guard = 0; guard < 40; guard++) {
      let moved = false;
      for (const u of [a, b]) {
        const d = (await call(env, u.cookie, "GET", `/api/duels/${id}`)).json();
        if (d.duel.status !== "IN_PROGRESS") { assert.equal(d.duel.status, "FINISHED"); return; }
        const nx = d.duel.next;
        if (nx.action === "pick") {
          const r = await call(env, u.cookie, "POST", `/api/duels/${id}/pick`, { chapterId });
          assert.equal(r.statusCode, 201, r.body); moved = true;
        } else if (nx.action === "play") {
          for (;;) {
            const cur = await call(env, u.cookie, "GET", `/api/duels/${id}/current`);
            assert.equal(cur.statusCode, 200, cur.body);
            const c = cur.json();
            if (c.status !== "IN_PROGRESS") break;
            const ans = await call(env, u.cookie, "POST", `/api/duels/${id}/answer`, { gameQuestionId: c.question.gameQuestionId, choiceIndex: 1 });
            assert.equal(ans.statusCode, 200, ans.body);
            assert.equal(ans.json().timedOut, false);
            moved = true;
            if (ans.json().roundDone) break;
          }
        }
      }
      assert.ok(moved, "bloqué");
    }
    assert.fail("le duel ne se termine pas");
  });
}
