/** Gains d'XP par défaut (modifiables dans l'administration). */
export const XP_DEFAULTS = {
  perCorrectAnswer: 10,
  friendlyWinBonus: 40,
  friendlyDrawBonus: 20, // pour chacun des deux joueurs
  levelBase: 100,
  levelExponent: 1.2,
} as const;

export interface LevelConfig {
  base: number;
  exponent: number;
}

const DEFAULT_LEVEL_CONFIG: LevelConfig = {
  base: XP_DEFAULTS.levelBase,
  exponent: XP_DEFAULTS.levelExponent,
};

/** XP nécessaires pour passer du niveau `level` au niveau `level + 1`. */
export function xpToNextLevel(level: number, cfg: LevelConfig = DEFAULT_LEVEL_CONFIG): number {
  return Math.round(cfg.base * Math.pow(level, cfg.exponent));
}

export interface LevelInfo {
  level: number;
  /** XP accumulés dans le niveau en cours. */
  xpIntoLevel: number;
  /** XP à atteindre pour le niveau suivant (taille du niveau en cours). */
  xpForNext: number;
}

/** Le niveau est toujours calculé à partir du total d'XP, jamais stocké. */
export function levelFromXp(totalXp: number, cfg: LevelConfig = DEFAULT_LEVEL_CONFIG): LevelInfo {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXp));
  let needed = xpToNextLevel(level, cfg);
  while (remaining >= needed) {
    remaining -= needed;
    level += 1;
    needed = xpToNextLevel(level, cfg);
  }
  return { level, xpIntoLevel: remaining, xpForNext: needed };
}

export type MatchResult = "WIN" | "DRAW" | "LOSS" | "FORFEIT";

/** XP de fin de duel (hors bonnes réponses, comptées à part). */
export function friendlyResultBonus(result: MatchResult): number {
  switch (result) {
    case "WIN":
      return XP_DEFAULTS.friendlyWinBonus;
    case "DRAW":
      return XP_DEFAULTS.friendlyDrawBonus;
    default:
      return 0;
  }
}
