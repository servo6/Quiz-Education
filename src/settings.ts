import { z } from "zod";
import { XP_DEFAULTS } from "./xp.ts";

/** Paramètres de jeu. Valeurs globales (table Setting), surchargeables par matière (Subject.settings). */
export const SettingsSchema = z
  .object({
    timePerQuestionSec: z.number().int().min(0).max(600), // 0 = pas de limite de temps
    soloQuestions: z.number().int().min(1).max(100),
    soloGamesPerDay: z.number().int().min(0).max(1000), // 0 = illimité
    roundsPerDuel: z.number().int().min(1).max(10),
    questionsPerRound: z.number().int().min(1).max(10),
    // Duels en direct (synchrones) : réglages indépendants du solo et des duels différés.
    liveTimePerQuestionSec: z.number().int().min(0).max(600), // 0 = pas de limite de temps
    liveRoundsPerDuel: z.number().int().min(1).max(10),
    liveQuestionsPerRound: z.number().int().min(1).max(10),
    reconnectSec: z.number().int().min(0).max(300),
    chapterPickSec: z.number().int().min(5).max(120), // temps pour choisir le chapitre d'une manche en duel
    maxActiveDuels: z.number().int().min(0).max(100), // duels différés en cours par joueur et par matière (0 = illimité)
    shuffleChoices: z.boolean(), // mélange l'ordre des choix, différemment pour chaque joueur
    duelDeadlineDays: z.number().int().min(1).max(30), // durée maximale d'un duel différé
    // Modes solo : aventure (réglages ci-dessus), survie (cœurs) et course contre la montre (chrono global).
    adventureEnabled: z.boolean(),
    survivalEnabled: z.boolean(),
    survivalHearts: z.number().int().min(1).max(10),
    survivalQuestions: z.number().int().min(1).max(100),
    survivalTimePerQuestionSec: z.number().int().min(0).max(600), // 0 = pas de limite de temps
    survivalXpPerCorrect: z.number().int().min(0).max(1000),
    attackEnabled: z.boolean(),
    attackDurationSec: z.number().int().min(10).max(3600),
    attackMaxQuestions: z.number().int().min(5).max(200),
    attackXpPerCorrect: z.number().int().min(0).max(1000),
    xpPerCorrect: z.number().int().min(0).max(1000),
    friendlyWinBonus: z.number().int().min(0).max(10000),
    friendlyDrawBonus: z.number().int().min(0).max(10000),
    levelBase: z.number().int().min(1).max(100000),
    levelExponent: z.number().min(1).max(3),
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  timePerQuestionSec: 20,
  soloQuestions: 10,
  soloGamesPerDay: 5,
  roundsPerDuel: 4,
  questionsPerRound: 4,
  liveTimePerQuestionSec: 20,
  liveRoundsPerDuel: 4,
  liveQuestionsPerRound: 4,
  reconnectSec: 30,
  chapterPickSec: 20,
  duelDeadlineDays: 3,
  maxActiveDuels: 10,
  shuffleChoices: false,
  adventureEnabled: true,
  survivalEnabled: true,
  survivalHearts: 3,
  survivalQuestions: 15,
  survivalTimePerQuestionSec: 20,
  survivalXpPerCorrect: XP_DEFAULTS.perCorrectAnswer,
  attackEnabled: true,
  attackDurationSec: 180,
  attackMaxQuestions: 100,
  attackXpPerCorrect: XP_DEFAULTS.perCorrectAnswer,
  xpPerCorrect: XP_DEFAULTS.perCorrectAnswer,
  friendlyWinBonus: XP_DEFAULTS.friendlyWinBonus,
  friendlyDrawBonus: XP_DEFAULTS.friendlyDrawBonus,
  levelBase: XP_DEFAULTS.levelBase,
  levelExponent: XP_DEFAULTS.levelExponent,
};

export const PartialSettingsSchema = SettingsSchema.partial();

/** Pour les modifications : `null` supprime la surcharge d'un paramètre. */
export const SettingsPatchSchema = z
  .object(
    Object.fromEntries(Object.entries(SettingsSchema.shape).map(([k, v]) => [k, v.nullable().optional()])) as {
      [K in SettingKey]: z.ZodOptional<z.ZodNullable<(typeof SettingsSchema.shape)[K]>>;
    },
  )
  .strict();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** Lit un JSON stocké ; ignore silencieusement ce qui est invalide plutôt que de planter le serveur. */
export function parseStoredSettings(json: string | null | undefined): Partial<Settings> {
  if (!json) return {};
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const known = Object.fromEntries(Object.entries(raw ?? {}).filter(([k]) => k in SettingsSchema.shape));
    const parsed = PartialSettingsSchema.safeParse(known);
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function applyPatch(current: Partial<Settings>, patch: SettingsPatch): Partial<Settings> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as Partial<Settings>;
}

/** Ordre de priorité : valeurs par défaut < globales < propres à la matière. */
export function mergeSettings(...layers: Array<Partial<Settings> | undefined>): Settings {
  return Object.assign({}, DEFAULT_SETTINGS, ...layers.map((l) => l ?? {})) as Settings;
}
