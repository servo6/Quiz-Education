import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createMailer, MailError, type Mailer } from "../src/mailer.ts";
import { ADMIN, call, createTestEnv, login, seedAdmin, type TestEnv } from "./helpers.ts";

/** Fournisseur d'e-mails en panne : refuse chaque envoi comme le ferait une clé ou une IP non autorisée. */
const failing: Mailer = {
  configured: true,
  provider: "brevo",
  state: {},
  async send() {
    throw new MailError("brevo a refusé l'envoi (401) : unrecognised IP address", 401);
  },
};

let env: TestEnv;
let root: string;
before(async () => {
  env = await createTestEnv({ mailer: failing });
  await seedAdmin(env);
  root = await login(env, ADMIN.username, ADMIN.password);
  await env.prisma.user.updateMany({ where: { role: "ADMIN" }, data: { email: "admin@site.test" } });
});
after(() => env.close());

const reg = (body: object) => env.app.inject({ method: "POST", url: "/api/auth/register", payload: body });

test("panne du fournisseur : message clair pour le joueur, sans fuite technique", async () => {
  // L'inscription réussit même si le mail de vérification ne part pas.
  assert.equal((await reg({ username: "joueur", email: "joueur@mail.test", password: "password-123" })).statusCode, 201);
  const cookie = await login(env, "joueur", "password-123");

  const res = await call(env, cookie, "POST", "/api/me/email/send-verification");
  assert.equal(res.statusCode, 502);
  const err = res.json().error;
  assert.equal(err.code, "mail_failed");
  assert.match(err.message, /n'a pas pu être envoyé/);
  assert.match(err.message, /préviens un administrateur/);
  assert.doesNotMatch(err.message, /unrecognised|brevo|401/i, "la cause technique ne doit pas être montrée au joueur");
});

test("changement d'adresse : l'adresse est enregistrée même si l'envoi échoue, et on le dit", async () => {
  const cookie = await login(env, "joueur", "password-123");
  const res = await call(env, cookie, "POST", "/api/me/email", { email: "nouvelle@mail.test", currentPassword: "password-123" });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error.message, /^Adresse enregistrée, mais l'e-mail n'a pas pu être envoyé/);
  const u = await env.prisma.user.findUniqueOrThrow({ where: { username: "joueur" } });
  assert.equal(u.email, "nouvelle@mail.test");
  assert.equal(u.emailVerifiedAt, null);
});

test("mot de passe oublié : réponse neutre même si l'envoi échoue", async () => {
  const r = await env.app.inject({ method: "POST", url: "/api/auth/forgot", payload: { identifier: "joueur" } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true });
});

test("le super administrateur voit la cause technique et peut tester l'envoi", async () => {
  const res = await call(env, root, "POST", "/api/me/email/send-verification");
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error.message, /Cause : brevo a refusé l'envoi \(401\) : unrecognised IP address/);

  const test = await call(env, root, "POST", "/api/admin/mail-test", {});
  assert.equal(test.statusCode, 502);
  assert.match(test.json().error.message, /unrecognised IP address/);

  const status = await call(env, root, "GET", "/api/admin/mail-status");
  assert.equal(status.statusCode, 200);
  assert.deepEqual({ provider: status.json().provider, configured: status.json().configured }, { provider: "brevo", configured: true });

  const player = await login(env, "joueur", "password-123");
  assert.equal((await call(env, player, "GET", "/api/admin/mail-status")).statusCode, 403);
  assert.equal((await call(env, player, "POST", "/api/admin/mail-test", {})).statusCode, 403);
});

test("fournisseur non configuré : message explicite au lieu d'un faux succès", async () => {
  const quiet = console.log;
  console.log = () => {};
  const env2 = await createTestEnv({ mailer: createMailer({ provider: "console" }) });
  try {
    await seedAdmin(env2);
    const admin = await login(env2, ADMIN.username, ADMIN.password);
    const r2 = await env2.app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "joueur2", email: "joueur2@mail.test", password: "password-123" } }); assert.equal(r2.statusCode, 201, r2.body);
    const j2 = await login(env2, "joueur2", "password-123");

    const res = await call(env2, j2, "POST", "/api/me/email/send-verification");
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, "mail_not_configured");
    assert.doesNotMatch(res.json().error.message, /MAIL_API_KEY/);

    await env2.prisma.user.updateMany({ where: { role: "ADMIN" }, data: { email: "a@site.test" } });
    const adm = await call(env2, admin, "POST", "/api/me/email/send-verification");
    assert.match(adm.json().error.message, /MAIL_API_KEY/);
    assert.equal((await call(env2, admin, "GET", "/api/admin/mail-status")).json().configured, false);
  } finally {
    console.log = quiet;
    await env2.close();
  }
});

test("test d'envoi administrateur : réussi avec un fournisseur qui fonctionne", async () => {
  const env3 = await createTestEnv();
  try {
    await seedAdmin(env3);
    const admin = await login(env3, ADMIN.username, ADMIN.password);
    assert.equal((await call(env3, admin, "POST", "/api/admin/mail-test", {})).json().error.code, "no_email");
    const ok = await call(env3, admin, "POST", "/api/admin/mail-test", { to: "dest@mail.test" });
    assert.equal(ok.statusCode, 200);
    assert.equal(env3.outbox.at(-1)?.to, "dest@mail.test");
  } finally {
    await env3.close();
  }
});

async function fakeApi(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mail`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
const mail = { to: "x@y.test", subject: "s", text: "t", html: "<p>t</p>" };

test("fournisseur Brevo simulé : refus 401, succès, panne réseau, délai dépassé", async () => {
  const api = await fakeApi((req, res) => {
    req.resume();
    if (req.headers["api-key"] === "bonne-cle") { res.writeHead(201, { "content-type": "application/json" }); res.end('{"messageId":"1"}'); }
    else if (req.headers["api-key"] === "lente") { /* ne répond jamais */ }
    else { res.writeHead(401, { "content-type": "application/json" }); res.end('{"code":"unauthorized","message":"unrecognised IP address"}'); }
  });
  try {
    const cfg = { provider: "brevo" as const, from: "no-reply@site.test", endpoint: api.url, timeoutMs: 300 };

    const bad = createMailer({ ...cfg, apiKey: "mauvaise" });
    await assert.rejects(() => bad.send(mail), (e: unknown) => e instanceof MailError && e.status === 401 && /unrecognised IP address/.test(e.message));
    assert.match(bad.state.lastError!.message, /401/);

    const good = createMailer({ ...cfg, apiKey: "bonne-cle" });
    await good.send(mail);
    assert.ok(good.state.lastOkAt);
    assert.equal(good.state.lastError, undefined);

    const slow = createMailer({ ...cfg, apiKey: "lente" });
    await assert.rejects(() => slow.send(mail), /délai de 0 s dépassé|délai/);
  } finally {
    await api.close();
  }
  const down = createMailer({ provider: "resend", apiKey: "k", from: "a@b.test", endpoint: api.url, timeoutMs: 300 });
  await assert.rejects(() => down.send(mail), (e: unknown) => e instanceof MailError && /Connexion à resend impossible/.test(e.message));
});
