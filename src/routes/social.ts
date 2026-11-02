import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireMembership } from "../access.ts";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import type { Hub } from "../duel/engine.ts";
import { HttpError } from "../http.ts";
import { assertCan } from "../permissions.ts";
import { subjectView } from "./progress.ts";

/** Durées de conservation proposées à l'administrateur (jours). */
export const RETENTION_CHOICES = [2, 7, 30] as const;
export const DEFAULT_RETENTION_DAYS = 7;
const KEY = "chat.retentionDays";
const DAY_MS = 86_400_000;
const MAX_BODY = 1000;

export async function retentionDays(prisma: PrismaClient): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  try {
    const v = row ? JSON.parse(row.value) : DEFAULT_RETENTION_DAYS;
    return (RETENTION_CHOICES as readonly number[]).includes(v) ? v : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}

/** Supprime les messages plus vieux que la durée de conservation. Renvoie le nombre supprimé. */
export async function purgeExpiredMessages(prisma: PrismaClient, now = new Date()): Promise<number> {
  const days = await retentionDays(prisma);
  const { count } = await prisma.message.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - days * DAY_MS) } } });
  return count;
}

export function registerSocialRoutes(app: FastifyInstance, { prisma, auth }: Deps, hub: Pick<Hub, "emit"> & { isOnline?: (id: string) => boolean }): void {
  const BodyUser = z.object({ userId: z.string().min(1) });
  const BodyMsg = z.object({ body: z.string().trim().min(1, "Message vide").max(MAX_BODY, `${MAX_BODY} caractères maximum`) });

  // ── Durée de conservation des messages
  app.get("/api/chat/settings", async (req) => {
    await auth(req);
    return { retentionDays: await retentionDays(prisma), choices: RETENTION_CHOICES };
  });
  app.put("/api/admin/chat", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "settings:global");
    const { retentionDays: days } = z.object({ retentionDays: z.number().int().refine((v) => (RETENTION_CHOICES as readonly number[]).includes(v), "Choisis 2, 7 ou 30 jours") }).parse(req.body);
    await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(days) }, update: { value: JSON.stringify(days) } });
    await logAction(prisma, ctx.user.id, null, "UPDATE_CHAT_RETENTION", { days });
    const purged = await purgeExpiredMessages(prisma);
    return { retentionDays: days, choices: RETENTION_CHOICES, purged };
  });

  const noAdmin = (role: string) => {
    if (role === "ADMIN") throw new HttpError(403, "admin_cannot_play", "Un administrateur n'a pas de messagerie de joueur");
  };

  /** L'amitié existe, est acceptée (si `accepted`) et concerne bien l'utilisateur. */
  async function loadFriendship(userId: string, id: string, accepted = false) {
    const f = await prisma.friendship.findUnique({ where: { id } });
    if (!f || (f.requesterId !== userId && f.addresseeId !== userId)) throw new HttpError(404, "friendship_not_found", "Ami introuvable");
    if (accepted && f.status !== "ACCEPTED") throw new HttpError(409, "not_friends", "Vous n'êtes pas encore amis");
    return f;
  }
  const otherOf = (f: { requesterId: string; addresseeId: string }, userId: string) => (f.requesterId === userId ? f.addresseeId : f.requesterId);

  // ── Amis d'une matière
  app.get<{ Params: { id: string } }>("/api/subjects/:id/friends", async (req) => {
    const ctx = await auth(req);
    noAdmin(ctx.actor.role);
    await requireMembership(prisma, ctx.user.id, req.params.id);
    const view = await subjectView(prisma, req.params.id);
    const rows = await prisma.friendship.findMany({
      where: { subjectId: req.params.id, OR: [{ requesterId: ctx.user.id }, { addresseeId: ctx.user.id }] },
      orderBy: { createdAt: "desc" },
      include: { requester: { select: { id: true, username: true, avatar: true, bannedAt: true } }, addressee: { select: { id: true, username: true, avatar: true, bannedAt: true } } },
    });
    const otherIds = rows.map((r) => otherOf(r, ctx.user.id));
    const memberships = await prisma.membership.findMany({ where: { subjectId: req.params.id, userId: { in: otherIds } } });
    const xpOf = new Map(memberships.map((m) => [m.userId, m]));
    const cutoff = new Date(Date.now() - (await retentionDays(prisma)) * DAY_MS);
    const out = [];
    for (const r of rows) {
      const other = r.requesterId === ctx.user.id ? r.addressee : r.requester;
      const m = xpOf.get(other.id);
      if (!m || m.revokedAt || other.bannedAt) continue; // un ancien membre disparaît de la liste
      const base = { id: r.id, status: r.status, createdAt: r.createdAt, direction: r.requesterId === ctx.user.id ? "out" : "in", user: view.card(other, m.xp), online: hub.isOnline?.(other.id) ?? false };
      if (r.status === "ACCEPTED") {
        const [unread, last] = await Promise.all([
          prisma.message.count({ where: { friendshipId: r.id, senderId: other.id, readAt: null, createdAt: { gte: cutoff } } }),
          prisma.message.findFirst({ where: { friendshipId: r.id, createdAt: { gte: cutoff } }, orderBy: { createdAt: "desc" } }),
        ]);
        out.push({ ...base, unread, last: last ? { body: last.body, mine: last.senderId === ctx.user.id, createdAt: last.createdAt } : null });
      } else out.push(base);
    }
    return {
      friends: out.filter((f) => f.status === "ACCEPTED").sort((a, b) => ((b as any).last?.createdAt?.getTime?.() ?? 0) - ((a as any).last?.createdAt?.getTime?.() ?? 0)),
      incoming: out.filter((f) => f.status === "PENDING" && f.direction === "in"),
      outgoing: out.filter((f) => f.status === "PENDING" && f.direction === "out"),
      retentionDays: await retentionDays(prisma),
    };
  });

  // ── Inviter un membre de la matière (si lui m'a déjà invité, l'amitié est acceptée)
  app.post<{ Params: { id: string } }>("/api/subjects/:id/friends", async (req, reply) => {
    const ctx = await auth(req);
    noAdmin(ctx.actor.role);
    await requireMembership(prisma, ctx.user.id, req.params.id);
    const { userId } = BodyUser.parse(req.body);
    if (userId === ctx.user.id) throw new HttpError(422, "self_friend", "Tu ne peux pas t'inviter toi-même");
    const target = await prisma.membership.findUnique({ where: { userId_subjectId: { userId, subjectId: req.params.id } }, include: { user: true } });
    if (!target || target.revokedAt || target.user.bannedAt || target.user.role === "ADMIN") throw new HttpError(404, "player_not_found", "Joueur introuvable dans cette matière");
    const existing = await prisma.friendship.findFirst({
      where: { subjectId: req.params.id, OR: [{ requesterId: ctx.user.id, addresseeId: userId }, { requesterId: userId, addresseeId: ctx.user.id }] },
    });
    if (existing) {
      if (existing.status === "ACCEPTED") throw new HttpError(409, "already_friends", "Vous êtes déjà amis");
      if (existing.requesterId === ctx.user.id) throw new HttpError(409, "already_invited", "Invitation déjà envoyée");
      const f = await prisma.friendship.update({ where: { id: existing.id }, data: { status: "ACCEPTED", respondedAt: new Date() } });
      hub.emit(userId, "friend:accepted", { friendshipId: f.id, subjectId: req.params.id, by: ctx.user.username });
      return reply.status(200).send({ id: f.id, status: f.status });
    }
    const f = await prisma.friendship.create({ data: { subjectId: req.params.id, requesterId: ctx.user.id, addresseeId: userId } });
    hub.emit(userId, "friend:request", { friendshipId: f.id, subjectId: req.params.id, from: ctx.user.username });
    return reply.status(201).send({ id: f.id, status: f.status });
  });

  app.post<{ Params: { id: string } }>("/api/friendships/:id/accept", async (req) => {
    const ctx = await auth(req);
    noAdmin(ctx.actor.role);
    const f = await loadFriendship(ctx.user.id, req.params.id);
    if (f.addresseeId !== ctx.user.id) throw new HttpError(403, "not_addressee", "Seule la personne invitée peut accepter");
    if (f.status === "ACCEPTED") return { id: f.id, status: f.status };
    await requireMembership(prisma, ctx.user.id, f.subjectId);
    const up = await prisma.friendship.update({ where: { id: f.id }, data: { status: "ACCEPTED", respondedAt: new Date() } });
    hub.emit(f.requesterId, "friend:accepted", { friendshipId: f.id, subjectId: f.subjectId, by: ctx.user.username });
    return { id: up.id, status: up.status };
  });

  // Refuser, annuler une invitation ou retirer un ami : même geste (les messages sont supprimés avec l'amitié).
  app.delete<{ Params: { id: string } }>("/api/friendships/:id", async (req) => {
    const ctx = await auth(req);
    noAdmin(ctx.actor.role);
    const f = await loadFriendship(ctx.user.id, req.params.id);
    await prisma.$transaction([prisma.message.deleteMany({ where: { friendshipId: f.id } }), prisma.friendship.delete({ where: { id: f.id } })]);
    return { ok: true };
  });

  // ── Fil de discussion
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/friendships/:id/messages", async (req) => {
    const ctx = await auth(req);
    noAdmin(ctx.actor.role);
    const f = await loadFriendship(ctx.user.id, req.params.id, true);
    await requireMembership(prisma, ctx.user.id, f.subjectId);
    const days = await retentionDays(prisma);
    const cutoff = new Date(Date.now() - days * DAY_MS);
    const after = req.query.after ? new Date(req.query.after) : null;
    const rows = await prisma.message.findMany({
      where: { friendshipId: f.id, createdAt: { gte: after && !Number.isNaN(after.getTime()) && after > cutoff ? after : cutoff, ...(after ? { gt: after } : {}) } },
      orderBy: { createdAt: "asc" },
      take: 300,
    });
    const other = otherOf(f, ctx.user.id);
    await prisma.message.updateMany({ where: { friendshipId: f.id, senderId: other, readAt: null }, data: { readAt: new Date() } });
    const otherUser = await prisma.user.findUniqueOrThrow({ where: { id: other }, select: { username: true } });
    return {
      friend: { id: other, username: otherUser.username, online: hub.isOnline?.(other) ?? false },
      retentionDays: days,
      messages: rows.map((m) => ({ id: m.id, body: m.body, mine: m.senderId === ctx.user.id, createdAt: m.createdAt, read: !!m.readAt })),
    };
  });

  app.post<{ Params: { id: string } }>("/api/friendships/:id/messages", async (req, reply) => {
    const ctx = await auth(req);
    noAdmin(ctx.actor.role);
    const { body } = BodyMsg.parse(req.body);
    const f = await loadFriendship(ctx.user.id, req.params.id, true);
    await requireMembership(prisma, ctx.user.id, f.subjectId);
    const other = otherOf(f, ctx.user.id);
    const om = await prisma.membership.findUnique({ where: { userId_subjectId: { userId: other, subjectId: f.subjectId } }, include: { user: { select: { bannedAt: true } } } });
    if (!om || om.revokedAt || om.user.bannedAt) throw new HttpError(409, "friend_unavailable", "Cet ami n'a plus accès à la matière");
    // Anti-inondation : 20 messages par minute et par conversation.
    const recent = await prisma.message.count({ where: { friendshipId: f.id, senderId: ctx.user.id, createdAt: { gte: new Date(Date.now() - 60_000) } } });
    if (recent >= 20) throw new HttpError(429, "too_fast", "Trop de messages d'affilée, patiente quelques secondes");
    const m = await prisma.message.create({ data: { friendshipId: f.id, senderId: ctx.user.id, body } });
    hub.emit(other, "chat:message", { friendshipId: f.id, subjectId: f.subjectId, from: ctx.user.username, preview: body.slice(0, 80), id: m.id, createdAt: m.createdAt });
    return reply.status(201).send({ id: m.id, body: m.body, mine: true, createdAt: m.createdAt, read: false });
  });

  // ── Pastilles : messages non lus et invitations reçues (toutes matières)
  app.get("/api/me/social-summary", async (req) => {
    const ctx = await auth(req);
    if (ctx.actor.role === "ADMIN") return { unread: 0, invitations: 0 };
    const cutoff = new Date(Date.now() - (await retentionDays(prisma)) * DAY_MS);
    const [unread, invitations] = await Promise.all([
      prisma.message.count({ where: { readAt: null, senderId: { not: ctx.user.id }, createdAt: { gte: cutoff }, friendship: { status: "ACCEPTED", OR: [{ requesterId: ctx.user.id }, { addresseeId: ctx.user.id }] } } }),
      prisma.friendship.count({ where: { addresseeId: ctx.user.id, status: "PENDING" } }),
    ]);
    return { unread, invitations };
  });
}
