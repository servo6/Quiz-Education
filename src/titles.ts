import type { PrismaClient } from "@prisma/client";

export interface TierDef {
  name: string;
  minLevel: number;
  color: string;
}

/** Titres par défaut, utilisés tant que l'administrateur n'en a pas défini. */
export const DEFAULT_TIERS: readonly TierDef[] = [
  { name: "Novice", minLevel: 1, color: "#9CA3AF" },
  { name: "Apprenti", minLevel: 5, color: "#22C55E" },
  { name: "Initié", minLevel: 10, color: "#3B82F6" },
  { name: "Confirmé", minLevel: 20, color: "#8B5CF6" },
  { name: "Expert", minLevel: 30, color: "#F59E0B" },
  { name: "Maître", minLevel: 40, color: "#EF4444" },
  { name: "Légende", minLevel: 50, color: "#EC4899" },
];

/** Titre d'un niveau : le palier le plus élevé dont le niveau minimum est atteint. */
export function titleFor(level: number, tiers: readonly TierDef[]): TierDef {
  const sorted = [...tiers].sort((a, b) => a.minLevel - b.minLevel);
  let found = sorted[0] ?? DEFAULT_TIERS[0];
  for (const t of sorted) if (t.minLevel <= level) found = t;
  return found;
}

/** Titres d'une matière : les siens s'il y en a, sinon les titres globaux, sinon ceux par défaut. */
export async function loadTiers(prisma: PrismaClient, subjectId?: string): Promise<{ tiers: TierDef[]; source: "subject" | "global" | "default" }> {
  const read = async (id: string | null) =>
    (await prisma.tier.findMany({ where: { subjectId: id }, orderBy: { minLevel: "asc" } })).map((t) => ({ name: t.name, minLevel: t.minLevel, color: t.color }));
  if (subjectId) {
    const own = await read(subjectId);
    if (own.length) return { tiers: own, source: "subject" };
  }
  const global = await read(null);
  if (global.length) return { tiers: global, source: "global" };
  return { tiers: [...DEFAULT_TIERS], source: "default" };
}
