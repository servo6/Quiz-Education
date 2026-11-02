// Graphiques en SVG, sans bibliothèque : ils prennent leurs couleurs dans le thème actif (voir .ch-* dans app.css).
import { h } from "./lib.js";

const NS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k != null) el.append(typeof k === "string" ? document.createTextNode(k) : k);
  return el;
}
const title = (t) => s("title", {}, t);
const nice = (max) => {
  if (max <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};
export const fmtDay = (key) => { const [, m, d] = key.split("-"); return `${d}/${m}`; };
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const DOW = ["L", "M", "M", "J", "V", "S", "D"];
export const monthName = (m) => MONTHS[m];

/** Courbe(s). series : [{ name, values (null = trou), cls }]. */
export function lineChart({ labels, series, height = 200, max = null, unit = "", area = true, ariaLabel = "Courbe" }) {
  const W = 640, H = height, L = 36, R = 10, T = 12, B = 24;
  const all = series.flatMap((x) => x.values).filter((v) => v != null);
  const top = max ?? nice(Math.max(1, ...all));
  const n = labels.length;
  const x = (i) => L + (n <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const g = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "ch", role: "img", "aria-label": ariaLabel, preserveAspectRatio: "xMidYMid meet" });
  for (let i = 0; i <= 4; i++) {
    const v = (top / 4) * i;
    g.append(s("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "ch-grid" }), s("text", { x: L - 6, y: y(v) + 4, class: "ch-axis", "text-anchor": "end" }, `${Math.round(v * 10) / 10}${unit}`));
  }
  const step = Math.max(1, Math.ceil(n / 7));
  labels.forEach((lb, i) => { if (i % step === 0 || i === n - 1) g.append(s("text", { x: x(i), y: H - 6, class: "ch-axis", "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }, lb)); });
  for (const se of series) {
    let d = "";
    let pen = false;
    se.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `; pen = true; });
    if (area && series.length === 1 && d) {
      const pts = se.values.map((v, i) => [i, v]).filter(([, v]) => v != null);
      if (pts.length > 1) g.append(s("path", { d: `${d}L${x(pts.at(-1)[0]).toFixed(1)} ${y(0)} L${x(pts[0][0]).toFixed(1)} ${y(0)} Z`, class: `ch-area ${se.cls}` }));
    }
    g.append(s("path", { d, class: `ch-line ${se.cls}`, fill: "none" }));
    if (n <= 45) se.values.forEach((v, i) => { if (v != null) g.append(s("circle", { cx: x(i), cy: y(v), r: 3, class: `ch-dot ${se.cls}` }, title(`${labels[i]} — ${se.name} : ${Math.round(v * 10) / 10}${unit}`))); });
  }
  if (series.every((x) => x.values.every((v) => v == null || v === 0)) ) g.append(s("text", { x: W / 2, y: H / 2, class: "ch-axis", "text-anchor": "middle" }, "Pas encore de données sur cette période"));
  const legend = series.length > 1 ? h("div.ch-legend", series.map((se) => h("span", h("i", { class: `sw ${se.cls}` }), se.name))) : null;
  return h("figure.chart", g, legend);
}

/** Barres verticales, éventuellement empilées. bars : [{ label, parts:[{value, cls, name}] }]. */
export function barChart({ bars, height = 180, ariaLabel = "Histogramme", unit = "", labelEvery = null }) {
  const W = 640, H = height, L = 32, R = 6, T = 10, B = 24;
  const totals = bars.map((b) => b.parts.reduce((a, p) => a + p.value, 0));
  const top = nice(Math.max(1, ...totals));
  const n = bars.length;
  const bw = (W - L - R) / n;
  const g = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "ch", role: "img", "aria-label": ariaLabel });
  for (let i = 0; i <= 4; i++) {
    const v = (top / 4) * i, yy = T + (1 - v / top) * (H - T - B);
    g.append(s("line", { x1: L, x2: W - R, y1: yy, y2: yy, class: "ch-grid" }), s("text", { x: L - 5, y: yy + 4, class: "ch-axis", "text-anchor": "end" }, String(Math.round(v))));
  }
  const step = labelEvery ?? Math.max(1, Math.ceil(n / 8));
  bars.forEach((b, i) => {
    let acc = 0;
    const gap = Math.min(4, bw * 0.2);
    for (const p of b.parts) {
      if (p.value <= 0) continue;
      const hh = (p.value / top) * (H - T - B);
      g.append(s("rect", { x: L + i * bw + gap / 2, y: T + (H - T - B) - ((acc + p.value) / top) * (H - T - B), width: Math.max(1, bw - gap), height: hh, rx: 2, class: `ch-bar ${p.cls}` }, title(`${b.label} — ${p.name} : ${p.value}${unit}`)));
      acc += p.value;
    }
    if (i % step === 0) g.append(s("text", { x: L + i * bw + bw / 2, y: H - 6, class: "ch-axis", "text-anchor": "middle" }, b.label));
  });
  const names = [...new Map(bars.flatMap((b) => b.parts).map((p) => [p.cls, p.name])).entries()];
  return h("figure.chart", g, names.length > 1 ? h("div.ch-legend", names.map(([cls, name]) => h("span", h("i", { class: `sw ${cls}` }), name))) : null);
}

/** Anneau. segments : [{ label, value, cls }]. */
export function donut({ segments, center, sub, size = 150 }) {
  const total = segments.reduce((a, x) => a + x.value, 0);
  const r = 54, C = 2 * Math.PI * r;
  const g = s("svg", { viewBox: "0 0 140 140", class: "donut", role: "img", "aria-label": segments.map((x) => `${x.label} ${x.value}`).join(", "), style: `width:${size}px;height:${size}px` });
  g.append(s("circle", { cx: 70, cy: 70, r, class: "donut-bg", fill: "none", "stroke-width": 16 }));
  let off = 0;
  if (total > 0) for (const sg of segments) {
    if (sg.value <= 0) continue;
    const len = (sg.value / total) * C;
    g.append(s("circle", { cx: 70, cy: 70, r, fill: "none", "stroke-width": 16, class: `ch-stroke ${sg.cls}`, "stroke-dasharray": `${Math.max(0, len - 1.5)} ${C}`, "stroke-dashoffset": -off, transform: "rotate(-90 70 70)" }, title(`${sg.label} : ${sg.value}`)));
    off += len;
  }
  g.append(s("text", { x: 70, y: sub ? 69 : 76, class: "donut-c", "text-anchor": "middle" }, center ?? ""), sub ? s("text", { x: 70, y: 88, class: "ch-axis", "text-anchor": "middle" }, sub) : null);
  return h("figure.donut-wrap", g, h("ul.ch-legend.col", segments.map((x) => h("li", h("i", { class: `sw ${x.cls}` }), `${x.label} `, h("strong", String(x.value))))));
}

/** Barres horizontales en HTML (accessibles) : rows [{ label, value (0-100 ou null), note }]. */
export function hbars(rows, { tone = true } = {}) {
  return h("div.hbars", rows.map((r) => {
    const v = r.value;
    const cls = v == null ? "" : !tone ? "" : v >= 75 ? "good" : v >= 50 ? "warn" : "bad";
    return h("div.hb", h("div.hb-top", h("span.hb-label", r.label), h("strong", v == null ? "–" : `${v} %`)),
      h("div.hb-track", { role: "img", "aria-label": `${r.label} : ${v ?? "pas de données"}` }, h("i", { class: cls, style: `width:${v ?? 0}%` })),
      r.note ? h("span.muted.small", r.note) : null);
  }));
}

/** Calendrier annuel façon « contributions » : 53 semaines, lundi en haut. */
export function yearHeatmap(days, today) {
  const map = new Map(days.map((d) => [d.date, d]));
  const end = new Date(today + "T12:00:00Z");
  const dow = (end.getUTCDay() + 6) % 7;
  const start = new Date(end.getTime() - (52 * 7 + dow) * 86400000);
  const max = Math.max(1, ...days.map((d) => d.answers));
  const level = (n) => (n === 0 ? 0 : n <= max * 0.25 ? 1 : n <= max * 0.5 ? 2 : n <= max * 0.75 ? 3 : 4);
  const cell = 11, gap = 3;
  const W = 53 * (cell + gap) + 22, H = 7 * (cell + gap) + 18;
  const g = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "ch heat", role: "img", "aria-label": "Activité sur un an" });
  ["L", "", "M", "", "V", "", "D"].forEach((t, i) => t && g.append(s("text", { x: 0, y: 18 + i * (cell + gap) + 9, class: "ch-axis" }, t)));
  let lastMonth = -1;
  for (let w = 0; w < 53; w++) for (let d = 0; d < 7; d++) {
    const t = new Date(start.getTime() + (w * 7 + d) * 86400000);
    if (t > end) continue;
    const key = t.toISOString().slice(0, 10);
    const v = map.get(key);
    if (d === 0 && t.getUTCMonth() !== lastMonth) { lastMonth = t.getUTCMonth(); g.append(s("text", { x: 22 + w * (cell + gap), y: 10, class: "ch-axis" }, MONTHS[lastMonth].slice(0, 3))); }
    g.append(s("rect", { x: 22 + w * (cell + gap), y: 16 + d * (cell + gap), width: cell, height: cell, rx: 2.5, class: `heat-c l${level(v?.answers ?? 0)}` },
      title(`${key.split("-").reverse().join("/")} — ${v ? `${v.answers} réponse${v.answers > 1 ? "s" : ""}, ${v.correct} bonne${v.correct > 1 ? "s" : ""}` : "aucune activité"}`)));
  }
  return h("figure.chart.scroll-x", g, h("div.ch-legend", h("span", "Moins"), [0, 1, 2, 3, 4].map((l) => h("i", { class: `sw heat-c l${l}` })), h("span", "Plus")));
}

/** Calendrier d'un mois : les jours pratiqués sont pointés. onNav(delta) change de mois. */
export function monthCalendar({ year, month, days, today, onNav, canNext = true }) {
  const map = new Map(days.map((d) => [d.date, d]));
  const first = new Date(Date.UTC(year, month, 1, 12));
  const lead = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(h("span.cal-c.empty"));
  let practiced = 0;
  for (let d = 1; d <= count; d++) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const v = map.get(key);
    if (v) practiced++;
    cells.push(h("span.cal-c", { class: `${v ? "on" : ""} ${key === today ? "today" : ""} ${key > today ? "future" : ""}`.trim(),
      title: v ? `${v.answers} réponse${v.answers > 1 ? "s" : ""}, ${v.correct} bonne${v.correct > 1 ? "s" : ""}` : "", "aria-label": `${d} ${MONTHS[month]}${v ? ", jour pratiqué" : ""}` }, String(d)));
  }
  return h("div.cal",
    h("div.row.between", h("button.btn.ghost.small", { type: "button", "aria-label": "Mois précédent", onclick: () => onNav(-1) }, "‹"),
      h("strong", `${MONTHS[month][0].toUpperCase()}${MONTHS[month].slice(1)} ${year}`),
      h("button.btn.ghost.small", { type: "button", "aria-label": "Mois suivant", disabled: !canNext, onclick: () => onNav(1) }, "›")),
    h("div.cal-grid", DOW.map((d) => h("span.cal-h", d)), cells),
    h("p.muted.small.center", `${practiced} jour${practiced > 1 ? "s" : ""} pratiqué${practiced > 1 ? "s" : ""} ce mois-ci`));
}

/** Carte chiffre clé. */
export function kpi(value, label, { sub = null, tone = "" } = {}) {
  return h("div.kpi", { class: tone }, h("b", String(value)), h("span", label), sub ? h("small.muted", sub) : null);
}
