import type { FastifyInstance } from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";
import { requireMembership } from "../access.ts";
import type { Deps } from "../auth.ts";
import { localDayKey, startOfPeriod } from "../time.ts";

/**
 * Ligues hebdomadaires par matière : Bronze → Argent → Or → Diamant. Chaque semaine (lundi à dimanche), on classe les
 * joueurs d'une même ligue selon l'XP gagnée ; les meilleurs montent, les derniers descendent. Les joueurs sans XP
 * cette semaine-là restent où ils sont. Le calcul se fait à la première visite après la fin de la semaine.
 */
export const TIERS = ["Bronze", "Argent", "Or", "Diamant"] as const;
const MAX_CATCHUP_WEEKS = 8;
const MIN_GROUP = 4;

/** Nombre de places de promotion (= de relégation) pour un groupe de `n` joueurs actifs. */
export const zoneSize = (n: number) => (n < MIN_GROUP ? 0 : Math.max(1, Math.floor(n * 0.2)));

type Move = { week: string; from: number; to: number; rank: number; of: number; xp: number };
const parseMove = (s: string | null): Move | null => { try { return s ? (JSON.parse(s) as Move) : null; } catch { return null; } };

async function weeklyXp(prisma: PrismaClient, subjectId: string, from: Date, to: Date): Promise<Map<string, number>> {
  const rows = await prisma.xpEvent.groupBy({ by: ["userId"], where: { subjectId, createdAt: { gte: from, lt: to } }, _sum: { amount: true } });
  return new Map(rows.map((r) => [r.userId, r._sum.amount ?? 0]));
}

/** Clôture les semaines écoulées (une seule fois par semaine et par matière, même en cas d'appels simultanés). */
export async function settleLeagues(prisma: PrismaClient, subjectId: string, timezone: string, now = new Date()): Promise<void> {
  const thisWeek = startOfPeriod("week", now, timezone);
  const prevStart = (d: Date) => startOfPeriod("week", new Date(d.getTime() - 1), timezone);
  const last = await prisma.leagueWeek.findFirst({ where: { subjectId }, orderBy: { weekKey: "desc" } });
  const todo: Date[] = [];
  if (!last) {
    // Première visite : la ligue démarre maintenant, la semaine passée est simplement marquée comme close.
    const w = prevStart(thisWeek);
    try { await prisma.leagueWeek.create({ data: { subjectId, weekKey: localDayKey(w, timezone) } }); } catch { /* déjà fait */ }
    return;
  }
  for (let w = prevStart(thisWeek), i = 0; localDayKey(w, timezone) > last.weekKey && i < MAX_CATCHUP_WEEKS; w = prevStart(w), i++) todo.unshift(w);
  for (const start of todo) {
    const key = localDayKey(start, timezone);
    const weekEnd = startOfPeriod("week", new Date(start.getTime() + 7.5 * 86_400_000), timezone);
    try { await prisma.leagueWeek.create({ data: { subjectId, weekKey: key } }); } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue; // un autre appel s'en occupe
      throw e;
    }
    const [members, xp] = await Promise.all([
      prisma.leagueMember.findMany({ where: { subjectId } }),
      weeklyXp(prisma, subjectId, start, weekEnd),
    ]);
    const active = await prisma.membership.findMany({ where: { subjectId, revokedAt: null, user: { bannedAt: null, role: "USER" } }, select: { userId: true } });
    const activeIds = new Set(active.map((a) => a.userId));
    for (let tier = 0; tier < TIERS.length; tier++) {
      const group = members.filter((m) => m.tier === tier && activeIds.has(m.userId) && (xp.get(m.userId) ?? 0) > 0).sort((a, b) => (xp.get(b.userId) ?? 0) - (xp.get(a.userId) ?? 0) || a.userId.localeCompare(b.userId));
      const z = zoneSize(group.length);
      for (let i = 0; i < group.length; i++) {
        const to = i < z && tier < TIERS.length - 1 ? tier + 1 : i >= group.length - z && z > 0 && tier > 0 ? tier - 1 : tier;
        const move: Move = { week: key, from: tier, to, rank: i + 1, of: group.length, xp: xp.get(group[i].userId) ?? 0 };
        await prisma.leagueMember.update({ where: { id: group[i].id }, data: { tier: to, lastMove: JSON.stringify(move) } });
      }
    }
  }
}

export function registerLeagueRoutes(app: FastifyInstance, { prisma, auth, timezone }: Deps): void {
  app.get<{ Params: { id: string } }>("/api/subjects/:id/league", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id, ctx.user.role);
    const subjectId = req.params.id;
    await settleLeagues(prisma, subjectId, timezone);
    // Tous les membres actifs ont une ligue (Bronze au départ).
    const active = await prisma.membership.findMany({ where: { subjectId, revokedAt: null, user: { bannedAt: null, role: "USER" } }, select: { userId: true, xp: true } });
    await prisma.leagueMember.createMany({ data: active.map((a) => ({ userId: a.userId, subjectId })), skipDuplicates: true });
    const me = await prisma.leagueMember.findUniqueOrThrow({ where: { userId_subjectId: { userId: ctx.user.id, subjectId } } });
    const now = new Date();
    const weekStart = startOfPeriod("week", now, timezone);
    const nextStart = startOfPeriod("week", new Date(weekStart.getTime() + 7.5 * 86_400_000), timezone);
    const [group, xp] = await Promise.all([
      prisma.leagueMember.findMany({ where: { subjectId, tier: me.tier, userId: { in: active.map((a) => a.userId) } }, include: { user: { select: { id: true, username: true, avatar: true } } } }),
      weeklyXp(prisma, subjectId, weekStart, nextStart),
    ]);
    const ranked = group.map((g) => ({ g, xp: xp.get(g.userId) ?? 0 })).sort((a, b) => b.xp - a.xp || a.g.userId.localeCompare(b.g.userId));
    const playing = ranked.filter((r) => r.xp > 0).length;
    const z = zoneSize(playing);
    const standings = ranked.map((r, i) => ({
      rank: i + 1, userId: r.g.userId, username: r.g.user.username, avatar: (() => { try { return JSON.parse(r.g.user.avatar); } catch { return null; } })(), xp: r.xp, mine: r.g.userId === ctx.user.id,
      zone: r.xp <= 0 ? null : i < z && me.tier < TIERS.length - 1 ? "up" : i >= playing - z && z > 0 && me.tier > 0 ? "down" : null,
    }));
    const mineIdx = standings.findIndex((s) => s.mine);
    const shown = standings.slice(0, 30);
    if (mineIdx >= 30) shown.push(standings[mineIdx]);
    const lastMove = parseMove(me.lastMove);
    return {
      tier: me.tier, tierName: TIERS[me.tier], tiers: TIERS, weekStart: localDayKey(weekStart, timezone), endsAt: nextStart.toISOString(),
      participants: playing, zone: z, myRank: mineIdx + 1, myXp: standings[mineIdx]?.xp ?? 0, standings: shown,
      lastMove: lastMove ? { ...lastMove, fromName: TIERS[lastMove.from], toName: TIERS[lastMove.to], result: lastMove.to > lastMove.from ? "UP" : lastMove.to < lastMove.from ? "DOWN" : "STAY" } : null,
    };
  });
}
