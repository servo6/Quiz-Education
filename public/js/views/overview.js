import { h, get, fail } from "../lib.js";
import { S } from "../state.js";
import { barChart, donut, fmtDay, hbars, kpi, lineChart } from "../charts.js";

const PERIODS = [[7, "7 jours"], [30, "30 jours"], [90, "3 mois"]];
const nf = (n) => new Intl.NumberFormat("fr-FR").format(n);
const best = (list, key) => list.reduce((b, x) => (x[key] > (b?.[key] ?? -1) ? x : b), null);
const plural = (n, one, many) => `${nf(n)} ${n > 1 ? many : one}`;
const PALETTE = ["c-accent", "c-good", "c-warn", "c-bad", "c-muted"];

function record(title, item, key, unit) {
  return h("div.card.flat.stack.tight", h("span.muted.small", title),
    item && item[key] > 0 ? [h("strong", { style: "font-size:1.1rem" }, item.name), h("span.muted.small", `${nf(item[key])} ${unit}`)] : h("span.muted", "Pas encore de données"));
}

function table(columns, rows) {
  return h("div.table-wrap", h("table.data",
    h("thead", h("tr", columns.map(([, label, num]) => h("th", { class: num ? "num" : "" }, label)))),
    h("tbody", rows.map((r) => h("tr", columns.map(([key, , num, fmt]) => h("td", { class: num ? "num" : "" }, fmt ? fmt(r[key], r) : String(r[key] ?? "–"))))))));
}
const pctCell = (v) => (v == null ? "–" : `${v} %`);

/** Tableau de bord du super administrateur (toute la plateforme) ou d'un administrateur d'organisation (son organisation). */
export async function overviewPanel() {
  const root = h("div.stack");
  const isRoot = S.me.user.role === "ADMIN";
  let orgs = [];
  if (!isRoot) orgs = (await get("/api/organizations")).organizations;
  if (!isRoot && !orgs.length) return h("p.muted", "Aucune organisation.");
  const sel = h("select.input", { "aria-label": "Organisation", style: "max-width:280px" }, orgs.map((o) => h("option", { value: o.id }, o.name)));
  let days = 30;
  const body = h("div.stack");

  async function load() {
    const q = isRoot ? "scope=platform" : `scope=organization&organizationId=${sel.value}`;
    const d = await get(`/api/overview?${q}&days=${days}`);
    paint(d);
  }
  function paint(d) {
    const t = d.totals;
    const labels = d.series.map((x) => fmtDay(x.date));
    const seg = h("div.seg", { role: "group", "aria-label": "Période" }, PERIODS.map(([n, label]) =>
      h("button", { type: "button", "aria-pressed": String(n === days), onclick: () => { days = n; load().catch(fail); } }, label)));
    const subjects = d.subjects;
    const ranked = (list, key) => [...list].sort((a, b) => b[key] - a[key]);
    const totalPlayers = subjects.reduce((n, s) => n + s.players, 0);

    const kpis = isRoot
      ? [kpi(t.organizations, t.organizations > 1 ? "organisations" : "organisation"), kpi(t.subjects, t.subjects > 1 ? "matières" : "matière"),
        kpi(t.players, t.players > 1 ? "joueurs" : "joueur", { sub: t.unaffiliated ? `${t.unaffiliated} sans organisation` : null }),
        kpi(t.active7, "actifs sur 7 jours", { tone: "accent", sub: t.players ? `${Math.round((t.active7 / t.players) * 100)} % des joueurs` : null }),
        kpi(t.orgAdmins, t.orgAdmins > 1 ? "admins d'organisation" : "admin d'organisation"), kpi(t.managers, t.managers > 1 ? "responsables" : "responsable"),
        kpi(t.chapters, t.chapters > 1 ? "chapitres" : "chapitre"), kpi(t.questions, t.questions > 1 ? "questions" : "question"),
        kpi(t.answers, `réponses (${days} j)`), kpi(t.accuracy == null ? "–" : `${t.accuracy} %`, "réussite globale"),
        kpi(t.banned, t.banned > 1 ? "comptes suspendus" : "compte suspendu")]
      : [kpi(t.subjects, t.subjects > 1 ? "matières" : "matière"), kpi(t.chapters, t.chapters > 1 ? "chapitres" : "chapitre"), kpi(t.questions, t.questions > 1 ? "questions" : "question"),
        kpi(t.players, t.players > 1 ? "joueurs" : "joueur"),
        kpi(t.active7, "actifs sur 7 jours", { tone: "accent", sub: t.players ? `${Math.round((t.active7 / t.players) * 100)} % des joueurs` : null }),
        kpi(t.managers, t.managers > 1 ? "responsables" : "responsable"),
        kpi(t.answers, `réponses (${days} j)`), kpi(t.accuracy == null ? "–" : `${t.accuracy} %`, "réussite globale"),
        kpi(t.banned, t.banned > 1 ? "comptes suspendus" : "compte suspendu")];

    const records = [
      ...(isRoot ? [record("Organisation la plus active", best(d.organizations, "answers"), "answers", `réponses sur ${days} jours`),
        record("Organisation la plus peuplée", best(d.organizations, "players"), "players", "joueurs")] : []),
      record("Matière la plus active", best(subjects, "answers"), "answers", `réponses sur ${days} jours`),
      record("Matière la plus peuplée", best(subjects, "players"), "players", "joueurs"),
      record("Matière la plus riche", best(subjects, "questions"), "questions", "questions"),
      record("Meilleure réussite", best(subjects.filter((s) => s.answers >= 10), "accuracy"), "accuracy", "% de bonnes réponses"),
    ];

    const modeTotal = t.games.SOLO + t.games.DUEL + t.games.FRIENDLY;
    const groups = isRoot ? d.organizations : subjects;
    const top = ranked(groups, "players");
    const shown = top.slice(0, 5);
    const rest = top.slice(5).reduce((n, g) => n + g.players, 0);
    const segs = [...shown.map((g, i) => ({ label: g.name, value: g.players, cls: PALETTE[i] })), ...(rest ? [{ label: "Autres", value: rest, cls: "c-muted" }] : [])].filter((s) => s.value > 0);
    const maxOf = (list, key) => Math.max(1, ...list.map((x) => x[key]));
    const share = (list, key) => ranked(list, key).map((x) => ({ label: x.name, value: Math.round((x[key] / maxOf(list, key)) * 100), note: nf(x[key]) }));

    body.replaceChildren(
      h("div.row.between.wrap", h("h2", isRoot ? "Toute la plateforme" : orgs.find((o) => o.id === sel.value)?.name ?? ""), seg),
      h("section.kpis", kpis),
      h("section.stack.tight", h("h2", "Records"), h("div.grid-2", records)),

      h("section.card.stack", h("h2", "Activité"),
        h("div", h("strong.small", "Réponses par jour"), barChart({ bars: d.series.map((x, i) => ({ label: labels[i], parts: [{ value: x.correct, cls: "c-good", name: "Bonnes" }, { value: x.answers - x.correct, cls: "c-bad", name: "Fausses" }] })), ariaLabel: "Réponses par jour" })),
        h("div.grid-2",
          h("div", h("strong.small", "Joueurs actifs par jour"), lineChart({ labels, series: [{ name: "Joueurs actifs", values: d.series.map((x) => x.activePlayers), cls: "c-accent" }], ariaLabel: "Joueurs actifs" })),
          h("div", h("strong.small", "Réussite (%)"), lineChart({ labels, series: [{ name: "Réussite", values: d.series.map((x) => x.accuracy), cls: "c-good" }], max: 100, unit: "%", ariaLabel: "Réussite" }))),
        h("div", h("strong.small", "Nouveaux joueurs par jour"), barChart({ bars: d.series.map((x, i) => ({ label: labels[i], parts: [{ value: x.newPlayers, cls: "c-accent", name: "Nouveaux joueurs" }] })), height: 140, ariaLabel: "Nouveaux joueurs" }))),

      h("div.grid-2",
        h("section.card.stack", h("h2", isRoot ? "Joueurs par organisation" : "Joueurs par matière"),
          segs.length ? donut({ segments: segs, center: nf(isRoot ? t.players : totalPlayers), sub: isRoot ? "joueurs" : "inscriptions" }) : h("p.muted", "Aucun joueur pour l'instant.")),
        h("section.card.stack", h("h2", "Types de parties"),
          modeTotal ? donut({ segments: [{ label: "Solo", value: t.games.SOLO, cls: "c-accent" }, { label: "Duels différés", value: t.games.DUEL, cls: "c-good" }, { label: "Duels en direct", value: t.games.FRIENDLY, cls: "c-warn" }].filter((s) => s.value > 0), center: nf(modeTotal), sub: `parties (${days} j)` })
            : h("p.muted", "Aucune partie sur la période."))),

      h("div.grid-2",
        h("section.card.stack", h("h2", "Matières les plus actives"), subjects.length ? hbars(share(subjects, "answers"), { tone: false, raw: true }) : h("p.muted", "Aucune matière."), h("p.muted.small", `Réponses données sur ${days} jours.`)),
        h("section.card.stack", h("h2", "Chapitres par matière"), subjects.length ? hbars(share(subjects, "chapters"), { tone: false, raw: true }) : h("p.muted", "Aucune matière."))),

      isRoot ? h("section.card.stack", h("h2", `Organisations (${d.organizations.length})`),
        table([["name", "Organisation"], ["subjects", "Matières", true], ["chapters", "Chapitres", true], ["questions", "Questions", true], ["players", "Joueurs", true], ["active7", "Actifs 7 j", true], ["answers", "Réponses", true], ["accuracy", "Réussite", true, pctCell]], ranked(d.organizations, "players"))) : null,
      h("section.card.stack", h("h2", `Matières (${subjects.length})`),
        subjects.length ? table([["name", "Matière"], ...(isRoot ? [["organizationName", "Organisation"]] : []), ["chapters", "Chapitres", true], ["questions", "Questions", true], ["players", "Joueurs", true], ["active7", "Actifs 7 j", true], ["answers", "Réponses", true], ["accuracy", "Réussite", true, pctCell], ["games", "Parties", true]], ranked(subjects, "players")) : h("p.muted", "Aucune matière.")));
  }

  sel.onchange = () => load().catch(fail);
  await load();
  root.append(!isRoot && orgs.length > 1 ? sel : "", body);
  return root;
}
