import type { Prisma } from "@prisma/client";

export type XpSource = "CORRECT_ANSWER" | "FRIENDLY_WIN" | "FRIENDLY_DRAW";

/**
 * Attribue de l'XP dans une matière : journal (XpEvent) et total de l'utilisateur (Membership.xp) dans la même
 * transaction. Seul le serveur appelle cette fonction. Renvoie le nouveau total d'XP dans la matière.
 */
export async function awardXp(
  tx: Prisma.TransactionClient,
  p: { userId: string; subjectId: string; source: XpSource; amount: number; gameId?: string },
): Promise<number> {
  const key = { userId_subjectId: { userId: p.userId, subjectId: p.subjectId } };
  if (p.amount <= 0) {
    const m = await tx.membership.findUniqueOrThrow({ where: key });
    return m.xp;
  }
  await tx.xpEvent.create({
    data: { userId: p.userId, subjectId: p.subjectId, source: p.source, amount: p.amount, gameId: p.gameId ?? null },
  });
  const m = await tx.membership.update({ where: key, data: { xp: { increment: p.amount } } });
  return m.xp;
}
