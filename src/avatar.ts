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
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Lit l'avatar stocké ; tout ce qui est invalide est ignoré. */
export function parseAvatar(json: string | null | undefined): AvatarData {
  const out: AvatarData = { items: {}, colors: {} };
  try {
    const raw = JSON.parse(json || "{}") as { items?: Record<string, unknown>; colors?: Record<string, unknown> };
    for (const c of AVATAR_CATEGORIES) if (typeof raw.items?.[c] === "string") out.items[c] = raw.items[c] as string;
    for (const [k, v] of Object.entries(raw.colors ?? {})) if (typeof v === "string" && HEX.test(v)) out.colors[k] = v;
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
  maxLevel: number;
  badgeCodes: Set<string>;
  tiers: Array<{ name: string; minLevel: number }>;
}

/** Niveau le plus haut atteint dans les matières de l'utilisateur, ses badges et les titres globaux. */
export async function unlockContext(prisma: PrismaClient, userId: string): Promise<UnlockContext> {
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
