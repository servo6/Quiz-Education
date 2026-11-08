import type { PrismaClient } from "@prisma/client";
import { loadTiers } from "./titles.ts";
import { loadEffectiveSettings } from "./settingsStore.ts";
import { levelFromXp } from "./xp.ts";

export const AVATAR_CATEGORIES = ["hair", "face", "outfit", "glasses", "hat", "background", "frame"] as const;
export type AvatarCategory = (typeof AVATAR_CATEGORIES)[number];
export const UNLOCK_TYPES = ["FREE", "LEVEL", "BADGE", "TIER"] as const;

export interface AvatarData {
  items: Partial<Record<AvatarCategory, string>>; // catégorie → id d'objet
  colors: Record<string, string>; // ex. { skin: "#f2c9a0", hair: "#3b2a1a" }
  look: Record<string, string>; // choix de forme de l'avatar détaillé : { face: "oval", hair: "waves", … }
}

const HEX = /^#[0-9a-fA-F]{6}$/;
export const LOOK_KEY = /^[a-z]{2,16}$/;
export const LOOK_VALUE = /^[a-z0-9-]{1,24}$/;
export const LOOK_MAX_KEYS = 30;

/** Options de l'avatar détaillé réservées : « clé:valeur » → condition de déblocage (mêmes règles que les objets du catalogue). */
export const LOOK_LOCKS: Record<string, { unlockType: string; unlockValue: string | null }> = {
  "headwear:cap": { unlockType: "LEVEL", unlockValue: "3" },
  "glasses:round": { unlockType: "LEVEL", unlockValue: "5" },
  "headwear:headphones": { unlockType: "LEVEL", unlockValue: "6" },
  "glasses:shades": { unlockType: "LEVEL", unlockValue: "8" },
  "glasses:aviator": { unlockType: "LEVEL", unlockValue: "8" },
  "hair:mohawk": { unlockType: "LEVEL", unlockValue: "10" },
  "headwear:gradcap": { unlockType: "LEVEL", unlockValue: "12" },
  "outfit:suit": { unlockType: "LEVEL", unlockValue: "15" },
  "bg:aurora": { unlockType: "LEVEL", unlockValue: "20" },
  "outfit:blouse": { unlockType: "TIER", unlockValue: "Expert" },
  "headwear:crown": { unlockType: "BADGE", unlockValue: "wins_50" },
};

/** Lit l'avatar stocké ; tout ce qui est invalide est ignoré. */
export function parseAvatar(json: string | null | undefined): AvatarData {
  const out: AvatarData = { items: {}, colors: {}, look: {} };
  try {
    const raw = JSON.parse(json || "{}") as { items?: Record<string, unknown>; colors?: Record<string, unknown>; look?: Record<string, unknown> };
    for (const c of AVATAR_CATEGORIES) if (typeof raw.items?.[c] === "string") out.items[c] = raw.items[c] as string;
    for (const [k, v] of Object.entries(raw.colors ?? {})) if (typeof v === "string" && HEX.test(v)) out.colors[k] = v;
    for (const [k, v] of Object.entries(raw.look ?? {}).slice(0, LOOK_MAX_KEYS)) if (LOOK_KEY.test(k) && typeof v === "string" && LOOK_VALUE.test(v)) out.look[k] = v;
  } catch {
    /* avatar vide */
  }
  return out;
}

const free = (category: AvatarCategory, name: string) => ({ category, name, assetPath: `avatars/${category}/${name.toLowerCase().replace(/\s+/g, "-")}.svg`, unlockType: "FREE", unlockValue: null as string | null });
const gated = (category: AvatarCategory, name: string, unlockType: string, unlockValue: string) => ({ ...free(category, name), unlockType, unlockValue });

/** Catalogue de départ ; les fichiers graphiques correspondants seront fournis avec l'interface. */
export const DEFAULT_AVATAR_ITEMS = [
  free("hair", "Courts"), free("hair", "Longs"), free("hair", "Bouclés"), gated("hair", "Crête", "LEVEL", "10"),
  free("face", "Sourire"), free("face", "Sérieux"), gated("face", "Lunettes rondes", "LEVEL", "5"),
  free("outfit", "T-shirt"), free("outfit", "Sweat"), gated("outfit", "Costume", "LEVEL", "15"), gated("outfit", "Blouse", "TIER", "Expert"),
  free("glasses", "Aucune"), gated("glasses", "Soleil", "LEVEL", "8"),
  free("hat", "Aucun"), gated("hat", "Casquette", "LEVEL", "3"), gated("hat", "Couronne", "BADGE", "wins_50"),
  free("background", "Bleu"), free("background", "Vert"), gated("background", "Galaxie", "LEVEL", "25"),
  free("frame", "Simple"), gated("frame", "Or", "BADGE", "correct_1000"), gated("frame", "Légende", "TIER", "Légende"),
];

export async function ensureDefaultAvatarItems(prisma: PrismaClient): Promise<number> {
  if ((await prisma.avatarItem.count()) > 0) return 0;
  return (await prisma.avatarItem.createMany({ data: DEFAULT_AVATAR_ITEMS.map((i) => ({ ...i })) })).count;
}

export interface UnlockContext {
  /** Comptes de gestion : toutes les personnalisations, sans condition. */
  all?: boolean;
  maxLevel: number;
  badgeCodes: Set<string>;
  tiers: Array<{ name: string; minLevel: number }>;
}

/** Niveau le plus haut atteint dans les matières de l'utilisateur, ses badges et les titres globaux. */
export async function unlockContext(prisma: PrismaClient, userId: string, all = false): Promise<UnlockContext> {
  if (all) return { all: true, maxLevel: Number.MAX_SAFE_INTEGER, badgeCodes: new Set(), tiers: [] };
  const [memberships, badges, { tiers }] = await Promise.all([
    prisma.membership.findMany({ where: { userId, revokedAt: null }, include: { subject: { select: { settings: true, organizationId: true } } } }),
    prisma.userBadge.findMany({ where: { userId }, include: { badge: { select: { code: true } } } }),
    loadTiers(prisma),
  ]);
  let maxLevel = 1;
  for (const m of memberships) {
    const s = await loadEffectiveSettings(prisma, m.subject.settings, m.subject.organizationId);
    maxLevel = Math.max(maxLevel, levelFromXp(m.xp, { base: s.levelBase, exponent: s.levelExponent }).level);
  }
  return { maxLevel, badgeCodes: new Set(badges.map((b) => b.badge.code)), tiers };
}

/** `null` si l'objet est utilisable, sinon la raison du verrouillage. */
export function lockReason(item: { unlockType: string; unlockValue: string | null }, ctx: UnlockContext): string | null {
  if (ctx.all) return null;
  switch (item.unlockType) {
    case "FREE":
      return null;
    case "LEVEL": {
      const need = Number(item.unlockValue);
      return ctx.maxLevel >= need ? null : `Niveau ${need} requis`;
    }
    case "BADGE":
      return item.unlockValue && ctx.badgeCodes.has(item.unlockValue) ? null : `Badge « ${item.unlockValue} » requis`;
    case "TIER": {
      const tier = ctx.tiers.find((t) => t.name === item.unlockValue);
      return tier && ctx.maxLevel >= tier.minLevel ? null : `Titre « ${item.unlockValue} » requis`;
    }
    default:
      return "Objet indisponible";
  }
}

export type LookLocks = Record<string, { unlockType: string; unlockValue: string | null }>;
const LOCKS_KEY = "avatar.lookLocks";

/** Règles de déblocage des options de l'avatar détaillé : celles de l'administrateur, sinon celles d'origine. */
export async function loadLookLocks(prisma: PrismaClient): Promise<LookLocks> {
  const row = await prisma.setting.findUnique({ where: { key: LOCKS_KEY } });
  if (!row) return LOOK_LOCKS;
  try {
    const raw = JSON.parse(row.value) as LookLocks;
    const out: LookLocks = {};
    for (const [k, v] of Object.entries(raw)) if (v && (UNLOCK_TYPES as readonly string[]).includes(v.unlockType) && v.unlockType !== "FREE") out[k] = { unlockType: v.unlockType, unlockValue: v.unlockValue ?? null };
    return out;
  } catch { return LOOK_LOCKS; }
}
export async function saveLookLocks(prisma: PrismaClient, locks: LookLocks | null): Promise<void> {
  if (locks === null) { await prisma.setting.deleteMany({ where: { key: LOCKS_KEY } }); return; }
  const value = JSON.stringify(locks);
  await prisma.setting.upsert({ where: { key: LOCKS_KEY }, create: { key: LOCKS_KEY, value }, update: { value } });
}

/** Options de l'avatar détaillé encore verrouillées pour cet utilisateur : « clé:valeur » → raison. */
export function lockedLook(ctx: UnlockContext, locks: LookLocks = LOOK_LOCKS): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, rule] of Object.entries(locks)) {
    const reason = lockReason(rule, ctx);
    if (reason) out[key] = reason;
  }
  return out;
}
