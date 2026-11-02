import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { hashPassword, verifyPassword } from "../password.ts";
import { assertCan } from "../permissions.ts";
import { startOfDay } from "../time.ts";

const PasswordBody = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(8, "8 caractères minimum").max(128) });

export function registerAccountRoutes(app: FastifyInstance, { prisma, auth, limit, timezone }: Deps): void {
  // ── Changer son propre mot de passe
  app.post("/api/me/password", { config: limit(10) }, async (req) => {
    const ctx = await auth(req);
    const { currentPassword, newPassword } = PasswordBody.parse(req.body);
    if (!(await verifyPassword(currentPassword, ctx.user.passwordHash))) {
      throw new HttpError(401, "wrong_password", "Mot de passe actuel incorrect");
    }
    if (currentPassword === newPassword) throw new HttpError(422, "same_password", "Le nouveau mot de passe doit être différent");
    await prisma.user.update({ where: { id: ctx.user.id }, data: { passwordHash: await hashPassword(newPassword) } });
    await logAction(prisma, ctx.user.id, null, "CHANGE_OWN_PASSWORD");
    return { ok: true };
  });

  // ── Vue d'ensemble de la plateforme (administrateur)
  app.get("/api/admin/overview", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "users:list");
    const day = startOfDay(new Date(), timezone);
    const week = new Date(day.getTime() - 6 * 86_400_000);
    const [users, banned, subjects, chapters, questions, gamesByMode, gamesToday, activeWeek, answers] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { bannedAt: { not: null } } }),
      prisma.subject.count(),
      prisma.chapter.count({ where: { deletedAt: null } }),
      prisma.question.count({ where: { deletedAt: null } }),
      prisma.game.groupBy({ by: ["mode", "status"], _count: { _all: true } }),
      prisma.game.count({ where: { createdAt: { gte: day } } }),
      prisma.answer.findMany({ where: { answeredAt: { gte: week } }, select: { userId: true }, distinct: ["userId"] }),
      prisma.answer.count(),
    ]);
    const games: Record<string, Record<string, number>> = {};
    for (const g of gamesByMode) (games[g.mode] ??= {})[g.status] = g._count._all;
    return { users: { total: users, banned, activeLast7Days: activeWeek.length }, subjects, chapters, questions, answers, games, gamesToday };
  });

  // ── Sauvegarde logique (administrateur) : contenu et progression, sans aucun secret
  app.get("/api/admin/export", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "backup:export");
    const [users, subjects, managers, memberships, chapters, batches, questions, tiers, badges, userBadges, avatarItems, settings, xpEvents] = await Promise.all([
      prisma.user.findMany({ select: { id: true, username: true, role: true, avatar: true, activeSubjectId: true, bannedAt: true, createdAt: true } }),
      prisma.subject.findMany({ select: { id: true, name: true, accessName: true, settings: true, createdAt: true } }),
      prisma.subjectManager.findMany(),
      prisma.membership.findMany(),
      prisma.chapter.findMany(),
      prisma.importBatch.findMany(),
      prisma.question.findMany(),
      prisma.tier.findMany(),
      prisma.badge.findMany(),
      prisma.userBadge.findMany(),
      prisma.avatarItem.findMany(),
      prisma.setting.findMany(),
      prisma.xpEvent.findMany(),
    ]);
    await logAction(prisma, ctx.user.id, null, "EXPORT_BACKUP", { users: users.length, questions: questions.length });
    return {
      exportedAt: new Date().toISOString(),
      note: "Ne contient ni mots de passe, ni mots de passe d'accès, ni l'historique détaillé des parties.",
      users, subjects, managers, memberships, chapters, batches, questions, tiers, badges, userBadges, avatarItems, settings, xpEvents,
    };
  });
}
