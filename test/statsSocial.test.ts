import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv, joinSubject } from "./helpers.ts";
import { addDaysKey, startOfPeriod } from "../src/time.ts";
import { answerStreaks, dayStreaks } from "../src/routes/stats.ts";
import { purgeExpiredMessages } from "../src/routes/social.ts";

let env: TestEnv;
let admin: string;
let subjectId: string;
let chapterId: string;
let n = 0;

before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Stats" })).json().subject.id;
  chapterId = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(20, "S"), newChapterName: "S" })).json().chapterId;
  await call(env, admin, "PATCH", `/api/subjects/${subjectId}`, { settings: { soloQuestions: 5, soloGamesPerDay: 0, timePerQuestionSec: 0 } });
});
after(() => env.close());

async function player() {
  const u = await register(env, `st-${++n}`);
  await joinSubject(env, u.cookie, "stats");
  return u;
}
const right = async (gq: string) => (await env.prisma.gameQuestion.findUniqueOrThrow({ where: { id: gq }, include: { question: true } })).question.answerIndex;
async function playSolo(cookie: string, wrong = 0) {
  const start = (await call(env, cookie, "POST", "/api/solo/start", { subjectId, chapterId })).json();
  let q = start.question;
  let i = 0;
  while (q) {
    const r = await right(q.gameQuestionId);
    const res = (await call(env, cookie, "POST", `/api/solo/${start.game.id}/answer`, { gameQuestionId: q.gameQuestionId, choiceIndex: i++ < wrong ? (r + 1) % q.choices.length : r })).json();
    if (res.finished) break;
    q = (await call(env, cookie, "GET", `/api/solo/${start.game.id}/current`)).json().question;
  }
}

test("séries de jours et de bonnes réponses", () => {
  assert.deepEqual(dayStreaks(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-10"], "2026-01-10"), { current: 1, longest: 3 });
  assert.deepEqual(dayStreaks(["2026-01-08", "2026-01-09"], "2026-01-10"), { current: 2, longest: 2 }); // encore valable hier
  assert.deepEqual(dayStreaks(["2026-01-05"], "2026-01-10"), { current: 0, longest: 1 });
  assert.deepEqual(answerStreaks([true, true, false, true, true, true]), { current: 3, longest: 3 });
  assert.equal(addDaysKey("2026-03-01", -1), "2026-02-28");
});

test("début de semaine / mois dans le fuseau", () => {
  const at = new Date("2026-11-04T10:00:00Z"); // mercredi
  assert.equal(startOfPeriod("week", at, "Europe/Paris").toISOString(), "2026-11-01T23:00:00.000Z"); // lundi 2 nov 00:00 Paris
  assert.equal(startOfPeriod("month", at, "Europe/Paris").toISOString(), "2026-10-31T23:00:00.000Z");
});

test("statistiques complètes d'un joueur : totaux, séries, courbe, calendrier, chapitres", async () => {
  const u = await player();
  await playSolo(u.cookie, 1);
  const s = (await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/stats/full?days=14`)).json();
  assert.equal(s.totals.answers, 5);
  assert.equal(s.totals.correct, 4);
  assert.equal(s.totals.accuracy, 80);
  assert.equal(s.streaks.daysCurrent, 1);
  assert.equal(s.streaks.daysLongest, 1);
  assert.equal(s.streaks.correctLongest, 4);
  assert.equal(s.series.length, 14);
  assert.equal(s.series.at(-1).answers, 5);
  assert.equal(s.calendar.length, 1);
  assert.equal(s.chapters[0].answered, 5);
  assert.equal(s.solo.finished, 1);
  assert.equal(s.weekday.reduce((a: number, w: any) => a + w.answers, 0), 5);
  assert.equal(s.hours.reduce((a: number, b: number) => a + b, 0), 5);
  assert.equal(s.rank, 1);
});

test("classement : critères et périodes, admin exclu", async () => {
  const [a, b] = [await player(), await player()];
  await playSolo(a.cookie);
  await playSolo(b.cookie, 3);
  const byCorrect = (await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/ranking?metric=correct&period=week`)).json();
  assert.equal(byCorrect.players[0].id, a.id);
  assert.equal(byCorrect.players[0].value, 5);
  const ids = byCorrect.players.map((p: any) => p.id);
  assert.ok(ids.indexOf(a.id) < ids.indexOf(b.id));
  assert.equal(byCorrect.you.rank, ids.indexOf(a.id) + 1);
  const xpAll = (await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/ranking?metric=xp&period=all`)).json();
  assert.ok(xpAll.players.length >= 3);
  // Une période sans activité ne liste personne.
  await env.prisma.answer.updateMany({ data: { answeredAt: new Date("2020-01-01") } });
  await env.prisma.xpEvent.updateMany({ data: { createdAt: new Date("2020-01-01") } });
  const empty = (await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/ranking?metric=xp&period=month`)).json();
  assert.equal(empty.players.length, 0);
  assert.equal(empty.you.rank, null);
  const wins = (await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/ranking?metric=wins&period=all`)).json();
  assert.equal(wins.metric, "wins");
});

test("statistiques administrateur : réservées, complètes, détail d'un joueur", async () => {
  const u = await player();
  await playSolo(u.cookie, 2);
  assert.equal((await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/admin-stats`)).statusCode, 403);
  assert.equal((await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/stats/player/${u.id}`)).statusCode, 403);
  const st = (await call(env, admin, "GET", `/api/subjects/${subjectId}/admin-stats?days=7`)).json();
  assert.ok(st.totals.members >= 1);
  assert.ok(st.totals.answers >= 5);
  assert.equal(st.series.length, 7);
  assert.ok(st.players.some((p: any) => p.id === u.id));
  assert.ok(!st.players.some((p: any) => p.username === ADMIN.username));
  assert.equal(st.hours.length, 24);
  assert.equal(st.chapters.length, 1);
  const one = (await call(env, admin, "GET", `/api/subjects/${subjectId}/stats/player/${u.id}`)).json();
  assert.equal(one.player.id, u.id);
  assert.equal(one.totals.answers, 5);
  assert.equal((await call(env, admin, "GET", "/api/subjects/inconnue/stats/player/x")).statusCode, 404);
});

test("amis : invitation, acceptation croisée, refus, règles", async () => {
  const [a, b, c] = [await player(), await player(), await player()];
  const inv = await call(env, a.cookie, "POST", `/api/subjects/${subjectId}/friends`, { userId: b.id });
  assert.equal(inv.statusCode, 201);
  assert.equal((await call(env, a.cookie, "POST", `/api/subjects/${subjectId}/friends`, { userId: b.id })).statusCode, 409);
  assert.equal((await call(env, a.cookie, "POST", `/api/subjects/${subjectId}/friends`, { userId: a.id })).statusCode, 422);
  assert.equal((await call(env, a.cookie, "POST", `/api/subjects/${subjectId}/friends`, { userId: "inconnu" })).statusCode, 404);
  const listB = (await call(env, b.cookie, "GET", `/api/subjects/${subjectId}/friends`)).json();
  assert.equal(listB.incoming.length, 1);
  assert.equal(listB.incoming[0].user.id, a.id);
  assert.equal((await call(env, b.cookie, "GET", "/api/me/social-summary")).json().invitations, 1);
  // L'invitant ne peut pas accepter lui-même.
  assert.equal((await call(env, a.cookie, "POST", `/api/friendships/${inv.json().id}/accept`)).statusCode, 403);
  // Un tiers ne voit pas l'amitié.
  assert.equal((await call(env, c.cookie, "POST", `/api/friendships/${inv.json().id}/accept`)).statusCode, 404);
  assert.equal((await call(env, b.cookie, "POST", `/api/friendships/${inv.json().id}/accept`)).statusCode, 200);
  assert.equal((await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/friends`)).json().friends.length, 1);
  // Invitations croisées : acceptation automatique.
  const x = await call(env, c.cookie, "POST", `/api/subjects/${subjectId}/friends`, { userId: a.id });
  assert.equal(x.statusCode, 201);
  const y = await call(env, a.cookie, "POST", `/api/subjects/${subjectId}/friends`, { userId: c.id });
  assert.equal(y.statusCode, 200);
  assert.equal(y.json().status, "ACCEPTED");
  // Refus.
  const d = await player();
  const inv2 = (await call(env, d.cookie, "POST", `/api/subjects/${subjectId}/friends`, { userId: b.id })).json();
  assert.equal((await call(env, b.cookie, "DELETE", `/api/friendships/${inv2.id}`)).statusCode, 200);
  assert.equal((await call(env, b.cookie, "GET", `/api/subjects/${subjectId}/friends`)).json().incoming.length, 0);
});

test("messagerie : échange, non lus, droits, suppression automatique configurable", async () => {
  const [a, b, c] = [await player(), await player(), await player()];
  const fid = (await call(env, a.cookie, "POST", `/api/subjects/${subjectId}/friends`, { userId: b.id })).json().id;
  // Pas de message avant l'acceptation.
  assert.equal((await call(env, a.cookie, "POST", `/api/friendships/${fid}/messages`, { body: "salut" })).statusCode, 409);
  await call(env, b.cookie, "POST", `/api/friendships/${fid}/accept`);
  assert.equal((await call(env, a.cookie, "POST", `/api/friendships/${fid}/messages`, { body: "  salut !  " })).statusCode, 201);
  assert.equal((await call(env, a.cookie, "POST", `/api/friendships/${fid}/messages`, { body: "   " })).statusCode, 400);
  assert.equal((await call(env, a.cookie, "POST", `/api/friendships/${fid}/messages`, { body: "x".repeat(1001) })).statusCode, 400);
  assert.equal((await call(env, c.cookie, "GET", `/api/friendships/${fid}/messages`)).statusCode, 404);
  assert.equal((await call(env, c.cookie, "POST", `/api/friendships/${fid}/messages`, { body: "intrus" })).statusCode, 404);
  assert.equal((await call(env, b.cookie, "GET", "/api/me/social-summary")).json().unread, 1);
  const list = (await call(env, b.cookie, "GET", `/api/subjects/${subjectId}/friends`)).json();
  assert.equal(list.friends[0].unread, 1);
  assert.equal(list.friends[0].last.body, "salut !");
  const thread = (await call(env, b.cookie, "GET", `/api/friendships/${fid}/messages`)).json();
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].mine, false);
  assert.equal((await call(env, b.cookie, "GET", "/api/me/social-summary")).json().unread, 0); // lu

  // Conservation : 7 jours par défaut, configurable par l'administrateur uniquement.
  assert.equal((await call(env, a.cookie, "GET", "/api/chat/settings")).json().retentionDays, 7);
  assert.equal((await call(env, a.cookie, "PUT", "/api/admin/chat", { retentionDays: 2 })).statusCode, 403);
  assert.equal((await call(env, admin, "PUT", "/api/admin/chat", { retentionDays: 5 })).statusCode, 400);
  const old = await env.prisma.message.create({ data: { friendshipId: fid, senderId: a.id, body: "ancien", createdAt: new Date(Date.now() - 3 * 86_400_000) } });
  assert.equal((await call(env, b.cookie, "GET", `/api/friendships/${fid}/messages`)).json().messages.length, 2); // 3 j < 7 j
  const put = (await call(env, admin, "PUT", "/api/admin/chat", { retentionDays: 2 })).json();
  assert.equal(put.retentionDays, 2);
  assert.equal(put.purged, 1);
  assert.equal(await env.prisma.message.findUnique({ where: { id: old.id } }), null);
  assert.equal((await call(env, b.cookie, "GET", `/api/friendships/${fid}/messages`)).json().messages.length, 1);
  // Un message de 2,5 jours est masqué même avant la purge.
  const edge = await env.prisma.message.create({ data: { friendshipId: fid, senderId: a.id, body: "limite", createdAt: new Date(Date.now() - 2.5 * 86_400_000) } });
  assert.equal((await call(env, b.cookie, "GET", `/api/friendships/${fid}/messages`)).json().messages.length, 1);
  assert.equal(await purgeExpiredMessages(env.prisma), 1);
  assert.equal(await env.prisma.message.findUnique({ where: { id: edge.id } }), null);
  await call(env, admin, "PUT", "/api/admin/chat", { retentionDays: 30 });
  assert.equal((await call(env, a.cookie, "GET", "/api/chat/settings")).json().retentionDays, 30);

  // Retirer l'ami supprime la conversation.
  await call(env, a.cookie, "DELETE", `/api/friendships/${fid}`);
  assert.equal(await env.prisma.message.count({ where: { friendshipId: fid } }), 0);
});

test("l'administrateur n'a pas de messagerie de joueur", async () => {
  assert.equal((await call(env, admin, "GET", `/api/subjects/${subjectId}/friends`)).statusCode, 403);
  assert.deepEqual((await call(env, admin, "GET", "/api/me/social-summary")).json(), { unread: 0, invitations: 0 });
});

test("chapitres : couleur, blocage — invisible et injouable tant que bloqué", async () => {
  const u = await player();
  const bad = await call(env, admin, "POST", `/api/subjects/${subjectId}/chapters`, { name: "Mauvaise", color: "rouge" });
  assert.equal(bad.statusCode, 400);
  const made = (await call(env, admin, "POST", `/api/subjects/${subjectId}/chapters`, { name: "Secret", color: "#d9534f", locked: true })).json().chapter;
  assert.equal(made.locked, true);
  assert.equal(made.color, "#d9534f");
  await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(6, "Z"), chapterId: made.id });
  const names = async (cookie: string) => (await call(env, cookie, "GET", `/api/subjects/${subjectId}/chapters`)).json().chapters.map((c: any) => c.name);
  assert.ok((await names(admin)).includes("Secret")); // l'administration le voit
  assert.ok(!(await names(u.cookie)).includes("Secret")); // pas les joueurs
  // Impossible à jouer, en solo comme en duel.
  assert.equal((await call(env, u.cookie, "POST", "/api/solo/start", { subjectId, chapterId: made.id })).statusCode, 403);
  const opp = await player();
  assert.equal((await call(env, u.cookie, "POST", "/api/duels", { subjectId, opponentId: opp.id, chapterId: made.id })).statusCode, 403);
  // Débloqué : visible et jouable. Rebloqué : de nouveau caché.
  assert.equal((await call(env, admin, "PATCH", `/api/chapters/${made.id}`, { locked: false })).json().chapter.locked, false);
  assert.ok((await names(u.cookie)).includes("Secret"));
  assert.equal((await call(env, u.cookie, "POST", "/api/solo/start", { subjectId, chapterId: made.id })).statusCode, 201);
  await call(env, admin, "PATCH", `/api/chapters/${made.id}`, { locked: true, color: "#2f8f5b" });
  assert.ok(!(await names(u.cookie)).includes("Secret"));
  assert.equal((await call(env, u.cookie, "PATCH", `/api/chapters/${made.id}`, { locked: false })).statusCode, 403); // un joueur ne débloque rien
  // Un nouveau chapitre créé par import peut aussi naître bloqué et coloré.
  const imp = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(3, "I"), newChapterName: "Importé", newChapterColor: "#6670e0", newChapterLocked: true })).json();
  const row = await env.prisma.chapter.findUniqueOrThrow({ where: { id: imp.chapterId } });
  assert.equal(row.locked, true);
  assert.equal(row.color, "#6670e0");
});
