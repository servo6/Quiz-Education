import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { assertCan } from "../permissions.ts";
import type { Actor } from "../permissions.ts";
import { loadSubject } from "../access.ts";

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

const validTheme = (v: unknown): string | null => (typeof v === "string" && (THEMES as readonly string[]).includes(v) ? v : null);
const orgKey = (id: string) => `ui.theme:org:${id}`;
const subjectKey = (id: string) => `ui.theme:subject:${id}`;

async function readKeys(prisma: Deps["prisma"], keys: string[]): Promise<Map<string, string>> {
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
  const out = new Map<string, string>();
  for (const r of rows) {
    try { const v = validTheme(JSON.parse(r.value)); if (v) out.set(r.key, v); } catch { /* ignoré */ }
  }
  return out;
}

/** Thème par défaut propre à l'utilisateur : celui de sa matière active, sinon de son organisation ; null = celui de la plateforme. */
export async function defaultTheme(prisma: Deps["prisma"], user: { id: string; role: string; activeSubjectId: string | null }, actor: Actor): Promise<string | null> {
  if (user.role === "ADMIN") return null;
  let subjectId: string | null = null;
  let orgId: string | null = null;
  if (user.role === "ORG_ADMIN") orgId = [...(actor.adminOrgIds ?? [])][0] ?? null;
  else {
    subjectId = user.activeSubjectId;
    if (user.role === "SUBJECT_MANAGER" && (!subjectId || !actor.managedSubjectIds.has(subjectId))) subjectId = [...actor.managedSubjectIds][0] ?? null;
    if (subjectId) orgId = (await prisma.subject.findUnique({ where: { id: subjectId }, select: { organizationId: true } }))?.organizationId ?? null;
  }
  const keys = [subjectId ? subjectKey(subjectId) : null, orgId ? orgKey(orgId) : null].filter((k): k is string => !!k);
  if (!keys.length) return null;
  const found = await readKeys(prisma, keys);
  return (subjectId && found.get(subjectKey(subjectId))) || (orgId && found.get(orgKey(orgId))) || null;
}

export function registerScopedThemeRoutes(app: FastifyInstance, { prisma, auth }: Deps): void {
  const ScopeBody = z.object({ theme: z.enum(THEMES).nullable() }).strict();

  // Apparence par défaut d'une organisation (admin d'organisation) ou d'une matière (responsable)
  app.get<{ Params: { scope: string; id: string } }>("/api/theme/:scope/:id", async (req) => {
    const ctx = await auth(req);
    const { scope, id } = req.params;
    if (scope === "organization") assertCan(ctx.actor, "org:manage", id);
    else if (scope === "subject") { const s = await loadSubject(prisma, id); assertCan(ctx.actor, "subject:settings", s.id); }
    else throw new HttpError(404, "not_found", "Introuvable");
    const key = scope === "organization" ? orgKey(id) : subjectKey(id);
    return { theme: (await readKeys(prisma, [key])).get(key) ?? null };
  });

  app.put<{ Params: { scope: string; id: string } }>("/api/theme/:scope/:id", async (req) => {
    const ctx = await auth(req);
    const { scope, id } = req.params;
    let subjectId: string | null = null;
    if (scope === "organization") {
      assertCan(ctx.actor, "org:manage", id);
      if (!(await prisma.organization.findUnique({ where: { id } }))) throw new HttpError(404, "organization_not_found", "Organisation introuvable");
    } else if (scope === "subject") {
      const s = await loadSubject(prisma, id);
      assertCan(ctx.actor, "subject:settings", s.id);
      subjectId = s.id;
    } else throw new HttpError(404, "not_found", "Introuvable");
    const { theme } = ScopeBody.parse(req.body);
    const key = scope === "organization" ? orgKey(id) : subjectKey(id);
    if (theme === null) await prisma.setting.deleteMany({ where: { key } });
    else await prisma.setting.upsert({ where: { key }, create: { key, value: JSON.stringify(theme) }, update: { value: JSON.stringify(theme) } });
    await logAction(prisma, ctx.user.id, subjectId, "UPDATE_THEME", { scope, theme });
    return { theme };
  });
}
