import type { PrismaClient } from "@prisma/client";
import { mergeSettings, parseStoredSettings, type Settings } from "./settings.ts";

/** Paramètres globaux enregistrés (table Setting), sans les valeurs par défaut. */
let globalCache: { at: number; value: Partial<Settings> } | null = null;
/** À appeler après toute écriture dans la table Setting. */
export function invalidateSettings(): void {
  globalCache = null;
}

export async function loadGlobalSettings(prisma: PrismaClient): Promise<Partial<Settings>> {
  if (globalCache && Date.now() - globalCache.at < 15_000) return globalCache.value;
  const value = await readGlobalSettings(prisma);
  globalCache = { at: Date.now(), value };
  return value;
}

async function readGlobalSettings(prisma: PrismaClient): Promise<Partial<Settings>> {
  const rows = await prisma.setting.findMany();
  const obj: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      obj[r.key] = JSON.parse(r.value);
    } catch {
      /* valeur illisible : ignorée */
    }
  }
  return parseStoredSettings(JSON.stringify(obj));
}

/** Paramètres effectifs d'une matière : défauts < globaux < surcharges de la matière. */
export async function loadEffectiveSettings(prisma: PrismaClient, subjectSettingsJson: string): Promise<Settings> {
  return mergeSettings(await loadGlobalSettings(prisma), parseStoredSettings(subjectSettingsJson));
}
