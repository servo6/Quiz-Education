import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { ForbiddenError } from "./permissions.ts";

/** Erreur "attendue" renvoyée au client avec un code stable lisible par l'interface. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function registerErrorHandling(app: FastifyInstance, opts: { spaFallback?: boolean } = {}): void {
  app.setNotFoundHandler((req, reply) => {
    // Interface web : une adresse interne de l'application (GET, navigateur) renvoie la page d'accueil.
    const isApi = req.url.startsWith("/api/") || req.url.startsWith("/socket.io/");
    if (opts.spaFallback && req.method === "GET" && !isApi && (req.headers.accept ?? "").includes("text/html")) {
      return (reply as unknown as { sendFile: (f: string) => unknown }).sendFile("index.html");
    }
    reply.status(404).send({ error: { code: "not_found", message: "Route introuvable" } });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "validation",
          message: "Données invalides",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    if (err instanceof ForbiddenError) {
      return reply.status(403).send({ error: { code: "forbidden", message: "Action non autorisée" } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.status(429).send({ error: { code: "rate_limited", message: "Trop de tentatives, réessaie dans un moment." } });
    }
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: "bad_request", message: (err as Error).message } });
    }
    req.log.error(err);
    const text = String((err as Error)?.message ?? err);
    const code = (err as { code?: string }).code;
    // Base de données ou client Prisma pas à jour après une mise à jour du programme : on le dit clairement.
    if (/undefined \(reading '(find|create|update|delete|count|group)/.test(text)) {
      return reply.status(503).send({ error: { code: "client_outdated", message: "Le programme n'a pas été régénéré. Arrête le serveur, lance « npx prisma generate » puis « npm run dev »." } });
    }
    if (code === "P2021" || code === "P2022") {
      const meta = (err as { meta?: { table?: string; column?: string } }).meta;
      const what = meta?.table ?? meta?.column;
      return reply.status(503).send({ error: { code: "db_outdated", message: `La base de données n'est pas à jour${what ? ` (${what} manquant)` : ""}. Arrête le serveur, lance « npm run db:patch » puis « npm run dev ».` } });
    }
    // En développement, on affiche la vraie cause pour trouver le problème plus vite.
    const detail = process.env.NODE_ENV === "production" ? "" : ` (${text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 240) ?? ""})`;
    return reply.status(500).send({ error: { code: "internal", message: `Erreur interne${detail}` } });
  });
}
