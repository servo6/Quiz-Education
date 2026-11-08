import type { Prisma, PrismaClient } from "@prisma/client";

/** Boutique : thèmes et animations achetables avec les pièces gagnées en salon (en plus du déblocage par niveau). */
export const SHOP = [
  { id: "aurora", type: "theme", price: 300 },
  { id: "neon", type: "theme", price: 600 },
  { id: "goldblack", type: "theme", price: 1000 },
  { id: "stars", type: "effect", price: 200 },
  { id: "fireworks", type: "effect", price: 400 },
] as const;

export async function coinBalance(db: PrismaClient | Prisma.TransactionClient, userId: string): Promise<number> {
  const r = await db.coinLedger.aggregate({ where: { userId }, _sum: { amount: true } });
  return r._sum.amount ?? 0;
}
