import type { PrismaClient } from "@prisma/client";

export const BADGE_TYPES = ["CORRECT_TOTAL", "PERFECT_SOLO", "FRIENDLY_WINS", "PERFECT_DUEL", "STREAK_DAYS", "SUBJECTS_PLAYED", "FAST_STREAK"] as const;
export type BadgeType = (typeof BADGE_TYPES)[number];

/** Une bonne réponse donnée en moins de ce temps compte pour la série "rapide". */
export const FAST_MS = 5000;

export const DEFAULT_BADGES: ReadonlyArray<{ code: string; name: string; description: string; conditionType: BadgeType; threshold: number; icon: string }> = [
  { code: "correct_10", name: "Échauffement", description: "10 bonnes réponses au total", conditionType: "CORRECT_TOTAL", threshold: 10, icon: "🌱" },
  { code: "correct_100", name: "Centurion", description: "100 bonnes réponses au total", conditionType: "CORRECT_TOTAL", threshold: 100, icon: "💯" },
  { code: "correct_1000", name: "Encyclopédie", description: "1000 bonnes réponses au total", conditionType: "CORRECT_TOTAL", threshold: 1000, icon: "📚" },
  { code: "perfect_solo_1", name: "Sans faute", description: "Une partie solo sans aucune erreur", conditionType: "PERFECT_SOLO", threshold: 1, icon: "🎯" },
  { code: "perfect_solo_10", name: "Perfectionniste", description: "10 parties solo sans faute", conditionType: "PERFECT_SOLO", threshold: 10, icon: "🏅" },
  { code: "wins_1", name: "Première victoire", description: "Gagner un duel", conditionType: "FRIENDLY_WINS", threshold: 1, icon: "⚔️" },
  { code: "wins_10", name: "Duelliste", description: "Gagner 10 duels", conditionType: "FRIENDLY_WINS", threshold: 10, icon: "🤺" },
  { code: "wins_50", name: "Champion", description: "Gagner 50 duels", conditionType: "FRIENDLY_WINS", threshold: 50, icon: "🏆" },
  { code: "perfect_duel_1", name: "Duel parfait", description: "Un duel sans aucune erreur", conditionType: "PERFECT_DUEL", threshold: 1, icon: "✨" },
  { code: "streak_3", name: "Régulier", description: "Jouer 3 jours de suite", conditionType: "STREAK_DAYS", threshold: 3, icon: "🔥" },
  { code: "streak_7", name: "Assidu", description: "Jouer 7 jours de suite", conditionType: "STREAK_DAYS", threshold: 7, icon: "📅" },
  { code: "streak_30", name: "Inébranlable", description: "Jouer 30 jours de suite", conditionType: "STREAK_DAYS", threshold: 30, icon: "🗓️" },
  { code: "subjects_2", name: "Curieux", description: "Jouer dans 2 matières", conditionType: "SUBJECTS_PLAYED", threshold: 2, icon: "🧭" },
  { code: "subjects_5", name: "Touche-à-tout", description: "Jouer dans 5 matières", conditionType: "SUBJECTS_PLAYED", threshold: 5, icon: "🌍" },
  { code: "fast_5", name: "Éclair", description: "5 bonnes réponses d'affilée en moins de 5 secondes", conditionType: "FAST_STREAK", threshold: 5, icon: "⚡" },
  { code: "fast_10", name: "Foudroyant", description: "10 bonnes réponses d'affilée en moins de 5 secondes", conditionType: "FAST_STREAK", threshold: 10, icon: "🌩️" },
];

/** Crée les badges par défaut si aucun n'existe (ne touche jamais à ce que l'administrateur a modifié). */
export async function ensureDefaultBadges(prisma: PrismaClient): Promise<number> {
  if ((await prisma.badge.count()) > 0) return 0;
  const r = await prisma.badge.createMany({ data: DEFAULT_BADGES.map((b) => ({ ...b })), skipDuplicates: true });
  return r.count;
}

/** Plus longue suite de jours consécutifs dans une liste de dates "AAAA-MM-JJ". */
export function longestDayStreak(days: Iterable<string>): number {
  const nums = [...new Set(days)].map((d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000)).sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < nums.length; i++) {
    run = i > 0 && nums[i] === nums[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/** Plus longue série de bonnes réponses rapides consécutives. */
export function longestFastStreak(answers: ReadonlyArray<{ isCorrect: boolean; timeMs: number | null }>): number {
  let best = 0;
  let run = 0;
  for (const a of answers) {
    run = a.isCorrect && a.timeMs !== null && a.timeMs <= FAST_MS ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/** Valeur actuelle de l'utilisateur pour chaque type de condition (calculée seulement quand elle est demandée). */
export function badgeStats(prisma: PrismaClient, userId: string, timezone: string): Record<BadgeType, () => Promise<number>> {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const duelGames = { game: { mode: { in: ["FRIENDLY", "DUEL"] }, status: "FINISHED" } };
  return {
    CORRECT_TOTAL: () => prisma.answer.count({ where: { userId, isCorrect: true } }),
    PERFECT_SOLO: async () => {
      const rows = await prisma.gamePlayer.findMany({
        where: { userId, game: { mode: "SOLO", status: "FINISHED" } },
        select: { correctCount: true, game: { select: { _count: { select: { questions: true } } } } },
      });
      return rows.filter((r) => r.game._count.questions > 0 && r.correctCount === r.game._count.questions).length;
    },
    FRIENDLY_WINS: () => prisma.gamePlayer.count({ where: { userId, result: "WIN", ...duelGames } }),
    PERFECT_DUEL: async () => {
      const rows = await prisma.gamePlayer.findMany({
        where: { userId, ...duelGames },
        select: { correctCount: true, game: { select: { _count: { select: { questions: true } } } } },
      });
      return rows.filter((r) => r.game._count.questions > 0 && r.correctCount === r.game._count.questions).length;
    },
    STREAK_DAYS: async () => {
      const rows = await prisma.answer.findMany({ where: { userId }, select: { answeredAt: true }, orderBy: { answeredAt: "desc" }, take: 50_000 });
      return longestDayStreak(rows.map((r) => fmt.format(r.answeredAt)));
    },
    SUBJECTS_PLAYED: async () => {
      const rows = await prisma.gamePlayer.findMany({ where: { userId }, select: { game: { select: { subjectId: true } } } });
      return new Set(rows.map((r) => r.game.subjectId)).size;
    },
    FAST_STREAK: async () => {
      const rows = await prisma.answer.findMany({ where: { userId }, select: { isCorrect: true, timeMs: true }, orderBy: { answeredAt: "asc" }, take: 20_000 });
      return longestFastStreak(rows);
    },
  };
}

export interface BadgeProgress {
  id: string;
  code: string;
  name: string;
  description: string;
  icon: string;
  conditionType: string;
  threshold: number;
  current: number;
  earned: boolean;
  earnedAt: Date | null;
}

/**
 * Attribue les badges dont la condition est remplie. Renvoie la progression de chaque badge et ceux gagnés à l'instant.
 * Idempotent : un badge n'est jamais attribué deux fois.
 */
export async function evaluateBadges(prisma: PrismaClient, userId: string, timezone: string): Promise<{ progress: BadgeProgress[]; newlyEarned: BadgeProgress[] }> {
  const [badges, owned] = await Promise.all([
    prisma.badge.findMany({ orderBy: [{ conditionType: "asc" }, { threshold: "asc" }] }),
    prisma.userBadge.findMany({ where: { userId } }),
  ]);
  const ownedAt = new Map(owned.map((o) => [o.badgeId, o.earnedAt]));
  const stats = badgeStats(prisma, userId, timezone);
  const cache = new Map<string, number>();
  const value = async (type: string) => {
    if (!cache.has(type)) cache.set(type, type in stats ? await stats[type as BadgeType]() : 0);
    return cache.get(type)!;
  };

  const progress: BadgeProgress[] = [];
  const newlyEarned: BadgeProgress[] = [];
  for (const b of badges) {
    const earnedAt = ownedAt.get(b.id) ?? null;
    const current = earnedAt ? Math.max(b.threshold, 0) : await value(b.conditionType);
    const row: BadgeProgress = { id: b.id, code: b.code, name: b.name, description: b.description, icon: b.icon, conditionType: b.conditionType, threshold: b.threshold, current: Math.min(current, b.threshold), earned: !!earnedAt, earnedAt };
    if (!earnedAt && current >= b.threshold) {
      const created = await prisma.userBadge.createMany({ data: [{ userId, badgeId: b.id }], skipDuplicates: true });
      if (created.count > 0) {
        row.earned = true;
        row.earnedAt = new Date();
        newlyEarned.push(row);
      }
    }
    progress.push(row);
  }
  return { progress, newlyEarned };
}

/** Pour les routes de jeu : une erreur de calcul des badges ne doit jamais faire échouer une réponse. */
export async function newBadgesSafe(prisma: PrismaClient, userId: string, timezone: string) {
  try {
    return (await evaluateBadges(prisma, userId, timezone)).newlyEarned.map(({ code, name, description, icon }) => ({ code, name, description, icon }));
  } catch {
    return [];
  }
}
