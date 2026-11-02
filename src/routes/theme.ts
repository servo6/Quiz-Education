import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { assertCan } from "../permissions.ts";

/** Identifiants des thèmes de l'interface (les styles sont dans public/css/themes.css). */
export const THEMES = ["graphite", "porcelain", "paper", "midnight", "mono", "emerald", "azure", "aubergine", "nord", "sepia", "royal", "ruby", "contrast"] as const;
export const DEFAULT_THEME = "graphite";

const ThemeBody = z
  .object({ theme: z.enum(THEMES).optional(), allowUserChoice: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "Aucune modification demandée");

async function readTheme(prisma: Deps["prisma"]) {
  const rows = await prisma.setting.findMany({ where: { key: { in: ["ui.theme", "ui.allowUserChoice"] } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const parse = <T>(k: string, fallback: T): T => {
    try {
      const v = map.get(k);
      return v === undefined ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  };
  const theme = parse<string>("ui.theme", DEFAULT_THEME);
  return {
    theme: (THEMES as readonly string[]).includes(theme) ? theme : DEFAULT_THEME,
    allowUserChoice: parse<boolean>("ui.allowUserChoice", true),
    themes: THEMES,
  };
}

export function registerThemeRoutes(app: FastifyInstance, { prisma, auth }: Deps): void {
  // Public : la page de connexion doit déjà avoir le bon thème.
  app.get("/api/theme", async () => readTheme(prisma));

  app.put("/api/admin/theme", async (req) => {
    const ctx = await auth(req);
    assertCan(ctx.actor, "settings:global");
    const body = ThemeBody.parse(req.body);
    for (const [key, value] of [["ui.theme", body.theme], ["ui.allowUserChoice", body.allowUserChoice]] as const) {
      if (value === undefined) continue;
      await prisma.setting.upsert({ where: { key }, create: { key, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } });
    }
    await logAction(prisma, ctx.user.id, null, "UPDATE_THEME", body);
    return readTheme(prisma);
  });
}
