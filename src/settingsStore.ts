import type { PrismaClient } from "@prisma/client";
import { mergeSettings, parseStoredSettings, type Settings } from "./settings.ts";

/** Paramètres globaux enregistrés (table Setting), sans les valeurs par défaut. */
let globalCache: { at: number; value: Partial<Settings> } | null = null;
/** À appeler après toute écriture dans la table Setting. */
export function invalidateSettings(): void {
  globalCache = null;
  orgCache.clear();
}

/** Réglages propres à une organisation (clé « org:<id> » de la table Setting). */
const orgCache = new Map<string, { at: number; value: Partial<Settings> }>();
export async function loadOrgSettings(prisma: PrismaClient, organizationId: string | null | undefined): Promise<Partial<Settings>> {
  if (!organizationId) return {};
  const hit = orgCache.get(organizationId);
  if (hit && Date.now() - hit.at < 15_000) return hit.value;
  const row = await prisma.setting.findUnique({ where: { key: `org:${organizationId}` } });
  const value = parseStoredSettings(row?.value);
  orgCache.set(organizationId, { at: Date.now(), value });
  return value;
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

/** Paramètres effectifs d'une matière : défauts < globaux < organisation < surcharges de la matière. */
export async function loadEffectiveSettings(prisma: PrismaClient, subjectSettingsJson: string, organizationId?: string | null): Promise<Settings> {
  const [g, o] = await Promise.all([loadGlobalSettings(prisma), loadOrgSettings(prisma, organizationId)]);
  return mergeSettings({ ...g, ...o }, parseStoredSettings(subjectSettingsJson));
}
