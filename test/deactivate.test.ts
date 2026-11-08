import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
before(async () => { env = await createTestEnv(); await seedAdmin(env); admin = await login(env, ADMIN.username, ADMIN.password); });
after(async () => { await env.close(); });

test("compte : désactivation par le joueur, connexion refusée, rétablissement par un administrateur", async () => {
  const u = await register(env, "deact_u");
  assert.equal((await call(env, u.cookie, "POST", "/api/me/deactivate", { password: "faux-mot-de-passe" })).statusCode, 401);
  assert.equal((await call(env, u.cookie, "POST", "/api/me/deactivate", { password: "password-123" })).statusCode, 200);
  assert.equal((await call(env, u.cookie, "GET", "/api/me")).statusCode, 403);
  const res = await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "deact_u", password: "password-123" } });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error?.message ?? res.json().message ?? "", /désactivé/);
  const list = (await call(env, admin, "GET", "/api/users?q=deact_u")).json().users;
  assert.equal(list[0].deactivated, true);
  assert.equal(list[0].banned, true);
  assert.equal((await call(env, admin, "POST", `/api/users/${u.id}/unban`, {})).statusCode, 200);
  assert.equal((await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "deact_u", password: "password-123" } })).statusCode, 200);
});

test("comptes : la liste indique les organisations de chaque utilisateur", async () => {
  const org = (await call(env, admin, "POST", "/api/organizations", { name: "Lycée Pasteur" })).json().organization.id;
  const created = await call(env, admin, "POST", `/api/organizations/${org}/admins`, { username: "org_boss", password: "password-123" });
  assert.equal(created.statusCode, 201);
  const row = (await call(env, admin, "GET", "/api/users?q=org_boss")).json().users[0];
  assert.deepEqual(row.organizations, ["Lycée Pasteur"]);
  const plain = (await call(env, admin, "GET", "/api/users?q=deact_u")).json().users[0];
  assert.deepEqual(plain.organizations, []);
});
