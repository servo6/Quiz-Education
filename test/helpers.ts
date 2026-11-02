import { hashPassword } from "../src/password.ts";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { createMailer, type Mail } from "../src/mailer.ts";
import type { Timings } from "../src/duel/engine.ts";
import { createPrisma } from "../src/db.ts";
import { ensureAdmin } from "../src/bootstrap.ts";
import { pgPoolConfig } from "../src/pgConfig.ts";

export interface TestEnv {
  app: FastifyInstance;
  prisma: PrismaClient;
  close: () => Promise<void>;
  /** E-mails « envoyés » pendant le test. */
  outbox: Mail[];
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
  const mailer = createMailer({ provider: "memory" });
  const app = await buildApp({
    mailer,
    appUrl: "http://site.test",
    prisma,
    jwtSecret: "test-secret-test-secret-test-secret-123",
    rateLimit: opts.rateLimit ?? false,
    registrationOpen: opts.registrationOpen,
    duelTimings: opts.duelTimings,
  });
  return {
    app,
    prisma,
    outbox: mailer.outbox!,
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

export const TEST_ORG = { name: "Organisation test" };

/** Crée le super administrateur et l'organisation de test (les matières des tests y sont créées automatiquement). */
export async function seedAdmin(env: TestEnv): Promise<void> {
  await ensureAdmin(env.prisma, ADMIN.username, ADMIN.password);
  if (!(await env.prisma.organization.findUnique({ where: { name: TEST_ORG.name } }))) {
    await env.prisma.organization.create({
      data: { name: TEST_ORG.name, accessName: "orga-test", accessPasswordHash: await hashPassword("interne-12345") },
    });
  }
}

export const SUBJECT_KEY_PASSWORD = "acces-123";
/** Un joueur rejoint la matière (par identifiant ou par nom) avec ses clés d'accès ; les clés sont fixées ici pour les tests. */
export async function joinSubject(env: TestEnv, cookie: string, key: string) {
  const subject = await env.prisma.subject.findFirst({ where: { OR: [{ id: key }, { name: { equals: key, mode: "insensitive" } }] } });
  if (!subject) throw new Error(`matière introuvable : ${key}`);
  const accessName = `k-${subject.id}`.toLowerCase();
  if (subject.accessName !== accessName) {
    await env.prisma.subject.update({ where: { id: subject.id }, data: { accessName, accessPasswordHash: await hashPassword(SUBJECT_KEY_PASSWORD) } });
  }
  return call(env, cookie, "POST", "/api/subjects/join", { accessName, accessPassword: SUBJECT_KEY_PASSWORD });
}

/** Raccourci de test : fait de ce compte un responsable de la matière (en production, le compte est créé par l'administrateur). */
export async function assignManager(env: TestEnv, subjectId: string, userId: string): Promise<{ statusCode: number }> {
  await env.prisma.user.update({ where: { id: userId }, data: { role: "SUBJECT_MANAGER" } });
  await env.prisma.membership.deleteMany({ where: { userId } });
  await env.prisma.orgMember.deleteMany({ where: { userId } });
  await env.prisma.subjectManager.upsert({ where: { userId_subjectId: { userId, subjectId } }, create: { userId, subjectId }, update: {} });
  return { statusCode: 200 };
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
