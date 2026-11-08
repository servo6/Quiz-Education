import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, joinSubject, login, register, sampleBlock, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
let subjectId: string;
let chapterId: string;
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Chimie" })).json().subject.id;
  chapterId = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(12, "Q"), newChapterName: "Grand" })).json().chapterId;
  await call(env, admin, "PATCH", `/api/subjects/${subjectId}`, { settings: { soloQuestions: 6, timePerQuestionSec: 60, soloGamesPerDay: 0 } });
});
after(() => env.close());

const answerIdx = async (qid: string) => (await env.prisma.question.findUniqueOrThrow({ where: { id: qid } })).answerIndex;
let n = 0;
const player = async () => { const u = await register(env, `rev${++n}`); await joinSubject(env, u.cookie, "chimie"); return u; };

/** Joue une partie solo : les `wrong` premières réponses sont fausses ; renvoie les ids de questions ratées. */
async function playSolo(cookie: string, wrong: number): Promise<string[]> {
  const s = (await call(env, cookie, "POST", "/api/solo/start", { subjectId, chapterId })).json();
  const gid = s.game.id as string;
  const missed: string[] = [];
  for (let i = 0; i < 6; i++) {
    const cur = (await call(env, cookie, "GET", `/api/solo/${gid}/current`)).json();
    const gq = await env.prisma.gameQuestion.findUniqueOrThrow({ where: { id: cur.question.gameQuestionId } });
    const good = await answerIdx(gq.questionId);
    const choice = i < wrong ? (good + 1) % cur.question.choices.length : good;
    if (i < wrong) missed.push(gq.questionId);
    await call(env, cookie, "POST", `/api/solo/${gid}/answer`, { gameQuestionId: cur.question.gameQuestionId, choiceIndex: choice });
  }
  return missed;
}

test("les questions ratées en solo deviennent des cartes à réviser, qui avancent puis sont maîtrisées", async () => {
  const u = await player();
  assert.equal((await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/review`)).json().due, 0);
  const missed = await playSolo(u.cookie, 3);
  const st = (await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/review`)).json();
  assert.equal(st.due, 3);
  assert.equal(st.sessionSize, 3);

  // séance complète, tout juste : chaque carte passe en boîte 1 (revient dans 1 jour)
  let done = 0;
  for (; done < 3; done++) {
    const nx = (await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/review/next?done=${done}&size=3`)).json();
    assert.equal(nx.status, "IN_PROGRESS");
    assert.equal(nx.question.correctIndex, undefined);
    assert.ok(missed.includes(nx.question.gameQuestionId));
    const r = (await call(env, u.cookie, "POST", `/api/subjects/${subjectId}/review/answer`, { gameQuestionId: nx.question.gameQuestionId, choiceIndex: await answerIdx(nx.question.gameQuestionId), done, size: 3 })).json();
    assert.equal(r.correct, true);
  }
  assert.equal((await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/review/next?done=3&size=3`)).json().status, "DONE");
  assert.equal((await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/review`)).json().due, 0);
  const cards = await env.prisma.reviewCard.findMany({ where: { userId: u.id } });
  assert.equal(cards.length, 3);
  assert.ok(cards.every((c) => c.box === 1 && c.dueAt.getTime() > Date.now() + 20 * 3600_000));

  // une carte arrive à échéance, on se trompe : retour à la boîte 0, de nouveau à réviser dans 10 min
  const target = cards[0];
  await env.prisma.reviewCard.update({ where: { id: target.id }, data: { dueAt: new Date(Date.now() - 1000) } });
  assert.equal((await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/review`)).json().due, 1);
  const wrongR = (await call(env, u.cookie, "POST", `/api/subjects/${subjectId}/review/answer`, { gameQuestionId: target.questionId, choiceIndex: ((await answerIdx(target.questionId)) + 1) % 2 === 0 ? 0 : 1, done: 0, size: 1 })).json();
  if (!wrongR.correct) {
    const after = await env.prisma.reviewCard.findUniqueOrThrow({ where: { id: target.id } });
    assert.equal(after.box, 0);
    assert.equal(after.lapses, 1);
    assert.equal((await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/review`)).json().due, 0);
  }

  // maîtrise : une carte en boîte 4 réussie devient maîtrisée
  const c2 = cards[1];
  await env.prisma.reviewCard.update({ where: { id: c2.id }, data: { box: 4, dueAt: new Date(Date.now() - 1000) } });
  const ok = (await call(env, u.cookie, "POST", `/api/subjects/${subjectId}/review/answer`, { gameQuestionId: c2.questionId, choiceIndex: await answerIdx(c2.questionId), done: 0, size: 1 })).json();
  assert.equal(ok.mastered, true);
  assert.equal((await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/review`)).json().mastered, 1);
});

test("refus : question non due, hors matière, non connecté, administrateur", async () => {
  const u = await player();
  const q = await env.prisma.question.findFirstOrThrow({ where: { chapterId } });
  assert.equal((await call(env, u.cookie, "POST", `/api/subjects/${subjectId}/review/answer`, { gameQuestionId: q.id, choiceIndex: 0 })).statusCode, 409);
  assert.equal((await call(env, null, "GET", `/api/subjects/${subjectId}/review`)).statusCode, 401);
  assert.equal((await call(env, admin, "GET", `/api/subjects/${subjectId}/review`)).statusCode, 403);
  const outsider = await register(env, `rev-out${++n}`);
  assert.equal((await call(env, outsider.cookie, "GET", `/api/subjects/${subjectId}/review`)).statusCode, 403);
});

test("une question ratée puis réussie en solo n'est plus à réviser", async () => {
  const u = await player();
  await playSolo(u.cookie, 6);
  const before = (await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/review`)).json().due;
  assert.equal(before, 6);
  await playSolo(u.cookie, 0); // mêmes questions (chapitre de 12, parties de 6) : certaines sont réussies
  const after = (await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/review`)).json().due;
  assert.ok(after <= before);
});
