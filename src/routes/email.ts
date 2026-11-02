import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { consumeToken, normalizeEmail, sendResetMail, sendVerificationMail, verificationOverdue } from "../emailService.ts";
import { HttpError } from "../http.ts";
import { hashPassword, verifyPassword } from "../password.ts";

export const emailSchema = z.string().trim().toLowerCase().max(120, "120 caractères maximum").email("Adresse e-mail invalide");
const TokenBody = z.object({ token: z.string().min(10).max(200) });

export function registerEmailRoutes(app: FastifyInstance, deps: Deps): void {
  const { prisma, auth, limit } = deps;

  /** Mot de passe oublié : réponse toujours identique (ne révèle pas si le compte existe). */
  app.post("/api/auth/forgot", { config: limit(5) }, async (req) => {
    const { identifier } = z.object({ identifier: z.string().trim().toLowerCase().min(1).max(120) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: identifier.includes("@") ? { email: identifier } : { username: identifier } });
    if (user?.email && !user.bannedAt) {
      try {
        await sendResetMail(deps, req, user, user.email);
      } catch (e) {
        req.log.error(e, "envoi du mail de réinitialisation");
      }
    }
    return { ok: true };
  });

  app.post("/api/auth/reset", { config: limit(10) }, async (req) => {
    const { token, newPassword } = TokenBody.extend({ newPassword: z.string().min(8, "8 caractères minimum").max(128) }).parse(req.body);
    const t = await consumeToken(prisma, token, "RESET");
    const user = await prisma.user.findUnique({ where: { id: t.userId } });
    if (!user || user.email !== t.email) throw new HttpError(400, "invalid_token", "Ce lien est invalide ou a expiré. Demande-en un nouveau.");
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
    await prisma.emailToken.deleteMany({ where: { userId: user.id, kind: "RESET" } });
    return { ok: true };
  });

  app.post("/api/auth/verify-email", { config: limit(20) }, async (req) => {
    const { token } = TokenBody.parse(req.body);
    const t = await consumeToken(prisma, token, "VERIFY");
    const user = await prisma.user.findUnique({ where: { id: t.userId } });
    if (!user || user.email !== t.email) throw new HttpError(400, "invalid_token", "Ce lien est invalide ou a expiré. Demande-en un nouveau.");
    if (verificationOverdue(user)) throw new HttpError(403, "verification_overdue", "Délai dépassé : contacte le super administrateur pour qu'il le prolonge.");
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    return { ok: true, username: user.username };
  });

  /** Ajoute ou change l'adresse e-mail du compte (mot de passe demandé) et envoie le lien de vérification. */
  app.post("/api/me/email", { config: limit(10) }, async (req) => {
    const { user } = await auth(req);
    const { email, currentPassword } = z.object({ email: emailSchema, currentPassword: z.string().min(1).max(128) }).parse(req.body);
    if (!(await verifyPassword(currentPassword, user.passwordHash))) throw new HttpError(403, "bad_password", "Mot de passe incorrect");
    const taken = await prisma.user.findUnique({ where: { email } });
    if (taken && taken.id !== user.id) throw new HttpError(409, "email_taken", "Cette adresse e-mail est déjà utilisée");
    if (user.email !== email) {
      try {
        await prisma.user.update({ where: { id: user.id }, data: { email, emailVerifiedAt: null } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new HttpError(409, "email_taken", "Cette adresse e-mail est déjà utilisée");
        throw e;
      }
    } else if (user.emailVerifiedAt) {
      return { ok: true, verified: true, sent: false };
    }
    await sendVerificationMail(deps, req, user, email);
    return { ok: true, verified: false, sent: true };
  });

  app.post("/api/me/email/send-verification", { config: limit(5) }, async (req) => {
    const { user } = await auth(req);
    if (!user.email) throw new HttpError(400, "no_email", "Ajoute d'abord une adresse e-mail");
    if (user.emailVerifiedAt) return { ok: true, verified: true, sent: false };
    await sendVerificationMail(deps, req, user, user.email);
    return { ok: true, verified: false, sent: true };
  });

  app.delete("/api/me/email", async (req) => {
    const { user } = await auth(req);
    if (user.role === "ORG_ADMIN" || user.role === "SUBJECT_MANAGER") throw new HttpError(403, "email_required", "Un compte de gestion doit garder une adresse e-mail");
    await prisma.user.update({ where: { id: user.id }, data: { email: null, emailVerifiedAt: null } });
    await prisma.emailToken.deleteMany({ where: { userId: user.id } });
    return { ok: true };
  });

  /** Le super administrateur prolonge le délai de vérification d'un administrateur d'organisation ou d'un responsable. */
  app.post<{ Params: { id: string } }>("/api/users/:id/extend-verification", async (req) => {
    const ctx = await auth(req);
    if (ctx.user.role !== "ADMIN") throw new HttpError(403, "forbidden", "Réservé au super administrateur");
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(3) }).parse(req.body ?? {});
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target || (target.role !== "ORG_ADMIN" && target.role !== "SUBJECT_MANAGER")) throw new HttpError(404, "user_not_found", "Compte de gestion introuvable");
    if (target.emailVerifiedAt) throw new HttpError(409, "already_verified", "Cette adresse est déjà vérifiée");
    const base = Math.max(Date.now(), target.verifyDeadline?.getTime() ?? 0);
    const verifyDeadline = new Date(base + days * 86_400_000);
    await prisma.user.update({ where: { id: target.id }, data: { verifyDeadline } });
    await logAction(prisma, ctx.user.id, null, "EXTEND_VERIFICATION", { username: target.username, days, until: verifyDeadline.toISOString() });
    return { ok: true, verifyDeadline };
  });
}
