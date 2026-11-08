import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { coinBalance, SHOP } from "../shop.ts";

/** Portefeuille de pièces et boutique de personnalisations. */
export function registerWalletRoutes(app: FastifyInstance, { prisma, auth }: Deps): void {
  app.get("/api/wallet", async (req) => {
    const ctx = await auth(req);
    const [coins, unlocks] = await Promise.all([coinBalance(prisma, ctx.user.id), prisma.itemUnlock.findMany({ where: { userId: ctx.user.id }, select: { itemId: true } })]);
    return { coins, unlocked: unlocks.map((u) => u.itemId), shop: SHOP };
  });

  app.post("/api/shop/buy", async (req) => {
    const ctx = await auth(req);
    const { itemId } = z.object({ itemId: z.string().min(1) }).parse(req.body);
    const item = SHOP.find((i) => i.id === itemId);
    if (!item) throw new HttpError(404, "item_not_found", "Article introuvable");
    return prisma.$transaction(async (tx) => {
      if (await tx.itemUnlock.findUnique({ where: { userId_itemId: { userId: ctx.user.id, itemId } } })) throw new HttpError(409, "already_owned", "Tu possèdes déjà cet article");
      const balance = await coinBalance(tx, ctx.user.id);
      if (balance < item.price) throw new HttpError(402, "not_enough_coins", `Il te manque ${item.price - balance} pièces`);
      await tx.itemUnlock.create({ data: { userId: ctx.user.id, itemId, price: item.price } });
      await tx.coinLedger.create({ data: { userId: ctx.user.id, amount: -item.price, reason: "PURCHASE", refId: itemId } });
      return { coins: balance - item.price, unlocked: itemId };
    }, { isolationLevel: "Serializable" });
  });

  /** Historique des salons du joueur dans la matière. */
  app.get<{ Params: { id: string } }>("/api/subjects/:id/rooms", async (req) => {
    const ctx = await auth(req);
    const rows = await prisma.roomPlayer.findMany({
      where: { userId: ctx.user.id, game: { subjectId: req.params.id } },
      orderBy: { game: { finishedAt: "desc" } }, take: 15,
      include: { game: { select: { code: true, size: true, finishedAt: true, _count: { select: { players: true } } } } },
    });
    return { rooms: rows.map((r) => ({ code: r.game.code, size: r.game.size, finishedAt: r.game.finishedAt, players: r.game._count.players, rank: r.rank, score: r.score, correct: r.correct, xpEarned: r.xpEarned, coinsEarned: r.coinsEarned })) };
  });
}
