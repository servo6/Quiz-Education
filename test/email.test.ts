import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, TEST_ORG, call, createTestEnv, login, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let root: string;
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  root = await login(env, ADMIN.username, ADMIN.password);
});
after(() => env.close());

const reg = (body: object) => env.app.inject({ method: "POST", url: "/api/auth/register", payload: body });
const tokenFrom = (mail: { text: string }) => mail.text.match(/#\/[a-z-]+\/([\w-]+)/)![1];
const lastMail = (to: string) => [...env.outbox].reverse().find((m) => m.to === to)!;

test("inscription : e-mail facultatif, pseudo obligatoire, e-mail unique", async () => {
  assert.equal((await reg({ username: "sans-mail", password: "password-123" })).statusCode, 201);
  assert.equal((await reg({ username: "avec-mail", email: "Avec@Mail.test", password: "password-123" })).statusCode, 201);
  const u = await env.prisma.user.findUniqueOrThrow({ where: { username: "avec-mail" } });
  assert.equal(u.email, "avec@mail.test");
  assert.equal(u.emailVerifiedAt, null);
  assert.equal((await reg({ username: "autre", email: "avec@mail.test", password: "password-123" })).json().error.code, "email_taken");
  assert.equal((await reg({ username: "x", email: "pas-un-mail", password: "password-123" })).statusCode, 400);
  assert.equal((await reg({ email: "z@z.test", password: "password-123" })).statusCode, 400);
});

test("connexion par pseudo ou par e-mail", async () => {
  for (const id of ["avec-mail", "AVEC@mail.test"]) {
    const res = await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: id, password: "password-123" } });
    assert.equal(res.statusCode, 200, id);
    assert.equal(res.json().user.username, "avec-mail");
  }
  const bad = await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "avec@mail.test", password: "faux-faux-1" } });
  assert.equal(bad.statusCode, 401);
});

test("vérification de l'adresse via le lien reçu (usage unique)", async () => {
  const cookie = await login(env, "avec-mail", "password-123");
  const sent = await call(env, cookie, "POST", "/api/me/email/send-verification");
  assert.equal(sent.json().sent, true);
  const token = tokenFrom(lastMail("avec@mail.test"));
  assert.equal((await env.app.inject({ method: "POST", url: "/api/auth/verify-email", payload: { token } })).statusCode, 200);
  assert.equal((await env.app.inject({ method: "POST", url: "/api/auth/verify-email", payload: { token } })).statusCode, 400);
  const me = (await call(env, cookie, "GET", "/api/me")).json().user;
  assert.equal(me.emailVerified, true);
});

test("ajout et changement d'adresse depuis le profil", async () => {
  const cookie = await login(env, "sans-mail", "password-123");
  assert.equal((await call(env, cookie, "POST", "/api/me/email", { email: "new@mail.test", currentPassword: "mauvais-mdp-1" })).statusCode, 403);
  assert.equal((await call(env, cookie, "POST", "/api/me/email", { email: "avec@mail.test", currentPassword: "password-123" })).statusCode, 409);
  assert.equal((await call(env, cookie, "POST", "/api/me/email", { email: "new@mail.test", currentPassword: "password-123" })).statusCode, 200);
  assert.ok(lastMail("new@mail.test"));
  // changer d'adresse annule la vérification
  await call(env, cookie, "POST", "/api/auth/verify-email");
  assert.equal((await call(env, cookie, "DELETE", "/api/me/email")).statusCode, 200);
  assert.equal((await call(env, cookie, "GET", "/api/me")).json().user.email, null);
});

test("mot de passe oublié : lien à usage unique, durée limitée, réponse neutre", async () => {
  const n = env.outbox.length;
  for (const id of ["inconnu-total", "sans-mail"]) {
    const r = await env.app.inject({ method: "POST", url: "/api/auth/forgot", payload: { identifier: id } });
    assert.deepEqual(r.json(), { ok: true });
  }
  assert.equal(env.outbox.length, n, "aucun mail pour un compte inconnu ou sans adresse");

  await env.app.inject({ method: "POST", url: "/api/auth/forgot", payload: { identifier: "avec-mail" } });
  const token = tokenFrom(lastMail("avec@mail.test"));
  assert.match(lastMail("avec@mail.test").text, /http:\/\/site\.test\/#\/reset\//);
  assert.equal((await env.app.inject({ method: "POST", url: "/api/auth/reset", payload: { token, newPassword: "court" } })).statusCode, 400);
  assert.equal((await env.app.inject({ method: "POST", url: "/api/auth/reset", payload: { token, newPassword: "nouveau-mdp-1" } })).statusCode, 200);
  assert.equal((await env.app.inject({ method: "POST", url: "/api/auth/reset", payload: { token, newPassword: "encore-un-mdp-1" } })).statusCode, 400);
  await login(env, "avec-mail", "nouveau-mdp-1");

  // par e-mail, puis lien expiré
  await env.app.inject({ method: "POST", url: "/api/auth/forgot", payload: { identifier: "avec@mail.test" } });
  const t2 = tokenFrom(lastMail("avec@mail.test"));
  await env.prisma.emailToken.updateMany({ where: { kind: "RESET", usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await env.app.inject({ method: "POST", url: "/api/auth/reset", payload: { token: t2, newPassword: "troisieme-mdp-1" } })).statusCode, 400);
});

test("responsables et admins d'organisation : 3 jours pour vérifier, sinon suspendus ; le super admin prolonge", async () => {
  const org = (await env.prisma.organization.findUniqueOrThrow({ where: { name: TEST_ORG.name } })).id;
  const created = await call(env, root, "POST", `/api/organizations/${org}/admins`, { username: "oa-mail", email: "oa@mail.test", password: "password-123" });
  assert.equal(created.statusCode, 201);
  const oaId = created.json().admin.id as string;
  const u = await env.prisma.user.findUniqueOrThrow({ where: { id: oaId } });
  const days = (u.verifyDeadline!.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 2.9 && days <= 3, `délai ${days}`);
  assert.ok(lastMail("oa@mail.test"), "mail de vérification envoyé à la création");
  const oa = await login(env, "oa-mail", "password-123");
  assert.equal((await call(env, oa, "GET", "/api/me")).statusCode, 200);

  // délai dépassé → suspendu (session ouverte comprise)
  await env.prisma.user.update({ where: { id: oaId }, data: { verifyDeadline: new Date(Date.now() - 1000) } });
  const cut = await call(env, oa, "GET", "/api/me");
  assert.equal(cut.statusCode, 403);
  assert.equal(cut.json().error.code, "verification_overdue");
  const relog = await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "oa-mail", password: "password-123" } });
  assert.equal(relog.json().error.code, "verification_overdue");

  // seul le super admin peut prolonger
  assert.equal((await call(env, oa, "POST", `/api/users/${oaId}/extend-verification`, { days: 2 })).statusCode, 403);
  const ext = await call(env, root, "POST", `/api/users/${oaId}/extend-verification`, { days: 2 });
  assert.equal(ext.statusCode, 200);
  const after = await env.prisma.user.findUniqueOrThrow({ where: { id: oaId } });
  assert.ok(after.verifyDeadline!.getTime() > Date.now() + 1.9 * 86_400_000);
  const oa2 = await login(env, "oa-mail", "password-123");

  // la vérification lève définitivement l'obligation
  await call(env, oa2, "POST", "/api/me/email/send-verification");
  const token = tokenFrom(lastMail("oa@mail.test"));
  assert.equal((await env.app.inject({ method: "POST", url: "/api/auth/verify-email", payload: { token } })).statusCode, 200);
  await env.prisma.user.update({ where: { id: oaId }, data: { verifyDeadline: new Date(Date.now() - 1000) } });
  assert.equal((await call(env, oa2, "GET", "/api/me")).statusCode, 200);
  assert.equal((await call(env, root, "POST", `/api/users/${oaId}/extend-verification`, {})).statusCode, 409);
  // un compte de gestion ne peut pas retirer son adresse
  assert.equal((await call(env, oa2, "DELETE", "/api/me/email")).statusCode, 403);
});

test("le super administrateur n'a pas de délai", async () => {
  const a = await env.prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  assert.equal(a.verifyDeadline, null);
  assert.equal((await call(env, root, "GET", "/api/me")).statusCode, 200);
});
