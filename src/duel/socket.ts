import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { parseCookie } from "cookie";
import { Server, type Socket } from "socket.io";
import { z, ZodError } from "zod";
import { COOKIE_NAME } from "../auth.ts";
import { DuelError, type DuelEngine } from "./engine.ts";
import type { SocketHub } from "./hub.ts";

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
export function attachSocketServer(app: FastifyInstance, deps: { prisma: PrismaClient; engine: DuelEngine; hub: SocketHub }): Server {
  const { prisma, engine, hub } = deps;
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

    socket.on("disconnect", () => {
      if (hub.remove(userId, socket.id)) engine.onDisconnect(userId).catch(log);
    });
  });

  return io;
}
