import { h, toast, fail } from "../lib.js";
import { THEMES, themeConfig, personalTheme, setPersonalTheme, setPlatformTheme, applyTheme } from "../theme.js";

/** Carte de thème : miniature de l'interface dessinée avec les couleurs réelles du thème. */
function themeCard(t, selected, onclick) {
  return h("button.theme-card", { type: "button", "aria-pressed": String(selected), onclick, "aria-label": `Thème ${t.name}` },
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
        h("div", h("h2", "Thème de la plateforme"), h("p.muted", "S'applique à tous les joueurs et à cette interface d'administration. Le changement est immédiat.")),
        h("div.themes", THEMES.map((t) => themeCard(t, t.id === themeConfig.theme, async () => {
          try { await setPlatformTheme({ theme: t.id }); toast(`Thème « ${t.name} » appliqué`, "good"); paint(); } catch (ex) { fail(ex); }
        })))),
      h("section.card.stack",
        h("label.row", { for: "allow-choice", style: "gap:12px;cursor:pointer" }, toggle,
          h("div", h("strong", "Autoriser chaque joueur à choisir son thème"),
            h("div.muted.small", "Quand c'est activé, le choix de chaque joueur (dans son profil) remplace le thème de la plateforme pour lui seul."))))
    );
  };
  paint();
  return root;
}

/** Profil d'un joueur : choix personnel du thème (si l'administrateur l'autorise). */
export function personalThemeSection() {
  if (!themeConfig.allowUserChoice) {
    return h("section.stack.tight", h("h2", "Apparence"), h("p.muted", "Le thème est choisi par l'administrateur de la plateforme."));
  }
  const box = h("div.themes");
  const paint = () => {
    const own = personalTheme();
    box.replaceChildren(
      themeCard({ id: themeConfig.theme, name: "Par défaut", desc: "Thème choisi par la plateforme" }, !own, () => { setPersonalTheme(null); paint(); }),
      ...THEMES.map((t) => themeCard(t, own === t.id, () => { setPersonalTheme(t.id); paint(); })));
  };
  paint();
  return h("section.stack.tight", h("h2", "Apparence"), h("p.muted.small", "Ce choix ne s'applique qu'à toi, sur cet appareil."), box);
}

export { applyTheme };
