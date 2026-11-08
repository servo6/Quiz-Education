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
  // À débloquer : `unlock` = niveau minimal (le meilleur de tes matières).
  { id: "aurora", name: "Aurore", desc: "Nuit polaire, vert et violet", unlock: 5 },
  { id: "neon", name: "Néon", desc: "Noir profond, rose et cyan", unlock: 10 },
  { id: "goldblack", name: "Or et noir", desc: "Élégance sombre et dorée", unlock: 15 },
  // Thèmes « arcade » : bordures épaisses, boutons en relief.
  { id: "pousse", name: "Pousse", desc: "Sombre, vert vif, boutons en relief" },
  { id: "pousse-clair", name: "Pousse claire", desc: "Blanc et vert vif, arrondis généreux" },
  { id: "ciel", name: "Ciel", desc: "Sombre, bleu vif, boutons en relief" },
];
/** Animations de victoire : `unlock` = niveau minimal. */
export const EFFECTS = [
  { id: "confetti", name: "Confettis", desc: "Le classique", unlock: 0 },
  { id: "stars", name: "Étoiles", desc: "Une pluie d'étoiles", unlock: 8 },
  { id: "fireworks", name: "Feux d'artifice", desc: "Trois bouquets colorés", unlock: 12 },
];
export const effectChoice = () => { const v = safe.get("qp-fx"); return EFFECTS.some((e) => e.id === v) ? v : "confetti"; };
export const setEffect = (id) => safe.set("qp-fx", id);
const ids = new Set(THEMES.map((t) => t.id));
const safe = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
};

export const FONTS = [
  { id: "quicksand", name: "Quicksand", desc: "Ronde et douce (par défaut)" },
  { id: "nunito", name: "Nunito", desc: "Ronde et lisible" },
  { id: "inter", name: "Inter", desc: "Neutre et sobre" },
  { id: "dmsans", name: "DM Sans", desc: "Géométrique" },
  { id: "theme", name: "Police du thème", desc: "Chaque thème garde sa police" },
];
export function applyFont(id) {
  if (!FONTS.some((f) => f.id === id)) id = "quicksand";
  if (id === "theme") delete document.documentElement.dataset.font; else document.documentElement.dataset.font = id;
  safe.set("qp-font", id);
}
export const themeConfig = { theme: "graphite", font: "quicksand", allowUserChoice: true, ignorePersonal: false, scopeTheme: null };
export const personalTheme = () => { const v = safe.get("qp-theme-own"); return v && ids.has(v) ? v : null; };

/** Thème réellement appliqué : le choix personnel s'il est autorisé, sinon celui de la plateforme. */
export const effectiveTheme = () => (!themeConfig.ignorePersonal && themeConfig.allowUserChoice && personalTheme()) || (ids.has(themeConfig.scopeTheme) ? themeConfig.scopeTheme : null) || themeConfig.theme;

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
    themeConfig.font = r.font ?? "quicksand";
    applyFont(themeConfig.font);
  } catch { /* on garde le thème en cache */ }
  applyTheme();
}
export function setPersonalTheme(id) { safe.set("qp-theme-own", id); applyTheme(); }
/** Apparence par défaut d'une organisation ou d'une matière (null = revenir au thème de la plateforme). */
export async function setScopeTheme(scope, id, theme) {
  const r = await put(`/api/theme/${scope}/${id}`, { theme });
  themeConfig.scopeTheme = r.theme; applyTheme();
  return r;
}
export async function platformThemeOf(scope, id) { return (await get(`/api/theme/${scope}/${id}`)).theme; }
export async function setPlatformTheme(patch) {
  const r = await put("/api/admin/theme", patch);
  themeConfig.theme = r.theme; themeConfig.allowUserChoice = r.allowUserChoice;
  if (r.font) { themeConfig.font = r.font; applyFont(r.font); }
  applyTheme();
  return r;
}
