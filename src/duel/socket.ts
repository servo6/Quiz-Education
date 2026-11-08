import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { parseCookie } from "cookie";
import { Server, type Socket } from "socket.io";
import { z, ZodError } from "zod";
import { COOKIE_NAME } from "../auth.ts";
import { DuelError, type DuelEngine } from "./engine.ts";
import type { SocketHub } from "./hub.ts";
import type { RoomEngine } from "./rooms.ts";

/** Serveurs STUN (gratuits) et, si configuré, TURN (TURN_URL, TURN_USERNAME, TURN_CREDENTIAL) pour les réseaux qui bloquent le pair-à-pair. */
function iceServers(): { urls: string | string[]; username?: string; credential?: string }[] {
  const list: { urls: string | string[]; username?: string; credential?: string }[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
  const url = process.env.TURN_URL;
  if (url) list.push({ urls: url.split(",").map((u) => u.trim()).filter(Boolean), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  return list;
}

export const REACTIONS = ["👍", "😂", "😮", "😅", "🔥", "👏", "😭", "🤝"] as const;

type Ack = (response: unknown) => void;

function errorPayload(e: unknown, log: (e: unknown) => void) {
  if (e instanceof DuelError) return { code: e.code, message: e.message };
  if (e instanceof ZodError) return { code: "validation", message: "Données invalides", details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  log(e);
  return { code: "internal", message: "Erreur interne" };
}

/**
 * Serveur temps réel. La session est celle du cookie `token` (le même que pour l'API) : une connexion sans cookie valide,
 * ou d'un compte suspendu, est refusée.
 *
 * Événements envoyés par le client (chacun avec un accusé de réception { ok, ... } ou { ok: false, error }) :
 *   duel:challenge { subjectId, opponentId }   duel:respond { challengeId, accept }   duel:cancel { challengeId }
 *   duel:pick { gameId, chapterId }            duel:answer { gameId, gameQuestionId, choiceIndex }
 *   duel:forfeit { gameId }                    duel:resume {}
 */
export function attachSocketServer(app: FastifyInstance, deps: { prisma: PrismaClient; engine: DuelEngine; hub: SocketHub; rooms?: RoomEngine }): Server {
  const { prisma, engine, hub, rooms } = deps;
  const io = new Server(app.server, { serveClient: true });
  hub.attach(io);

  io.use(async (socket, next) => {
    try {
      const token = parseCookie(socket.handshake.headers.cookie ?? "")[COOKIE_NAME];
      if (!token) return next(new Error("unauthenticated"));
      const payload = app.jwt.verify<{ sub?: string }>(token);
      const user = payload.sub ? await prisma.user.findUnique({ where: { id: payload.sub } }) : null;
      if (!user || user.bannedAt) return next(new Error("unauthenticated"));
      socket.data.userId = user.id;
      next();
    } catch {
      next(new Error("unauthenticated"));
    }
  });

  const log = (e: unknown) => app.log.error(e);

  io.on("connection", (socket: Socket) => {
    const userId = socket.data.userId as string;
    void socket.join(`user:${userId}`);
    if (hub.add(userId, socket.id)) engine.onConnect(userId).catch(log);

    const on = <S extends z.ZodTypeAny>(event: string, schema: S, fn: (data: z.infer<S>) => Promise<object | void> | object | void) => {
      socket.on(event, async (raw: unknown, ack?: Ack) => {
        const reply: Ack = typeof ack === "function" ? ack : () => {};
        try {
          const data = schema.parse(raw ?? {});
          const result = await fn(data);
          reply({ ok: true, ...(result ?? {}) });
        } catch (e) {
          reply({ ok: false, error: errorPayload(e, log) });
        }
      });
    };

    on("duel:challenge", z.object({ subjectId: z.string().min(1), opponentId: z.string().min(1) }), (d) =>
      engine.createChallenge(userId, d.subjectId, d.opponentId),
    );
    on("duel:respond", z.object({ challengeId: z.string().min(1), accept: z.boolean() }), (d) => engine.respondChallenge(userId, d.challengeId, d.accept));
    on("duel:cancel", z.object({ challengeId: z.string().min(1) }), (d) => engine.cancelChallenge(userId, d.challengeId));
    on("duel:pick", z.object({ gameId: z.string().min(1), chapterId: z.string().min(1) }), (d) => engine.pickChapter(userId, d.gameId, d.chapterId));
    on(
      "duel:answer",
      z.object({ gameId: z.string().min(1), gameQuestionId: z.string().min(1), choiceIndex: z.number().int().min(0) }),
      (d) => engine.answer(userId, d.gameId, d.gameQuestionId, d.choiceIndex),
    );
    on("duel:forfeit", z.object({ gameId: z.string().min(1) }), (d) => engine.forfeit(userId, d.gameId));
    on("duel:resume", z.object({}).passthrough(), () => ({ state: engine.snapshot(userId) }));

    // ── Chat vocal du duel en direct : le serveur ne fait que relayer la signalisation WebRTC entre les deux joueurs
    // (l'audio passe directement de l'un à l'autre). Rien n'est relayé hors d'une partie en cours.
    const Signal = z.object({ description: z.object({ type: z.enum(["offer", "answer"]), sdp: z.string().max(20000) }).optional(), candidate: z.unknown().optional(), bye: z.boolean().optional() });
    on("voice:signal", Signal, (d) => {
      const opp = engine.opponentIdInGame(userId);
      if (!opp) return;
      if (d.candidate !== undefined && JSON.stringify(d.candidate).length > 2000) return;
      hub.emit(opp, "voice:signal", d);
    });
    // ── Réactions rapides pendant le duel : un émoji parmi une liste fermée, relayé à l'adversaire (1 par seconde au plus).
    let lastReact = 0;
    on("duel:react", z.object({ emoji: z.enum(REACTIONS) }), (d) => {
      const opp = engine.opponentIdInGame(userId);
      const now = Date.now();
      if (!opp || now - lastReact < 700) return;
      lastReact = now;
      hub.emit(opp, "duel:reaction", { emoji: d.emoji });
    });
    // ── Salons privés en direct (voir rooms.ts)
    if (rooms) {
      on("room:create", z.object({ subjectId: z.string().min(1), size: z.number().int() }), (d) => rooms.create(userId, d.subjectId, d.size));
      on("room:join", z.object({ code: z.string().min(3).max(12) }), (d) => rooms.join(userId, d.code));
      on("room:leave", z.object({}).passthrough(), () => rooms.leave(userId));
      on("room:start", z.object({}).passthrough(), () => rooms.start(userId));
      on("room:answer", z.object({ index: z.number().int().min(0), choiceIndex: z.number().int().min(0) }), (d) => rooms.answer(userId, d.index, d.choiceIndex));
      on("room:rematch", z.object({}).passthrough(), () => rooms.rematch(userId));
      on("room:resume", z.object({}).passthrough(), () => ({ state: rooms.snapshot(userId) }));
    }
    on("voice:config", z.object({}).passthrough(), () => ({ iceServers: iceServers() }));

    socket.on("disconnect", () => {
      if (hub.remove(userId, socket.id)) engine.onDisconnect(userId).catch(log);
    });
  });

  return io;
}
