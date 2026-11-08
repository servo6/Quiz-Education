import { h, get, put, icon, toast, fail, sheet, avatarEl, rich } from "../lib.js";
import { loadCatalog, lvl } from "../state.js";
import { barChart, donut, fmtDay, hbars, kpi, lineChart } from "../charts.js";
import { playerStatsBody } from "./stats.js";

const PERIODS = [[7, "7 jours"], [30, "30 jours"], [90, "3 mois"], [365, "1 an"]];
const WEEKDAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const secs = (ms) => (ms == null ? "–" : `${(ms / 1000).toFixed(1).replace(".", ",")} s`);
const when = (iso) => (iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "jamais");

const COLUMNS = [
  ["username", "Joueur", (p) => p.username, false],
  ["level", "Niv.", (p) => lvl(p.level), true],
  ["xp", "XP", (p) => p.xp, true],
  ["answers", "Réponses", (p) => p.answers, true],
  ["accuracy", "Réussite", (p) => p.accuracy ?? -1, true],
  ["wins", "V", (p) => p.wins, true],
  ["draws", "N", (p) => p.draws, true],
  ["losses", "D", (p) => p.losses, true],
  ["streak", "Série", (p) => p.streak, true],
  ["longestStreak", "Record", (p) => p.longestStreak, true],
  ["activeDays", "Jours actifs", (p) => p.activeDays, true],
  ["avgTimeMs", "Temps moy.", (p) => p.avgTimeMs ?? 1e12, true],
  ["lastActive", "Dernière activité", (p) => (p.lastActive ? new Date(p.lastActive).getTime() : 0), true],
];
const cell = { accuracy: (p) => (p.accuracy == null ? "–" : `${p.accuracy} %`), avgTimeMs: (p) => secs(p.avgTimeMs), lastActive: (p) => when(p.lastActive), level: (p) => lvl(p.level) };

/** Panneau « Statistiques » de la matière : tous les joueurs, courbes et difficultés. */
export async function statsPanel(sub) {
  const cat = await loadCatalog().catch(() => []);
  let days = 30;
  let sort = { key: "xp", dir: -1 };
  let filter = "";
  const root = h("div.stack");
  let data = await get(`/api/subjects/${sub.id}/admin-stats?days=${days}`);

  async function setDays(d) { days = d; data = await get(`/api/subjects/${sub.id}/admin-stats?days=${days}`); paint(); }
  function openPlayer(p) {
    sheet(p.username, () => {
      const box = h("div.stack", h("div.center", h("div.spinner")));
      playerStatsBody((d) => get(`/api/subjects/${sub.id}/stats/player/${p.id}?days=${d}`)).then((n) => box.replaceChildren(n)).catch((e) => box.replaceChildren(h("p.error-box", e.message)));
      return box;
    });
    document.querySelector(".sheet")?.style.setProperty("max-width", "min(960px, 96vw)");
  }

  function paint() {
    const t = data.totals;
    const labels = data.series.map((d) => fmtDay(d.date));
    const seg = h("div.seg", { role: "group", "aria-label": "Période" }, PERIODS.map(([d, label]) => h("button", { type: "button", "aria-pressed": String(d === days), onclick: () => setDays(d) }, label)));
    const col = COLUMNS.find((c) => c[0] === sort.key) ?? COLUMNS[2];
    const rows = data.players.filter((p) => p.username.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => {
      const x = col[2](a), y = col[2](b);
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * sort.dir;
    });
    const search = h("input.input", { type: "search", placeholder: "Filtrer les joueurs", value: filter, "aria-label": "Filtrer les joueurs", style: "max-width:260px" });
    search.oninput = () => { filter = search.value; const pos = search.selectionStart; paint(); const s = root.querySelector('input[type=search]'); s.focus(); s.setSelectionRange(pos, pos); };
    const hourMax = Math.max(...data.hours);

    root.replaceChildren(
      h("section.kpis",
        kpi(t.members, t.members > 1 ? "joueurs" : "joueur", { sub: t.revoked ? `${t.revoked} accès révoqué${t.revoked > 1 ? "s" : ""}` : null }),
        kpi(t.active7, "actifs sur 7 jours", { tone: "accent", sub: t.members ? `${Math.round((t.active7 / t.members) * 100)} % des joueurs` : null }),
        kpi(t.active30, "actifs sur 30 jours"),
        kpi(t.answers, "réponses données"),
        kpi(t.accuracy == null ? "–" : `${t.accuracy} %`, "réussite globale"),
        kpi(t.soloFinished, "parties solo"),
        kpi(t.duelsFinished, "duels terminés", { sub: t.duelsInProgress ? `${t.duelsInProgress} en cours` : null }),
        kpi(secs(t.avgTimeMs), "temps moyen / réponse")),

      h("section.card.stack",
        h("div.row.between.wrap", h("h2", "Activité"), seg),
        h("div", h("strong.small", "Réponses par jour"), barChart({ bars: data.series.map((d, i) => ({ label: labels[i], parts: [{ value: d.correct, cls: "c-good", name: "Bonnes" }, { value: d.answers - d.correct, cls: "c-bad", name: "Fausses" }] })), ariaLabel: "Réponses par jour" })),
        h("div.grid-2",
          h("div", h("strong.small", "Joueurs actifs par jour"), lineChart({ labels, series: [{ name: "Joueurs actifs", values: data.series.map((d) => d.activePlayers), cls: "c-accent" }], ariaLabel: "Joueurs actifs" })),
          h("div", h("strong.small", "Réussite (%)"), lineChart({ labels, series: [{ name: "Réussite", values: data.series.map((d) => d.accuracy), cls: "c-good" }], max: 100, unit: "%", ariaLabel: "Réussite" }))),
        h("div.grid-2",
          h("div", h("strong.small", "XP distribuée par jour"), lineChart({ labels, series: [{ name: "XP", values: t.xpPerDay.map((d) => d.xp), cls: "c-warn" }], ariaLabel: "XP distribuée" })),
          h("div", h("strong.small", "Nouveaux membres par jour"), barChart({ bars: data.series.map((d, i) => ({ label: labels[i], parts: [{ value: d.newMembers, cls: "c-accent", name: "Nouveaux membres" }] })), height: 150, ariaLabel: "Nouveaux membres" })))),

      h("section.card.stack",
        h("div.row.between.wrap", h("h2", `Joueurs (${rows.length})`), h("div.row", search, h("button.btn.ghost.small", { type: "button", onclick: () => exportCsv(rows, sub) }, "Exporter en CSV"))),
        rows.length ? h("div.table-wrap", h("table.data",
          h("thead", h("tr", COLUMNS.map(([key, label, , num]) => h("th", { class: num ? "num" : "", "aria-sort": sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : null, tabindex: 0, onclick: () => { sort = { key, dir: sort.key === key ? -sort.dir : key === "username" ? 1 : -1 }; paint(); }, onkeydown: (e) => { if (e.key === "Enter") e.currentTarget.click(); } },
            label + (sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""))))),
          h("tbody", rows.map((p) => h("tr.click", { tabindex: 0, onclick: () => openPlayer(p), onkeydown: (e) => { if (e.key === "Enter") openPlayer(p); } },
            COLUMNS.map(([key, , , num]) => h("td", { class: num ? "num" : "" }, key === "username"
              ? h("div.row", { style: "gap:10px;align-items:center" }, avatarEl(p.avatar, cat, 28), h("strong", p.username))
              : (cell[key] ? cell[key](p) : String(p[key] ?? "–"))))))))) : h("p.muted", "Aucun joueur ne correspond.")),

      watchList(data.players, openPlayer),

      h("div.grid-2",
        h("section.card.stack", h("h2", "Difficulté par chapitre"),
          data.chapters.length ? hbars(data.chapters.map((c) => ({ label: c.name, value: c.accuracy, note: `${c.questions} question${c.questions > 1 ? "s" : ""} · ${c.answered} réponse${c.answered > 1 ? "s" : ""}` }))) : h("p.muted", "Aucun chapitre."),
          null),
        h("section.card.stack", h("h2", "Questions les plus ratées"),
          data.hardQuestions.length ? h("ol.stack.tight", { style: "padding-left:1.2em;margin:0" }, data.hardQuestions.map((q) => h("li", h("div", rich(q.text)), h("div.muted.small", `${q.chapter} · ${q.accuracy} % de réussite sur ${q.answered} réponses`))))
            : h("p.muted", "Il faut au moins 5 réponses à une question pour qu'elle apparaisse ici."))),

      h("div.grid-2",
        h("section.card.stack", h("h2", "Duels"),
          t.duelsFinished ? donut({ segments: [{ label: "Avec un vainqueur", value: data.duelOutcomes.decisive, cls: "c-accent" }, { label: "Égalités", value: data.duelOutcomes.draws, cls: "c-warn" }], center: String(t.duelsFinished), sub: "terminés" }) : h("p.muted", "Aucun duel terminé pour l'instant.")),
        h("section.card.stack", h("h2", "Quand les joueurs jouent"),
          h("div", h("strong.small", "Par jour de la semaine"), barChart({ bars: data.weekday.map((v, i) => ({ label: WEEKDAYS[i], parts: [{ value: v, cls: "c-accent", name: "Réponses" }] })), height: 140, labelEvery: 1, ariaLabel: "Par jour de la semaine" })),
          h("div", h("strong.small", "Par heure"), barChart({ bars: data.hours.map((v, i) => ({ label: `${i}h`, parts: [{ value: v, cls: "c-accent", name: "Réponses" }] })), height: 140, labelEvery: 3, ariaLabel: "Par heure" })),
          hourMax > 0 ? h("p.muted.small", `Heure la plus active : ${data.hours.indexOf(hourMax)} h.`) : null)));
  }
  paint();
  return root;
}

/** Panneau « Messagerie » (administrateur) : durée de conservation des messages. */
export async function chatPanel() {
  let cfg = await get("/api/chat/settings");
  const LABELS = { 2: "2 jours", 7: "1 semaine", 30: "1 mois" };
  const root = h("div.stack");
  async function choose(days) {
    try { const r = await put("/api/admin/chat", { retentionDays: days }); cfg = r; toast(r.purged ? `Conservation : ${LABELS[days]} · ${r.purged} message${r.purged > 1 ? "s" : ""} supprimé${r.purged > 1 ? "s" : ""}` : `Conservation : ${LABELS[days]}`, "good"); paint(); } catch (e) { fail(e); }
  }
  function paint() {
    root.replaceChildren(h("section.card.stack",
      h("div", h("h2", "Conservation des messages")),
      h("div.seg", { role: "radiogroup", "aria-label": "Durée de conservation" }, cfg.choices.map((d) => h("button", { type: "button", role: "radio", "aria-checked": String(d === cfg.retentionDays), "aria-pressed": String(d === cfg.retentionDays), onclick: () => choose(d) }, LABELS[d] ?? `${d} jours`))),));
  }
  paint();
  return root;
}

const DAY_MS = 86_400_000;
/** Élèves à suivre : inactifs depuis plus d'une semaine, ou en difficulté (moins de 50 % de réussite sur au moins 20 réponses). */
function watchList(players, openPlayer) {
  const now = Date.now();
  const rows = [];
  for (const p of players) {
    const idle = !p.lastActive ? Infinity : (now - new Date(p.lastActive).getTime()) / DAY_MS;
    const reasons = [];
    if (idle >= 7) reasons.push(idle === Infinity ? "n'a jamais joué" : `inactif depuis ${Math.floor(idle)} jours`);
    if (p.answers >= 20 && p.accuracy != null && p.accuracy < 50) reasons.push(`réussite ${p.accuracy} %`);
    if (reasons.length) rows.push({ p, reasons, score: (idle === Infinity ? 999 : idle) + (p.accuracy != null && p.accuracy < 50 ? 100 : 0) });
  }
  rows.sort((a, b) => b.score - a.score);
  return h("section.card.stack", h("h2", `Élèves à suivre (${rows.length})`),
    rows.length ? h("div.list", rows.slice(0, 12).map(({ p, reasons }) => h("button.item", { type: "button", onclick: () => openPlayer(p) },
      h("div.grow", h("strong", p.username), h("div.muted.small", reasons.join(" · "))), h("span.chip", { class: reasons.length > 1 ? "bad" : "amber" }, reasons.length > 1 ? "à contacter" : "à relancer"))))
      : h("p.muted", "Tout le monde joue régulièrement et réussit bien. Rien à signaler."),
    rows.length > 12 ? h("p.muted.small", `Et ${rows.length - 12} autre${rows.length - 12 > 1 ? "s" : ""}.`) : null);
}

/** Export CSV (séparateur « ; » et BOM : s'ouvre directement dans Excel en français). */
function exportCsv(rows, sub) {
  const head = ["Joueur", "Niveau", "XP", "Réponses", "Bonnes réponses", "Réussite (%)", "Temps moyen (s)", "Jours actifs", "Série", "Record de série", "Victoires", "Égalités", "Défaites", "Dernière activité"];
  const esc = (v) => { const t = String(v ?? ""); return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const lines = [head, ...rows.map((p) => [p.username, lvl(p.level), p.xp, p.answers, p.correct, p.accuracy ?? "", p.avgTimeMs == null ? "" : (p.avgTimeMs / 1000).toFixed(1).replace(".", ","), p.activeDays, p.streak, p.longestStreak, p.wins, p.draws, p.losses, p.lastActive ? new Date(p.lastActive).toISOString().slice(0, 10) : ""])];
  const blob = new Blob(["\uFEFF" + lines.map((l) => l.map(esc).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `joueurs-${(sub?.name ?? "matiere").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast("Fichier CSV téléchargé", "good");
}
