import { h, get, post, icon, sheet, fail, toast } from "../lib.js";
import { S, activeSubject, loadCatalog, lvl } from "../state.js";
import { avatarEl } from "../lib.js";

const METRICS = [["xp", "Expérience"], ["wins", "Victoires"], ["correct", "Bonnes réponses"]];
const PERIODS = [["today", "Aujourd'hui"], ["week", "Cette semaine"], ["month", "Ce mois-ci"], ["year", "Cette année"], ["all", "Depuis le début"]];
const UNIT = { xp: "XP", wins: "victoire", correct: "bonne réponse" };
const unit = (metric, v) => (metric === "xp" ? "XP" : `${UNIT[metric]}${v > 1 ? "s" : ""}`);
let choice = { metric: "xp", period: "all" };

export async function rankingView() {
  const sub = activeSubject();
  const cat = await loadCatalog().catch(() => []);
  const root = h("div.stack");
  const list = h("div.stack");

  const seg = (items, key) => h("div.seg", { role: "group" }, items.map(([v, label]) =>
    h("button", { type: "button", "aria-pressed": String(choice[key] === v), onclick: () => { choice = { ...choice, [key]: v }; paintControls(); load(); } }, label)));
  const controls = h("div.rank-controls");
  const paintControls = () => controls.replaceChildren(seg(METRICS, "metric"), seg(PERIODS, "period"));

  async function load() {
    list.replaceChildren(h("div.center", { style: "padding:24px" }, h("div.spinner")));
    let r;
    try { r = await get(`/api/subjects/${sub.id}/ranking?metric=${choice.metric}&period=${choice.period}&limit=100`); } catch (e) { list.replaceChildren(h("p.error-box", e.message)); return; }
    const me = S.me.user.id;
    const open = (p) => p.id !== me && profile(sub, p, cat);
    const top = r.players.filter((p) => p.rank <= 3).slice(0, 3);
    const rest = r.players.filter((p) => !top.includes(p));
    const pod = (p, place) => !p ? h("div") : h("button.pod", { class: `p${place} ${p.id === me ? "me" : ""}`, onclick: () => open(p), "aria-label": `${p.rank}e : ${p.username}, ${p.value} ${unit(r.metric, p.value)}` },
      place === 1 ? h("span.crown", icon("crown")) : null,
      avatarEl(p.avatar, cat, place === 1 ? 72 : 58),
      h("span.name", p.username),
      h("span.tt", { style: p.title?.color ? `color:${p.title.color}` : "" }, p.title?.name ?? ""),
      h("span.val", `${p.value} ${unit(r.metric, p.value)}`),
      h("div.step", String(p.rank)));
    // Ordre classique d'un podium : 2e, 1er, 3e (les ex æquo gardent leur rang réel).
    const [p1, p2, p3] = [top[0], top[1], top[2]];
    list.replaceChildren(...[
      r.players.length === 0 ? h("div.empty", icon("rank"), h("p", "Aucun résultat")) : null,
      top.length ? h("section.card", h("div.podium", pod(p2, 2), pod(p1, 1), pod(p3, 3))) : null,
      rest.length ? h("div.list", rest.map((p) => h("button.item", { class: p.id === me ? "me" : "", onclick: () => open(p) },
        h("span.rank", String(p.rank)),
        avatarEl(p.avatar, cat, 44),
        h("div.grow", h("strong", p.username), h("div.small", { style: p.title?.color ? `color:${p.title.color};font-weight:700` : "" }, p.title?.name ?? "")),
        h("div", { style: "text-align:right" }, h("strong", `${p.value} ${unit(r.metric, p.value)}`), h("div.muted.small", `Niv. ${lvl(p.level)}`))))) : null,
      r.you.rank && !r.players.some((p) => p.id === me) ? h("p.muted.center", `Tu es ${r.you.rank}${r.you.rank === 1 ? "er" : "e"} avec ${r.you.value} ${unit(r.metric, r.you.value)}.`) : null,
      !r.you.rank && r.players.length ? h("p.muted.center", "Tu n'as pas encore de point sur cette période.") : null].filter(Boolean));
    count.textContent = `${r.totalPlayers} joueur${r.totalPlayers > 1 ? "s" : ""}`;
  }
  const count = h("span.muted", "");
  paintControls();
  root.append(h("div.row.between", h("h1", "Classement"), count), controls, list);
  await load();
  return root;
}

async function profile(sub, p, cat) {
  let d;
  try { d = await get(`/api/subjects/${sub.id}/players/${p.id}`); } catch (e) { return fail(e); }
  const hh = d.headToHead;
  sheet(p.username, () => h("div.stack",
    h("div.row", avatarEl(p.avatar, cat, 72), h("div", h("strong", p.username), h("div.muted.small", `${d.rank}e · ${p.xp} XP · niveau ${p.level}`))),
    h("div.stats", h("div.stat", h("b", `${d.answers.accuracy ?? "–"} %`), h("span.muted.small", "Réussite")), h("div.stat", h("b", String(d.duels.wins)), h("span.muted.small", "Duels gagnés")), h("div.stat", h("b", String(d.duels.played)), h("span.muted.small", "Duels joués"))),
    hh ? h("div.card.flat", h("strong", "Vous deux"), h("p", hh.played ? `${hh.yourWins} victoire${hh.yourWins > 1 ? "s" : ""} pour toi, ${hh.theirWins} pour lui, ${hh.draws} égalité${hh.draws > 1 ? "s" : ""}.` : "Vous ne vous êtes pas encore affrontés.")) : null,
    d.badges.length ? h("div.row.wrap", d.badges.map((b) => h("span.chip", `${b.icon || "🏅"} ${b.name}`))) : h("p.muted.small", "Pas encore de badge."),
    h("div.row", { style: "gap:8px" },
      h("a.btn.primary.grow", { href: "#/duels/new", onclick: () => document.querySelector(".sheet-back")?.remove() }, "Défier"),
      h("button.btn.grow", { onclick: async (e) => { try { const r = await post(`/api/subjects/${sub.id}/friends`, { userId: p.id }); toast(r.status === "ACCEPTED" ? "Vous êtes maintenant amis" : "Invitation envoyée", "good"); e.target.disabled = true; } catch (ex) { fail(ex); } } }, icon("userplus"), "Ajouter en ami"))));
}
