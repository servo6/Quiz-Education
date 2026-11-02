import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import type { Timings } from "../src/duel/engine.ts";
import { createPrisma } from "../src/db.ts";
import { ensureAdmin } from "../src/bootstrap.ts";
import { pgPoolConfig } from "../src/pgConfig.ts";

export interface TestEnv {
  app: FastifyInstance;
  prisma: PrismaClient;
  close: () => Promise<void>;
}

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Tests : définis TEST_DATABASE_URL (ou DATABASE_URL) dans .env");
  return url;
}

/**
 * Application complète sur un schéma PostgreSQL temporaire (qt_xxxx), créé depuis test/schema.sql puis supprimé
 * à la fin. Les tables réelles du schéma `public` ne sont jamais touchées.
 */
export async function createTestEnv(
  opts: { rateLimit?: boolean; registrationOpen?: boolean; duelTimings?: Partial<Timings> } = {},
): Promise<TestEnv> {
  const url = testDatabaseUrl();
  const schema = `qt_${randomBytes(6).toString("hex")}`;

  const admin = new pg.Client(pgPoolConfig(url));
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(fs.readFileSync(path.join(import.meta.dirname, "schema.sql"), "utf8"));
  } finally {
    await admin.end();
  }

  const prisma = createPrisma(url, { schema, max: 3 });
  const app = await buildApp({
    prisma,
    jwtSecret: "test-secret-test-secret-test-secret-123",
    rateLimit: opts.rateLimit ?? false,
    registrationOpen: opts.registrationOpen,
    duelTimings: opts.duelTimings,
  });
  return {
    app,
    prisma,
    close: async () => {
      await app.close();
      await prisma.$disconnect();
      const cleaner = new pg.Client(pgPoolConfig(url));
      await cleaner.connect();
      try {
        if (schema.startsWith("qt_")) await cleaner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await cleaner.end();
      }
    },
  };
}

export const ADMIN = { username: "admin", password: "admin-password-1" };

export async function seedAdmin(env: TestEnv): Promise<void> {
  await ensureAdmin(env.prisma, ADMIN.username, ADMIN.password);
}

/** Cookie de session d'un utilisateur déjà existant. */
export async function login(env: TestEnv, username: string, password: string): Promise<string> {
  const res = await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`login ${username} → ${res.statusCode} ${res.body}`);
  return res.cookies.find((c) => c.name === "token")!.value;
}

/** Inscrit un utilisateur et renvoie son id et son cookie. */
export async function register(env: TestEnv, username: string, password = "password-123"): Promise<{ id: string; cookie: string }> {
  const res = await env.app.inject({ method: "POST", url: "/api/auth/register", payload: { username, password } });
  if (res.statusCode !== 201) throw new Error(`register ${username} → ${res.statusCode} ${res.body}`);
  return { id: res.json().user.id, cookie: res.cookies.find((c) => c.name === "token")!.value };
}

export function call(env: TestEnv, cookie: string | null, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  return env.app.inject({ method, url, payload: payload as object | undefined, cookies: cookie ? { token: cookie } : undefined });
}

export const sampleBlock = (n: number, prefix = "Question") =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ question: `${prefix} ${i + 1} ?`, choices: ["A", "B", "C", "D"], answer: i % 4 })),
  );
