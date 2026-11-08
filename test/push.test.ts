import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createPusher, notificationFor } from "../src/push.ts";
import { call, createTestEnv, register, type TestEnv } from "./helpers.ts";

const sent: { endpoint: string; payload: any }[] = [];
let failWith: number | null = null;
let env: TestEnv;
before(async () => {
  // Le pusher a besoin de la base : on le branche après coup sur la même instance via un objet partagé.
  const holder: any = { enabled: true, publicKey: "PUBKEY", send: async () => {} };
  env = await createTestEnv({ pusher: holder });
  const real = createPusher(env.prisma, { publicKey: "PUBKEY", privateKey: "PRIV" }, async (sub, payload) => {
    if (failWith) throw Object.assign(new Error("gone"), { statusCode: failWith });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  });
  holder.send = real.send;
});
after(() => env.close());

const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "p".repeat(20), auth: "a".repeat(12) } });

test("config publique et abonnement d'un appareil (sans doublon)", async () => {
  const u = await register(env, "pushuser1");
  const cfg = (await call(env, null, "GET", "/api/push/config")).json();
  assert.deepEqual(cfg, { enabled: true, publicKey: "PUBKEY" });
  assert.equal((await call(env, null, "POST", "/api/push/subscribe", sub(1))).statusCode, 401);
  assert.equal((await call(env, u.cookie, "POST", "/api/push/subscribe", sub(1))).statusCode, 200);
  assert.equal((await call(env, u.cookie, "POST", "/api/push/subscribe", sub(1))).statusCode, 200);
  assert.equal(await env.prisma.pushSubscription.count({ where: { userId: u.id } }), 1);
  assert.equal((await call(env, u.cookie, "POST", "/api/push/subscribe", { endpoint: "pas une url", keys: {} })).statusCode, 400);
  await call(env, u.cookie, "POST", "/api/push/unsubscribe", { endpoint: sub(1).endpoint });
  assert.equal(await env.prisma.pushSubscription.count({ where: { userId: u.id } }), 0);
});

test("envoi : tous les appareils reçoivent ; un abonnement expiré (410) est supprimé", async () => {
  const u = await register(env, "pushuser2");
  await call(env, u.cookie, "POST", "/api/push/subscribe", sub(10));
  await call(env, u.cookie, "POST", "/api/push/subscribe", sub(11));
  sent.length = 0;
  await call(env, u.cookie, "POST", "/api/push/test");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].payload.title, "Notifications activées");
  failWith = 410;
  await call(env, u.cookie, "POST", "/api/push/test");
  failWith = null;
  assert.equal(await env.prisma.pushSubscription.count({ where: { userId: u.id } }), 0);
});

test("sans clés VAPID : désactivé sans erreur", async () => {
  const p = createPusher(env.prisma, {});
  assert.equal(p.enabled, false);
  await p.send("x", { title: "t", body: "b", url: "/" });
});

test("événements → notifications", () => {
  assert.equal(notificationFor("duel:turn", { from: { username: "Ana" }, duelId: "d" })?.title, "C'est ton tour !");
  assert.match(notificationFor("chat:message", { from: "Bob", preview: "salut", friendshipId: "f1" })!.url, /friends\/f1$/);
  assert.equal(notificationFor("duel:reveal", {}), null);
});
