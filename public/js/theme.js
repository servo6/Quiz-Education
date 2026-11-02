import { get, put } from "./lib.js";

/** Thèmes disponibles : id, nom affiché et courte description. Les couleurs sont dans css/themes.css. */
export const THEMES = [
  { id: "graphite", name: "Graphite", desc: "Sombre et sobre, accent indigo" },
  { id: "porcelain", name: "Porcelaine", desc: "Clair, bandeau marine, accent violet" },
  { id: "paper", name: "Papier", desc: "Clair et chaleureux, titres à empattement" },
  { id: "midnight", name: "Minuit", desc: "Bleu nuit, accent bleu vif" },
  { id: "mono", name: "Monochrome", desc: "Noir et blanc, très épuré" },
  { id: "emerald", name: "Émeraude", desc: "Sombre, accent vert vif" },
  { id: "azure", name: "Azur", desc: "Clair, bleu institutionnel" },
  { id: "aubergine", name: "Aubergine", desc: "Menu violet profond" },
  { id: "nord", name: "Nord", desc: "Bleu glacier, contrastes doux" },
  { id: "sepia", name: "Sépia", desc: "Papier ivoire, lecture confortable" },
  { id: "royal", name: "Royal", desc: "Bleu marine et or" },
  { id: "ruby", name: "Rubis", desc: "Blanc éclatant, accent rouge" },
  { id: "contrast", name: "Contraste élevé", desc: "Accessibilité maximale" },
];
const ids = new Set(THEMES.map((t) => t.id));
const safe = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
};

export const themeConfig = { theme: "graphite", allowUserChoice: true, ignorePersonal: false };
export const personalTheme = () => { const v = safe.get("qp-theme-own"); return v && ids.has(v) ? v : null; };

/** Thème réellement appliqué : le choix personnel s'il est autorisé, sinon celui de la plateforme. */
export const effectiveTheme = () => (!themeConfig.ignorePersonal && themeConfig.allowUserChoice && personalTheme()) || themeConfig.theme;

export function applyTheme(id = effectiveTheme()) {
  if (!ids.has(id)) id = "graphite";
  document.documentElement.dataset.theme = id;
  safe.set("qp-theme", id);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) { const c = getComputedStyle(document.documentElement).getPropertyValue("--nav-bg").trim(); if (c) meta.content = c; }
}

export async function loadThemeConfig() {
  try {
    const r = await get("/api/theme");
    themeConfig.theme = ids.has(r.theme) ? r.theme : "graphite";
    themeConfig.allowUserChoice = r.allowUserChoice !== false;
  } catch { /* on garde le thème en cache */ }
  applyTheme();
}
export function setPersonalTheme(id) { safe.set("qp-theme-own", id); applyTheme(); }
export async function setPlatformTheme(patch) {
  const r = await put("/api/admin/theme", patch);
  themeConfig.theme = r.theme; themeConfig.allowUserChoice = r.allowUserChoice;
  applyTheme();
  return r;
}
