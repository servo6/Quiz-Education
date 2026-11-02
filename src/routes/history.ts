import type { FastifyInstance } from "fastify";
import type { Deps } from "../auth.ts";
import { requireMembership } from "../access.ts";
import { HttpError } from "../http.ts";

/**
 * Historique des parties d'un joueur. « Supprimer » retire la partie de SON historique : les statistiques, les séries et
 * l'XP déjà gagnés restent acquis, et l'adversaire d'un duel garde la sienne. Seules les parties terminées peuvent être retirées.
 */
export function registerHistoryRoutes(app: FastifyInstance, { prisma, auth }: Deps): void {
  // ── Parties solo terminées (les plus récentes d'abord)
  app.get<{ Params: { id: string } }>("/api/subjects/:id/solo/history", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id, ctx.user.role);
    const games = await prisma.game.findMany({
      where: { mode: "SOLO", subjectId: req.params.id, status: { not: "IN_PROGRESS" }, players: { some: { userId: ctx.user.id, hiddenAt: null } } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { players: { where: { userId: ctx.user.id } }, rounds: { include: { chapter: { select: { id: true, name: true, color: true } } } } },
    });
    return {
      games: games.map((g) => {
        let total = 0;
        try { total = (JSON.parse(g.config) as { totalQuestions?: number }).totalQuestions ?? 0; } catch { /* config illisible */ }
        return {
          id: g.id,
          status: g.status,
          chapter: g.rounds[0]?.chapter ?? null,
          correct: g.players[0]?.correctCount ?? 0,
          total,
          xp: g.players[0]?.xpEarned ?? 0,
          at: g.finishedAt ?? g.createdAt,
        };
      }),
    };
  });

  // ── Retirer une partie terminée de mon historique
  app.delete<{ Params: { id: string } }>("/api/games/:id", async (req) => {
    const ctx = await auth(req);
    const mine = await prisma.gamePlayer.findUnique({
      where: { gameId_userId: { gameId: req.params.id, userId: ctx.user.id } },
      include: { game: { select: { status: true } } },
    });
    if (!mine) throw new HttpError(404, "game_not_found", "Partie introuvable");
    if (mine.game.status === "IN_PROGRESS") throw new HttpError(409, "game_in_progress", "Une partie en cours ne peut pas être supprimée");
    await prisma.gamePlayer.update({ where: { id: mine.id }, data: { hiddenAt: new Date() } });
    return { ok: true };
  });

  // ── Vider tout l'historique d'un type de partie dans une matière
  app.delete<{ Params: { id: string }; Querystring: { mode?: string } }>("/api/subjects/:id/history", async (req) => {
    const ctx = await auth(req);
    await requireMembership(prisma, ctx.user.id, req.params.id, ctx.user.role);
    const mode = req.query.mode === "duel" ? "DUEL" : req.query.mode === "solo" ? "SOLO" : null;
    if (!mode) throw new HttpError(400, "invalid_mode", "mode doit valoir solo ou duel");
    const r = await prisma.gamePlayer.updateMany({
      where: { userId: ctx.user.id, hiddenAt: null, game: { subjectId: req.params.id, mode, status: { not: "IN_PROGRESS" } } },
      data: { hiddenAt: new Date() },
    });
    return { removed: r.count };
  });
}
