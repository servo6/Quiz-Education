import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
});
after(() => env.close());

const newSubject = (name: string, accessName: string, accessPassword = "acces-123") =>
  call(env, admin, "POST", "/api/subjects", { name, accessName, accessPassword });

test("seul l'administrateur crée une matière", async () => {
  const user = await register(env, "u-create");
  assert.equal((await call(env, user.cookie, "POST", "/api/subjects", { name: "Chimie", accessName: "chimie", accessPassword: "acces-123" })).statusCode, 403);
  const res = await newSubject("Chimie", "Chimie-2026");
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().subject.accessName, "chimie-2026"); // minuscules
  assert.equal((await newSubject("Chimie", "autre-nom")).statusCode, 409);
  assert.equal((await newSubject("Autre", "chimie-2026")).statusCode, 409);
});

test("rejoindre une matière : bon accès, mauvais accès, idempotence", async () => {
  await newSubject("Histoire", "histoire");
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
  assert.equal(me.subjects[0].level, 1);
  assert.equal(me.user.activeSubjectId, me.subjects[0].id); // première matière = active
});

test("plusieurs matières, changement de matière active, accès refusé hors matière", async () => {
  const a = (await newSubject("Maths", "maths")).json().subject;
  const b = (await newSubject("Physique", "physique")).json().subject;
  const u = await register(env, "u-switch");
  await call(env, u.cookie, "POST", "/api/subjects/join", { accessName: "maths", accessPassword: "acces-123" });
  await call(env, u.cookie, "POST", "/api/subjects/join", { accessName: "physique", accessPassword: "acces-123" });

  assert.equal((await call(env, u.cookie, "POST", "/api/me/active-subject", { subjectId: b.id })).statusCode, 200);
  assert.equal((await call(env, u.cookie, "GET", "/api/me")).json().user.activeSubjectId, b.id);

  const other = (await newSubject("Anglais", "anglais")).json().subject;
  assert.equal((await call(env, u.cookie, "POST", "/api/me/active-subject", { subjectId: other.id })).statusCode, 403);
  assert.ok(a.id);
});

test("accès révoqué : impossible de rejoindre à nouveau", async () => {
  const s = (await newSubject("Latin", "latin")).json().subject;
  const u = await register(env, "u-revoked");
  await call(env, u.cookie, "POST", "/api/subjects/join", { accessName: "latin", accessPassword: "acces-123" });
  await env.prisma.membership.updateMany({ where: { userId: u.id, subjectId: s.id }, data: { revokedAt: new Date() } });
  const res = await call(env, u.cookie, "POST", "/api/subjects/join", { accessName: "latin", accessPassword: "acces-123" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, "access_revoked");
  assert.equal((await call(env, u.cookie, "GET", "/api/me")).json().subjects.length, 0);
  assert.equal((await call(env, u.cookie, "POST", "/api/me/active-subject", { subjectId: s.id })).statusCode, 403);
});

test("changer le mot de passe d'accès invalide l'ancien", async () => {
  const s = (await newSubject("Grec", "grec")).json().subject;
  const patch = await call(env, admin, "PATCH", `/api/subjects/${s.id}`, { accessPassword: "nouveau-mdp" });
  assert.equal(patch.statusCode, 200);
  const u = await register(env, "u-pw");
  assert.equal((await call(env, u.cookie, "POST", "/api/subjects/join", { accessName: "grec", accessPassword: "acces-123" })).statusCode, 401);
  assert.equal((await call(env, u.cookie, "POST", "/api/subjects/join", { accessName: "grec", accessPassword: "nouveau-mdp" })).statusCode, 200);
});

test("responsable de matière : assignation, droits limités, retrait", async () => {
  const s1 = (await newSubject("Bio", "bio")).json().subject;
  const s2 = (await newSubject("Géo", "geo")).json().subject;
  const mgr = await register(env, "mgr");

  // Un utilisateur simple ne peut pas assigner
  assert.equal((await call(env, mgr.cookie, "PUT", `/api/subjects/${s1.id}/managers/${mgr.id}`)).statusCode, 403);

  assert.equal((await call(env, admin, "PUT", `/api/subjects/${s1.id}/managers/${mgr.id}`)).statusCode, 200);
  assert.equal((await call(env, mgr.cookie, "GET", "/api/me")).json().user.role, "SUBJECT_MANAGER");
  assert.deepEqual((await call(env, mgr.cookie, "GET", "/api/me")).json().managedSubjectIds, [s1.id]);

  const list = (await call(env, mgr.cookie, "GET", "/api/subjects")).json().subjects;
  assert.deepEqual(list.map((s: { id: string }) => s.id), [s1.id]);

  // Son rôle : sa matière oui, l'autre non, rien de global
  assert.equal((await call(env, mgr.cookie, "GET", `/api/subjects/${s1.id}`)).statusCode, 200);
  assert.equal((await call(env, mgr.cookie, "GET", `/api/subjects/${s2.id}`)).statusCode, 403);
  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/subjects/${s1.id}`, { accessPassword: "nouveau-mdp-2" })).statusCode, 200);
  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/subjects/${s1.id}`, { name: "Renommée" })).statusCode, 403);
  assert.equal((await call(env, mgr.cookie, "PATCH", `/api/subjects/${s2.id}`, { accessPassword: "nouveau-mdp-2" })).statusCode, 403);
  assert.equal((await call(env, mgr.cookie, "POST", "/api/subjects", { name: "X", accessName: "xxx", accessPassword: "acces-123" })).statusCode, 403);
  assert.equal((await call(env, mgr.cookie, "GET", "/api/settings")).statusCode, 403);

  // Responsable de deux matières, puis retrait progressif
  await call(env, admin, "PUT", `/api/subjects/${s2.id}/managers/${mgr.id}`);
  await call(env, admin, "DELETE", `/api/subjects/${s1.id}/managers/${mgr.id}`);
  assert.equal((await call(env, mgr.cookie, "GET", "/api/me")).json().user.role, "SUBJECT_MANAGER");
  await call(env, admin, "DELETE", `/api/subjects/${s2.id}/managers/${mgr.id}`);
  assert.equal((await call(env, mgr.cookie, "GET", "/api/me")).json().user.role, "USER");
  assert.equal((await call(env, mgr.cookie, "GET", "/api/subjects")).statusCode, 403);
});

test("un administrateur ne peut pas être désigné responsable", async () => {
  const s = (await newSubject("Éco", "eco")).json().subject;
  const adminId = (await call(env, admin, "GET", "/api/me")).json().user.id;
  assert.equal((await call(env, admin, "PUT", `/api/subjects/${s.id}/managers/${adminId}`)).statusCode, 400);
});

test("paramètres : globaux, surcharge par matière, valeurs invalides, retour au défaut", async () => {
  const s = (await newSubject("Philo", "philo")).json().subject;

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
  assert.equal(detail.settings.soloQuestions, 15); // hérité du global

  await call(env, admin, "PATCH", `/api/subjects/${s.id}`, { settings: { timePerQuestionSec: null } }); // supprime la surcharge
  detail = (await call(env, admin, "GET", `/api/subjects/${s.id}`)).json();
  assert.equal(detail.settings.timePerQuestionSec, 30);
  assert.deepEqual(detail.overrides, {});
});

test("les actions d'administration sont journalisées", async () => {
  const n = await env.prisma.adminLog.count({ where: { action: "CREATE_SUBJECT" } });
  assert.ok(n >= 5);
});
