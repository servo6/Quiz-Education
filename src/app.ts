import fs from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { COOKIE_NAME, SESSION_DAYS, invalidateAuth, makeAuth, type Deps } from "./auth.ts";
import { invalidateSettings } from "./settingsStore.ts";
import { DuelEngine, type Timings } from "./duel/engine.ts";
import { SocketHub } from "./duel/hub.ts";
import { attachSocketServer } from "./duel/socket.ts";
import { registerLessonRoutes } from "./routes/lessons.ts";
import { registerExamRoutes } from "./routes/exam.ts";
import { registerWalletRoutes } from "./routes/wallet.ts";
import { RoomEngine } from "./duel/rooms.ts";
import { registerErrorHandling } from "./http.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerChapterRoutes } from "./routes/chapters.ts";
import { registerDuelRoutes } from "./routes/duel.ts";
import { registerImportRoutes } from "./routes/importQuestions.ts";
import { registerDuelAsyncRoutes } from "./routes/duelAsync.ts";
import { registerAccountRoutes } from "./routes/accounts.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerLibraryRoutes } from "./routes/library.ts";
import { registerMemberRoutes } from "./routes/members.ts";
import { registerProgressRoutes } from "./routes/progress.ts";
import { registerOrganizationRoutes } from "./routes/organizations.ts";
import { registerSoloRoutes } from "./routes/solo.ts";
import { registerHistoryRoutes } from "./routes/history.ts";
import { registerSocialRoutes } from "./routes/social.ts";
import { registerStatsRoutes } from "./routes/stats.ts";
import { registerOverviewRoutes } from "./routes/overview.ts";
import { registerSubjectRoutes } from "./routes/subjects.ts";
import { registerThemeRoutes, registerScopedThemeRoutes } from "./routes/theme.ts";
import { createMailer, type Mailer } from "./mailer.ts";
import { registerEmailRoutes } from "./routes/email.ts";
import { registerDailyRoutes } from "./routes/daily.ts";
import { registerReviewRoutes } from "./routes/review.ts";
import { registerReportRoutes } from "./routes/reports.ts";
import { registerLeagueRoutes } from "./routes/league.ts";
import { registerPushRoutes } from "./routes/push.ts";
import { disabledPusher, type Pusher } from "./push.ts";
import { DEFAULT_TIMEZONE } from "./time.ts";

export interface AppOptions {
  prisma: PrismaClient;
  jwtSecret: string;
  /** Cookie réservé au HTTPS (à activer en production). */
  secureCookies?: boolean;
  registrationOpen?: boolean;
  /** Fuseau horaire des "jours" de jeu (défaut : Europe/Paris). */
  timezone?: string;
  /** `false` désactive la limitation des tentatives (tests). */
  rateLimit?: boolean;
  /** Cache mémoire court (comptes, paramètres) : à activer en production pour une base distante. */
  cache?: boolean;
  logger?: boolean;
  /** Temps réel (Socket.IO) activé par défaut ; `false` pour les tests qui n'en ont pas besoin. */
  realtime?: boolean;
  /** Durées des duels, modifiables pour les tests. */
  duelTimings?: Partial<Timings>;
  /** Dossier de l'interface web (index.html, assets…) servi à la racine ; ignoré s'il n'existe pas. */
  staticDir?: string;
  /** Envoi d'e-mails (vérification, mot de passe oublié). Défaut : affichage dans le terminal. */
  mailer?: Mailer;
  /** Notifications push (désactivées par défaut). */
  pusher?: Pusher;
  /** Adresse publique du site pour les liens des e-mails. */
  appUrl?: string;
}

declare module "fastify" {
  interface FastifyInstance {
    duels: DuelEngine;
    hub: SocketHub;
  }
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const staticDir = opts.staticDir ? path.resolve(opts.staticDir) : undefined;
  const serveStatic = !!staticDir && fs.existsSync(path.join(staticDir, "index.html"));
  registerErrorHandling(app, { spaFallback: serveStatic });

  // En-têtes de sécurité de base ; les réponses de l'API ne sont jamais mises en cache.
  // Toute écriture (sauf réponses de jeu et messages, très fréquentes) vide les caches : comptes, rôles, paramètres.
  app.addHook("onResponse", async (req) => {
    if (opts.cache !== true || req.method === "GET" || req.method === "HEAD") return;
    if (/\/answer$|\/messages$|\/heartbeat$/.test(req.url.split("?")[0])) return;
    invalidateAuth();
    invalidateSettings();
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  });

  await app.register(cookie);
  await app.register(jwt, {
    secret: opts.jwtSecret,
    cookie: { cookieName: COOKIE_NAME, signed: false },
    sign: { expiresIn: `${SESSION_DAYS}d` },
  });
  await app.register(rateLimit, { global: false });

  const useLimit = opts.rateLimit !== false;
  const deps: Deps = {
    prisma: opts.prisma,
    auth: makeAuth(opts.prisma, opts.cache === true),
    registrationOpen: opts.registrationOpen ?? true,
    mailer: opts.mailer ?? createMailer({ provider: "console" }),
    appUrl: opts.appUrl,
    timezone: opts.timezone ?? DEFAULT_TIMEZONE,
    secret: opts.jwtSecret,
    limit: (max) => ({ rateLimit: useLimit ? { max, timeWindow: "1 minute" } : false }),
  };

  registerAuthRoutes(app, deps, opts.secureCookies ?? false);
  registerEmailRoutes(app, deps);
  registerOrganizationRoutes(app, deps);
  registerSubjectRoutes(app, deps);
  registerThemeRoutes(app, deps);
  registerScopedThemeRoutes(app, deps);
  registerChapterRoutes(app, deps);
  registerImportRoutes(app, deps);
  registerSoloRoutes(app, deps);
  registerHistoryRoutes(app, deps);
  const hub = new SocketHub();
  hub.pusher = opts.pusher ?? disabledPusher;
  registerPushRoutes(app, deps, hub.pusher);
  app.decorate("hub", hub);
  registerDuelAsyncRoutes(app, deps, hub);
  registerStatsRoutes(app, deps);
  registerDailyRoutes(app, deps);
  registerReviewRoutes(app, deps);
  registerReportRoutes(app, deps);
  registerLeagueRoutes(app, deps);
  registerWalletRoutes(app, deps);
  registerExamRoutes(app, deps);
  registerLessonRoutes(app, deps);
  registerOverviewRoutes(app, deps);
  registerSocialRoutes(app, deps, hub);
  registerProgressRoutes(app, deps);
  registerMemberRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerLibraryRoutes(app, deps);
  registerAccountRoutes(app, deps);

  const duels = new DuelEngine({ prisma: opts.prisma, hub, timings: opts.duelTimings, logger: app.log });
  app.decorate("duels", duels);
  registerDuelRoutes(app, deps, duels, hub);
  const rooms = new RoomEngine({ prisma: opts.prisma, hub, timings: opts.duelTimings, logger: app.log });
  void rooms.restore().catch((e) => app.log.error(e, "salons : reprise"));
  app.addHook("onClose", async () => rooms.shutdown());
  if (opts.realtime !== false) {
    const io = attachSocketServer(app, { prisma: opts.prisma, engine: duels, hub, rooms });
    app.addHook("preClose", async () => {
      io.local.disconnectSockets(true);
    });
    app.addHook("onClose", async () => {
      void io.close();
    });
  }
  app.addHook("onClose", async () => duels.shutdown());

  app.get("/api/health", async () => ({ ok: true }));

  // Interface web : fichiers statiques + repli sur index.html pour les adresses internes de l'application.
  if (serveStatic) {
    await app.register(fastifyStatic, {
      root: staticDir!,
      wildcard: true,
      setHeaders(res, filePath) {
        const name = path.basename(filePath);
        // Le service worker doit toujours être revérifié, pour que les mises à jour du site arrivent vite.
        if (name === "sw.js") {
          res.header("Cache-Control", "no-cache");
          res.header("Service-Worker-Allowed", "/");
        } else if (filePath.replace(/\\/g, "/").includes("/vendor/katex/")) {
          // Bibliothèque de formules (fichiers fixes) : conservée une semaine par le navigateur.
          res.header("Cache-Control", "public, max-age=604800");
        } else if (name === "manifest.webmanifest") {
          res.header("Content-Type", "application/manifest+json; charset=utf-8");
          res.header("Cache-Control", "no-cache");
        }
      },
    });
  }
  return app;
}
