import { h, toast, fail, get, confetti } from "../lib.js";
import { S } from "../state.js";
import { W, loadWallet, priceOf, buyItem } from "../wallet.js";
import { FONTS, EFFECTS, effectChoice, setEffect, THEMES, themeConfig, personalTheme, setPersonalTheme, setPlatformTheme, setScopeTheme, platformThemeOf, applyTheme } from "../theme.js";

/** Carte de thème : miniature de l'interface dessinée avec les couleurs réelles du thème. */
/** Meilleur niveau du joueur, toutes matières confondues : il débloque thèmes et animations. */
export const bestLevel = () => Math.max(1, ...(S.me?.subjects ?? []).map((s) => (typeof s.level === "object" ? s.level?.level : s.level) ?? 1));

/** Débloqué par le niveau, ou acheté avec des pièces. */
export const isUnlocked = (item) => !item.unlock || (S.me?.user.role ?? "USER") !== "USER" || bestLevel() >= item.unlock || W.unlocked.has(item.id);
const lockLabel = (item) => { const p = priceOf(item.id); return `🔒 Niv. ${item.unlock}${p ? ` ou 🪙 ${p}` : ""}`; };

function themeCard(t, selected, onclick, locked = false) {
  return h("button.theme-card", { type: "button", class: locked ? "locked" : "", "aria-pressed": String(selected), onclick, "aria-label": `Thème ${t.name}${locked ? `, débloqué au niveau ${t.unlock}${priceOf(t.id) ? ` ou pour ${priceOf(t.id)} pièces` : ""}` : ""}`, style: "position:relative" },
    locked ? h("span.lock", lockLabel(t)) : null,
    h("div.mock", { "data-theme": t.id, style: "font-family:var(--font-body)" },
      h("div.nav", h("i"), h("i"), h("i"), h("i")),
      h("div.body", h("b"), h("div.card-m", h("i"), h("i")), h("div.card-m", h("i"), h("i")))),
    h("div", h("div.name", t.name), h("div.desc", t.desc)),
    selected ? h("span.tick", { "aria-hidden": "true" }, "✓") : null);
}

/** Panneau d'administration : thème de toute la plateforme. */
export async function appearancePanel() {
  const root = h("div.stack");
  const paint = () => {
    const toggle = h("input", {
      type: "checkbox", id: "allow-choice", checked: themeConfig.allowUserChoice,
      onchange: async (e) => {
        try { await setPlatformTheme({ allowUserChoice: e.target.checked }); toast(e.target.checked ? "Les joueurs peuvent choisir leur thème" : "Tous les joueurs voient le thème de la plateforme", "good"); }
        catch (ex) { e.target.checked = !e.target.checked; fail(ex); }
      },
    });
    root.replaceChildren(
      h("section.card.stack",
        h("div", h("h2", "Thème de la plateforme")),
        h("div.themes", THEMES.map((t) => themeCard(t, t.id === themeConfig.theme, async () => {
          try { await setPlatformTheme({ theme: t.id }); toast(`Thème « ${t.name} » appliqué`, "good"); paint(); } catch (ex) { fail(ex); }
        })))),
      h("section.card.stack",
        h("div", h("h2", "Police de l'interface"), h("p.muted.small", "S'applique à toute la plateforme. « Police du thème » laisse chaque thème utiliser sa propre police.")),
        h("div.row.wrap", FONTS.map((f) => h("button.btn", { type: "button", class: themeConfig.font === f.id ? "primary" : "ghost", title: f.desc, style: f.id === "theme" ? "" : `font-family:'${f.name}',sans-serif`,
          onclick: async () => { try { await setPlatformTheme({ font: f.id }); toast(`Police « ${f.name} » appliquée`, "good"); paint(); } catch (ex) { fail(ex); } } }, f.name)))),
      h("section.card.stack",
        h("label.row", { for: "allow-choice", style: "gap:12px;cursor:pointer" }, toggle,
          h("div", h("strong", "Autoriser chaque joueur à choisir son thème"),)))
    );
  };
  paint();
  return root;
}

/** Apparence d'une organisation (`scope` = "organization") ou d'une matière ("subject") : thème de l'interface de gestion et thème par défaut des joueurs. */
export async function scopedAppearancePanel(scope, items, text) {
  const root = h("div.stack");
  const sel = h("select.input", { "aria-label": scope === "organization" ? "Organisation" : "Matière" }, items.map((o) => h("option", { value: o.id }, o.name)));
  const body = h("div.stack");
  async function paint() {
    const current = await platformThemeOf(scope, sel.value);
    body.replaceChildren(h("section.card.stack",
      h("div", h("h2", text.title)),
      h("div.themes",
        themeCard({ id: themeConfig.theme, name: "Thème de la plateforme", desc: "Aucun thème particulier" }, !current, async () => {
          try { await setScopeTheme(scope, sel.value, null); toast("Thème de la plateforme rétabli", "good"); paint(); } catch (ex) { fail(ex); } }),
        ...THEMES.map((t) => themeCard(t, current === t.id, async () => {
          try { await setScopeTheme(scope, sel.value, t.id); toast(`Thème « ${t.name} » appliqué`, "good"); paint(); } catch (ex) { fail(ex); } })))));
  }
  sel.onchange = () => paint().catch(fail);
  await paint();
  root.append(items.length > 1 ? sel : "", body);
  return root;
}

/** Profil d'un joueur : choix personnel du thème (si l'administrateur l'autorise). */
export function personalThemeSection() {
  if (!themeConfig.allowUserChoice) {
    return h("section.stack.tight", h("h2", "Apparence"), null);
  }
  const box = h("div.themes");
  const paint = () => {
    const own = personalTheme();
    box.replaceChildren(
      themeCard({ id: themeConfig.theme, name: "Par défaut", desc: "Thème choisi par la plateforme" }, !own, () => { setPersonalTheme(null); paint(); }),
      ...THEMES.map((t) => themeCard(t, own === t.id, () => {
        if (isUnlocked(t)) { setPersonalTheme(t.id); paint(); } else offer(t, () => { setPersonalTheme(t.id); paint(); });
      }, !isUnlocked(t))));
  };
  /** Article verrouillé : propose de l'acheter avec les pièces gagnées en salon. */
  const offer = async (item, done) => {
    const p = priceOf(item.id);
    if (!p) return toast(`Se débloque au niveau ${item.unlock}`);
    if (W.coins < p) return toast(`Il te manque ${p - W.coins} pièces (tu en as ${W.coins}). Gagne-en en jouant en salon.`);
    if (!confirm(`Acheter « ${item.name} » pour ${p} pièces ?`)) return;
    try { await buyItem(item.id); toast(`« ${item.name} » débloqué`, "good"); coins.textContent = `🪙 ${W.coins} pièces`; paintFx(); done(); } catch (ex) { fail(ex); }
  };
  const coins = h("strong", `🪙 ${W.coins} pièces`);
  loadWallet().then(() => { coins.textContent = `🪙 ${W.coins} pièces`; paint(); paintFx(); });
  paint();
  const fxBox = h("div.row.wrap");
  const paintFx = () => fxBox.replaceChildren(...EFFECTS.map((e) => {
    const locked = !isUnlocked(e);
    return h("button.btn", { type: "button", class: effectChoice() === e.id && !locked ? "primary" : "ghost", title: e.desc,
      onclick: () => { if (locked) return offer(e, () => { setEffect(e.id); paintFx(); confetti(e.id); }); setEffect(e.id); paintFx(); confetti(e.id); } }, locked ? `🔒 ${e.name} (niv. ${e.unlock}${priceOf(e.id) ? ` ou 🪙 ${priceOf(e.id)}` : ""})` : e.name);
  }));
  paintFx();
  return h("section.stack.tight", h("h2", "Apparence"), box,
    h("h2", "Animation de victoire"), h("p.muted.small", `Monte en niveau, ou dépense des pièces gagnées en salon, pour débloquer de nouveaux thèmes et animations. Ton meilleur niveau : ${bestLevel()}.`), h("p", coins), fxBox);
}

export { applyTheme };
