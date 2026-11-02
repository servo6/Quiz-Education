import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ensureDefaultAvatarItems } from "../src/avatar.ts";
import { ensureDefaultBadges } from "../src/badges.ts";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv, joinSubject, assignManager } from "./helpers.ts";

let env: TestEnv;
let admin: string;
let subjectId: string;
let otherSubjectId: string;
let chapterId: string;
let counter = 0;

before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
  const mk = async (name: string, accessName: string) =>
    (await call(env, admin, "POST", "/api/subjects", { name })).json().subject.id as string;
  subjectId = await mk("Chimie", "chimie");
  otherSubjectId = await mk("Histoire", "histoire");
  chapterId = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(30, "A"), newChapterName: "A" })).json().chapterId;
  await call(env, admin, "PATCH", `/api/subjects/${subjectId}`, { settings: { soloQuestions: 10, soloGamesPerDay: 0, timePerQuestionSec: 30 } });
  await ensureDefaultBadges(env.prisma);
  await ensureDefaultAvatarItems(env.prisma);
});
after(() => env.close());

async function player(sid = "chimie") {
  const u = await register(env, `prog-${++counter}`);
  await joinSubject(env, u.cookie, sid);
  return u;
}
const setXp = (userId: string, xp: number, sid = subjectId) => env.prisma.membership.update({ where: { userId_subjectId: { userId, subjectId: sid } }, data: { xp } });
const correctOf = async (gqId: string) => (await env.prisma.gameQuestion.findUniqueOrThrow({ where: { id: gqId }, include: { question: true } })).question.answerIndex;

/** Partie solo complète ; renvoie la dernière réponse. */
async function playSolo(cookie: string, wrong = 0) {
  const start = await call(env, cookie, "POST", "/api/solo/start", { subjectId, chapterId });
  assert.ok(start.statusCode === 201 || start.statusCode === 200, start.body);
  const id = start.json().game.id;
  let q = start.json().question;
  let last: any;
  let i = 0;
  while (q) {
    const right = await correctOf(q.gameQuestionId);
    const choice = i++ < wrong ? (right + 1) % q.choices.length : right;
    last = (await call(env, cookie, "POST", `/api/solo/${id}/answer`, { gameQuestionId: q.gameQuestionId, choiceIndex: choice })).json();
    if (last.finished) break;
    q = (await call(env, cookie, "GET", `/api/solo/${id}/current`)).json().question;
  }
  return last;
}

// ───────────── Titres ─────────────

test("titres : valeurs par défaut, remplacement global et par matière, droits", async () => {
  const u = await player();
  const def = (await call(env, u.cookie, "GET", "/api/tiers")).json();
  assert.equal(def.source, "default");
  assert.equal(def.tiers[0].name, "Novice");

  let me = (await call(env, u.cookie, "GET", "/api/me")).json();
  assert.equal(me.subjects[0].title.name, "Novice");

  const body = { tiers: [{ name: "Petit", minLevel: 1, color: "#112233" }, { name: "Grand", minLevel: 2 }] };
  assert.equal((await call(env, u.cookie, "PUT", "/api/tiers", body)).statusCode, 403);
  assert.equal((await call(env, admin, "PUT", "/api/tiers", { tiers: [{ name: "X", minLevel: 2 }] })).statusCode, 422); // pas de niveau 1
  assert.equal((await call(env, admin, "PUT", "/api/tiers", { tiers: [{ name: "X", minLevel: 1 }, { name: "Y", minLevel: 1 }] })).statusCode, 422);
  assert.equal((await call(env, admin, "PUT", "/api/tiers", { tiers: [{ name: "X", minLevel: 1, color: "rouge" }] })).statusCode, 400);

  const ok = await call(env, admin, "PUT", "/api/tiers", body);
  assert.equal(ok.json().source, "global");
  await setXp(u.id, 150); // niveau 2 (100 XP pour le niveau 1)
  me = (await call(env, u.cookie, "GET", "/api/me")).json();
  assert.equal(me.subjects[0].level, 2);
  assert.equal(me.subjects[0].title.name, "Grand");

  // surcharge pour une matière, puis retour au global
  await call(env, admin, "PUT", `/api/subjects/${subjectId}/tiers`, { tiers: [{ name: "Alchimiste", minLevel: 1 }] });
  me = (await call(env, u.cookie, "GET", "/api/me")).json();
  assert.equal(me.subjects[0].title.name, "Alchimiste");
  assert.equal((await call(env, u.cookie, "PUT", `/api/subjects/${subjectId}/tiers`, body)).statusCode, 403);
  await call(env, admin, "DELETE", `/api/subjects/${subjectId}/tiers`);
  me = (await call(env, u.cookie, "GET", "/api/me")).json();
  assert.equal(me.subjects[0].title.name, "Grand");
  await env.prisma.tier.deleteMany({}); // retour aux titres par défaut pour la suite
});

// ───────────── Badges ─────────────

test("badges : attribués à la fin d'une partie, une seule fois, progression visible", async () => {
  const u = await player();
  assert.equal((await call(env, u.cookie, "GET", "/api/me/badges")).json().earnedCount, 0);

  const last = await playSolo(u.cookie); // 10/10, réponses immédiates
  const codes = last.newBadges.map((b: any) => b.code).sort();
  assert.deepEqual(codes, ["correct_10", "fast_10", "fast_5", "perfect_solo_1"]);

  const list = (await call(env, u.cookie, "GET", "/api/me/badges")).json();
  assert.equal(list.newlyEarned.length, 0); // déjà attribués
  assert.equal(list.earnedCount, 4);
  const c100 = list.badges.find((b: any) => b.code === "correct_100");
  assert.equal(c100.earned, false);
  assert.equal(c100.current, 10);
  assert.equal(c100.threshold, 100);
  assert.equal(await env.prisma.userBadge.count({ where: { userId: u.id } }), 4);

  const again = await playSolo(u.cookie, 3);
  assert.deepEqual(again.newBadges, []); // rien de nouveau
  assert.equal(await env.prisma.userBadge.count({ where: { userId: u.id } }), 4);
});

test("badges : victoires en duel, matières jouées, série de jours", async () => {
  const u = await player();
  const o = await player();
  const g = await env.prisma.game.create({ data: { subjectId, mode: "DUEL", status: "FINISHED", finishedAt: new Date() } });
  await env.prisma.gamePlayer.createMany({ data: [{ gameId: g.id, userId: u.id, result: "WIN" }, { gameId: g.id, userId: o.id, result: "LOSS" }] });
  const g2 = await env.prisma.game.create({ data: { subjectId: otherSubjectId, mode: "SOLO", status: "FINISHED" } });
  await env.prisma.gamePlayer.create({ data: { gameId: g2.id, userId: u.id } });
  // 3 jours consécutifs de réponses
  const gq = await env.prisma.gameQuestion.findFirstOrThrow({ where: {} });
  for (let d = 0; d < 3; d++) {
    const u2 = d === 0 ? u : u;
    const gqx = await env.prisma.gameQuestion.findMany({ take: 3 });
    await env.prisma.answer.create({ data: { gameQuestionId: gqx[d].id, userId: u2.id, choiceIndex: 0, isCorrect: false, timeMs: 9000, answeredAt: new Date(Date.now() - d * 86_400_000 + 3_600_000 * 0) } });
  }
  void gq;
  const earned = (await call(env, u.cookie, "GET", "/api/me/badges")).json().badges.filter((b: any) => b.earned).map((b: any) => b.code);
  assert.ok(earned.includes("wins_1"));
  assert.ok(earned.includes("subjects_2"));
  assert.ok(earned.includes("streak_3"));
  assert.equal(earned.includes("wins_10"), false);
  const oEarned = (await call(env, o.cookie, "GET", "/api/me/badges")).json().badges.filter((b: any) => b.earned);
  assert.equal(oEarned.length, 0);
});

test("badges : administration (droits, code unique, suppression)", async () => {
  const u = await player();
  const body = { code: "mon_badge", name: "Mon badge", description: "Test", conditionType: "CORRECT_TOTAL", threshold: 1 };
  assert.equal((await call(env, u.cookie, "POST", "/api/badges", body)).statusCode, 403);
  assert.equal((await call(env, admin, "POST", "/api/badges", { ...body, conditionType: "INCONNU" })).statusCode, 400);
  const created = await call(env, admin, "POST", "/api/badges", body);
  assert.equal(created.statusCode, 201);
  assert.equal((await call(env, admin, "POST", "/api/badges", body)).statusCode, 409);
  const id = created.json().badge.id;
  assert.equal((await call(env, admin, "PATCH", `/api/badges/${id}`, { threshold: 2 })).json().badge.threshold, 2);
  assert.equal((await call(env, admin, "DELETE", `/api/badges/${id}`)).statusCode, 200);
  assert.equal((await call(env, admin, "DELETE", `/api/badges/${id}`)).statusCode, 404);
});

// ───────────── Avatar ─────────────

test("avatar : catalogue verrouillé, enregistrement, déblocage par niveau et par badge", async () => {
  const u = await player();
  const cat = (await call(env, u.cookie, "GET", "/api/avatar/items")).json();
  const item = (name: string) => cat.items.find((i: any) => i.name === name);
  assert.equal(item("Courts").unlocked, true);
  assert.equal(item("Crête").unlocked, false);
  assert.match(item("Crête").lockReason, /Niveau 10/);

  const save = (items: Record<string, string | null>, colors: Record<string, string> = {}) => call(env, u.cookie, "PUT", "/api/me/avatar", { items, colors });
  assert.equal((await save({ hair: item("Courts").id, outfit: item("T-shirt").id }, { skin: "#f2c9a0" })).statusCode, 200);
  assert.equal((await save({ hair: item("Crête").id })).statusCode, 403);
  assert.equal((await save({ hair: item("T-shirt").id })).statusCode, 422); // mauvaise catégorie
  assert.equal((await save({ hair: "inconnu" })).statusCode, 422);
  assert.equal((await save({ hair: item("Courts").id }, { skin: "pas-une-couleur" })).statusCode, 400);

  const me = (await call(env, u.cookie, "GET", "/api/me")).json();
  assert.equal(me.user.avatar.items.hair, item("Courts").id);
  assert.equal(me.user.avatar.colors.skin, "#f2c9a0");

  // niveau 10 : environ 6400 XP cumulés
  await setXp(u.id, 8000);
  assert.equal((await save({ hair: item("Crête").id })).statusCode, 200);
  // badge requis pour la couronne
  assert.equal((await save({ hat: item("Couronne").id })).statusCode, 403);
  const badge = await env.prisma.badge.findUniqueOrThrow({ where: { code: "wins_50" } });
  await env.prisma.userBadge.create({ data: { userId: u.id, badgeId: badge.id } });
  assert.equal((await save({ hat: item("Couronne").id })).statusCode, 200);
});

test("avatar : administration du catalogue", async () => {
  const u = await player();
  const body = { category: "hat", name: "Chapeau test", assetPath: "avatars/hat/test.svg", unlockType: "LEVEL", unlockValue: "2" };
  assert.equal((await call(env, u.cookie, "POST", "/api/avatar/items", body)).statusCode, 403);
  assert.equal((await call(env, admin, "POST", "/api/avatar/items", { ...body, category: "cape" })).statusCode, 400);
  const id = (await call(env, admin, "POST", "/api/avatar/items", body)).json().item.id;
  assert.equal((await call(env, admin, "PATCH", `/api/avatar/items/${id}`, { unlockType: "FREE", unlockValue: null })).json().item.unlockType, "FREE");
  assert.equal((await call(env, admin, "DELETE", `/api/avatar/items/${id}`)).statusCode, 200);
  assert.equal((await call(env, admin, "DELETE", `/api/avatar/items/${id}`)).statusCode, 404);
});

// ───────────── Classement, statistiques, profil ─────────────

test("classement : tri par XP, égalités, exclus (révoqués), droits", async () => {
  await env.prisma.membership.updateMany({ where: { subjectId }, data: { xp: 0 } });
  const [a, b, c, d] = [await player(), await player(), await player(), await player()];
  await setXp(a.id, 300);
  await setXp(b.id, 200);
  await setXp(c.id, 200);
  await setXp(d.id, 900);
  await env.prisma.membership.update({ where: { userId_subjectId: { userId: d.id, subjectId } }, data: { revokedAt: new Date() } });

  const lb = (await call(env, c.cookie, "GET", `/api/subjects/${subjectId}/leaderboard`)).json();
  const mine = lb.players.filter((p: any) => p.xp > 0);
  assert.deepEqual(mine.map((p: any) => [p.rank, p.xp]), [[1, 300], [2, 200], [2, 200]]);
  assert.deepEqual(lb.you, { rank: 2, xp: 200 });
  assert.ok(lb.players[0].title.name);
  assert.equal(lb.players.some((p: any) => p.id === d.id), false);
  assert.equal(JSON.stringify(lb).includes("passwordHash"), false);

  assert.equal((await call(env, d.cookie, "GET", `/api/subjects/${subjectId}/leaderboard`)).statusCode, 403);
  assert.equal((await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/leaderboard?limit=1`)).json().players.length, 1);
});

test("statistiques personnelles : réussite globale, par chapitre, par mode, duels", async () => {
  const u = await player();
  await playSolo(u.cookie, 4); // 6/10
  const s = (await call(env, u.cookie, "GET", `/api/subjects/${subjectId}/stats`)).json();
  assert.equal(s.answers.total, 10);
  assert.equal(s.answers.correct, 6);
  assert.equal(s.answers.accuracy, 60);
  assert.equal(s.byMode.SOLO.accuracy, 60);
  assert.equal(s.chapters[0].name, "A");
  assert.equal(s.chapters[0].accuracy, 60);
  assert.equal(s.solo.finished, 1);
  assert.equal(s.xpBySource.CORRECT_ANSWER, 60);
  assert.equal(s.player.xp, 60);
  assert.equal(s.duels.played, 0);
  assert.equal((await call(env, (await player("histoire")).cookie, "GET", `/api/subjects/${subjectId}/stats`)).statusCode, 403);
});

test("profil d'un joueur : même matière seulement, avec le bilan face à face", async () => {
  const [me, rival, stranger] = [await player(), await player(), await player("histoire")];
  for (const [r1, r2] of [["WIN", "LOSS"], ["WIN", "LOSS"], ["DRAW", "DRAW"], ["LOSS", "WIN"]] as const) {
    const g = await env.prisma.game.create({ data: { subjectId, mode: "DUEL", status: "FINISHED", finishedAt: new Date() } });
    await env.prisma.gamePlayer.createMany({ data: [{ gameId: g.id, userId: me.id, result: r1 }, { gameId: g.id, userId: rival.id, result: r2 }] });
  }
  const p = (await call(env, me.cookie, "GET", `/api/subjects/${subjectId}/players/${rival.id}`)).json();
  assert.deepEqual(p.headToHead, { played: 4, yourWins: 2, theirWins: 1, draws: 1 });
  assert.equal(p.duels.wins, 1);
  assert.ok(Array.isArray(p.badges));
  assert.equal(JSON.stringify(p).includes("passwordHash"), false);
  assert.equal((await call(env, me.cookie, "GET", `/api/subjects/${subjectId}/players/${me.id}`)).json().headToHead, null);
  assert.equal((await call(env, me.cookie, "GET", `/api/subjects/${subjectId}/players/${stranger.id}`)).statusCode, 404);
  assert.equal((await call(env, stranger.cookie, "GET", `/api/subjects/${subjectId}/players/${me.id}`)).statusCode, 403);
});

// ───────────── Membres ─────────────

test("membres : liste, révocation par un responsable, limites de ses droits, rétablissement", async () => {
  const [mgr, victim, other, mgr2] = [await player(), await player(), await player(), await player("histoire")];
  assert.equal((await assignManager(env, subjectId, mgr.id)).statusCode, 200);
  assert.equal((await assignManager(env, otherSubjectId, mgr2.id)).statusCode, 200);
  const mgrCookie = (await login(env, `prog-${counter - 3}`, "password-123"));

  assert.equal((await call(env, victim.cookie, "GET", `/api/subjects/${subjectId}/members`)).statusCode, 403);
  const list = (await call(env, mgrCookie, "GET", `/api/subjects/${subjectId}/members?q=prog-`)).json();
  assert.ok(list.members.some((m: any) => m.userId === victim.id));
  assert.equal(JSON.stringify(list).includes("passwordHash"), false);

  // un responsable d'une autre matière n'a aucun droit ici
  const mgr2Cookie = await login(env, `prog-${counter}`, "password-123");
  assert.equal((await call(env, mgr2Cookie, "POST", `/api/subjects/${subjectId}/members/${victim.id}/revoke`)).statusCode, 403);
  // un responsable ne peut pas révoquer un autre responsable de sa matière, ni un administrateur, ni lui-même
  const adminUser = await env.prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  await env.prisma.membership.create({ data: { userId: adminUser.id, subjectId } }).catch(() => {});
  assert.equal((await call(env, mgrCookie, "POST", `/api/subjects/${subjectId}/members/${adminUser.id}/revoke`)).statusCode, 403);
  assert.equal((await call(env, mgrCookie, "POST", `/api/subjects/${subjectId}/members/${mgr.id}/revoke`)).statusCode, 404); // un responsable n'est pas un membre

  // révocation : plus d'accès au jeu, XP conservé, duel différé clos
  await setXp(victim.id, 500);
  const duel = await call(env, victim.cookie, "POST", "/api/duels", { subjectId, opponentId: other.id, chapterId });
  assert.equal(duel.statusCode, 201);
  const res = await call(env, mgrCookie, "POST", `/api/subjects/${subjectId}/members/${victim.id}/revoke`, { reason: "test" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().duelsClosed, 1);
  assert.equal((await call(env, mgrCookie, "POST", `/api/subjects/${subjectId}/members/${victim.id}/revoke`)).statusCode, 409);
  assert.equal((await call(env, victim.cookie, "POST", "/api/solo/start", { subjectId, chapterId })).statusCode, 403);
  assert.equal((await env.prisma.membership.findUniqueOrThrow({ where: { userId_subjectId: { userId: victim.id, subjectId } } })).xp, 500);
  const revoked = (await call(env, mgrCookie, "GET", `/api/subjects/${subjectId}/members?status=revoked`)).json().members;
  assert.ok(revoked.some((m: any) => m.userId === victim.id));
  assert.ok(revoked.every((m: any) => m.revokedAt));
  assert.ok(await env.prisma.adminLog.findFirst({ where: { action: "REVOKE_ACCESS", subjectId } }));

  assert.equal((await call(env, mgrCookie, "POST", `/api/subjects/${subjectId}/members/${victim.id}/restore`)).statusCode, 200);
  assert.equal((await call(env, mgrCookie, "POST", `/api/subjects/${subjectId}/members/${victim.id}/restore`)).statusCode, 409);
  assert.equal((await call(env, victim.cookie, "POST", "/api/solo/start", { subjectId, chapterId })).statusCode, 201);
  assert.equal((await call(env, mgrCookie, "POST", `/api/subjects/${subjectId}/members/inconnu/revoke`)).statusCode, 404);
});

test("comptes : suspension, rétablissement, réinitialisation du mot de passe", async () => {
  const u = await player();
  const victim = await register(env, "a-suspendre");
  assert.equal((await call(env, u.cookie, "POST", `/api/users/${victim.id}/ban`)).statusCode, 403);
  const adminUser = await env.prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  assert.equal((await call(env, admin, "POST", `/api/users/${adminUser.id}/ban`)).statusCode, 403); // super admin intouchable

  assert.equal((await call(env, admin, "POST", `/api/users/${victim.id}/ban`, { reason: "spam" })).statusCode, 200);
  assert.equal((await call(env, admin, "POST", `/api/users/${victim.id}/ban`)).statusCode, 409);
  assert.equal((await call(env, victim.cookie, "GET", "/api/me")).statusCode, 403);
  const attempt = await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "a-suspendre", password: "password-123" } });
  assert.equal(attempt.statusCode, 403);

  assert.equal((await call(env, admin, "POST", `/api/users/${victim.id}/unban`)).statusCode, 200);
  assert.equal((await call(env, admin, "POST", `/api/users/${victim.id}/unban`)).statusCode, 409);
  assert.equal((await call(env, victim.cookie, "GET", "/api/me")).statusCode, 200);

  assert.equal((await call(env, u.cookie, "POST", `/api/users/${victim.id}/reset-password`, { newPassword: "nouveau-mdp-123" })).statusCode, 403);
  assert.equal((await call(env, admin, "POST", `/api/users/${victim.id}/reset-password`, { newPassword: "court" })).statusCode, 400);
  assert.equal((await call(env, admin, "POST", `/api/users/${victim.id}/reset-password`, { newPassword: "nouveau-mdp-123" })).statusCode, 200);
  const old = await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "a-suspendre", password: "password-123" } });
  assert.equal(old.statusCode, 401);
  const fresh = await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "a-suspendre", password: "nouveau-mdp-123" } });
  assert.equal(fresh.statusCode, 200);
});
