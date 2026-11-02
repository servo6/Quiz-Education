import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
let subjectId: string;
let otherSubjectId: string;
let bigChapter: string; // 12 questions
let smallChapter: string; // 3 questions
let emptyChapter: string;
let foreignChapter: string; // chapitre d'une autre matière

before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
  const mk = async (name: string, accessName: string) =>
    (await call(env, admin, "POST", "/api/subjects", { name, accessName, accessPassword: "acces-123" })).json().subject.id as string;
  subjectId = await mk("Chimie", "chimie");
  otherSubjectId = await mk("Histoire", "histoire");
  const imp = async (sid: string, name: string, n: number) =>
    (await call(env, admin, "POST", `/api/subjects/${sid}/import/commit`, { raw: sampleBlock(n, name), newChapterName: name })).json().chapterId as string;
  bigChapter = await imp(subjectId, "Grand", 12);
  smallChapter = await imp(subjectId, "Petit", 3);
  foreignChapter = await imp(otherSubjectId, "Ailleurs", 5);
  emptyChapter = (await call(env, admin, "POST", `/api/subjects/${subjectId}/chapters`, { name: "Vide" })).json().chapter.id;
});
after(() => env.close());

const setSettings = (settings: Record<string, unknown>) => call(env, admin, "PATCH", `/api/subjects/${subjectId}`, { settings });

async function player(name: string) {
  const u = await register(env, name);
  await call(env, u.cookie, "POST", "/api/subjects/join", { accessName: "chimie", accessPassword: "acces-123" });
  return u;
}

const start = (cookie: string, chapterId = bigChapter, sid = subjectId) => call(env, cookie, "POST", "/api/solo/start", { subjectId: sid, chapterId });
const correctIndexOf = async (gameQuestionId: string) =>
  (await env.prisma.gameQuestion.findUniqueOrThrow({ where: { id: gameQuestionId }, include: { question: true } })).question.answerIndex;

test("accès : non-membre 403, chapitre d'une autre matière 404, chapitre vide 422", async () => {
  const outsider = await register(env, "solo-dehors");
  assert.equal((await start(outsider.cookie)).statusCode, 403);
  assert.equal((await call(env, null, "POST", "/api/solo/start", { subjectId, chapterId: bigChapter })).statusCode, 401);

  const p = await player("solo-acces");
  assert.equal((await start(p.cookie, foreignChapter)).statusCode, 404);
  assert.equal((await start(p.cookie, emptyChapter)).statusCode, 422);
  assert.equal((await call(env, p.cookie, "POST", "/api/solo/start", { subjectId, chapterId: "inconnu" })).statusCode, 404);
  assert.equal(await env.prisma.game.count({ where: { players: { some: { userId: p.id } } } }), 0);
});

test("partie complète : questions distinctes, XP, niveau, revue, aucune fuite de la réponse", async () => {
  await setSettings({ soloQuestions: 10, timePerQuestionSec: 30, soloGamesPerDay: 0 });
  const p = await player("solo-complet");
  const res = await start(p.cookie);
  assert.equal(res.statusCode, 201);
  const first = res.json();
  assert.equal(first.resumed, false);
  assert.equal(first.game.total, 10);
  assert.equal(first.game.chapter.name, "Grand");
  assert.equal(first.status, "IN_PROGRESS");
  assert.equal(first.question.position, 1);
  assert.ok(first.question.remainingMs > 25_000);

  // Ni la bonne réponse ni l'explication ne sont envoyées avant la réponse
  const raw = JSON.stringify(first);
  assert.equal(/correct|answerIndex|explanation/i.test(raw.replace(/isCorrect/g, "")), false, raw);

  // Les 10 questions tirées sont distinctes
  const gq = await env.prisma.gameQuestion.findMany({ where: { gameId: first.game.id } });
  assert.equal(new Set(gq.map((g) => g.questionId)).size, 10);

  let q = first.question;
  let lastAnswer;
  for (let i = 1; i <= 10; i++) {
    const good = await correctIndexOf(q.gameQuestionId);
    const wrong = (good + 1) % q.choices.length;
    const choice = i <= 7 ? good : wrong; // 7 bonnes réponses, 3 erreurs
    const a = await call(env, p.cookie, "POST", `/api/solo/${first.game.id}/answer`, { gameQuestionId: q.gameQuestionId, choiceIndex: choice });
    assert.equal(a.statusCode, 200, a.body);
    lastAnswer = a.json();
    assert.equal(lastAnswer.correct, i <= 7);
    assert.equal(lastAnswer.correctIndex, good);
    assert.equal(lastAnswer.xpGained, i <= 7 ? 10 : 0);
    assert.equal(lastAnswer.finished, i === 10);
    if (i === 10) assert.equal(lastAnswer.next, null);
    if (i < 10) {
      // La réponse embarque déjà la question suivante (aucune requête supplémentaire nécessaire pour l'afficher)…
      assert.equal(lastAnswer.next.position, i + 1);
      assert.equal(JSON.stringify(lastAnswer.next).includes("answerIndex"), false);
      const next = (await call(env, p.cookie, "GET", `/api/solo/${first.game.id}/current`)).json();
      assert.equal(next.question.position, i + 1);
      // …et GET /current (qui démarre le chrono) renvoie bien la même question.
      assert.equal(next.question.gameQuestionId, lastAnswer.next.gameQuestionId);
      q = next.question;
    }
  }
  assert.equal(lastAnswer.totalXp, 70);
  assert.equal(lastAnswer.level.level, 1); // 70 XP : pas encore le niveau 2 (100)

  const done = (await call(env, p.cookie, "GET", `/api/solo/${first.game.id}/current`)).json();
  assert.equal(done.status, "FINISHED");

  const result = (await call(env, p.cookie, "GET", `/api/solo/${first.game.id}/result`)).json();
  assert.equal(result.correct, 7);
  assert.equal(result.total, 10);
  assert.equal(result.xpEarned, 70);
  assert.equal(result.review.length, 10);
  assert.equal(result.review.filter((r: { isCorrect: boolean }) => r.isCorrect).length, 7);
  assert.equal(result.leveledUp, false);

  // XP enregistrés partout
  assert.equal((await env.prisma.membership.findFirstOrThrow({ where: { userId: p.id, subjectId } })).xp, 70);
  assert.equal(await env.prisma.xpEvent.count({ where: { userId: p.id, source: "CORRECT_ANSWER" } }), 7);
  const me = (await call(env, p.cookie, "GET", "/api/me")).json();
  assert.equal(me.subjects[0].xp, 70);

  // Plus de réponse possible une fois terminée
  assert.equal((await call(env, p.cookie, "POST", `/api/solo/${first.game.id}/answer`, { gameQuestionId: q.gameQuestionId, choiceIndex: 0 })).statusCode, 409);
});

test("passage de niveau : 10 bonnes réponses sur 10 donnent le niveau 2", async () => {
  const p = await player("solo-niveau");
  const s = (await start(p.cookie)).json();
  let q = s.question;
  let last;
  for (let i = 1; i <= 10; i++) {
    last = (await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/answer`, { gameQuestionId: q.gameQuestionId, choiceIndex: await correctIndexOf(q.gameQuestionId) })).json();
    if (i < 10) q = (await call(env, p.cookie, "GET", `/api/solo/${s.game.id}/current`)).json().question;
  }
  assert.equal(last.totalXp, 100);
  assert.equal(last.level.level, 2);
  assert.equal(last.leveledUp, true);
  const result = (await call(env, p.cookie, "GET", `/api/solo/${s.game.id}/result`)).json();
  assert.equal(result.leveledUp, true);
  assert.equal(result.level.level, 2);
});

test("anti-double-clic : répondre deux fois ou à une autre question est refusé", async () => {
  const p = await player("solo-double");
  const s = (await start(p.cookie)).json();
  const q1 = s.question;
  const body = { gameQuestionId: q1.gameQuestionId, choiceIndex: await correctIndexOf(q1.gameQuestionId) };
  assert.equal((await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/answer`, body)).statusCode, 200);
  const again = await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/answer`, body);
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error.code, "already_answered");

  // La question 3 n'est pas la question en cours (on est à la 2)
  const gq = await env.prisma.gameQuestion.findMany({ where: { gameId: s.game.id }, orderBy: { position: "asc" } });
  const skip = await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/answer`, { gameQuestionId: gq[2].id, choiceIndex: 0 });
  assert.equal(skip.statusCode, 409);
  assert.equal(skip.json().error.code, "not_current");

  // La question 2 existe mais n'a pas encore été affichée (aucun appel à /current)
  const early = await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/answer`, { gameQuestionId: gq[1].id, choiceIndex: 0 });
  assert.equal(early.json().error.code, "not_served");

  // XP : une seule fois
  assert.equal((await env.prisma.xpEvent.count({ where: { userId: p.id } })), 1);
  await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/abandon`);
});

test("choix invalide", async () => {
  const p = await player("solo-choix");
  const s = (await start(p.cookie)).json();
  const bad = await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/answer`, { gameQuestionId: s.question.gameQuestionId, choiceIndex: 9 });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, "invalid_choice");
  assert.equal((await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/answer`, { gameQuestionId: s.question.gameQuestionId, choiceIndex: -1 })).statusCode, 400);
  await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/abandon`);
});

test("chrono : réponse hors délai = erreur sans XP ; question abandonnée clôturée automatiquement", async () => {
  await setSettings({ soloQuestions: 3, timePerQuestionSec: 10 });
  const p = await player("solo-chrono");
  const s = (await start(p.cookie, smallChapter)).json();
  assert.equal(s.question.timeLimitSec, 10);

  // 1re question : on recule son départ de 30 s, puis on répond (la bonne réponse) : trop tard
  const gq = await env.prisma.gameQuestion.findMany({ where: { gameId: s.game.id }, orderBy: { position: "asc" } });
  await env.prisma.gameQuestion.update({ where: { id: gq[0].id }, data: { servedAt: new Date(Date.now() - 30_000) } });
  const late = await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/answer`, { gameQuestionId: gq[0].id, choiceIndex: await correctIndexOf(gq[0].id) });
  assert.equal(late.statusCode, 200);
  assert.equal(late.json().timedOut, true);
  assert.equal(late.json().correct, false);
  assert.equal(late.json().xpGained, 0);

  // 2e question affichée puis laissée sans réponse : au prochain /current elle est clôturée et on passe à la 3e
  const second = (await call(env, p.cookie, "GET", `/api/solo/${s.game.id}/current`)).json();
  assert.equal(second.question.position, 2);
  await env.prisma.gameQuestion.update({ where: { id: gq[1].id }, data: { servedAt: new Date(Date.now() - 60_000) } });
  const third = (await call(env, p.cookie, "GET", `/api/solo/${s.game.id}/current`)).json();
  assert.equal(third.question.position, 3);
  assert.ok(third.question.remainingMs > 5_000);

  // Rechargement : le chronomètre n'est pas remis à zéro
  await env.prisma.gameQuestion.update({ where: { id: gq[2].id }, data: { servedAt: new Date(Date.now() - 6_000) } });
  const reload = (await call(env, p.cookie, "GET", `/api/solo/${s.game.id}/current`)).json();
  assert.ok(reload.question.remainingMs <= 4_100, `remainingMs=${reload.question.remainingMs}`);

  // Dernière question dans les temps
  const ok = await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/answer`, { gameQuestionId: gq[2].id, choiceIndex: await correctIndexOf(gq[2].id) });
  assert.equal(ok.json().correct, true);
  assert.equal(ok.json().finished, true);

  const result = (await call(env, p.cookie, "GET", `/api/solo/${s.game.id}/result`)).json();
  assert.equal(result.correct, 1);
  assert.equal(result.review.length, 3);
  assert.deepEqual(result.review.map((r: { timedOut: boolean }) => r.timedOut), [true, true, false]);
});

test("temps illimité (0) : jamais de hors délai", async () => {
  await setSettings({ soloQuestions: 3, timePerQuestionSec: 0 });
  const p = await player("solo-illimite");
  const s = (await start(p.cookie, smallChapter)).json();
  assert.equal(s.question.remainingMs, null);
  await env.prisma.gameQuestion.update({ where: { id: s.question.gameQuestionId }, data: { servedAt: new Date(Date.now() - 3_600_000) } });
  const a = await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/answer`, { gameQuestionId: s.question.gameQuestionId, choiceIndex: await correctIndexOf(s.question.gameQuestionId) });
  assert.equal(a.json().timedOut, false);
  assert.equal(a.json().correct, true);
  await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/abandon`);
});

test("chapitre plus petit que le nombre demandé : on utilise toutes les questions", async () => {
  await setSettings({ soloQuestions: 10, timePerQuestionSec: 20 });
  const p = await player("solo-petit");
  const s = (await start(p.cookie, smallChapter)).json();
  assert.equal(s.game.total, 3);
  await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/abandon`);
});

test("limite de parties par jour, reprise de la partie en cours, abandon", async () => {
  await setSettings({ soloQuestions: 5, soloGamesPerDay: 2, timePerQuestionSec: 20 });
  const p = await player("solo-limite");

  const st0 = (await call(env, p.cookie, "GET", `/api/subjects/${subjectId}/solo/status`)).json();
  assert.equal(st0.remaining, 2);
  assert.equal(st0.activeGameId, null);

  const g1 = (await start(p.cookie)).json();
  // Relancer pendant qu'une partie est en cours = la reprendre (même partie, pas de partie en plus)
  const again = (await start(p.cookie, smallChapter)).json();
  assert.equal(again.resumed, true);
  assert.equal(again.game.id, g1.game.id);
  assert.equal(again.game.chapter.name, "Grand");
  assert.equal(again.question.gameQuestionId, g1.question.gameQuestionId);

  assert.equal((await call(env, p.cookie, "POST", `/api/solo/${g1.game.id}/abandon`)).statusCode, 200);
  assert.equal((await call(env, p.cookie, "POST", `/api/solo/${g1.game.id}/abandon`)).statusCode, 409);
  const g2 = (await start(p.cookie)).json();
  await call(env, p.cookie, "POST", `/api/solo/${g2.game.id}/abandon`);

  const blocked = await start(p.cookie);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, "daily_limit_reached");
  const st = (await call(env, p.cookie, "GET", `/api/subjects/${subjectId}/solo/status`)).json();
  assert.equal(st.played, 2);
  assert.equal(st.remaining, 0);

  // La limite est propre à chaque joueur
  const other = await player("solo-limite-autre");
  assert.equal((await start(other.cookie)).statusCode, 201);

  // Les parties d'hier ne comptent pas : on recule la date des deux parties
  await env.prisma.game.updateMany({ where: { players: { some: { userId: p.id } } }, data: { createdAt: new Date(Date.now() - 48 * 3600_000) } });
  assert.equal((await start(p.cookie)).statusCode, 201);

  // Résultat d'une partie abandonnée accessible, mais pas d'une partie en cours
  assert.equal((await call(env, p.cookie, "GET", `/api/solo/${g1.game.id}/result`)).json().status, "ABANDONED");
});

test("limite à 0 = illimité", async () => {
  await setSettings({ soloQuestions: 3, soloGamesPerDay: 0 });
  const p = await player("solo-sans-limite");
  for (let i = 0; i < 4; i++) {
    const s = await start(p.cookie, smallChapter);
    assert.equal(s.statusCode, 201);
    await call(env, p.cookie, "POST", `/api/solo/${s.json().game.id}/abandon`);
  }
});

test("confidentialité : on ne peut ni voir ni jouer la partie d'un autre ; résultat refusé en cours de partie", async () => {
  await setSettings({ soloQuestions: 3, soloGamesPerDay: 0 });
  const a = await player("solo-a");
  const b = await player("solo-b");
  const s = (await start(a.cookie, smallChapter)).json();
  assert.equal((await call(env, b.cookie, "GET", `/api/solo/${s.game.id}/current`)).statusCode, 404);
  assert.equal((await call(env, b.cookie, "POST", `/api/solo/${s.game.id}/answer`, { gameQuestionId: s.question.gameQuestionId, choiceIndex: 0 })).statusCode, 404);
  assert.equal((await call(env, b.cookie, "POST", `/api/solo/${s.game.id}/abandon`)).statusCode, 404);
  assert.equal((await call(env, b.cookie, "GET", `/api/solo/${s.game.id}/result`)).statusCode, 404);
  assert.equal((await call(env, a.cookie, "GET", `/api/solo/${s.game.id}/result`)).statusCode, 409); // en cours : pas de corrigé
  await call(env, a.cookie, "POST", `/api/solo/${s.game.id}/abandon`);
});

test("accès révoqué en cours de partie : plus de réponse possible", async () => {
  await setSettings({ soloQuestions: 3, soloGamesPerDay: 0 });
  const p = await player("solo-revoque");
  const s = (await start(p.cookie, smallChapter)).json();
  await env.prisma.membership.updateMany({ where: { userId: p.id, subjectId }, data: { revokedAt: new Date() } });
  const res = await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/answer`, { gameQuestionId: s.question.gameQuestionId, choiceIndex: 0 });
  assert.equal(res.statusCode, 403);
  assert.equal((await start(p.cookie, smallChapter)).statusCode, 403);
});

test("les paramètres modifiés pendant une partie ne la changent pas", async () => {
  await setSettings({ soloQuestions: 3, soloGamesPerDay: 0, timePerQuestionSec: 20, xpPerCorrect: 10 });
  const p = await player("solo-snapshot");
  const s = (await start(p.cookie, smallChapter)).json();
  await setSettings({ xpPerCorrect: 50, timePerQuestionSec: 5 });
  const a = (await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/answer`, { gameQuestionId: s.question.gameQuestionId, choiceIndex: await correctIndexOf(s.question.gameQuestionId) })).json();
  assert.equal(a.xpGained, 10);
  await setSettings({ xpPerCorrect: null, timePerQuestionSec: null });
  await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/abandon`);
});

test("l'XP est propre à chaque matière", async () => {
  const p = await player("solo-matieres");
  await call(env, p.cookie, "POST", "/api/subjects/join", { accessName: "histoire", accessPassword: "acces-123" });
  await setSettings({ soloQuestions: 3, soloGamesPerDay: 0 });
  const s = (await start(p.cookie, smallChapter)).json();
  await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/answer`, { gameQuestionId: s.question.gameQuestionId, choiceIndex: await correctIndexOf(s.question.gameQuestionId) });
  const me = (await call(env, p.cookie, "GET", "/api/me")).json();
  const byName = Object.fromEntries(me.subjects.map((x: { name: string; xp: number }) => [x.name, x.xp]));
  assert.equal(byName["Chimie"], 10);
  assert.equal(byName["Histoire"], 0);
  await call(env, p.cookie, "POST", `/api/solo/${s.game.id}/abandon`);
});

test("tickets : parties restantes par type, illimité = null, un ticket part au lancement", async () => {
  await setSettings({ soloQuestions: 5, soloGamesPerDay: 3, maxActiveDuels: 4 });
  const p = await player("solo-tickets");
  const t0 = (await call(env, p.cookie, "GET", `/api/subjects/${subjectId}/tickets`)).json();
  assert.deepEqual(t0.solo, { total: 3, left: 3, resume: null });
  assert.deepEqual(t0.duel, { total: 4, left: 4 });
  assert.deepEqual(t0.live, { total: null, left: null });

  const g = (await start(p.cookie)).json();
  assert.equal((await call(env, p.cookie, "GET", `/api/subjects/${subjectId}/tickets`)).json().solo.left, 2);
  await start(p.cookie); // reprise : ne consomme rien
  assert.equal((await call(env, p.cookie, "GET", `/api/subjects/${subjectId}/tickets`)).json().solo.left, 2);
  await call(env, p.cookie, "POST", `/api/solo/${g.game.id}/abandon`);

  await setSettings({ soloGamesPerDay: 0, maxActiveDuels: 0 });
  const t1 = (await call(env, p.cookie, "GET", `/api/subjects/${subjectId}/tickets`)).json();
  assert.equal(t1.solo.total, null);
  assert.equal(t1.duel.total, null);
  assert.equal((await call(env, null, "GET", `/api/subjects/${subjectId}/tickets`)).statusCode, 401);
  assert.equal((await call(env, (await register(env, "solo-tickets-dehors")).cookie, "GET", `/api/subjects/${subjectId}/tickets`)).statusCode, 403);
});
