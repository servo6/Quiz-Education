import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/**
 * Le mot de passe d'accès d'une matière est haché (irrécupérable). Pour pouvoir créer un lien de partage en un clic,
 * le responsable le confie une fois : il est conservé CHIFFRÉ (AES-256-GCM, clé dérivée du secret du serveur),
 * dans la table des réglages, sous la clé `share:<id de la matière>`.
 */
const keyFor = (secret: string) => createHash("sha256").update(`access-share:${secret}`).digest();
export const shareKey = (subjectId: string) => `share:${subjectId}`;

export function encryptShare(secret: string, password: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const enc = Buffer.concat([c.update(password, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

export function decryptShare(secret: string, blob: string): string | null {
  try {
    const raw = Buffer.from(blob, "base64");
    const d = createDecipheriv("aes-256-gcm", keyFor(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null; // secret changé ou donnée altérée
  }
}

export async function saveShare(prisma: PrismaClient, secret: string, subjectId: string, password: string): Promise<void> {
  const value = encryptShare(secret, password);
  await prisma.setting.upsert({ where: { key: shareKey(subjectId) }, create: { key: shareKey(subjectId), value }, update: { value } });
}

export async function loadShare(prisma: PrismaClient, secret: string, subjectId: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: shareKey(subjectId) } });
  return row ? decryptShare(secret, row.value) : null;
}

export const dropShare = (prisma: PrismaClient, subjectId: string) => prisma.setting.deleteMany({ where: { key: shareKey(subjectId) } });
