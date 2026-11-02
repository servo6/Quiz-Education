import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { DuelEngine, type Hub } from "../src/duel/engine.ts";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
let subjectId: string;
let otherId: string;
let chapterId: string;
let counter = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
  const mk = async (name: string, accessName: string) =>
    (await call(env, admin, "POST", "/api/subjects", { name, accessName, accessPassword: "acces-123" })).json().subject.id as string;
  subjectId = await mk("Chimie", "chimie");
  otherId = await mk("Histoire", "histoire");
  chapterId = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(40, "A"), newChapterName: "A" })).json().chapterId;
  await settings({ soloGamesPerDay: 0, soloQuestions: 6, roundsPerDuel: 2, questionsPerRound: 2, timePerQuestionSec: 30, maxActiveDuels: 0, shuffleChoices: false });
});
after(() => env.close());

const settings = (s: Record<string, unknown>) => call(env, admin, "PATCH", `/api/subjects/${subjectId}`, { settings: s });
async function player(accessName = "chimie") {
  const u = await register(env, `cmp-${++counter}`);
  await call(env, u.cookie, "POST", "/api/subjects/join", { accessName, accessPassword: "acces-123" });
  return u;
}
const originalAnswer = async (gqId: string) => (await env.prisma.gameQuestion.findUniqueOrThrow({ where: { id: gqId }, include: { question: true } })).question;

// ───────────── Mélange des choix ─────────────

test("mélange en solo : la réponse affichée correspond bien à la bonne réponse, revue cohérente", async () => {
  await settings({ shuffleChoices: true });
  const u = await player();
  const start = (await call(env, u.cookie, "POST", "/api/solo/start", { subjectId, chapterId })).json();
  const id = start.game.id;
  let q = start.question;
  let orderChanged = 0;
  let n = 0;
  while (q) {
    const orig = await originalAnswer(q.gameQuestionId);
    const origChoices = JSON.parse(orig.choices) as string[];
    const shown = q.choices as string[];
    assert.deepEqual([...shown].sort(), [...origChoices].sort());
    if (shown.join("|") !== origChoices.join("|")) orderChanged++;
    // on répond comme le ferait un joueur : en repérant le bon texte à l'écran
    const wanted = origChoices[orig.answerIndex];
    const pickIndex = n % 3 === 0 ? (shown.indexOf(wanted) + 1) % shown.length : shown.indexOf(wanted);
    const res = (await call(env, u.cookie, "POST", `/api/solo/${id}/answer`, { gameQuestionId: q.gameQuestionId, choiceIndex: pickIndex })).json();
    assert.equal(res.correct, n % 3 !== 0);
    assert.equal(shown[res.correctIndex], wanted); // l'indice renvoyé est dans l'ordre affiché
    n++;
    if (res.finished) break;
    q = (await call(env, u.cookie, "GET", `/api/solo/${id}/current`)).json().question;
  }
  assert.ok(orderChanged >= 1);
  // en base, on stocke la position d'origine
  const ans = await env.prisma.answer.findMany({ where: { userId: u.id }, include: { gameQuestion: { include: { question: true } } } });
  for (const a of ans) if (a.isCorrect) assert.equal(a.choiceIndex, a.gameQuestion.question.answerIndex);
  // un rechargement redonne le même ordre ; la revue est dans l'ordre vu par le joueur
  const review = (await call(env, u.cookie, "GET", `/api/solo/${id}/result`)).json().review;
  for (const r of review) {
    const isCorrect = r.yourChoice === r.correctIndex;
    const db = ans.find((a) => a.gameQuestion.question.text === r.text)!;
    assert.equal(isCorrect, db.isCorrect);
  }
  await settings({ shuffleChoices: false });
});

test("sans mélange : l'ordre d'origine est conservé", async () => {
  const u = await player();
  const start = (await call(env, u.cookie, "POST", "/api/solo/start", { subjectId, chapterId })).json();
  const orig = await originalAnswer(start.question.gameQuestionId);
  assert.deepEqual(start.question.choices, JSON.parse(orig.choices));
});

test("mélange en duel différé : chaque joueur voit son ordre, la revue reste cohérente", async () => {
  await settings({ shuffleChoices: true, roundsPerDuel: 1, questionsPerRound: 4 });
  const [a, b] = [await player(), await player()];
  const id = (await call(env, a.cookie, "POST", "/api/duels", { subjectId, opponentId: b.id, chapterId })).json().duel.id;
  const playAll = async (u: { cookie: string }) => {
    const shownBy: string[][] = [];
    for (;;) {
      const cur = (await call(env, u.cookie, "GET", `/api/duels/${id}/current`)).json();
      if (cur.status !== "IN_PROGRESS") return shownBy;
      const orig = await originalAnswer(cur.question.gameQuestionId);
      const wanted = (JSON.parse(orig.choices) as string[])[orig.answerIndex];
      shownBy.push(cur.question.choices);
      const res = (await call(env, u.cookie, "POST", `/api/duels/${id}/answer`, { gameQuestionId: cur.question.gameQuestionId, choiceIndex: cur.question.choices.indexOf(wanted) })).json();
      assert.equal(res.correct, true);
      assert.equal(cur.question.choices[res.correctIndex], wanted);
    }
  };
  const sa = await playAll(a);
  const sb = await playAll(b);
  assert.ok(sa.some((c, i) => c.join("|") !== sb[i].join("|")), "les deux joueurs devraient voir au moins un ordre différent");
  const ra = (await call(env, a.cookie, "GET", `/api/duels/${id}/result`)).json();
  assert.equal(ra.duel.status, "FINISHED");
  for (const r of ra.review) {
    assert.equal(r.you.choice, r.correctIndex);
    assert.equal(r.opponent.correct, true);
    assert.equal(r.choices[r.opponent.choice], r.choices[r.correctIndex]); // même texte, vu dans l'ordre de a
  }
  await settings({ shuffleChoices: false, roundsPerDuel: 2, questionsPerRound: 2 });
});

test("mélange en duel direct : indices cohérents et réponse stockée à sa position d'origine", async () => {
  await settings({ shuffleChoices: true, liveRoundsPerDuel: 1, liveQuestionsPerRound: 3 });
  const events: Array<{ userId: string; event: string; payload: any }> = [];
  const online = new Set<string>();
  const listeners: Array<(e: (typeof events)[number]) => void> = [];
  const hub: Hub = {
    emit(userId, event, payload) {
      const e = { userId, event, payload: payload as any };
      events.push(e);
      listeners.forEach((l) => l(e));
    },
    isOnline: (id) => online.has(id),
  };
  const engine = new DuelEngine({ prisma: env.prisma, hub, timings: { revealMs: 20, graceMs: 50, challengeTtlMs: 2000 }, logger: { error: () => {} } });
  const [a, b] = [await player(), await player()];
  online.add(a.id).add(b.id);
  const done = new Promise<any>((resolve) => listeners.push((e) => e.event === "duel:finished" && e.userId === a.id && resolve(e.payload)));
  for (const u of [a, b]) {
    listeners.push((e) => {
      if (e.userId !== u.id) return;
      if (e.event === "duel:pick_chapter" && e.payload.picker === u.id) setImmediate(() => engine.pickChapter(u.id, e.payload.gameId, chapterId).catch(() => {}));
      if (e.event === "duel:question") {
        const p = e.payload;
        void originalAnswer(p.gameQuestionId).then((orig) => {
          const wanted = (JSON.parse(orig.choices) as string[])[orig.answerIndex];
          void engine.answer(u.id, p.gameId, p.gameQuestionId, (p.choices as string[]).indexOf(wanted)).catch(() => {});
        });
      }
      if (e.event === "duel:reveal") assert.equal(e.payload.correctIndex >= 0, true);
    });
  }
  const { challengeId } = await engine.createChallenge(a.id, subjectId, b.id);
  await engine.respondChallenge(b.id, challengeId, true);
  const fin = await done;
  assert.equal(fin.you.correct, 3);
  const answers = await env.prisma.answer.findMany({ where: { userId: a.id, gameQuestion: { game: { mode: "FRIENDLY" } } }, include: { gameQuestion: { include: { question: true } } } });
  assert.ok(answers.length >= 3);
  for (const x of answers) assert.equal(x.choiceIndex, x.gameQuestion.question.answerIndex);
  engine.shutdown();
  await settings({ shuffleChoices: false, roundsPerDuel: 2, questionsPerRound: 2 });
});

// ───────────── Duels différés : notifications, revanche, adversaire aléatoire, plafond, résumé ─────────────

test("notifications : défi, tour de l'adversaire, fin du duel", async () => {
  const [a, b] = [await player(), await player()];
  const got: Array<{ to: string; event: string; payload: any }> = [];
  const hub = env.app.hub as unknown as { emit: (u: string, e: string, p: unknown) => void };
  const original = hub.emit.bind(hub);
  hub.emit = (to, event, payload) => {
    got.push({ to, event, payload });
    original(to, event, payload);
  };
  try {
    const id = (await call(env, a.cookie, "POST", "/api/duels", { subjectId, opponentId: b.id, chapterId })).json().duel.id;
    assert.equal(got.filter((g) => g.event === "duel:challenged" && g.to === b.id).length, 1);

    const playRound = async (u: { cookie: string }) => {
      for (;;) {
        const cur = (await call(env, u.cookie, "GET", `/api/duels/${id}/current`)).json();
        if (cur.status !== "IN_PROGRESS") return;
        const o = await originalAnswer(cur.question.gameQuestionId);
        await call(env, u.cookie, "POST", `/api/duels/${id}/answer`, { gameQuestionId: cur.question.gameQuestionId, choiceIndex: o.answerIndex });
      }
    };
    await playRound(a); // a termine la manche 1 → b doit jouer
    const turn = got.find((g) => g.event === "duel:turn" && g.to === b.id)!;
    assert.equal(turn.payload.action, "play");
    assert.equal(turn.payload.duelId, id);
    assert.equal(got.filter((g) => g.event === "duel:turn" && g.to === a.id).length, 0);

    await playRound(b); // b termine la manche 1 → b doit choisir (manche 2 lui appartient), a n'est pas notifié
    assert.equal(got.filter((g) => g.event === "duel:turn" && g.to === a.id).length, 0);
    await call(env, b.cookie, "POST", `/api/duels/${id}/pick`, { chapterId });
    await playRound(b);
    assert.equal(got.filter((g) => g.event === "duel:turn" && g.to === a.id).length, 1); // a peut jouer la manche 2
    await playRound(a);
    assert.equal(got.filter((g) => g.event === "duel:ended").length, 2);
  } finally {
    hub.emit = original;
  }
});

test("revanche : après la fin seulement, mêmes joueurs, le demandeur devient challenger", async () => {
  const [a, b] = [await player(), await player()];
  const id = (await call(env, a.cookie, "POST", "/api/duels", { subjectId, opponentId: b.id, chapterId })).json().duel.id;
  assert.equal((await call(env, b.cookie, "POST", `/api/duels/${id}/rematch`, { chapterId })).statusCode, 409);
  await call(env, a.cookie, "POST", `/api/duels/${id}/forfeit`);
  const re = await call(env, b.cookie, "POST", `/api/duels/${id}/rematch`, { chapterId });
  assert.equal(re.statusCode, 201);
  assert.equal(re.json().duel.challenger, true);
  assert.equal(re.json().duel.opponent.id, a.id);
  assert.notEqual(re.json().duel.id, id);
  assert.equal((await call(env, b.cookie, "POST", `/api/duels/${id}/rematch`, { chapterId })).statusCode, 409); // un duel est déjà en cours
  const stranger = await player("histoire");
  assert.equal((await call(env, stranger.cookie, "POST", `/api/duels/${id}/rematch`, { chapterId })).statusCode, 404);
});

test("adversaire aléatoire : même matière, jamais soi-même, jamais quelqu'un déjà affronté en cours", async () => {
  const aloneId = await (async () => {
    const id = (await call(env, admin, "POST", "/api/subjects", { name: "Seul", accessName: "seul", accessPassword: "acces-123" })).json().subject.id as string;
    return id;
  })();
  await env.prisma.membership.deleteMany({ where: { subjectId: aloneId } }); // l'admin devient membre en créant la matière
  const aloneChapter = (await call(env, admin, "POST", `/api/subjects/${aloneId}/import/commit`, { raw: sampleBlock(10, "S"), newChapterName: "S" })).json().chapterId;
  const solo = await register(env, `cmp-${++counter}`);
  await call(env, solo.cookie, "POST", "/api/subjects/join", { accessName: "seul", accessPassword: "acces-123" });
  const none = await call(env, solo.cookie, "POST", `/api/subjects/${aloneId}/duels/random`, { chapterId: aloneChapter });
  assert.equal(none.statusCode, 404);
  assert.equal(none.json().error.code, "no_opponent");

  const [a, b, c] = [await player(), await player(), await player()];
  const members = new Set<string>();
  const r1 = await call(env, a.cookie, "POST", `/api/subjects/${subjectId}/duels/random`, { chapterId });
  assert.equal(r1.statusCode, 201);
  members.add(r1.json().duel.opponent.id);
  assert.notEqual(r1.json().duel.opponent.id, a.id);
  const inSubject = await env.prisma.membership.findMany({ where: { subjectId }, select: { userId: true } });
  assert.ok(inSubject.some((m) => m.userId === r1.json().duel.opponent.id));
  // plusieurs tirages : jamais le même adversaire deux fois tant que le duel court
  for (let i = 0; i < 4; i++) {
    const r = await call(env, a.cookie, "POST", `/api/subjects/${subjectId}/duels/random`, { chapterId });
    assert.equal(r.statusCode, 201);
    assert.equal(members.has(r.json().duel.opponent.id), false);
    members.add(r.json().duel.opponent.id);
  }
  void b;
  void c;
  const outsider = await player("histoire");
  assert.equal((await call(env, outsider.cookie, "POST", `/api/subjects/${subjectId}/duels/random`, { chapterId })).statusCode, 403);
});

test("plafond de duels simultanés", async () => {
  await settings({ maxActiveDuels: 2 });
  const [a, b, c, d] = [await player(), await player(), await player(), await player()];
  const mk = (from: { cookie: string }, to: { id: string }) => call(env, from.cookie, "POST", "/api/duels", { subjectId, opponentId: to.id, chapterId });
  assert.equal((await mk(a, b)).statusCode, 201);
  assert.equal((await mk(a, c)).statusCode, 201);
  const third = await mk(a, d);
  assert.equal(third.statusCode, 429);
  assert.equal(third.json().error.code, "too_many_duels");
  // l'adversaire déjà plein
  assert.equal((await mk(d, b)).statusCode, 201); // b : 2e duel
  const full = await mk(c, b);
  assert.equal(full.json().error.code, "opponent_too_many_duels");
  await settings({ maxActiveDuels: 0 });
});

test("résumé : duels à jouer, expirations proches, parties solo en cours", async () => {
  const [a, b] = [await player(), await player()];
  const id = (await call(env, a.cookie, "POST", "/api/duels", { subjectId, opponentId: b.id, chapterId })).json().duel.id;
  await call(env, a.cookie, "POST", "/api/solo/start", { subjectId, chapterId });
  let sa = (await call(env, a.cookie, "GET", "/api/me/summary")).json();
  assert.equal(sa.yourTurnCount, 1);
  assert.equal(sa.expiringSoonCount, 0);
  assert.equal(sa.duels[0].action, "play");
  assert.equal(sa.duels[0].subject.name, "Chimie");
  assert.equal(sa.soloInProgress.length, 1);
  const sb = (await call(env, b.cookie, "GET", "/api/me/summary")).json();
  assert.equal(sb.yourTurnCount, 0);
  assert.equal(sb.duels[0].action, "wait");

  // échéance dans 5 heures
  const g = await env.prisma.game.findUniqueOrThrow({ where: { id } });
  await env.prisma.game.update({ where: { id }, data: { config: JSON.stringify({ ...JSON.parse(g.config), deadlineAt: new Date(Date.now() + 5 * 3_600_000).toISOString() }) } });
  sa = (await call(env, a.cookie, "GET", "/api/me/summary")).json();
  assert.equal(sa.expiringSoonCount, 1);
  assert.ok(sa.duels[0].hoursLeft <= 5);
  assert.equal((await call(env, null, "GET", "/api/me/summary")).statusCode, 401);
});

// ───────────── Comptes et administration ─────────────

test("mot de passe personnel", async () => {
  const u = await player();
  const bodyOk = { currentPassword: "password-123", newPassword: "nouveau-mdp-1" };
  assert.equal((await call(env, null, "POST", "/api/me/password", bodyOk)).statusCode, 401);
  assert.equal((await call(env, u.cookie, "POST", "/api/me/password", { ...bodyOk, currentPassword: "faux" })).statusCode, 401);
  assert.equal((await call(env, u.cookie, "POST", "/api/me/password", { ...bodyOk, newPassword: "court" })).statusCode, 400);
  assert.equal((await call(env, u.cookie, "POST", "/api/me/password", { currentPassword: "password-123", newPassword: "password-123" })).statusCode, 422);
  assert.equal((await call(env, u.cookie, "POST", "/api/me/password", bodyOk)).statusCode, 200);
  const name = `cmp-${counter}`;
  assert.equal((await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: name, password: "password-123" } })).statusCode, 401);
  assert.equal((await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: name, password: "nouveau-mdp-1" } })).statusCode, 200);
});

test("rôles : nommer / retirer un administrateur", async () => {
  const u = await player();
  const v = await player();
  assert.equal((await call(env, u.cookie, "PUT", `/api/users/${v.id}/role`, { role: "ADMIN" })).statusCode, 403);
  assert.equal((await call(env, admin, "PUT", `/api/users/${v.id}/role`, { role: "SUPER" })).statusCode, 400);
  const adminUser = await env.prisma.user.findFirstOrThrow({ where: { role: "ADMIN", username: ADMIN.username } });
  assert.equal((await call(env, admin, "PUT", `/api/users/${adminUser.id}/role`, { role: "USER" })).statusCode, 422); // soi-même
  assert.equal((await call(env, admin, "PUT", `/api/users/inconnu/role`, { role: "ADMIN" })).statusCode, 404);

  assert.equal((await call(env, admin, "PUT", `/api/users/${v.id}/role`, { role: "ADMIN" })).json().role, "ADMIN");
  assert.equal((await call(env, v.cookie, "GET", "/api/users")).statusCode, 200); // il a maintenant les droits
  // retiré : redevient simple utilisateur, ou responsable s'il gère encore une matière
  await call(env, admin, "PUT", `/api/subjects/${subjectId}/managers/${v.id}`).catch(() => {});
  assert.equal((await call(env, admin, "PUT", `/api/users/${v.id}/role`, { role: "USER" })).json().role, "USER");
  const w = await player();
  await call(env, admin, "PUT", `/api/subjects/${subjectId}/managers/${w.id}`);
  await call(env, admin, "PUT", `/api/users/${w.id}/role`, { role: "ADMIN" }).catch(() => {});
  assert.ok(await env.prisma.adminLog.findFirst({ where: { action: "SET_ROLE" } }));
});

test("liste des utilisateurs : filtres et pagination", async () => {
  const p = await player();
  const banned = await player();
  await call(env, admin, "POST", `/api/users/${banned.id}/ban`);
  assert.equal((await call(env, p.cookie, "GET", "/api/users")).statusCode, 403);
  const onlyBanned = (await call(env, admin, "GET", "/api/users?banned=true&limit=100")).json().users;
  assert.ok(onlyBanned.every((u: any) => u.banned));
  assert.ok(onlyBanned.some((u: any) => u.id === banned.id));
  const admins = (await call(env, admin, "GET", "/api/users?role=ADMIN")).json().users;
  assert.ok(admins.every((u: any) => u.role === "ADMIN"));
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: any = (await call(env, admin, "GET", `/api/users?limit=7${cursor ? `&cursor=${cursor}` : ""}`)).json();
    seen.push(...page.users.map((u: any) => u.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, await env.prisma.user.count());
  const found = (await call(env, admin, "GET", `/api/users?q=${p.id ? `cmp-${counter - 1}` : ""}`)).json().users;
  assert.ok(found.length >= 1);
  assert.equal(JSON.stringify(found).includes("passwordHash"), false);
  assert.equal(typeof found[0].subjectCount, "number");
});

test("vue d'ensemble et sauvegarde : réservées à l'administrateur, sans secret", async () => {
  const p = await player();
  assert.equal((await call(env, p.cookie, "GET", "/api/admin/overview")).statusCode, 403);
  assert.equal((await call(env, p.cookie, "GET", "/api/admin/export")).statusCode, 403);
  const ov = (await call(env, admin, "GET", "/api/admin/overview")).json();
  assert.ok(ov.users.total >= 5);
  assert.ok(ov.subjects >= 2);
  assert.ok(ov.questions >= 40);
  assert.ok(ov.games.SOLO);
  assert.equal(typeof ov.users.activeLast7Days, "number");
  const ex = (await call(env, admin, "GET", "/api/admin/export")).json();
  assert.ok(ex.users.length >= 5 && ex.questions.length >= 40 && ex.badges !== undefined);
  const text = JSON.stringify(ex);
  assert.equal(text.includes("passwordHash"), false);
  assert.equal(text.includes("accessPasswordHash"), false);
  assert.ok(await env.prisma.adminLog.findFirst({ where: { action: "EXPORT_BACKUP" } }));
});

// ───────────── Interface web et en-têtes ─────────────

test("fichiers statiques : page d'accueil, repli, API intacte, en-têtes de sécurité", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-public-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Quiz</title><p>accueil</p>");
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
  const app = await buildApp({ prisma: env.prisma, jwtSecret: "test-secret-test-secret-test-secret-123", rateLimit: false, realtime: false, staticDir: dir });
  try {
    const home = await app.inject({ method: "GET", url: "/" });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /accueil/);
    assert.equal(home.headers["x-content-type-options"], "nosniff");
    assert.equal(home.headers["x-frame-options"], "DENY");
    assert.equal((await app.inject({ method: "GET", url: "/assets/app.js" })).statusCode, 200);
    // adresse interne de l'application : index.html ; fichier absent ou API : 404 JSON
    assert.match((await app.inject({ method: "GET", url: "/jeu/solo", headers: { accept: "text/html" } })).body, /accueil/);
    const api = await app.inject({ method: "GET", url: "/api/inconnu", headers: { accept: "text/html" } });
    assert.equal(api.statusCode, 404);
    assert.equal(api.json().error.code, "not_found");
    assert.equal((await app.inject({ method: "GET", url: "/nexiste/pas.js" })).statusCode, 404);
    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.headers["cache-control"], "no-store");
    // traversée de répertoire
    assert.notEqual((await app.inject({ method: "GET", url: "/..%2f..%2fetc%2fpasswd" })).statusCode, 200);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // sans dossier public : l'API seule fonctionne comme avant
  const bare = await env.app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
  assert.equal(bare.statusCode, 404);
  assert.equal((await env.app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
  void sleep;
});

test("l'administrateur devient membre des matières qu'il crée et peut entrer dans les autres sans mot de passe d'accès", async () => {
  const created = (await call(env, admin, "POST", "/api/subjects", { name: "AdminMembre", accessName: "adminmembre", accessPassword: "acces-123" })).json().subject.id as string;
  const me1 = (await call(env, admin, "GET", "/api/me")).json();
  assert.ok(me1.subjects.some((s: { id: string }) => s.id === created));

  const other = (await call(env, admin, "POST", "/api/subjects", { name: "AutreMatiere", accessName: "autrematiere", accessPassword: "acces-123" })).json().subject.id as string;
  await env.prisma.membership.deleteMany({ where: { subjectId: other } });
  assert.equal((await call(env, admin, "POST", "/api/me/active-subject", { subjectId: other })).statusCode, 200);
  assert.ok((await call(env, admin, "GET", "/api/me")).json().subjects.some((s: { id: string }) => s.id === other));

  const player = await register(env, `cmp-${++counter}`);
  assert.equal((await call(env, player.cookie, "POST", "/api/me/active-subject", { subjectId: other })).statusCode, 403);
});
