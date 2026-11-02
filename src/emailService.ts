import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { PrismaClient, User } from "@prisma/client";
import type { Deps } from "./auth.ts";
import { HttpError } from "./http.ts";

export const VERIFY_TTL_MS = 24 * 3600_000;
export const RESET_TTL_MS = 3600_000;
/** Délai laissé aux administrateurs d'organisation et aux responsables pour vérifier leur adresse. */
export const STAFF_VERIFY_DAYS = 3;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export const staffDeadline = (now = new Date()) => new Date(now.getTime() + STAFF_VERIFY_DAYS * 86_400_000);
/** Compte de gestion dont le délai de vérification est dépassé : il est suspendu. */
export function verificationOverdue(u: Pick<User, "role" | "emailVerifiedAt" | "verifyDeadline">, now = Date.now()): boolean {
  return (u.role === "ORG_ADMIN" || u.role === "SUBJECT_MANAGER") && !u.emailVerifiedAt && !!u.verifyDeadline && u.verifyDeadline.getTime() < now;
}

export function appOrigin(deps: Pick<Deps, "appUrl">, req: FastifyRequest): string {
  if (deps.appUrl) return deps.appUrl.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "http";
  return `${proto}://${req.headers.host}`;
}

export async function issueToken(prisma: PrismaClient, userId: string, kind: "VERIFY" | "RESET", email: string, ttlMs: number): Promise<string> {
  await prisma.emailToken.deleteMany({ where: { userId, kind, usedAt: null } }); // un seul lien valable à la fois
  const raw = randomBytes(32).toString("base64url");
  await prisma.emailToken.create({ data: { userId, kind, email, tokenHash: hash(raw), expiresAt: new Date(Date.now() + ttlMs) } });
  return raw;
}

/** Consomme un jeton valable (non utilisé, non expiré) ; sinon lève une erreur générique. */
export async function consumeToken(prisma: PrismaClient, raw: string, kind: "VERIFY" | "RESET") {
  const t = await prisma.emailToken.findUnique({ where: { tokenHash: hash(raw) } });
  if (!t || t.kind !== kind || t.usedAt || t.expiresAt.getTime() < Date.now()) {
    throw new HttpError(400, "invalid_token", "Ce lien est invalide ou a expiré. Demande-en un nouveau.");
  }
  const claimed = await prisma.emailToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) throw new HttpError(400, "invalid_token", "Ce lien est invalide ou a expiré. Demande-en un nouveau.");
  return t;
}

const wrap = (title: string, body: string, link: string, button: string) =>
  `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px"><h2>${title}</h2><p>${body}</p><p><a href="${link}" style="display:inline-block;background:#4f5bd5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${button}</a></p><p style="color:#666;font-size:13px">Si le bouton ne fonctionne pas, copie ce lien : <br>${link}</p></div>`;

export async function sendVerificationMail(deps: Pick<Deps, "prisma" | "mailer" | "appUrl">, req: FastifyRequest, user: Pick<User, "id" | "username">, email: string): Promise<void> {
  const raw = await issueToken(deps.prisma, user.id, "VERIFY", email, VERIFY_TTL_MS);
  const link = `${appOrigin(deps, req)}/#/verify-email/${raw}`;
  await deps.mailer.send({
    to: email,
    subject: "Vérifie ton adresse e-mail",
    text: `Bonjour ${user.username},\n\nConfirme ton adresse e-mail avec ce lien (valable 24 heures) :\n${link}\n`,
    html: wrap("Vérifie ton adresse e-mail", `Bonjour ${user.username}, confirme ton adresse e-mail. Le lien est valable 24 heures.`, link, "Vérifier mon adresse"),
  });
}

export async function sendResetMail(deps: Pick<Deps, "prisma" | "mailer" | "appUrl">, req: FastifyRequest, user: Pick<User, "id" | "username">, email: string): Promise<void> {
  const raw = await issueToken(deps.prisma, user.id, "RESET", email, RESET_TTL_MS);
  const link = `${appOrigin(deps, req)}/#/reset/${raw}`;
  await deps.mailer.send({
    to: email,
    subject: "Réinitialisation de ton mot de passe",
    text: `Bonjour ${user.username},\n\nChoisis un nouveau mot de passe avec ce lien (valable 1 heure) :\n${link}\n\nSi tu n'es pas à l'origine de cette demande, ignore ce message.\n`,
    html: wrap("Réinitialisation du mot de passe", `Bonjour ${user.username}, choisis un nouveau mot de passe. Le lien est valable 1 heure. Si tu n'es pas à l'origine de cette demande, ignore ce message.`, link, "Choisir un nouveau mot de passe"),
  });
}
