import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, call, createTestEnv, login, register, seedAdmin, type TestEnv } from "./helpers.ts";
import { LOOK_LOCKS } from "../src/avatar.ts";

let env: TestEnv;
let admin: string;
before(async () => {
  env = await createTestEnv();
  await seedAdmin(env);
  admin = await login(env, ADMIN.username, ADMIN.password);
});
after(() => env.close());

test("un administrateur personnalise son avatar sans restriction, un joueur reste limité", async () => {
  const key = Object.keys(LOOK_LOCKS).find((k) => LOOK_LOCKS[k].unlockType !== "FREE")!;
  const [cat, value] = key.split(":");
  const save = (cookie: string) => call(env, cookie, "PUT", "/api/me/avatar", { items: {}, colors: {}, look: { [cat]: value } });

  const player = await register(env, "avatar-joueur");
  assert.equal((await save(player.cookie)).statusCode, 403);

  const items = (await call(env, admin, "GET", "/api/avatar/items")).json();
  assert.deepEqual(items.lookLocks, {});
  assert.ok(items.items.every((i: { unlocked: boolean }) => i.unlocked));
  assert.equal((await save(admin)).statusCode, 200);
  const me = (await call(env, admin, "GET", "/api/me")).json();
  assert.equal(me.user.avatar.look[cat], value);
});
