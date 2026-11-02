import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ensureAdmin } from "../src/bootstrap.ts";
import { hashPassword, verifyPassword } from "../src/password.ts";
import { ADMIN, call, createTestEnv, login, register, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
});
after(() => env.close());

test("hachage : vérifie le bon mot de passe, refuse les autres, sel différent à chaque fois", async () => {
  const h1 = await hashPassword("secret-1");
  const h2 = await hashPassword("secret-1");
  assert.notEqual(h1, h2);
  assert.ok(await verifyPassword("secret-1", h1));
  assert.equal(await verifyPassword("secret-2", h1), false);
  assert.equal(await verifyPassword("x", "n'importe quoi"), false);
});

test("inscription, /api/me, déconnexion", async () => {
  const { cookie } = await register(env, "Alice_01");
  const me = await call(env, cookie, "GET", "/api/me");
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.username, "alice_01"); // normalisé en minuscules
  assert.equal(me.json().user.role, "USER");
  assert.deepEqual(me.json().subjects, []);

  const out = await call(env, cookie, "POST", "/api/auth/logout");
  assert.equal(out.statusCode, 200);
});

test("le cookie de session est httpOnly", async () => {
  const res = await call(env, null, "POST", "/api/auth/register", { username: "cookie-test", password: "password-123" });
  const c = res.cookies.find((x) => x.name === "token")!;
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, "Lax");
});

test("inscription : doublon, mot de passe trop court, nom invalide", async () => {
  await register(env, "bob");
  assert.equal((await call(env, null, "POST", "/api/auth/register", { username: "BOB", password: "password-123" })).statusCode, 409);
  assert.equal((await call(env, null, "POST", "/api/auth/register", { username: "carol", password: "court" })).statusCode, 400);
  assert.equal((await call(env, null, "POST", "/api/auth/register", { username: "a b", password: "password-123" })).statusCode, 400);
});

test("connexion : mauvais mot de passe et utilisateur inconnu donnent la même erreur", async () => {
  await register(env, "dave", "password-123");
  const wrong = await call(env, null, "POST", "/api/auth/login", { username: "dave", password: "mauvais-mdp" });
  const unknown = await call(env, null, "POST", "/api/auth/login", { username: "fantome", password: "mauvais-mdp" });
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.equal(wrong.json().error.message, unknown.json().error.message);
});

test("sans cookie ou avec un faux cookie : 401", async () => {
  assert.equal((await call(env, null, "GET", "/api/me")).statusCode, 401);
  assert.equal((await call(env, "faux.jeton.ici", "GET", "/api/me")).statusCode, 401);
});

test("un compte suspendu est refusé immédiatement, même avec une session valide", async () => {
  const { id, cookie } = await register(env, "erin");
  assert.equal((await call(env, cookie, "GET", "/api/me")).statusCode, 200);
  await env.prisma.user.update({ where: { id }, data: { bannedAt: new Date() } });
  assert.equal((await call(env, cookie, "GET", "/api/me")).statusCode, 403);
  assert.equal((await call(env, null, "POST", "/api/auth/login", { username: "erin", password: "password-123" })).statusCode, 403);
});

test("ensureAdmin ne crée l'administrateur qu'une fois", async () => {
  assert.equal(await ensureAdmin(env.prisma, "autre-admin", "password-123"), "exists");
  assert.equal(await env.prisma.user.count({ where: { role: "ADMIN" } }), 1);
  const cookie = await login(env, ADMIN.username, ADMIN.password);
  assert.equal((await call(env, cookie, "GET", "/api/me")).json().user.role, "ADMIN");
});

test("inscriptions fermées", async () => {
  const closed = await createTestEnv({ registrationOpen: false });
  try {
    const res = await call(closed, null, "POST", "/api/auth/register", { username: "zed", password: "password-123" });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "registration_closed");
  } finally {
    await closed.close();
  }
});

test("limitation des tentatives de connexion : 429 après 10 essais par minute", async () => {
  const limited = await createTestEnv({ rateLimit: true });
  try {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await call(limited, null, "POST", "/api/auth/login", { username: "x", password: "y" })).statusCode;
    }
    assert.equal(last, 429);
  } finally {
    await limited.close();
  }
});
