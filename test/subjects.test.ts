import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, TEST_ORG, call, createTestEnv, joinSubject, login, register, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
});
after(() => env.close());

const newSubject = (name: string) => call(env, admin, "POST", "/api/subjects", { name });

/** Crée un responsable de matière (compte créé par le super admin, qui reste dans les tests l'« autorité »). */
async function newManager(subjectId: string, username: string) {
  const res = await call(env, admin, "POST", `/api/subjects/${subjectId}/managers`, { username, password: "password-123" });
  assert.equal(res.statusCode, 201);
  return { id: res.json().manager.id as string, cookie: await login(env, username, "password-123") };
}

test("seul le personnel habilité crée une matière", async () => {
  const user = await register(env, "u-create");
  assert.equal((await call(env, user.cookie, "POST", "/api/subjects", { name: "Chimie" })).statusCode, 403);
  const res = await newSubject("Chimie");
  assert.equal(res.statusCode, 201);
  assert.equal((await newSubject("Chimie")).statusCode, 409);
});

test("rejoindre une matière : bonnes clés, mauvaises clés, idempotence ; l'organisation en découle", async () => {
  const res = await call(env, admin, "POST", "/api/subjects", { name: "Histoire", accessName: "histoire", accessPassword: "acces-123" });
  assert.equal(res.statusCode, 201);
  const u = await register(env, "u-join");

  const bad = await call(env, u.cookie, "POST", "/api/subjects/join", { accessName: "histoire", accessPassword: "faux-mdp" });
  assert.equal(bad.statusCode, 401);
  const unknown = await call(env, u.cookie, "POST", "/api/subjects/join", { accessName: "nexiste-pas", accessPassword: "faux-mdp" });
  assert.equal(unknown.statusCode, 401);
  assert.equal(bad.json().error.message, unknown.json().error.message);

  const ok = await call(env, u.cookie, "POST", "/api/subjects/join", { accessName: "HISTOIRE", accessPassword: "acces-123" });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().alreadyMember, false);
  assert.equal((await call(env, u.cookie, "POST", "/api/subjects/join", { accessName: "histoire", accessPassword: "acces-123" })).json().alreadyMember, true);

  const me = (await call(env, u.cookie, "GET", "/api/me")).json();
  assert.equal(me.subjects.length, 1);
  assert.equal(me.subjects[0].name, "Histoire");
  assert.equal(me.user.activeSubjectId, me.subjects[0].id);
  assert.equal(me.organizations[0].name, TEST_ORG.name);
});

test("plusieurs matières, changement de matière active, accès refusé hors matière", async () => {
  const a = (await newSubject("Maths")).json().subject;
  const b = (await newSubject("Physique")).json().subject;
  const u = await register(env, "u-switch");
  await joinSubject(env, u.cookie, "maths");
  await joinSubject(env, u.cookie, "physique");

  assert.equal((await call(env, u.cookie, "POST", "/api/me/active-subject", { subjectId: b.id })).statusCode, 200);
  assert.equal((await call(env, u.cookie, "GET", "/api/me")).json().user.activeSubjectId, b.id);

  const other = (await newSubject("Anglais")).json().subject;
  assert.equal((await call(env, u.cookie, "POST", "/api/me/active-subject", { subjectId: other.id })).statusCode, 403);
  assert.ok(a.id);
});

test("accès révoqué : impossible de rejoindre à nouveau", async () => {
  const s = (await newSubject("Latin")).json().subject;
  const u = await register(env, "u-revoked");
  await joinSubject(env, u.cookie, "latin");
  await env.prisma.membership.updateMany({ where: { userId: u.id, subjectId: s.id }, data: { revokedAt: new Date() } });
  const res = await joinSubject(env, u.cookie, s.id);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, "access_revoked");
  assert.equal((await call(env, u.cookie, "GET", "/api/me")).json().subjects.length, 0);
  assert.equal((await call(env, u.cookie, "POST", "/api/me/active-subject", { subjectId: s.id })).statusCode, 403);
});

test("responsable de matière : compte créé, droits limités à ses matières, aucune promotion", async () => {
  const s1 = (await newSubject("Bio")).json().subject;
  const s2 = (await newSubject("Géo")).json().subject;
  const player = await register(env, "simple-joueur");

  // Un joueur ne crée pas de responsable et ne peut pas être « promu »
  assert.equal((await call(env, player.cookie, "POST", `/api/subjects/${s1.id}/managers`, { username: "x-mgr", password: "password-123" })).statusCode, 403);
  assert.equal((await call(env, admin, "PUT", `/api/subjects/${s1.id}/managers/${player.id}`)).statusCode, 404);
  assert.equal((await call(env, admin, "PUT", `/api/users/${player.id}/role`, { role: "ADMIN" })).statusCode, 404);

  const mgr = await newManager(s1.id, "mgr");
  const me = (await call(env, mgr.cookie, "GET", "/api/me")).json();
  assert.equal(me.user.role, "SUBJECT_MANAGER");
  assert.deepEqual(me.managedSubjectIds, [s1.id]);
  assert.deepEqual(me.subjects.map((s: { id: string }) => s.id), [s1.id]); // il ne voit même pas les autres matières

  const list = (await call(env, mgr.cookie, "GET", "/api/subjects")).json().subjects;
  assert.deepEqual(list.map((s: { id: string }) => s.id), [s1.id]);

  assert.equal((await call(env, mgr.cookie, "GET", `/api/subjects/${s1.id}`)).statusCode, 200);
  assert.equal((await call(env, mgr.cookie, "GET", `/api/subjects/${s2.id}`)).statusCode, 403);
  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/subjects/${s1.id}`, { settings: { soloQuestions: 12 } })).statusCode, 200);
  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/subjects/${s1.id}`, { name: "Renommée" })).statusCode, 403);
  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/subjects/${s2.id}`, { settings: { soloQuestions: 12 } })).statusCode, 403);
  assert.equal((await call(env, mgr.cookie, "POST", "/api/subjects", { name: "X" })).statusCode, 403);
  assert.equal((await call(env, mgr.cookie, "POST", `/api/subjects/${s1.id}/managers`, { username: "autre-mgr", password: "password-123" })).statusCode, 403);
  assert.equal((await call(env, mgr.cookie, "GET", "/api/settings")).statusCode, 403);
  assert.equal((await call(env, mgr.cookie, "POST", "/api/me/active-subject", { subjectId: s2.id })).statusCode, 403);

  // Deux matières, puis retrait : le compte reste un compte de gestion, jamais un joueur
  assert.equal((await call(env, admin, "PUT", `/api/subjects/${s2.id}/managers/${mgr.id}`)).statusCode, 200);
  await call(env, admin, "DELETE", `/api/subjects/${s1.id}/managers/${mgr.id}`);
  assert.equal((await call(env, mgr.cookie, "GET", "/api/me")).json().user.role, "SUBJECT_MANAGER");
  await call(env, admin, "DELETE", `/api/subjects/${s2.id}/managers/${mgr.id}`);
  const after = (await call(env, mgr.cookie, "GET", "/api/me")).json();
  assert.equal(after.user.role, "SUBJECT_MANAGER");
  assert.deepEqual(after.subjects, []);
  assert.equal((await call(env, mgr.cookie, "GET", `/api/subjects/${s1.id}`)).statusCode, 403);
});

test("paramètres : globaux, surcharge par matière, valeurs invalides, retour au défaut", async () => {
  const s = (await newSubject("Philo")).json().subject;

  assert.equal((await call(env, admin, "GET", "/api/settings")).json().settings.timePerQuestionSec, 20);
  assert.equal((await call(env, admin, "PUT", "/api/settings", { timePerQuestionSec: 30, soloQuestions: 15 })).statusCode, 200);
  assert.equal((await call(env, admin, "PUT", "/api/settings", { soloQuestions: 0 })).statusCode, 400);
  assert.equal((await call(env, admin, "PUT", "/api/settings", { inconnu: 1 })).statusCode, 400);

  let detail = (await call(env, admin, "GET", `/api/subjects/${s.id}`)).json();
  assert.equal(detail.settings.timePerQuestionSec, 30);
  assert.equal(detail.settings.soloQuestions, 15);

  await call(env, admin, "PATCH", `/api/subjects/${s.id}`, { settings: { timePerQuestionSec: 0 } }); // 0 = pas de limite
  detail = (await call(env, admin, "GET", `/api/subjects/${s.id}`)).json();
  assert.equal(detail.settings.timePerQuestionSec, 0);
  assert.equal(detail.settings.soloQuestions, 15);

  await call(env, admin, "PATCH", `/api/subjects/${s.id}`, { settings: { timePerQuestionSec: null } });
  detail = (await call(env, admin, "GET", `/api/subjects/${s.id}`)).json();
  assert.equal(detail.settings.timePerQuestionSec, 30);
  assert.deepEqual(detail.overrides, {});
});

test("les actions d'administration sont journalisées", async () => {
  const n = await env.prisma.adminLog.count({ where: { action: "CREATE_SUBJECT" } });
  assert.ok(n >= 5);
});

test("lien de partage des clés : mot de passe mémorisé chiffré, réservé à la gestion de la matière", async () => {
  const sub = (await newSubject("Partage")).json().subject.id as string;
  const mgr = await newManager(sub, "mgr-partage");
  const other = (await newSubject("Autre matière")).json().subject.id as string;
  const user = await register(env, "u-partage");
  assert.equal((await call(env, user.cookie, "POST", `/api/subjects/${sub}/share`, {})).statusCode, 403);
  assert.equal((await call(env, mgr.cookie, "POST", `/api/subjects/${other}/share`, {})).statusCode, 403);

  // Aucun mot de passe connu (matière créée sans clés) : il faut le saisir une fois
  assert.equal((await call(env, mgr.cookie, "POST", `/api/subjects/${sub}/share`, {})).statusCode, 409);
  const set = await call(env, mgr.cookie, "PATCH", `/api/subjects/${sub}`, { accessName: "partage-x", accessPassword: "secret-partage-1" });
  assert.equal(set.statusCode, 200);
  const ok = await call(env, mgr.cookie, "POST", `/api/subjects/${sub}/share`, {});
  assert.equal(ok.statusCode, 200);
  assert.deepEqual([ok.json().accessName, ok.json().accessPassword], ["partage-x", "secret-partage-1"]);
  // Le mot de passe n'est jamais stocké en clair
  const row = await env.prisma.setting.findUnique({ where: { key: `share:${sub}` } });
  assert.ok(row && !row.value.includes("secret-partage-1"));
  // Les clés partagées permettent bien de rejoindre
  assert.equal((await call(env, user.cookie, "POST", "/api/subjects/join", { accessName: "partage-x", accessPassword: "secret-partage-1" })).statusCode, 200);

  // Matière existante dont le mot de passe n'est pas mémorisé : saisie vérifiée
  await env.prisma.setting.deleteMany({ where: { key: `share:${sub}` } });
  assert.equal((await call(env, mgr.cookie, "POST", `/api/subjects/${sub}/share`, {})).statusCode, 409);
  assert.equal((await call(env, mgr.cookie, "POST", `/api/subjects/${sub}/share`, { accessPassword: "faux-faux-1" })).statusCode, 401);
  const again = await call(env, mgr.cookie, "POST", `/api/subjects/${sub}/share`, { accessPassword: "secret-partage-1" });
  assert.equal(again.json().accessPassword, "secret-partage-1");
  assert.equal((await call(env, mgr.cookie, "POST", `/api/subjects/${sub}/share`, {})).statusCode, 200);
});
