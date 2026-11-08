import { h, get, put, fail, toast, sheet } from "../lib.js";
import { S, loadMe } from "../state.js";
import { drawAvatar, resolveLook, isCustomItem, OPTIONS, PALETTES, COLOR_DEFAULTS, randomLook } from "../avatar.js";

const HEX = /^#[0-9a-fA-F]{6}$/;

// Zone de l'avatar affichée dans chaque vignette (x, y, largeur, hauteur) : on zoome sur la partie modifiée.
export const VIEW = {
  face: [20, 14, 60, 60], eyes: [27, 30, 46, 46], brows: [27, 30, 46, 46], nose: [30, 38, 40, 40], mouth: [30, 46, 40, 40], hair: [12, 4, 76, 76], beard: [22, 32, 56, 56],
  glasses: [24, 32, 52, 52], earrings: [16, 28, 68, 68], headwear: [18, 2, 64, 64], outfit: [6, 36, 88, 88], bg: [0, 0, 100, 100], freckles: [26, 36, 48, 48], mark: [26, 36, 48, 48], blush: [26, 36, 48, 48],
};

const TABS = [
  { id: "face", label: "Visage", groups: [{ key: "face", title: "Forme du visage" }, { color: "skin", title: "Teint" }, { key: "blush", title: "Joues" }, { key: "freckles", title: "Taches de rousseur" }, { key: "mark", title: "Grain de beauté" }] },
  { id: "eyes", label: "Yeux", groups: [{ key: "eyes", title: "Forme des yeux" }, { color: "eyes", title: "Couleur des yeux" }, { key: "brows", title: "Sourcils" }] },
  { id: "mouth", label: "Nez et bouche", groups: [{ key: "nose", title: "Nez" }, { key: "mouth", title: "Bouche" }, { color: "lips", title: "Lèvres" }] },
  { id: "hair", label: "Cheveux", groups: [{ key: "hair", title: "Coiffure" }, { color: "hair", title: "Couleur des cheveux" }] },
  { id: "beard", label: "Barbe", groups: [{ key: "beard", title: "Barbe et moustache" }, { color: "hair", title: "Couleur (comme les cheveux)" }] },
  { id: "acc", label: "Accessoires", groups: [{ key: "glasses", title: "Lunettes" }, { key: "earrings", title: "Boucles d'oreilles" }, { key: "headwear", title: "Couvre-chef" }, { color: "acc", title: "Couleur des accessoires" }] },
  { id: "outfit", label: "Tenue", groups: [{ key: "outfit", title: "Vêtement" }, { color: "outfit", title: "Couleur du vêtement" }] },
  { id: "bg", label: "Fond et cadre", groups: [{ key: "bg", title: "Fond" }, { bgpair: true, title: "Couleurs du fond" }, { frame: true, title: "Cadre" }] },
];

export async function editAvatar(_cat, done) {
  const r = await get("/api/avatar/items").catch((e) => { fail(e); return null; });
  if (!r) return;
  const items = r.items;
  const locks = r.lookLocks || {};
  const start = resolveLook(r.avatar, items);
  // Les anciens objets d'origine sont remplacés par les choix détaillés ; on garde seulement le cadre et les objets personnalisés.
  const draft = { items: {}, colors: {}, look: { ...start.look } };
  for (const [cat, id] of Object.entries(r.avatar?.items ?? {})) {
    const it = items.find((i) => i.id === id);
    if (it && (it.category === "frame" || isCustomItem(it))) draft.items[cat] = id;
  }
  for (const [k, v] of Object.entries(start.colors)) if (HEX.test(v)) draft.colors[k] = v;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  sheet("Mon avatar", (close) => {
    let tab = TABS[0].id;
    const stage = h("div.av-stage");
    const tabsEl = h("div.av-tabs", { role: "tablist" });
    const panel = h("div.av-panel");
    const locked = (key, id) => locks[`${key}:${id}`] || null;

    // ── Aperçu avec effet de profondeur (les calques bougent à des vitesses différentes) ──
    let svgEl = null;
    const paintStage = () => {
      svgEl = drawAvatar(draft, items, 168);
      stage.replaceChildren(svgEl);
    };
    if (!reduce) {
      stage.addEventListener("pointermove", (e) => {
        if (!svgEl) return;
        const b = stage.getBoundingClientRect();
        const dx = Math.max(-1, Math.min(1, ((e.clientX - b.left) / b.width - 0.5) * 2));
        const dy = Math.max(-1, Math.min(1, ((e.clientY - b.top) / b.height - 0.5) * 2));
        [[".z1", 0.8], [".z2", 1.6], [".z3", 2.4]].forEach(([sel, z]) => {
          const g = svgEl.querySelector(sel);
          if (g) g.style.transform = `translate(${(dx * z).toFixed(2)}px, ${(dy * z * 0.7).toFixed(2)}px)`;
        });
        stage.style.transform = `perspective(520px) rotateY(${(dx * 9).toFixed(1)}deg) rotateX(${(-dy * 7).toFixed(1)}deg)`;
      });
      stage.addEventListener("pointerleave", () => {
        stage.style.transform = "";
        svgEl?.querySelectorAll(".z1,.z2,.z3").forEach((g) => { g.style.transform = ""; });
      });
    }

    // ── Briques d'interface ──
    const setLook = (key, id) => { draft.look[key] = id; refresh(); };
    const optionTiles = (key) => h("div.av-grid", OPTIONS[key].map(([id, label]) => {
      const lock = locked(key, id);
      const preview = { ...draft, look: { ...draft.look, [key]: id } };
      return h("button.av-tile", {
        type: "button", "aria-pressed": String(draft.look[key] === id), disabled: !!lock, title: lock || label,
        onclick: () => setLook(key, id),
      }, drawAvatar(preview, items, 64, { view: VIEW[key] || VIEW.face, noFrame: true }), h("span", label), lock ? h("em.av-lock", lock) : null);
    }));
    const swatch = (value, pressed, onpick, label) => h("button", {
      type: "button", style: `--c:${value || "#ccc"}`, class: value ? "" : "none", "aria-pressed": String(pressed), "aria-label": label, title: label, onclick: onpick,
    });
    const colorPicker = (name, palette) => {
      const cur = draft.colors[name] || "";
      const custom = h("input", { type: "color", value: HEX.test(cur) ? cur : "#888888", "aria-label": "Couleur personnalisée",
        oninput: (e) => { draft.colors[name] = e.target.value; refreshSoft(); } });
      return h("div.swatches", palette.map((c) => swatch(c, cur === c, () => { if (c) draft.colors[name] = c; else delete draft.colors[name]; refresh(); }, c || "Naturelle")), custom);
    };
    const bgPairs = () => h("div.swatches", PALETTES.bg.map(([a, b]) => h("button", {
      type: "button", style: `--c:linear-gradient(135deg, ${a}, ${b})`, "aria-pressed": String(draft.colors.bga === a && draft.colors.bgb === b), "aria-label": "Fond " + a,
      onclick: () => { draft.colors.bga = a; draft.colors.bgb = b; refresh(); },
    })), h("input", { type: "color", value: draft.colors.bga || COLOR_DEFAULTS.bga, "aria-label": "Couleur 1", oninput: (e) => { draft.colors.bga = e.target.value; refreshSoft(); } }),
      h("input", { type: "color", value: draft.colors.bgb || COLOR_DEFAULTS.bgb, "aria-label": "Couleur 2", oninput: (e) => { draft.colors.bgb = e.target.value; refreshSoft(); } }));
    const frames = () => {
      const list = items.filter((i) => i.category === "frame" || isCustomItem(i));
      const pick = (it) => {
        if (it.category === "frame" || !draft.items[it.category] || draft.items[it.category] !== it.id) draft.items[it.category] = it.id; else delete draft.items[it.category];
        refresh();
      };
      return h("div.opts",
        h("button.opt", { type: "button", "aria-pressed": String(!draft.items.frame), onclick: () => { delete draft.items.frame; refresh(); } }, "Aucun"),
        list.map((it) => h("button.opt", { type: "button", "aria-pressed": String(draft.items[it.category] === it.id), disabled: !it.unlocked, title: it.unlocked ? it.name : it.lockReason, onclick: () => pick(it) },
          it.name, !it.unlocked ? h("span.small.muted", it.lockReason ?? "Verrouillé") : null)));
    };

    const paintPanel = () => {
      const t = TABS.find((x) => x.id === tab);
      panel.replaceChildren(...t.groups.map((g) => h("div.stack.tight",
        h("strong", g.title),
        g.key ? optionTiles(g.key) : g.color ? colorPicker(g.color, PALETTES[g.color === "hair" ? "hair" : g.color]) : g.bgpair ? bgPairs() : frames())));
    };
    const paintTabs = () => tabsEl.replaceChildren(...TABS.map((t) => h("button.av-tab", {
      type: "button", role: "tab", "aria-selected": String(t.id === tab), onclick: () => { tab = t.id; paintTabs(); paintPanel(); },
    }, t.label)));
    const refresh = () => { paintStage(); paintPanel(); };
    const refreshSoft = () => { paintStage(); }; // couleur libre en cours de choix : le sélecteur garde le focus

    const surprise = () => {
      const free = (k, id) => !locked(k, id);
      const rnd = randomLook(free);
      draft.look = { ...draft.look, ...rnd.look };
      draft.colors = { ...draft.colors, ...rnd.colors };
      refresh();
    };
    const reset = () => {
      draft.look = { ...resolveLook({}, []).look };
      draft.colors = { ...COLOR_DEFAULTS }; delete draft.colors.lips;
      refresh();
    };
    const save = async () => {
      try {
        await put("/api/me/avatar", { items: draft.items, colors: draft.colors, look: draft.look });
        await loadMe(); S.catalog = null; toast("Avatar enregistré", "good"); close(); done();
      } catch (e) { fail(e); }
    };

    paintStage(); paintTabs(); paintPanel();
    return h("div.stack.av-editor",
      h("div.av-top", stage, h("div.av-actions",
        h("button.btn.small", { type: "button", onclick: surprise }, "Surprise"),
        h("button.btn.ghost.small", { type: "button", onclick: reset }, "Réinitialiser"))),
      tabsEl, panel,
      h("button.btn.primary.block.av-save", { type: "button", onclick: save }, "Enregistrer"));
  });
}
