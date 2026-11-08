// Sélecteur d'émojis : tous les émojis Unicode (ceux de WhatsApp et au-delà), par catégories, avec recherche en français,
// teintes de peau mémorisées et « récents ». Les données (public/emoji/fr.json) ne sont chargées qu'à la première ouverture.
import { h } from "./lib.js";

let DATA = null;
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};
const ICONS = { "smileys-emotion": "😀", "people-body": "👋", "animals-nature": "🐻", "food-drink": "🍔", "travel-places": "🚗", "activities": "⚽", "objects": "💡", "symbols": "❤️", "flags": "🏁" };
const SKINS = ["", 0, 1, 2, 3, 4]; // "" = jaune par défaut, sinon index dans la liste des variantes

async function load() {
  if (DATA) return DATA;
  const r = await fetch("/emoji/fr.json");
  if (!r.ok) throw new Error("emoji_data");
  DATA = await r.json();
  return DATA;
}
const norm = (s) => s.replace(/œ/g, "oe").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Insère `text` à la position du curseur de `input` (textarea) et déclenche l'évènement input. */
export function insertAtCursor(input, text) {
  const a = input.selectionStart ?? input.value.length, b = input.selectionEnd ?? a;
  const max = Number(input.getAttribute("maxlength")) || Infinity;
  if (input.value.length - (b - a) + text.length > max) return;
  input.value = input.value.slice(0, a) + text + input.value.slice(b);
  const pos = a + text.length;
  input.setSelectionRange?.(pos, pos);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Panneau déroulant ; `onPick(emoji)` est appelé à chaque choix (le panneau reste ouvert pour en enchaîner). */
export function emojiPanel(onPick) {
  const panel = h("div.emoji-panel", { hidden: true });
  const search = h("input.input", { type: "search", placeholder: "Chercher un émoji (ex. : rire, coeur, foot)", "aria-label": "Chercher un émoji" });
  const tabs = h("div.emoji-tabs", { role: "tablist" });
  const grid = h("div.emoji-grid", { role: "listbox", "aria-label": "Émojis" });
  const skinBtn = h("button.emoji-skin", { type: "button", title: "Teinte de peau", "aria-label": "Teinte de peau" }, "✋");
  let skin = store.get("qp:emoji:skin", -1); // -1 = par défaut
  let group = store.get("qp:emoji:recent", []).length ? "recent" : "smileys-emotion";
  let loaded = false;

  const SKIN_SAMPLES = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];
  skinBtn.textContent = SKIN_SAMPLES[skin + 1];
  skinBtn.onclick = () => { skin = skin >= 4 ? -1 : skin + 1; store.set("qp:emoji:skin", skin); skinBtn.textContent = SKIN_SAMPLES[skin + 1]; paint(); };

  const glyph = (it) => (skin >= 0 && it[3] && it[3][skin] ? it[3][skin] : it[0]);
  const cell = (ch, label) => h("button.emoji", { type: "button", role: "option", title: label, "aria-label": label, onclick: () => pick(ch) }, ch);
  function pick(ch) {
    const rec = [ch, ...store.get("qp:emoji:recent", []).filter((x) => x !== ch)].slice(0, 32);
    store.set("qp:emoji:recent", rec);
    onPick(ch);
  }

  function paint() {
    if (!loaded) return;
    const q = norm(search.value.trim());
    tabs.hidden = !!q;
    grid.replaceChildren();
    if (q) {
      const hits = [];
      for (const g of DATA) for (const it of g.i) if (norm(`${it[1]} ${it[2]}`).includes(q)) hits.push(it);
      if (!hits.length) grid.append(h("p.muted.small.emoji-empty", "Aucun émoji trouvé."));
      for (const it of hits.slice(0, 160)) grid.append(cell(glyph(it), it[1]));
      return;
    }
    const sections = group === "recent"
      ? [{ n: "Récents", list: store.get("qp:emoji:recent", []).map((ch) => [ch, ch]) }]
      : [{ n: DATA.find((g) => g.k === group)?.n ?? "", list: (DATA.find((g) => g.k === group)?.i ?? []).map((it) => [glyph(it), it[1]]) }];
    for (const s of sections) {
      grid.append(h("div.emoji-title", s.n));
      s.list.forEach(([ch, label]) => grid.append(cell(ch, label)));
    }
    tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.k === group)));
  }
  function buildTabs() {
    tabs.replaceChildren(
      h("button", { type: "button", "data-k": "recent", title: "Récents", onclick: () => { group = "recent"; paint(); } }, "🕘"),
      ...DATA.map((g) => h("button", { type: "button", "data-k": g.k, title: g.n, role: "tab", onclick: () => { group = g.k; grid.scrollTop = 0; paint(); } }, ICONS[g.k] ?? "🙂")));
  }
  search.addEventListener("input", paint);
  panel.append(h("div.emoji-top", search, skinBtn), tabs, grid);

  return {
    el: panel,
    async toggle(force) {
      const open = force ?? panel.hidden;
      panel.hidden = !open;
      if (!open || loaded) return open;
      grid.replaceChildren(h("p.muted.small.emoji-empty", "Chargement…"));
      try { await load(); loaded = true; buildTabs(); if (group === "recent" && !store.get("qp:emoji:recent", []).length) group = "smileys-emotion"; paint(); }
      catch { grid.replaceChildren(h("p.muted.small.emoji-empty", "Impossible de charger les émojis. Vérifie ta connexion.")); }
      return open;
    },
  };
}
