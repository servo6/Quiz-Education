import { drawAvatar } from "./avatar.js";
// Outils communs : construction du DOM sans innerHTML (pas d'injection), appels API, notifications, avatar.

const SVG_NS = "http://www.w3.org/2000/svg";

/** h("div.card", {onclick}, enfants…) : crée un élément ; les textes sont toujours insérés comme du texte. */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className += (el.className ? " " : "") + v;
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "disabled" || k === "hidden") el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function svg(markup) {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const mount = (el, ...children) => { clear(el); append(el, children); return el; };

// ───────── API ─────────
export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method, credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "Connexion impossible. Vérifie ta connexion et réessaie.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* pas de corps */ }
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? `Erreur ${res.status}`, e?.details);
  }
  return data;
}
export const get = (u) => api("GET", u);
export const post = (u, b = {}) => api("POST", u, b);
export const put = (u, b = {}) => api("PUT", u, b);
export const del = (u, b) => api("DELETE", u, b);

// ───────── Notifications ─────────
export function toast(message, kind = "", ms = 3800) {
  const t = h("div.toast", { class: kind }, message);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), ms);
}
export function errorMessage(e) {
  if (e?.code === "validation" && Array.isArray(e.details) && e.details[0]?.message) return e.details[0].message;
  return e?.message ?? "Une erreur est survenue";
}
export const fail = (e) => toast(errorMessage(e), "bad", 5000);

export function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cs = getComputedStyle(document.documentElement);
  const colors = ["--accent", "--good", "--warn", "--bad", "--text"].map((v) => cs.getPropertyValue(v).trim() || "#888");
  const box = h("div.confetti");
  for (let i = 0; i < 46; i++) {
    const p = h("i");
    p.style.left = Math.random() * 100 + "%";
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = Math.random() * 0.5 + "s";
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    box.append(p);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 2600);
}

/** Feuille modale. `build(close)` renvoie le contenu. */
export function sheet(title, build) {
  const prevFocus = document.activeElement;
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); prevFocus?.focus?.(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const back = h("div.sheet-back", { onclick: (e) => { if (e.target === back) close(); } },
    h("div.sheet", { role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div.row.between", h("h2", title), h("button.btn.ghost.small", { onclick: close }, "Fermer")),
      build(close)));
  document.addEventListener("keydown", onKey);
  document.body.append(back);
  back.querySelector("input,button.opt,button.item")?.focus();
  return close;
}

// ───────── Formats ─────────
export function timeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "terminé";
  const h = Math.floor(ms / 3600000);
  if (h >= 48) return `${Math.floor(h / 24)} jours`;
  if (h >= 1) return `${h} h`;
  return `${Math.max(1, Math.floor(ms / 60000))} min`;
}
/** Style d'un élément portant la couleur d'un chapitre (liseré à gauche). */
export const chapStyle = (c) => (c?.color ? `--chap:${c.color}` : "");
export const pct = (v) => (v == null ? "–" : `${v} %`);

// ───────── Icônes ─────────
const icons = {
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7.5"/><path d="m16.5 16.5 4.5 4.5M8.5 11.2l1.8 1.8 3.4-3.6"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m5 5v6m4-6v6"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2 21c0-3.6 3.1-6 7-6s7 2.4 7 6M16 4.5a3.5 3.5 0 0 1 0 7M22 21c0-3-2-5-5-5.7"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-1"/><circle cx="16" cy="6" r="2.2"/><circle cx="10" cy="12" r="2.2"/><circle cx="18" cy="18" r="2.2"/></svg>',
  journal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm3 5h6M9 12h6M9 16h4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.4 8.5 8 9.5 4.6-1 8-4.5 8-9.5V6l-8-3Z"/></svg>',
  award: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="6"/><path d="m8.5 14-1.5 7 5-3 5 3-1.5-7"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>',
  palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 0 18 2.2 2.2 0 0 0 1.6-3.7 2.2 2.2 0 0 1 1.6-3.7H17a4 4 0 0 0 4-4A9 9 0 0 0 12 3Z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2V5Zm0 15a2 2 0 0 1 2-2h13v3H6a2 2 0 0 1-2-1Z"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4.8v14.4a1 1 0 0 0 1.5.9l11-7.2a1 1 0 0 0 0-1.8l-11-7.2A1 1 0 0 0 7 4.8Z"/></svg>',
  duel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 4 9 9M20 4l-9 9M3 21l4-1 2-3-3-3-3 2-1 4 1 1Zm18 0-4-1-2-3 3-3 3 2 1 4-1 1Z"/></svg>',
  rank: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Zm10 2h3v2a3 3 0 0 1-3 3M7 6H4v2a3 3 0 0 0 3 3"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Zm4 9a2 2 0 0 0 4 0"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10m6 10V4m6 16v-7m5 7H3"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 .5 1.5 1.5 2 2 2 0-3-1-5 1-8Z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4m8-4v4"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 3-9.5 18-2.5-7.5L1.5 11 21 3Zm-12 11 5-5"/></svg>',
  userplus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2 21c0-3.6 3.1-6 7-6s7 2.4 7 6M19 8v6m-3-3h6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  crown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 8 4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8Z"/></svg>',
  help: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="32" cy="32" r="24"/><path d="M25 25a7 7 0 1 1 10 6c-2 1-3 2-3 5M32 44h.01"/></svg>',
};
export const icon = (name) => svg(icons[name]);

// ───────── Avatar : dessiné par /js/avatar.js (buste en SVG avec relief) ─────────
export function avatarEl(avatar, catalog, size = 48) {
  return drawAvatar(avatar, catalog, size);
}

// ───────── Texte riche : formules LaTeX ($…$) et chimie ($\ce{H2O}$) ─────────
// Les textes restent des textes (jamais d'HTML). Seuls les passages entre $…$, $$…$$, \(…\) ou \[…\]
// sont rendus comme des formules par KaTeX, chargé seulement quand une page en contient.
// Un dollar littéral s'écrit \$. Sans KaTeX (réseau coupé), la formule reste lisible en texte brut.

function splitMath(s) {
  const parts = []; let text = ""; let i = 0;
  const flush = () => { if (text) { parts.push({ t: "text", v: text }); text = ""; } };
  const findClose = (from, close) => {
    for (let j = from; j < s.length; j++) {
      if (s[j] === "\\" && close !== "\\)" && close !== "\\]") { j++; continue; }
      if (s.startsWith(close, j)) return j;
    }
    return -1;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "$") { text += "$"; i += 2; continue; }
    let open = 0, close = "", block = false;
    if (c === "$" && s[i + 1] === "$") { open = 2; close = "$$"; block = true; }
    else if (c === "$") { open = 1; close = "$"; }
    else if (c === "\\" && s[i + 1] === "(") { open = 2; close = "\\)"; }
    else if (c === "\\" && s[i + 1] === "[") { open = 2; close = "\\]"; block = true; }
    if (!open) { text += c; i++; continue; }
    const end = findClose(i + open, close);
    const body = end < 0 ? "" : s.slice(i + open, end);
    // « 5 $ et 10 $ » n'est pas une formule : un $ simple ne s'ouvre pas sur un espace, ne se ferme pas après un espace ni avant un chiffre.
    const plausible = end > i + open && (close !== "$" || (!/\s/.test(body[0]) && !/\s/.test(body[body.length - 1]) && !/\d/.test(s[end + 1] ?? "")));
    if (!plausible) { text += c; i++; continue; }
    flush();
    parts.push({ t: "math", v: body.trim(), block });
    i = end + close.length;
  }
  flush();
  return parts;
}

let katexLoading = null;
function loadKatex() {
  if (window.katex) return Promise.resolve(true);
  if (katexLoading) return katexLoading;
  const script = (src) => new Promise((ok, ko) => {
    const el = document.createElement("script");
    el.src = src; el.onload = ok; el.onerror = ko; document.head.append(el);
  });
  const css = document.createElement("link");
  css.rel = "stylesheet"; css.href = "/vendor/katex/katex.min.css"; document.head.append(css);
  katexLoading = script("/vendor/katex/katex.min.js")
    .then(() => script("/vendor/katex/mhchem.min.js").catch(() => {}))   // chimie : \ce{…}
    .then(() => true, () => { katexLoading = null; return false; });
  return katexLoading;
}

function drawMath(el) {
  try {
    window.katex.render(el.dataset.tex, el, { throwOnError: false, displayMode: el.classList.contains("math-block"), output: "htmlAndMathml", strict: "ignore", trust: false });
    el.classList.add("math-ok");
  } catch { /* on garde le texte brut */ }
}

/** rich("L'eau $\\ce{H2O}$ et $x^2$") → fragment à insérer dans le DOM (textes et formules). */
export function rich(value) {
  const s = value == null ? "" : String(value);
  if (!/[$\\]/.test(s)) return document.createTextNode(s);
  const frag = document.createDocumentFragment();
  for (const p of splitMath(s)) {
    if (p.t === "text") { frag.append(document.createTextNode(p.v)); continue; }
    const el = document.createElement("span");
    el.className = p.block ? "math math-block" : "math";
    el.dataset.tex = p.v;
    el.textContent = p.v;
    frag.append(el);
    if (window.katex) drawMath(el);
    else loadKatex().then((ok) => { if (ok) drawMath(el); });
  }
  return frag;
}
