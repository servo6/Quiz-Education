import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireMembership } from "../access.ts";
import { AVATAR_CATEGORIES, LOOK_KEY, LOOK_MAX_KEYS, LOOK_VALUE, lockedLook, lockReason, parseAvatar, unlockContext, UNLOCK_TYPES, type AvatarCategory } from "../avatar.ts";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { BADGE_TYPES, evaluateBadges } from "../badges.ts";
import { HttpError } from "../http.ts";
import { assertCan } from "../permissions.ts";
import { loadEffectiveSettings } from "../settingsStore.ts";
import { loadTiers, titleFor, type TierDef } from "../titles.ts";
import { levelFromXp } from "../xp.ts";

const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/, "couleur #RRGGBB");

const TiersBody = z.object({
  tiers: z
    .array(z.object({ name: z.string().trim().min(1).max(40), minLevel: z.number().int().min(1).max(1000), color: HEX.optional() }))
    .min(1)
    .max(30),
});
const BadgeBody = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,40}$/, "lettres minuscules, chiffres et underscore"),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(200),
  conditionType: z.enum(BADGE_TYPES),
  threshold: z.number().int().min(1).max(1_000_000),
  icon: z.string().max(40).default(""),
});
const AvatarItemBody = z.object({
  category: z.enum(AVATAR_CATEGORIES),
  name: z.string().trim().min(1).max(60),
  assetPath: z.string().trim().min(1).max(200),
  unlockType: z.enum(UNLOCK_TYPES).default("FREE"),
  unlockValue: z.string().trim().max(60).nullable().default(null),
});
const AvatarBody = z.object({
  items: z.record(z.enum(AVATAR_CATEGORIES), z.string().min(1).nullable()),
  colors: z.record(z.string().regex(/^[a-z]{2,20}$/), HEX).default({}),
  look: z.record(z.string().regex(LOOK_KEY), z.string().regex(LOOK_VALUE)).refine((o) => Object.keys(o).length <= LOOK_MAX_KEYS, "trop de choix").default({}),
});

/** Niveau, titre et réglages d'une matière, calculés une fois pour toute une liste. */
export async function subjectView(prisma: PrismaClient, subjectId: string) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) throw new HttpError(404, "subject_not_found", "Matière introuvable");
  const settings = await loadEffectiveSettings(prisma, subject.settings, subject.organizationId);
  const { tiers } = await loadTiers(prisma, subjectId);
  const lc = { base: settings.levelBase, exponent: settings.levelExponent };
  const card = (user: { id: string; username: string; avatar: string }, xp: number) => {
    const lvl = levelFromXp(xp, lc);
    const t = titleFor(lvl.level, tiers);
    return { id: user.id, username: user.username, avatar: parseAvatar(user.avatar), xp, ...lvl, title: { name: t.name, color: t.color } };
  };
  return { subject, settings, tiers, card };
}

export function registerProgressRoutes(app: FastifyInstance, { prisma, auth, timezone }: Deps): void {
  // ───────────── Titres ─────────────
  const tiersOut = (tiers: TierDef[]) => tiers.map((t) => ({ name: t.name, minLevel: t.minLevel, color: t.color }));

  async function replaceTiers(subjectId: string | null, body: z.infer<typeof TiersBody>, actorId: string) {
    const levels = body.tiers.map((t) => t.minLevel);
    if (new Set(levels).size !== levels.length) throw new HttpError(422, "duplicate_level", "Deux titres ont le même niveau minimum");
    if (!levels.includes(1)) throw new HttpError(422, "missing_level_one", "Un titre doit commencer au niveau 1");
    await prisma.$transaction(async (tx) => {
      await tx.tier.deleteMany({ where: { subjectId } });
      await tx.tier.createMany({ data: body.tiers.map((t) => ({ subjectId, name: t.name, minLevel: t.minLevel, color: t.color ?? "#9CA3AF" })) });
      await logAction(tx, actorId, subjectId, "SET_TIERS", { count: body.tiers.length });
    });
  }

  app.get("/api/tiers", async (req) => {
    await auth(req);
    const { tiers, source } = await loadTiers(prisma);
    return { tiers: tiersOut(tiers), source };
  });
  app.put("/api/tiers", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "tiers:manage");
    await replaceTiers(null, TiersBody.parse(req.body), ctx.user.id);
    const { tiers, source } = await loadTiers(prisma);
    return { tiers: tiersOut(tiers), source };
  });
  app.get<{ Params: { id: string } }>("/api/subjects/:id/tiers", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id);
    const { tiers, source } = await loadTiers(prisma, req.params.id);
    return { tiers: tiersOut(tiers), source };
  });
  app.put<{ Params: { id: string } }>("/api/subjects/:id/tiers", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "tiers:manage");
    if (!(await prisma.subject.findUnique({ where: { id: req.params.id } }))) throw new HttpError(404, "subject_not_found", "Matière introuvable");
    await replaceTiers(req.params.id, TiersBody.parse(req.body), ctx.user.id);
    const { tiers, source } = await loadTiers(prisma, req.params.id);
    return { tiers: tiersOut(tiers), source };
  });
  app.delete<{ Params: { id: string } }>("/api/subjects/:id/tiers", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "tiers:manage");
    await prisma.tier.deleteMany({ where: { subjectId: req.params.id } });
    await logAction(prisma, ctx.user.id, req.params.id, "RESET_TIERS");
    return { ok: true };
  });

  // ───────────── Badges ─────────────
  app.get("/api/me/badges", async (req) => {
    const ctx = await auth(req);
    if (ctx.actor.role !== "USER") throw new HttpError(403, "admin_cannot_play", "Un administrateur ne joue pas : il gère la plateforme");
    const { progress, newlyEarned } = await evaluateBadges(prisma, ctx.user.id, timezone);
    return { badges: progress, newlyEarned, earnedCount: progress.filter((b) => b.earned).length };
  });
  app.get("/api/badges", async (req) => {
    await auth(req);
    return { badges: await prisma.badge.findMany({ orderBy: [{ conditionType: "asc" }, { threshold: "asc" }] }) };
  });
  app.post("/api/badges", async (req, reply) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "badges:manage");
    const body = BadgeBody.parse(req.body);
    if (await prisma.badge.findUnique({ where: { code: body.code } })) throw new HttpError(409, "badge_code_taken", "Ce code de badge existe déjà");
    const badge = await prisma.badge.create({ data: body });
    await logAction(prisma, ctx.user.id, null, "CREATE_BADGE", { code: badge.code });
    return reply.status(201).send({ badge });
  });
  app.patch<{ Params: { id: string } }>("/api/badges/:id", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "badges:manage");
    const body = BadgeBody.partial().strict().parse(req.body);
    const existing = await prisma.badge.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, "badge_not_found", "Badge introuvable");
    if (body.code && body.code !== existing.code && (await prisma.badge.findUnique({ where: { code: body.code } }))) {
      throw new HttpError(409, "badge_code_taken", "Ce code de badge existe déjà");
    }
    const badge = await prisma.badge.update({ where: { id: existing.id }, data: body });
    await logAction(prisma, ctx.user.id, null, "UPDATE_BADGE", { code: badge.code, fields: Object.keys(body) });
    return { badge };
  });
  app.delete<{ Params: { id: string } }>("/api/badges/:id", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "badges:manage");
    const existing = await prisma.badge.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, "badge_not_found", "Badge introuvable");
    await prisma.badge.delete({ where: { id: existing.id } });
    await logAction(prisma, ctx.user.id, null, "DELETE_BADGE", { code: existing.code });
    return { ok: true };
  });

  // ───────────── Avatar ─────────────
  app.get("/api/avatar/items", async (req) => {
    const ctx = await auth(req);
    const [items, unlock] = await Promise.all([prisma.avatarItem.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] }), unlockContext(prisma, ctx.user.id)]);
    return {
      avatar: parseAvatar(ctx.user.avatar),
      lookLocks: lockedLook(unlock),
      items: items.map((i) => {
        const reason = lockReason(i, unlock);
        return { ...i, unlocked: reason === null, lockReason: reason };
      }),
    };
  });
  app.put("/api/me/avatar", async (req) => {
    const ctx = await auth(req);
    if (ctx.actor.role !== "USER") throw new HttpError(403, "admin_cannot_play", "Un administrateur ne joue pas : il gère la plateforme");
    const body = AvatarBody.parse(req.body);
    const unlock = await unlockContext(prisma, ctx.user.id);
    const items: Partial<Record<AvatarCategory, string>> = {};
    for (const [category, id] of Object.entries(body.items) as Array<[AvatarCategory, string | null]>) {
      if (id === null) continue;
      const item = await prisma.avatarItem.findUnique({ where: { id } });
      if (!item || item.category !== category) throw new HttpError(422, "invalid_avatar_item", `Objet invalide pour « ${category} »`);
      const reason = lockReason(item, unlock);
      if (reason) throw new HttpError(403, "avatar_item_locked", reason, { itemId: id });
      items[category] = id;
    }
    const locks = lockedLook(unlock);
    for (const [key, value] of Object.entries(body.look)) {
      const reason = locks[`${key}:${value}`];
      if (reason) throw new HttpError(403, "avatar_item_locked", reason, { itemId: `${key}:${value}` });
    }
    const avatar = { items, colors: body.colors, look: body.look };
    await prisma.user.update({ where: { id: ctx.user.id }, data: { avatar: JSON.stringify(avatar) } });
    return { avatar };
  });
  const adminItemPatch = AvatarItemBody.partial().strict();
  app.post("/api/avatar/items", async (req, reply) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "avatars:manage");
    const body = AvatarItemBody.parse(req.body);
    const item = await prisma.avatarItem.create({ data: body });
    await logAction(prisma, ctx.user.id, null, "CREATE_AVATAR_ITEM", { name: item.name });
    return reply.status(201).send({ item });
  });
  app.patch<{ Params: { id: string } }>("/api/avatar/items/:id", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "avatars:manage");
    const body = adminItemPatch.parse(req.body);
    if (!(await prisma.avatarItem.findUnique({ where: { id: req.params.id } }))) throw new HttpError(404, "avatar_item_not_found", "Objet introuvable");
    const item = await prisma.avatarItem.update({ where: { id: req.params.id }, data: body });
    await logAction(prisma, ctx.user.id, null, "UPDATE_AVATAR_ITEM", { name: item.name });
    return { item };
  });
  app.delete<{ Params: { id: string } }>("/api/avatar/items/:id", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "avatars:manage");
    if (!(await prisma.avatarItem.findUnique({ where: { id: req.params.id } }))) throw new HttpError(404, "avatar_item_not_found", "Objet introuvable");
    await prisma.avatarItem.delete({ where: { id: req.params.id } });
    await logAction(prisma, ctx.user.id, null, "DELETE_AVATAR_ITEM", { id: req.params.id });
    return { ok: true };
  });

  // ───────────── Classement ─────────────
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/subjects/:id/leaderboard", async (req) => {
    const ctx = await auth(req);
    const mine = await requireMembership(prisma, ctx.user.id, req.params.id);
    const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(req.query.limit ?? 20);
    const view = await subjectView(prisma, req.params.id);
    const active = { subjectId: req.params.id, revokedAt: null, user: { bannedAt: null, role: "USER" as const } };
    const rows = await prisma.membership.findMany({
      where: active,
      orderBy: [{ xp: "desc" }, { joinedAt: "asc" }],
      take: limit,
      include: { user: { select: { id: true, username: true, avatar: true } } },
    });
    // Rang : à XP égal, même rang.
    let lastXp = -1;
    let lastRank = 0;
    const players = rows.map((m, i) => {
      const rank = m.xp === lastXp ? lastRank : i + 1;
      lastXp = m.xp;
      lastRank = rank;
      return { rank, ...view.card(m.user, m.xp) };
    });
    const ahead = await prisma.membership.count({ where: { ...active, xp: { gt: mine.xp } } });
    return { players, you: { rank: ahead + 1, xp: mine.xp }, totalPlayers: await prisma.membership.count({ where: active }) };
  });

  // ───────────── Mes statistiques dans une matière ─────────────
  async function statsFor(userId: string, subjectId: string) {
    const [answers, players, xpBySource] = await Promise.all([
      prisma.answer.findMany({
        where: { userId, gameQuestion: { game: { subjectId } } },
        select: { isCorrect: true, choiceIndex: true, gameQuestion: { select: { game: { select: { mode: true } }, round: { select: { chapter: { select: { id: true, name: true } } } } } } },
        take: 50_000,
      }),
      prisma.gamePlayer.findMany({ where: { userId, game: { subjectId } }, select: { result: true, game: { select: { mode: true, status: true } } } }),
      prisma.xpEvent.groupBy({ by: ["source"], where: { userId, subjectId }, _sum: { amount: true } }),
    ]);

    const byChapter = new Map<string, { id: string; name: string; answered: number; correct: number }>();
    const byMode: Record<string, { answered: number; correct: number }> = {};
    let correct = 0;
    for (const a of answers) {
      if (a.isCorrect) correct++;
      const mode = a.gameQuestion.game.mode;
      const m = (byMode[mode] ??= { answered: 0, correct: 0 });
      m.answered++;
      if (a.isCorrect) m.correct++;
      const ch = a.gameQuestion.round.chapter;
      const c = byChapter.get(ch.id) ?? { id: ch.id, name: ch.name, answered: 0, correct: 0 };
      c.answered++;
      if (a.isCorrect) c.correct++;
      byChapter.set(ch.id, c);
    }
    const pct = (c: number, n: number) => (n === 0 ? null : Math.round((c / n) * 1000) / 10);

    const duels = players.filter((p) => ["FRIENDLY", "DUEL"].includes(p.game.mode) && p.game.status === "FINISHED" && p.result);
    const count = (r: string) => duels.filter((p) => p.result === r).length;
    return {
      answers: { total: answers.length, correct, accuracy: pct(correct, answers.length), timedOut: answers.filter((a) => a.choiceIndex === null).length },
      byMode: Object.fromEntries(Object.entries(byMode).map(([k, v]) => [k, { ...v, accuracy: pct(v.correct, v.answered) }])),
      solo: { finished: players.filter((p) => p.game.mode === "SOLO" && p.game.status === "FINISHED").length },
      duels: { played: duels.length, wins: count("WIN"), draws: count("DRAW"), losses: count("LOSS"), forfeits: count("FORFEIT"), inProgress: players.filter((p) => ["FRIENDLY", "DUEL"].includes(p.game.mode) && p.game.status === "IN_PROGRESS").length },
      chapters: [...byChapter.values()].map((c) => ({ ...c, accuracy: pct(c.correct, c.answered) })).sort((a, b) => a.name.localeCompare(b.name)),
      xpBySource: Object.fromEntries(xpBySource.map((x) => [x.source, x._sum.amount ?? 0])),
    };
  }

  app.get<{ Params: { id: string } }>("/api/subjects/:id/stats", async (req) => {
    const ctx = await auth(req);
    const m = await requireMembership(prisma, ctx.user.id, req.params.id);
    const view = await subjectView(prisma, req.params.id);
    const rank = (await prisma.membership.count({ where: { subjectId: req.params.id, revokedAt: null, user: { bannedAt: null, role: "USER" as const }, xp: { gt: m.xp } } })) + 1;
    const me = await prisma.user.findUniqueOrThrow({ where: { id: ctx.user.id }, select: { id: true, username: true, avatar: true } });
    return { player: view.card(me, m.xp), rank, ...(await statsFor(ctx.user.id, req.params.id)) };
  });

  // ───────────── Profil d'un autre membre de la matière ─────────────
  app.get<{ Params: { id: string; userId: string } }>("/api/subjects/:id/players/:userId", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id);
    const target = await prisma.membership.findUnique({
      where: { userId_subjectId: { userId: req.params.userId, subjectId: req.params.id } },
      include: { user: { select: { id: true, username: true, avatar: true, bannedAt: true } } },
    });
    if (!target || target.revokedAt || target.user.bannedAt) throw new HttpError(404, "player_not_found", "Joueur introuvable dans cette matière");
    const view = await subjectView(prisma, req.params.id);
    const [stats, badges] = await Promise.all([
      statsFor(target.userId, req.params.id),
      prisma.userBadge.findMany({ where: { userId: target.userId }, include: { badge: true }, orderBy: { earnedAt: "desc" } }),
    ]);
    const rank = (await prisma.membership.count({ where: { subjectId: req.params.id, revokedAt: null, user: { bannedAt: null, role: "USER" as const }, xp: { gt: target.xp } } })) + 1;

    // Face-à-face : duels terminés entre les deux joueurs dans cette matière.
    const shared = await prisma.game.findMany({
      where: {
        subjectId: req.params.id,
        mode: { in: ["FRIENDLY", "DUEL"] },
        status: "FINISHED",
        AND: [{ players: { some: { userId: ctx.user.id } } }, { players: { some: { userId: target.userId } } }],
      },
      include: { players: true },
    });
    const h2h = { played: shared.length, yourWins: 0, theirWins: 0, draws: 0 };
    for (const g of shared) {
      const mine = g.players.find((p) => p.userId === ctx.user.id)?.result;
      if (mine === "WIN") h2h.yourWins++;
      else if (mine === "DRAW") h2h.draws++;
      else if (mine === "LOSS" || mine === "FORFEIT") h2h.theirWins++;
    }
    return {
      player: view.card(target.user, target.xp),
      rank,
      answers: stats.answers,
      duels: stats.duels,
      badges: badges.map((b) => ({ code: b.badge.code, name: b.badge.name, icon: b.badge.icon, earnedAt: b.earnedAt })),
      headToHead: ctx.user.id === target.userId ? null : h2h,
    };
  });
}
