import { parseAvatar } from "../avatar.ts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertAccountInReach } from "../accountScope.ts";
import { loadSubject } from "../access.ts";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { hashPassword } from "../password.ts";
import { assertCan, canActOnUser, type Role } from "../permissions.ts";
import { finishDuel } from "./duelAsync.ts";
import { loadEffectiveSettings } from "../settingsStore.ts";
import { levelFromXp } from "../xp.ts";

const ReasonBody = z.object({ reason: z.string().trim().max(200).optional() }).default({});
const ResetBody = z.object({ newPassword: z.string().min(8).max(128) });

export function registerMemberRoutes(app: FastifyInstance, { prisma, auth }: Deps): void {
  // ── Membres d'une matière (administrateur ou responsable de la matière)
  app.get<{ Params: { id: string }; Querystring: { q?: string; status?: string } }>("/api/subjects/:id/members", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "members:view", subject.id);
    const q = z.string().trim().toLowerCase().max(40).catch("").parse(req.query.q ?? "");
    const status = z.enum(["active", "revoked", "all"]).catch("all").parse(req.query.status ?? "all");
    const settings = await loadEffectiveSettings(prisma, subject.settings, subject.organizationId);
    const rows = await prisma.membership.findMany({
      where: {
        subjectId: subject.id,
        ...(status === "active" ? { revokedAt: null } : status === "revoked" ? { revokedAt: { not: null } } : {}),
        user: { role: "USER", ...(q ? { username: { contains: q } } : {}) },
      },
      orderBy: [{ revokedAt: { sort: "asc", nulls: "first" } }, { xp: "desc" }],
      take: 500,
      include: { user: { select: { id: true, username: true, avatar: true, role: true, bannedAt: true, createdAt: true } } },
    });
    return {
      members: rows.map((m) => ({
        userId: m.user.id,
        username: m.user.username,
        avatar: parseAvatar(m.user.avatar),
        role: m.user.role,
        xp: m.xp,
        level: levelFromXp(m.xp, { base: settings.levelBase, exponent: settings.levelExponent }).level,
        joinedAt: m.joinedAt,
        revokedAt: m.revokedAt,
        banned: !!m.user.bannedAt,
      })),
    };
  });

  async function membershipTarget(subjectId: string, userId: string) {
    const m = await prisma.membership.findUnique({ where: { userId_subjectId: { userId, subjectId } }, include: { user: true } });
    if (!m) throw new HttpError(404, "member_not_found", "Ce joueur n'est pas membre de cette matière");
    return m;
  }

  // ── Révoquer l'accès d'un membre (son XP et ses statistiques sont conservés)
  app.post<{ Params: { id: string; userId: string } }>("/api/subjects/:id/members/:userId/revoke", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "members:revoke", subject.id);
    const { reason } = ReasonBody.parse(req.body ?? {});
    const m = await membershipTarget(subject.id, req.params.userId);
    if (m.userId === ctx.user.id) throw new HttpError(422, "self_revoke", "Tu ne peux pas révoquer ton propre accès");
    if (!canActOnUser(ctx.actor, m.user.role as Role, subject.id)) throw new HttpError(403, "forbidden", "Tu ne peux pas agir sur ce compte");
    if (m.revokedAt) throw new HttpError(409, "already_revoked", "L'accès est déjà révoqué");

    await prisma.$transaction(async (tx) => {
      await tx.membership.update({ where: { id: m.id }, data: { revokedAt: new Date() } });
      if (m.user.activeSubjectId === subject.id) await tx.user.update({ where: { id: m.userId }, data: { activeSubjectId: null } });
      await logAction(tx, ctx.user.id, subject.id, "REVOKE_ACCESS", { userId: m.userId, username: m.user.username, reason: reason ?? null });
    });
    // Ses duels différés en cours sont clos par abandon : l'adversaire n'attend pas pour rien.
    const open = await prisma.game.findMany({ where: { mode: "DUEL", subjectId: subject.id, status: "IN_PROGRESS", players: { some: { userId: m.userId } } }, select: { id: true } });
    for (const g of open) await finishDuel(prisma, g.id, "forfeit", m.userId);
    return { ok: true, duelsClosed: open.length };
  });

  app.post<{ Params: { id: string; userId: string } }>("/api/subjects/:id/members/:userId/restore", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "members:revoke", subject.id);
    const m = await membershipTarget(subject.id, req.params.userId);
    if (!canActOnUser(ctx.actor, m.user.role as Role, subject.id)) throw new HttpError(403, "forbidden", "Tu ne peux pas agir sur ce compte");
    if (!m.revokedAt) throw new HttpError(409, "not_revoked", "L'accès n'est pas révoqué");
    await prisma.membership.update({ where: { id: m.id }, data: { revokedAt: null } });
    await logAction(prisma, ctx.user.id, subject.id, "RESTORE_ACCESS", { userId: m.userId, username: m.user.username });
    return { ok: true };
  });

  // ── Suspendre / rétablir un compte (administrateur)
  function requireAccountManager(ctx: { actor: { role: string } }): void {
    if (ctx.actor.role !== "ADMIN" && ctx.actor.role !== "ORG_ADMIN") throw new HttpError(403, "forbidden", "Action non autorisée");
  }

  async function targetUser(id: string) {
    const u = await prisma.user.findUnique({ where: { id } });
    if (!u) throw new HttpError(404, "user_not_found", "Utilisateur introuvable");
    return u;
  }

  app.post<{ Params: { id: string } }>("/api/users/:id/ban", async (req) => {
    const ctx = await auth(req);
    requireAccountManager(ctx);
    const { reason } = ReasonBody.parse(req.body ?? {});
    const u = await targetUser(req.params.id);
    await assertAccountInReach(prisma, ctx, u);
    if (u.bannedAt) throw new HttpError(409, "already_banned", "Ce compte est déjà suspendu");
    await prisma.user.update({ where: { id: u.id }, data: { bannedAt: new Date() } });
    await logAction(prisma, ctx.user.id, null, "BAN_USER", { userId: u.id, username: u.username, reason: reason ?? null });
    const open = await prisma.game.findMany({ where: { mode: "DUEL", status: "IN_PROGRESS", players: { some: { userId: u.id } } }, select: { id: true } });
    for (const g of open) await finishDuel(prisma, g.id, "forfeit", u.id);
    return { ok: true, duelsClosed: open.length };
  });

  app.post<{ Params: { id: string } }>("/api/users/:id/unban", async (req) => {
    const ctx = await auth(req);
    requireAccountManager(ctx);
    const u = await targetUser(req.params.id);
    await assertAccountInReach(prisma, ctx, u);
    if (!u.bannedAt) throw new HttpError(409, "not_banned", "Ce compte n'est pas suspendu");
    await prisma.user.update({ where: { id: u.id }, data: { bannedAt: null, deactivatedAt: null } });
    await logAction(prisma, ctx.user.id, null, "UNBAN_USER", { userId: u.id, username: u.username });
    return { ok: true };
  });

  // ── Réinitialiser le mot de passe d'un utilisateur (pas d'e-mail : c'est l'administrateur qui s'en charge)
  app.post<{ Params: { id: string } }>("/api/users/:id/reset-password", async (req) => {
    const ctx = await auth(req);
    requireAccountManager(ctx);
    const { newPassword } = ResetBody.parse(req.body);
    const u = await targetUser(req.params.id);
    await assertAccountInReach(prisma, ctx, u);
    await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(newPassword) } });
    await logAction(prisma, ctx.user.id, null, "RESET_PASSWORD", { userId: u.id, username: u.username });
    return { ok: true };
  });
}
