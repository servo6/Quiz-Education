import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { io as ioc, type Socket } from "socket.io-client";
import { ADMIN, call, createTestEnv, login, register, sampleBlock, seedAdmin, type TestEnv, joinSubject } from "./helpers.ts";

let env: TestEnv;
let url: string;
let subjectId: string;
const sockets: Socket[] = [];

before(async () => {
  env = await createTestEnv({ duelTimings: { revealMs: 30, graceMs: 50 } });
  await seedAdmin(env);
  const admin = await login(env, ADMIN.username, ADMIN.password);
  subjectId = (await call(env, admin, "POST", "/api/subjects", { name: "Chimie" })).json().subject.id;
  await call(env, admin, "POST", `/api/subjects/${subjectId}/import/commit`, { raw: sampleBlock(10, "A"), newChapterName: "A" });
  await env.app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(env.app.server.address() as { port: number }).port}`;
});
after(async () => { for (const s of sockets) s.close(); await env.close(); });

async function member(name: string) {
  const u = await register(env, name);
  await joinSubject(env, u.cookie, "chimie");
  return u;
}
function connect(cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioc(url, { extraHeaders: { cookie: `token=${cookie}` }, reconnection: false, transports: ["websocket"] });
    sockets.push(s);
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
}
const emit = (s: Socket, ev: string, data: object): Promise<any> => new Promise((r) => s.emit(ev, data, r));
const once = (s: Socket, ev: string): Promise<any> => new Promise((r) => s.once(ev, r));

test("salon : création, code, 3 joueurs, partie complète et classement", async () => {
  const [a, b, c] = await Promise.all([member("room_a"), member("room_b"), member("room_c")]);
  const [sa, sb, sc] = await Promise.all([connect(a.cookie), connect(b.cookie), connect(c.cookie)]);
  const created = await emit(sa, "room:create", { subjectId, size: 5 });
  assert.equal(created.ok, true);
  const code = created.room.code as string;
  assert.match(code, /^[A-Z2-9]{5}$/);
  assert.equal((await emit(sa, "room:start", {})).error.code, "not_enough");
  assert.equal((await emit(sb, "room:join", { code: "ZZZZZ" })).error.code, "room_not_found");
  assert.equal((await emit(sb, "room:join", { code: code.toLowerCase() })).ok, true);
  assert.equal((await emit(sc, "room:join", { code })).room.members.length, 3);
  assert.equal((await emit(sb, "room:start", {})).error.code, "not_host");

  const questions: Record<string, any[]> = { a: [], b: [], c: [] };
  const finished = once(sa, "room:finished");
  const wire = (s: Socket, key: string, pickWrong: boolean) => {
    s.on("room:question", (q) => { questions[key].push(q); emit(s, "room:answer", { index: q.index, choiceIndex: pickWrong ? 3 : 0 }); });
  };
  wire(sa, "a", false); wire(sb, "b", true); wire(sc, "c", false);
  assert.equal((await emit(sa, "room:start", {})).ok, true);
  const end = await finished;
  assert.equal(end.total, 5);
  assert.equal(end.ranking.length, 3);
  assert.equal(questions.a.length, 5);
  assert.equal(questions.a[0].text, questions.b[0].text);
  const last = end.ranking[2];
  assert.equal(last.username, "room_b".toLowerCase() === last.username ? last.username : last.username);
  assert.ok(end.ranking[0].score >= end.ranking[1].score && end.ranking[1].score >= end.ranking[2].score);
  assert.ok(end.ranking[0].score > 0);
  // récompenses : XP, pièces, historique
  assert.ok(end.reward && typeof end.reward.coins === "number");
  const rows = await env.prisma.roomPlayer.findMany({ where: { game: { code } } });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((x) => x.coinsEarned >= 5));
  const winner = rows.find((x) => x.rank === 1)!;
  assert.ok(winner.coinsEarned >= 15 + Math.round(winner.score / 10) - 1);
  const w = await call(env, (winner.userId === a.id ? a : winner.userId === b.id ? b : c).cookie, "GET", "/api/wallet");
  assert.equal(w.json().coins, winner.coinsEarned);
  const hist = await call(env, a.cookie, "GET", `/api/subjects/${subjectId}/rooms`);
  assert.equal(hist.json().rooms[0].code, code);
  // la bonne réponse n'est jamais dans la question envoyée
  assert.equal("answerIndex" in questions.a[0], false);
});

test("salon : refus d'un non-membre et d'un joueur déjà dans un salon, reprise d'état", async () => {
  const x = await member("room_x");
  const outsider = await register(env, "room_out");
  const sx = await connect(x.cookie);
  const so = await connect(outsider.cookie);
  assert.equal((await emit(so, "room:create", { subjectId, size: 5 })).error.code, "not_a_member");
  const r = await emit(sx, "room:create", { subjectId, size: 5 });
  assert.equal((await emit(sx, "room:create", { subjectId, size: 5 })).error.code, "already_in_room");
  assert.equal((await emit(sx, "room:resume", {})).state.room.code, r.room.code);
  assert.equal((await emit(sx, "room:create", { subjectId, size: 7 })).error.code, "already_in_room");
  await emit(sx, "room:leave", {});
  assert.equal((await emit(sx, "room:resume", {})).state, null);
  assert.equal((await emit(sx, "room:create", { subjectId, size: 7 })).error.code, "bad_size");
});

test("boutique : achat refusé sans pièces, accepté avec, jamais deux fois", async () => {
  const u = await member("shop_u");
  assert.equal((await call(env, u.cookie, "POST", "/api/shop/buy", { itemId: "stars" })).statusCode, 402);
  assert.equal((await call(env, u.cookie, "POST", "/api/shop/buy", { itemId: "nope" })).statusCode, 404);
  const user = await env.prisma.user.findUniqueOrThrow({ where: { username: "shop_u" } });
  await env.prisma.coinLedger.create({ data: { userId: user.id, amount: 250, reason: "ROOM" } });
  const ok = await call(env, u.cookie, "POST", "/api/shop/buy", { itemId: "stars" });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().coins, 50);
  assert.equal((await call(env, u.cookie, "POST", "/api/shop/buy", { itemId: "stars" })).statusCode, 409);
  const w = (await call(env, u.cookie, "GET", "/api/wallet")).json();
  assert.deepEqual(w.unlocked, ["stars"]);
  assert.equal(w.coins, 50);
});

test("salon : plafond de 5 parties récompensées par jour", async () => {
  const x = await member("cap_x"), y = await member("cap_y");
  const ux = await env.prisma.user.findUniqueOrThrow({ where: { username: "cap_x" } });
  const g = await env.prisma.roomGame.create({ data: { subjectId, code: "OLD01", size: 5 } });
  for (let i = 0; i < 5; i++) {
    const gg = await env.prisma.roomGame.create({ data: { subjectId, code: `OLD0${i}`, size: 5 } });
    await env.prisma.roomPlayer.create({ data: { gameId: gg.id, userId: ux.id, username: "cap_x", rank: 1, score: 100, correct: 1, xpEarned: 5, coinsEarned: 15 } });
  }
  void g;
  const [sx, sy] = await Promise.all([connect(x.cookie), connect(y.cookie)]);
  const created = await emit(sx, "room:create", { subjectId, size: 5 });
  await emit(sy, "room:join", { code: created.room.code });
  const fin = once(sx, "room:finished");
  for (const [s, p] of [[sx, 0], [sy, 0]] as const) s.on("room:question", (q) => emit(s, "room:answer", { index: q.index, choiceIndex: p }));
  await emit(sx, "room:start", {});
  const end = await fin;
  assert.deepEqual(end.reward, { xp: 0, coins: 0, capped: true });
});

test("salon : survit à un redémarrage du serveur et se relance avec « Rejouer »", async () => {
  const { RoomEngine } = await import("../src/duel/rooms.ts");
  const events: { to: string; ev: string; p: any }[] = [];
  const hub = { emit: (to: string, ev: string, p: unknown) => { events.push({ to, ev, p }); }, isOnline: () => true };
  const a = await member("rs_a"), b = await member("rs_b");
  const e1 = new RoomEngine({ prisma: env.prisma, hub, timings: { revealMs: 20, graceMs: 20 } });
  const { room } = await e1.create(a.id, subjectId, 5);
  await e1.join(b.id, room.code);
  await e1.start(a.id);
  const q0 = e1.snapshot(a.id)!.question as any;
  e1.answer(a.id, q0.index, 0);
  // on attend que l'état soit enregistré, puis on « redémarre » (nouveau moteur, même base)
  for (let i = 0; i < 50; i++) {
    const row = await env.prisma.roomSnapshot.findUnique({ where: { code: room.code } });
    if (row && JSON.parse(row.data).members.some((m: any) => m.answered)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  e1.shutdown();
  events.length = 0;
  const e2 = new RoomEngine({ prisma: env.prisma, hub, timings: { revealMs: 20, graceMs: 20 } });
  assert.ok((await e2.restore()) >= 1);
  const snap = e2.snapshot(b.id)!;
  assert.equal((snap.room as any).code, room.code);
  assert.equal((snap.question as any).index, 0);
  assert.equal((snap.question as any).answered, false);
  assert.equal((e2.snapshot(a.id)!.question as any).answered, true);
  // la partie continue : b répond à chaque question, a aussi, jusqu'au classement final
  const done = new Promise<any>((res) => { hub.emit = (to, ev, p) => { events.push({ to, ev, p }); if (ev === "room:finished" && to === a.id) res(p); }; });
  const play = setInterval(() => {
    for (const u of [a, b]) { try { const s = e2.snapshot(u.id) as any; if (s?.question && !s.question.answered && s.room.phase === "QUESTION") e2.answer(u.id, s.question.index, 0); } catch { /* question terminée */ } }
  }, 15);
  const end = await done;
  clearInterval(play);
  assert.equal(end.ranking.length, 2);
  // rejouer : seul le créateur, uniquement une fois la partie terminée
  assert.throws(() => e2.rematch(b.id), /créateur/);
  e2.rematch(a.id);
  assert.equal((e2.snapshot(a.id)!.room as any).phase, "LOBBY");
  assert.equal(((e2.snapshot(a.id)!.room as any).members as any[]).length, 2);
  await e2.start(a.id);
  assert.equal((e2.snapshot(b.id)!.question as any).index, 0);
  e2.shutdown();
});
