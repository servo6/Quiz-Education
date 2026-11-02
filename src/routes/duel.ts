import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMembership } from "../access.ts";
import type { Deps } from "../auth.ts";
import type { DuelEngine, Hub } from "../duel/engine.ts";
import { loadEffectiveSettings } from "../settingsStore.ts";
import { levelFromXp } from "../xp.ts";

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function registerDuelRoutes(app: FastifyInstance, { prisma, auth }: Deps, engine: DuelEngine, hub: Hub): void {
  // ── Adversaires possibles : uniquement les membres de la même matière
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>("/api/subjects/:id/players", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id);
    const q = z.string().trim().toLowerCase().max(40).catch("").parse(req.query.q ?? "");

    const subject = await prisma.subject.findUniqueOrThrow({ where: { id: req.params.id } });
    const settings = await loadEffectiveSettings(prisma, subject.settings);
    const members = await prisma.membership.findMany({
      where: {
        subjectId: subject.id,
        revokedAt: null,
        userId: { not: ctx.user.id },
        user: { bannedAt: null, role: { not: "ADMIN" }, ...(q ? { username: { contains: q } } : {}) },
      },
      include: { user: { select: { id: true, username: true, avatar: true } } },
      orderBy: { user: { username: "asc" } },
      take: 50,
    });

    return {
      players: members.map((m) => ({
        id: m.user.id,
        username: m.user.username,
        avatar: safeJson(m.user.avatar),
        level: levelFromXp(m.xp, { base: settings.levelBase, exponent: settings.levelExponent }).level,
        online: hub.isOnline(m.user.id),
        busy: engine.isBusy(m.user.id),
      })),
    };
  });
}
