import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let admin: string;
before(async () => { env = await createTestEnv(); await seedAdmin(env); admin = await login(env, ADMIN.username, ADMIN.password); });
after(async () => { await env.close(); });

test("avatar intégré : l'administrateur règle les conditions de déblocage des options", async () => {
  const u = await register(env, "av_u");
  const before = (await call(env, u.cookie, "GET", "/api/avatar/items")).json().lookLocks;
  assert.ok(before["hair:mohawk"], "règle d'origine");
  assert.equal(before["hair:afro"], undefined);
  assert.equal((await call(env, u.cookie, "PUT", "/api/avatar/look-locks", { locks: {} })).statusCode, 403);
  // l'administrateur libère la crête et verrouille l'afro au niveau 7
  const put = await call(env, admin, "PUT", "/api/avatar/look-locks", { locks: { "hair:afro": { unlockType: "LEVEL", unlockValue: "7" } } });
  assert.equal(put.statusCode, 200);
  const after2 = (await call(env, u.cookie, "GET", "/api/avatar/items")).json().lookLocks;
  assert.equal(after2["hair:mohawk"], undefined);
  assert.match(after2["hair:afro"], /Niveau 7/);
  // le joueur ne peut pas choisir une option verrouillée
  assert.equal((await call(env, u.cookie, "PUT", "/api/me/avatar", { items: {}, colors: {}, look: { hair: "afro" } })).statusCode, 403);
  assert.equal((await call(env, u.cookie, "PUT", "/api/me/avatar", { items: {}, colors: {}, look: { hair: "mohawk" } })).statusCode, 200);
  // condition manquante ou niveau invalide refusés
  assert.equal((await call(env, admin, "PUT", "/api/avatar/look-locks", { locks: { "hair:bun": { unlockType: "BADGE", unlockValue: null } } })).statusCode, 422);
  assert.equal((await call(env, admin, "PUT", "/api/avatar/look-locks", { locks: { "hair:bun": { unlockType: "LEVEL", unlockValue: "abc" } } })).statusCode, 422);
  // retour aux valeurs d'origine
  assert.equal((await call(env, admin, "DELETE", "/api/avatar/look-locks")).statusCode, 200);
  assert.ok((await call(env, u.cookie, "GET", "/api/avatar/items")).json().lookLocks["hair:mohawk"]);
});
