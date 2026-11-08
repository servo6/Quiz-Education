import { h, get, icon, avatarEl } from "../lib.js";
import { activeSubject, loadCatalog, lvl } from "../state.js";
import { barChart, donut, fmtDay, hbars, kpi, lineChart, monthCalendar, yearHeatmap } from "../charts.js";

const PERIODS = [[7, "7 jours"], [30, "30 jours"], [90, "3 mois"], [365, "1 an"]];
const WEEKDAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const secs = (ms) => (ms == null ? "–" : `${(ms / 1000).toFixed(1).replace(".", ",")} s`);
const plural = (n, a, b = a + "s") => (n > 1 ? b : a);

/** Corps de la page de statistiques d'un joueur (aussi utilisé par l'administration). `load(days)` renvoie les données. */
export async function playerStatsBody(load, { initialDays = 30 } = {}) {
  let days = initialDays;
  let data = await load(days);
  const root = h("div.stack");
  let calMonth = null; // { year, month }

  async function setDays(d) {
    days = d;
    data = await load(days);
    paint();
  }

  function paint() {
    const t = data.totals, st = data.streaks, du = data.duels;
    const today = data.today;
    if (!calMonth) calMonth = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 };

    // Les 7 derniers jours, pointés
    const last7 = data.series.length >= 7 ? data.series.slice(-7) : data.series;
    const week = h("div.week-strip", last7.map((d) => h("span", h("i", { class: d.answers > 0 ? "on" : "", title: `${d.answers} réponse${d.answers > 1 ? "s" : ""}` }, d.answers > 0 ? icon("check") : ""), WEEKDAYS[(new Date(d.date + "T12:00:00Z").getUTCDay() + 6) % 7])));
    week.querySelectorAll("svg").forEach((s) => { s.style.width = "16px"; s.style.height = "16px"; });

    const seg = h("div.seg", { role: "group", "aria-label": "Période" }, PERIODS.map(([d, label]) =>
      h("button", { type: "button", "aria-pressed": String(d === days), onclick: () => setDays(d) }, label)));

    const labels = data.series.map((d) => fmtDay(d.date));
    const cal = h("div");
    const paintCal = () => {
      const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1];
      cal.replaceChildren(monthCalendar({
        ...calMonth, days: data.calendar, today,
        canNext: calMonth.year < ty || (calMonth.year === ty && calMonth.month < tm),
        onNav: (delta) => { let m = calMonth.month + delta, y = calMonth.year; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; } calMonth = { year: y, month: m }; paintCal(); },
      }));
    };
    paintCal();

    const weak = [...data.chapters].filter((c) => c.answered >= 3).sort((a, b) => a.accuracy - b.accuracy)[0];
    const hourMax = Math.max(...data.hours);
    const bestHour = hourMax > 0 ? data.hours.indexOf(hourMax) : null;

    root.replaceChildren(
      weekCard(data.insights) ?? "",
      h("section.kpis",
        kpi(st.daysCurrent, `${plural(st.daysCurrent, "jour")} de série`, { tone: st.daysCurrent > 0 ? "accent" : "", sub: st.practicedToday ? "Déjà pratiqué aujourd'hui" : st.daysCurrent > 0 ? "Pratique aujourd'hui pour la garder" : "Lance une partie pour démarrer" }),
        kpi(st.daysLongest, `${plural(st.daysLongest, "jour")}, record de série`),
        kpi(t.correct, plural(t.correct, "bonne réponse"), { sub: `sur ${t.answers}` }),
        kpi(t.accuracy == null ? "–" : `${t.accuracy} %`, "de réussite", { tone: t.accuracy >= 75 ? "good" : "" }),
        kpi(du.wins, plural(du.wins, "victoire"), { sub: du.played ? `${du.played} duel${du.played > 1 ? "s" : ""} joué${du.played > 1 ? "s" : ""}` : "Aucun duel terminé" }),
        kpi(t.activeDays, `${plural(t.activeDays, "jour")} pratiqué${t.activeDays > 1 ? "s" : ""}`)),

      h("div.grid-2",
        h("section.card.stack", h("h2", h("span.flame", icon("flame")), " Séries"),
          h("div.kpis", kpi(st.daysCurrent, "jours d'affilée"), kpi(st.daysLongest, "record (jours)"), kpi(st.correctCurrent, "bonnes réponses d'affilée"), kpi(st.correctLongest, "record (réponses)")),
          h("div.stack.tight", h("strong.small", "7 derniers jours"), week)),
        h("section.card.stack", h("h2", "Duels"),
          du.played === 0 ? h("p.muted", "Aucun duel") : h("div.stack",
            donut({ segments: [{ label: "Victoires", value: du.wins, cls: "c-good" }, { label: "Égalités", value: du.draws, cls: "c-warn" }, { label: "Défaites", value: du.losses, cls: "c-bad" }], center: du.winRate == null ? "–" : `${Math.round(du.winRate)} %`, sub: "victoires" }),
            h("div.stack.tight", h("strong.small", "Derniers duels (du plus récent)"), h("div.form-chips", du.recent.map((r) => h("b", { class: r, title: r === "W" ? "Victoire" : r === "D" ? "Égalité" : "Défaite" }, r === "W" ? "V" : r === "D" ? "N" : "D")))),
            h("p.muted.small", `Meilleure série de victoires : ${du.bestWinRun} · en cours : ${du.currentWinRun}`)))),

      h("section.card.stack",
        h("div.row.between.wrap", h("h2", "Évolution"), seg),
        h("div.stack",
          h("div", h("strong.small", "Réponses par jour"), barChart({ bars: data.series.map((d, i) => ({ label: labels[i], parts: [{ value: d.correct, cls: "c-good", name: "Bonnes" }, { value: d.answers - d.correct, cls: "c-bad", name: "Fausses" }] })), ariaLabel: "Réponses par jour" })),
          h("div", h("strong.small", "Taux de réussite (%)"), lineChart({ labels, series: [{ name: "Réussite", values: data.series.map((d) => d.accuracy), cls: "c-accent" }], max: 100, unit: "%", ariaLabel: "Taux de réussite par jour" })),
          h("div", h("strong.small", "XP gagnée par jour"), lineChart({ labels, series: [{ name: "XP", values: data.series.map((d) => d.xp), cls: "c-warn" }], ariaLabel: "XP par jour" })))),

      h("div.grid-2",
        h("section.card.stack", h("h2", h("span", icon("calendar")), " Calendrier"), cal,
          h("p.muted.small", data.bestDay ? `Meilleur jour : ${data.bestDay.answers} réponses le ${data.bestDay.date.split("-").reverse().join("/")}.` : "Les jours où tu joues apparaissent ici.")),
        h("section.card.stack", h("h2", "Régularité sur un an"), yearHeatmap(data.calendar, today))),

      h("div.grid-2",
        h("section.card.stack", h("h2", "Par chapitre"),
          data.chapters.length ? hbars(data.chapters.map((c) => ({ label: c.name, value: c.accuracy, note: `${c.correct} / ${c.answered} bonnes réponses` }))) : h("p.muted", "Joue quelques questions pour voir tes points forts et tes points faibles."),
          weak && weak.accuracy < 75 ? h("p.chip.amber", { style: "justify-self:start" }, `À revoir : ${weak.name} (${weak.accuracy} %)`) : null),
        h("section.card.stack", h("h2", "Rythme"),
          h("div", h("strong.small", "Réponses selon le jour de la semaine"), barChart({ bars: data.weekday.map((w, i) => ({ label: WEEKDAYS[i], parts: [{ value: w.answers, cls: "c-accent", name: "Réponses" }] })), height: 150, labelEvery: 1, ariaLabel: "Activité par jour de la semaine" })),
          h("div", h("strong.small", "Réponses selon l'heure"), barChart({ bars: data.hours.map((v, i) => ({ label: `${i}h`, parts: [{ value: v, cls: "c-accent", name: "Réponses" }] })), height: 150, labelEvery: 3, ariaLabel: "Activité par heure" })),
          h("div.kpis", kpi(secs(t.avgTimeMs), "temps moyen par réponse"), kpi(bestHour == null ? "–" : `${bestHour} h`, "heure la plus active"), kpi(t.timedOut, `${plural(t.timedOut, "temps écoulé", "temps écoulés")}`)))),

      h("section.card.stack", h("h2", "Solo et duels"),
        h("div.grid-2",
          h("div.stack.tight", h("strong", "Solo"), h("p.muted", data.solo.finished ? `${data.solo.finished} partie${data.solo.finished > 1 ? "s" : ""} terminée${data.solo.finished > 1 ? "s" : ""}${data.solo.avgScore != null ? ` · score moyen ${data.solo.avgScore} %` : ""}${data.solo.best ? ` · meilleur : ${data.solo.best.correct}/${data.solo.best.total}` : ""}` : "Aucune partie solo terminée."), data.byMode.SOLO ? hbars([{ label: "Réussite en solo", value: data.byMode.SOLO.accuracy }]) : null),
          h("div.stack.tight", h("strong", "Duels"), h("p.muted", du.played ? `${du.played} duel${du.played > 1 ? "s" : ""} terminé${du.played > 1 ? "s" : ""} · ${du.wins} V · ${du.draws} N · ${du.losses} D` : "Aucun duel terminé."), data.byMode.DUEL ? hbars([{ label: "Réussite en duel", value: data.byMode.DUEL.accuracy }]) : null))));
  }
  paint();
  return root;
}

/** « Cette semaine » : tendance des 7 derniers jours, chapitres forts et à retravailler. */
function weekCard(ins) {
  if (!ins || !ins.recent.answers) return null;
  const d = ins.delta;
  const trend = d == null ? h("span.chip", "Première semaine d'activité")
    : d > 0 ? h("span.chip.good", `▲ +${d} points`) : d < 0 ? h("span.chip.bad", `▼ ${d} points`) : h("span.chip", "= stable");
  const list = (title, rows, cls) => rows.length ? h("div.stack.tight", h("strong.small", title), h("div.form-chips", rows.map((c) => h("span.chip", { class: cls, title: `${c.answered} réponses` }, `${c.name} · ${c.accuracy} %`)))) : null;
  return h("section.card.stack", h("h2", "Cette semaine"),
    h("div.row.between.wrap", h("div", h("strong", `${ins.recent.accuracy} % de réussite`), h("div.muted.small", `${ins.recent.correct} bonnes réponses sur ${ins.recent.answers}`
      + (ins.previous.answers ? ` · semaine précédente : ${ins.previous.accuracy} %` : ""))), trend),
    list("Points forts", ins.strong, "good"), list("À retravailler", ins.weak, "amber"));
}

/** Comparaison avec un ami : statistiques côte à côte et bilan de vos duels. */
export async function compareView({ friendId }) {
  const sub = activeSubject();
  const [r, cat] = await Promise.all([get(`/api/subjects/${sub.id}/stats/compare/${friendId}`), loadCatalog().catch(() => [])]);
  const { me, friend, headToHead: hh } = r;
  const head = (p) => h("div.center.stack.tight", avatarEl(p.player.avatar, cat, 56), h("strong", p.player.username), h("div.muted.small", `Niveau ${lvl(p.player.level)}`));
  // Une ligne : valeur de chacun, la meilleure est mise en valeur (plus petit = meilleur si `lower`).
  const row = (label, a, b, fmt = (v) => (v == null ? "–" : String(v)), lower = false) => {
    const win = a == null || b == null || a === b ? 0 : (lower ? a < b : a > b) ? 1 : -1;
    return h("div.cmp-row", h("b", { class: win === 1 ? "win" : "" }, fmt(a)), h("span.muted.small", label), h("b", { class: win === -1 ? "win" : "" }, fmt(b)));
  };
  const chapNames = [...new Set([...me.chapters, ...friend.chapters].map((c) => c.name))].sort();
  const acc = (p, n) => p.chapters.find((c) => c.name === n)?.accuracy ?? null;
  return h("div.stack",
    h("a.muted", { href: "#/friends" }, "← Amis"),
    h("h1", "Comparer"),
    h("section.card.stack", h("div.cmp-head", head(me), h("span.vs-badge", "VS"), head(friend)),
      h("div.stack.tight",
        row("Réussite", me.totals.accuracy, friend.totals.accuracy, (v) => (v == null ? "–" : `${v} %`)),
        row("Bonnes réponses", me.totals.correct, friend.totals.correct),
        row("Temps moyen", me.totals.avgTimeMs, friend.totals.avgTimeMs, (v) => (v == null ? "–" : `${(v / 1000).toFixed(1).replace(".", ",")} s`), true),
        row("XP gagnée", me.totals.xp, friend.totals.xp),
        row("Jours de série", me.streak, friend.streak),
        row("Record de série", me.longestStreak, friend.longestStreak),
        row("Duels gagnés", me.duels.wins, friend.duels.wins))),
    h("section.card.center.stack", h("h2", "Vos duels l'un contre l'autre"),
      hh.played ? h("div", h("div.result-score", `${hh.wins} – ${hh.losses}`), h("div.muted.small", `${hh.played} duel${hh.played > 1 ? "s" : ""} · ${hh.draws} égalité${hh.draws > 1 ? "s" : ""}`))
        : h("p.muted", "Vous ne vous êtes pas encore affrontés."),
      h("a.btn.primary", { href: "#/duels/new" }, "Défier")),
    chapNames.length ? h("section.card.stack", h("h2", "Par chapitre"),
      h("div.stack.tight", chapNames.map((n) => row(n, acc(me, n), acc(friend, n), (v) => (v == null ? "–" : `${v} %`))))) : null);
}

export async function statsView() {
  const sub = activeSubject();
  const [cat] = await Promise.all([loadCatalog().catch(() => [])]);
  const first = await get(`/api/subjects/${sub.id}/stats/full?days=30`);
  const body = await playerStatsBody((d) => get(`/api/subjects/${sub.id}/stats/full?days=${d}`), { initialDays: 30 });
  return h("div.stack",
    h("div.row", { style: "gap:14px;align-items:center" }, avatarEl(first.player.avatar, cat, 56),
      h("div.grow", h("h1", "Statistiques"), h("div.muted.small", `${first.player.username} · niveau ${lvl(first.player.level)} · ${first.rank}${first.rank === 1 ? "er" : "e"} sur ${first.totalPlayers}`))),
    body);
}
