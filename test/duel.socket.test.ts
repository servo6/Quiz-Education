import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { io as ioc, type Socket } from "socket.io-client";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let url: string;
let subjectId: string;
let chapterId: string;
const sockets: Socket[] = [];

before(async () => {
  env = await createTestEnv({ duelTimings: { revealMs: 30, graceMs: 50 } });
  await seedAdmin(env);
  const admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Chimie", accessName: "chimie", accessPassword: "acces-123" })).json().subject.id;
  chapterId = (await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(10, "A"), newChapterName: "A" })).json().chapterId;
  await call(env, admin, "PATCH", `/api/subjects/${subjectId}`, { settings: { liveTimePerQuestionSec: 10, liveRoundsPerDuel: 1, liveQuestionsPerRound: 2 } });
  await env.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = env.app.server.address() as { port: number };
  url = `http://127.0.0.1:${addr.port}`;
});
after(async () => {
  for (const s of sockets) s.close();
  await env.close();
});

async function member(name: string) {
  const u = await register(env, name);
  await call(env, u.cookie, "POST", "/api/subjects/join", { accessName: "chimie", accessPassword: "acces-123" });
  return u;
}

function connect(cookie: string | null): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioc(url, { extraHeaders: cookie ? { cookie: `token=${cookie}` } : {}, reconnection: false, transports: ["websocket"] });
    sockets.push(s);
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
}

const once = <T = any>(s: Socket, event: string, ms = 8000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${event}`)), ms);
    s.once(event, (p: T) => {
      clearTimeout(t);
      resolve(p);
    });
  });
const emit = (s: Socket, event: string, payload?: unknown) => new Promise<any>((resolve) => s.emit(event, payload, resolve));

test("connexion refusée sans cookie valide", async () => {
  await assert.rejects(connect(null));
  await assert.rejects(connect("jeton-bidon"));
});

test("événements invalides : erreur claire dans l'accusé", async () => {
  const a = await member("sock-inval");
  const s = await connect(a.cookie);
  const r = await emit(s, "duel:challenge", { subjectId: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "validation");
  const r2 = await emit(s, "duel:answer", { gameId: "x", gameQuestionId: "y", choiceIndex: -1 });
  assert.equal(r2.ok, false);
});

test("duel de bout en bout par WebSocket, avec reprise après reconnexion", async () => {
  const a = await member("sock-a");
  const b = await member("sock-b");
  const sa = await connect(a.cookie);
  const sb = await connect(b.cookie);

  // liste des adversaires : b apparaît en ligne
  const list = (await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/players?q=sock-b`)).json().players;
  assert.equal(list[0].online, true);

  const invited = once(sb, "duel:invited");
  const ack = await emit(sa, "duel:challenge", { subjectId, opponentId: b.id });
  assert.equal(ack.ok, true);
  const inv = await invited;
  assert.equal(inv.from.username, "sock-a");

  const pickA = once(sa, "duel:pick_chapter");
  const startedA = once(sa, "duel:started");
  const acc = await emit(sb, "duel:respond", { challengeId: inv.challengeId, accept: true });
  assert.equal(acc.ok, true);
  const started = await startedA;
  const pick = await pickA;
  assert.equal(pick.picker, a.id);
  assert.equal(pick.chapters.length, 1);

  const qA = once(sa, "duel:question");
  const qB = once(sb, "duel:question");
  const pk = await emit(sa, "duel:pick", { gameId: started.gameId, chapterId });
  assert.equal(pk.ok, true);
  const q1a = await qA;
  const q1b = await qB;
  assert.equal(q1a.gameQuestionId, q1b.gameQuestionId);
  assert.equal(JSON.stringify(q1a).includes("answerIndex"), false);

  // b se déconnecte et revient : il reçoit l'état courant
  sb.close();
  await new Promise((r) => setTimeout(r, 150));
  const sb2 = await connect(b.cookie);
  const state = await once(sb2, "duel:state").catch(() => null);
  const resumed = state ?? (await emit(sb2, "duel:resume")).state;
  assert.ok(resumed);
  assert.equal(resumed.gameId, started.gameId);

  // les deux jouent la partie (2 questions) en répondant toujours juste
  const finA = once(sa, "duel:finished", 15000);
  const finB = once(sb2, "duel:finished", 15000);
  const answerer = (sock: Socket) =>
    sock.on("duel:question", async (p: any) => {
      const gq = await env.prisma.gameQuestion.findUniqueOrThrow({ where: { id: p.gameQuestionId }, include: { question: true } });
      sock.emit("duel:answer", { gameId: p.gameId, gameQuestionId: p.gameQuestionId, choiceIndex: gq.question.answerIndex }, () => {});
    });
  answerer(sa);
  answerer(sb2);
  // la question déjà en cours
  for (const [sock, q] of [[sa, q1a], [sb2, resumed.question ?? q1b]] as const) {
    const gq = await env.prisma.gameQuestion.findUniqueOrThrow({ where: { id: q1a.gameQuestionId }, include: { question: true } });
    if (!(q as any).answered) sock.emit("duel:answer", { gameId: started.gameId, gameQuestionId: q1a.gameQuestionId, choiceIndex: gq.question.answerIndex }, () => {});
  }
  const [fa, fb] = await Promise.all([finA, finB]);
  assert.equal(fa.result, "DRAW");
  assert.equal(fb.result, "DRAW");
  assert.equal(fa.you.correct, 2);
});
