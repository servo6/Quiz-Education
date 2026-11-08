import { h, get, post, del, fail, icon, sheet, timeLeft, confetti, toast, chapStyle, rich } from "../lib.js";
import { S, activeSubject, go, lvl, refreshSummary, loadCatalog } from "../state.js";
import { playStage } from "../stage.js";
import { challengeLive } from "../live.js";
import { avatarEl } from "../lib.js";
import { shareButton } from "../shareResult.js";
import { roomCard } from "../rooms.js";
import { ticketRow, spendTicket, loadTickets } from "../tickets.js";

const RESULT = { WIN: ["Victoire", "good"], DRAW: ["Égalité", "amber"], LOSS: ["Défaite", "bad"], FORFEIT: ["Forfait", "bad"] };

let duelsTab = "cours";
const scoreOf = (a, b) => {
  const tone = (x, y) => (x > y ? "win" : x < y ? "lose" : "tie");
  return h("div.dscore", h("b", { class: tone(a, b) }, String(a)), h("i", "–"), h("b", { class: tone(b, a) }, String(b)));
};
// ───────── Liste ─────────
export async function duelsView() {
  const sub = activeSubject();
  const [{ duels }, tix] = await Promise.all([get(`/api/subjects/${sub.id}/duels`), loadTickets(sub.id), loadCatalog().catch(() => null)]);
  refreshSummary();
  const active = duels.filter((d) => d.status === "IN_PROGRESS");
  const mine = active.filter((d) => d.yourTurn);
  const waiting = active.filter((d) => !d.yourTurn);
  const done = duels.filter((d) => d.status !== "IN_PROGRESS");

  // ── Présentation « duel » : deux onglets, cartes avec avatars, scores colorés (vert = devant, rouge = derrière).
  const me = S.me.user;
  const tone = (a, b) => (a > b ? "win" : a < b ? "lose" : "tie");
  const scoreEl = (a, b) => h("div.dscore", h("b", { class: tone(a, b) }, String(a)), h("i", "–"), h("b", { class: tone(b, a) }, String(b)));
  const side = (u, cls) => h("div.dside", { class: cls }, h("div.dav", avatarEl(u?.avatar ?? null, S.catalog, 44)), h("span.dname", u?.username ?? "?"));
  const sofar = (d) => d.score.opponent ?? d.score.opponentSoFar ?? 0;
  const roundOf = (d) => d.next?.round ?? null;
  // Mes duels en cours où c'est à moi : cartes défilantes.
  const turnCard = (d) => h("a.dcard", { href: `#/duels/${d.id}` },
    h("div.dav.big", avatarEl(d.opponent.avatar ?? null, S.catalog, 76)),
    h("strong.dname", d.opponent.username),
    scoreEl(d.score.you, sofar(d)),
    h("span.btn.primary.block", d.next.action === "pick" ? `Choisir la manche ${d.next.round}` : `Jouer la manche ${d.next.round}`));
  // Ligne « face à face » : adversaire à gauche, moi à droite.
  const versusRow = (d, under, extra) => h("a.drow", { href: `#/duels/${d.id}` },
    side(d.opponent, "left"),
    h("div.dmid", scoreEl(sofar(d), d.score.you), under),
    side(me, "right"), extra ?? null);
  const waitingRow = (d) => versusRow(d, h("span.dsub", `${roundOf(d) ? `Manche ${roundOf(d)} · ` : ""}fin dans ${timeLeft(d.deadlineAt)}`));
  const doneRow = (d) => {
    const [label, color] = RESULT[d.result] ?? ["Terminé", ""];
    const x = h("button.dx", { type: "button", "aria-label": "Supprimer ce duel de l'historique", onclick: async (e) => {
      e.preventDefault(); e.stopPropagation();
      try { await del(`/api/games/${d.id}`); r.remove(); } catch (er) { fail(er); }
    } }, "✕");
    const r = h("div.dwrap", versusRow(d, h("span.dres", { class: color }, label)), x);
    return r;
  };
  const list = (rows) => h("div.dlist", rows);
  const section = (title, node) => (node ? h("section.stack.tight", h("h2", title), node) : null);

  const turnBox = mine.length ? h("div.hscroll", mine.map(turnCard)) : null;
  const waitBox = waiting.length ? list(waiting.map(waitingRow)) : null;
  const progressPane = h("div.stack",
    section("À toi de jouer", turnBox), section("Parties en attente", waitBox),
    !mine.length && !waiting.length ? h("div.empty", icon("duel"), h("a.btn.primary", { href: "#/duels/new" }, "Défier un camarade")) : null);
  const doneBox = done.length ? h("section.stack.tight", h("div.row.between", h("h2", "Jouées récemment"),
    h("button.btn.ghost.small", { onclick: async () => {
      if (!confirm("Effacer tout l'historique des duels ? Tes statistiques et ton XP restent acquis.")) return;
      try { await del(`/api/subjects/${sub.id}/history?mode=duel`); donePane.replaceChildren(h("p.muted", "Aucune partie terminée.")); } catch (e) { fail(e); }
    } }, "Tout effacer")), list(done.slice(0, 30).map(doneRow))) : null;
  const donePane = h("div.stack", doneBox ?? h("p.muted", "Aucune partie terminée."));
  const tabs = [["cours", `Parties en cours${mine.length ? ` (${mine.length})` : ""}`, progressPane], ["finies", "Parties terminées", donePane]];
  const tabBtns = tabs.map(([id, label, pane]) => h("button", { type: "button", role: "tab", "aria-selected": String(id === duelsTab), onclick: () => {
    duelsTab = id; tabBtns.forEach((b, i) => b.setAttribute("aria-selected", String(tabs[i][0] === id))); tabs.forEach(([k,, pn]) => (pn.hidden = k !== id));
  } }, label));
  tabs.forEach(([k,, pn]) => (pn.hidden = k !== duelsTab));
  const tabsBar = h("div.dtabs", { role: "tablist" }, tabBtns);

  const roomHist = await get(`/api/subjects/${sub.id}/rooms`).then((r) => r.rooms).catch(() => []);
  return h("div.stack",
    h("div.row.between", h("h1", "Duels"), h("a.btn.primary", { href: "#/duels/new" }, "Nouveau duel")),
    roomCard(sub.id),
    roomHist.length ? h("section.stack.tight", h("h2", "Derniers salons"), h("div.list", roomHist.slice(0, 5).map((r) => h("div.item",
      h("span.chip", { class: r.rank === 1 ? "amber" : "" }, r.rank === 1 ? "🥇" : `${r.rank}e`),
      h("div.grow", h("strong", `Salon ${r.code}`), h("div.muted.small", `${r.players} joueurs · ${r.score} pts · ${r.correct}/${r.size} bonnes réponses`)),
      r.coinsEarned ? h("span.chip", `+${r.coinsEarned} 🪙`) : null)))) : null,
    tix ? h("div.tickets-bar", ticketRow("duel", tix.duel.left, tix.duel.total, { big: true }), ticketRow("live", null, null, { big: true })) : null,
    tabsBar, progressPane, donePane);
}
function statusText(d) {
  const n = d.next;
  if (n.action === "pick") return `Choisis le chapitre de la manche ${n.round}`;
  if (n.action === "play") return `Manche ${n.round} à jouer`;
  return `${d.opponent.username} doit jouer`;
}
function liveScore(d) { return `${d.score.you} – ${d.score.opponent ?? d.score.opponentSoFar ?? 0}`; }
function resultText(d) { return d.score.opponent == null ? "" : `${d.score.you} – ${d.score.opponent}`; }

// ───────── Nouveau duel ─────────
export async function duelNewView() {
  const sub = activeSubject();
  const [ch, pl, tix] = await Promise.all([
    get(`/api/subjects/${sub.id}/chapters`),
    get(`/api/subjects/${sub.id}/players`),
    loadTickets(sub.id),
    loadCatalog().catch(() => null),
  ]);
  const tixDuel = tix ? ticketRow("duel", tix.duel.left, tix.duel.total, { big: true }) : null;
  const usable = ch.chapters.filter((c) => c.questionCount > 0);
  let chosen = null;
  const playersBox = h("div.list");
  const q = h("input.input", { type: "search", placeholder: "Chercher un joueur", "aria-label": "Chercher un joueur",
    oninput: debounce(async () => { const r = await get(`/api/subjects/${sub.id}/players?q=${encodeURIComponent(q.value)}`).catch(() => null); if (r) paint(r.players); }, 250) });
  const random = h("button.btn.block", { disabled: true, onclick: () => create(() => post(`/api/subjects/${sub.id}/duels/random`, { chapterId: chosen.id })) }, "Adversaire au hasard");

  async function create(fn) {
    if (!chosen) return toast("Choisis d'abord un chapitre", "bad");
    try { const r = await fn(); await spendTicket(tixDuel); go(`/duels/${r.duel.id}`); } catch (e) { fail(e); }
  }
  const buttons = usable.map((c) => {
    const b = h("button.chapter", { "aria-pressed": "false", style: chapStyle(c), onclick: () => {
      chosen = c; buttons.forEach((x) => x.setAttribute("aria-pressed", String(x === b))); random.disabled = false;
    } }, h("strong", c.name), h("span.muted.small", `${c.questionCount} questions`));
    return b;
  });
  function paint(players) {
    playersBox.replaceChildren(...(players.length ? players.map((p) => h("button.item", {
      onclick: () => create(() => post("/api/duels", { subjectId: sub.id, opponentId: p.id, chapterId: chosen.id })),
    }, h("span.dav", avatarEl(p.avatar ?? null, S.catalog, 44)), h("div.grow", h("strong", p.username), h("div.muted.small", `Niveau ${lvl(p.level)}`)),
      p.online ? h("span.chip.good.dot", "en ligne") : null)) : [h("p.muted", "Aucun joueur trouvé.")]));
  }
  paint(pl.players);
  const online = pl.players.filter((p) => p.online && !p.busy);
  const liveBox = h("section.card.stack", h("div.row.between", h("h2", "En ligne"), ticketRow("live", null, null)),
    online.length ? h("div.list", online.map((p) => h("button.item", { onclick: () => challengeLive(sub.id, p) }, h("span.dav", avatarEl(p.avatar ?? null, S.catalog, 44)),
      h("div.grow", h("strong", p.username), h("div.muted.small", `Niveau ${lvl(p.level)}`)), h("span.chip.good.dot", "en ligne")))) : h("p.muted", "Personne en ligne"));

  // Deux modes distincts : le duel différé (chacun joue à son rythme) et le duel en direct (les deux en même temps).
  const deferred = h("div.stack",
    h("section.stack", h("div.row.between", h("h2", "Chapitre"), tixDuel),
      usable.length ? h("div.chapters", buttons) : h("p.muted", "Aucun chapitre jouable")),
    h("section.stack", h("h2", "Adversaire"),
      random, q, playersBox));
  const live = h("div.stack", liveBox);
  const tabDeferred = h("button.btn", { type: "button", role: "tab", "aria-selected": "true" }, "Duel différé");
  const tabLive = h("button.btn", { type: "button", role: "tab", "aria-selected": "false" }, "Duel en direct");
  const show = (isLive) => {
    deferred.hidden = isLive; live.hidden = !isLive;
    tabDeferred.setAttribute("aria-selected", String(!isLive)); tabLive.setAttribute("aria-selected", String(isLive));
    tabDeferred.classList.toggle("primary", !isLive); tabLive.classList.toggle("primary", isLive);
  };
  tabDeferred.onclick = () => show(false); tabLive.onclick = () => show(true);
  show(false);
  return h("div.stack",
    h("a.muted", { href: "#/duels" }, "← Mes duels"),
    h("h1", "Nouveau duel"),
    h("div.row.wrap", { role: "tablist" }, tabDeferred, tabLive),
    deferred, live);
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ───────── Détail ─────────
export async function duelDetailView({ id }) {
  const [d] = await Promise.all([get(`/api/duels/${id}`), loadCatalog().catch(() => null)]);
  const duel = d.duel;
  if (duel.status !== "IN_PROGRESS") { go(`/duels/${id}/result`); return h("div"); }
  const me = S.me.user.username;
  const n = duel.next;

  let action;
  if (n.action === "play") {
    action = h("a.btn.primary.block", { href: `#/duels/${id}/play` }, `Jouer la manche ${n.round}`);
  } else if (n.action === "pick") {
    action = h("div.stack", h("h2", `Manche ${n.round}`),
      h("div.chapters", (d.chapters ?? []).filter((c) => c.questionCount > 0).map((c) =>
        h("button.chapter", { style: chapStyle(c), onclick: async () => {
          try { await post(`/api/duels/${id}/pick`, { chapterId: c.id }); go(`/duels/${id}/play`); } catch (e) { fail(e); }
        } }, h("strong", c.name), h("span.muted.small", `${c.questionCount} questions`)))));
  } else {
    action = h("p.muted", `⏳ ${duel.opponent.username}`);
  }

  return h("div.stack",
    h("a.muted", { href: "#/duels" }, "← Mes duels"),
    h("section.card.stack",
      h("div.vs",
        h("div", h("span.dav.big", avatarEl(S.me.user.avatar ?? null, S.catalog, 64)), h("div", me)),
        h("div.score", `${duel.score.you} – ${duel.score.opponent ?? duel.score.opponentSoFar ?? 0}`),
        h("div", h("span.dav.big", avatarEl(duel.opponent.avatar ?? null, S.catalog, 64)), h("div", duel.opponent.username))),
      h("div.center", h("span.chip", `⏳ ${timeLeft(duel.deadlineAt)}`))),
    h("section.card.stack", { class: n.action === "wait" ? "" : "state-play" }, action),
    h("section.stack.tight", h("h2", `Manches (${duel.rounds})`),
      h("div.rounds", Array.from({ length: duel.rounds }, (_, i) => {
        const r = d.rounds.find((x) => x.number === i + 1);
        return h("div.round", h("span.n", String(i + 1)),
          h("div", r ? h("strong", r.chapter?.name ?? r.chapter ?? "") : h("span.muted", "Pas encore ouverte"),
            r ? h("div.muted.small", `${r.questions} questions · ouverte par ${r.openedBy === "you" ? "toi" : duel.opponent.username}`) : null),
          r ? h("span.chip", `${r.you.correct}${r.opponent ? " – " + r.opponent.correct : ""}`) : null);
      }))),
    h("button.btn.ghost.danger", { onclick: async () => {
      if (!confirm("Abandonner ce duel ? Ton adversaire sera déclaré vainqueur.")) return;
      try { await post(`/api/duels/${id}/forfeit`); go(`/duels/${id}/result`); } catch (e) { fail(e); }
    } }, "Abandonner le duel"));
}

// ───────── Jouer une manche ─────────
export async function duelPlayView({ id }, ctx) {
  const [cur] = await Promise.all([get(`/api/duels/${id}/current`), loadCatalog().catch(() => null)]);
  if (cur.status !== "IN_PROGRESS") { go(`/duels/${id}`); return h("div"); }
  const total = cur.question.total;
  const { el, cleanup } = playStage({
    total, question: cur.question, label: "Duel", versus: cur.versus, scores: { ...(cur.scores ?? { you: 0, opponent: 0 }) },
    answer: (gq, idx) => post(`/api/duels/${id}/answer`, { gameQuestionId: gq, choiceIndex: idx }),
    markServed: () => get(`/api/duels/${id}/current`),
    loadNext: async () => { const n = await get(`/api/duels/${id}/current`); return n.status === "IN_PROGRESS" ? n.question : null; },
    onDone: async (res) => {
      refreshSummary();
      if (res?.duel && res.duel.status !== "IN_PROGRESS") go(`/duels/${id}/result`);
      else { toast("Manche terminée", "good"); go(`/duels/${id}`); }
    },
    onQuit: () => go(`/duels/${id}`),
  });
  ctx.setCleanup(cleanup);
  return el;
}

// ───────── Résultat ─────────
export async function duelResultView({ id }) {
  const sub = activeSubject();
  const [r] = await Promise.all([get(`/api/duels/${id}/result`), loadCatalog().catch(() => null)]);
  const duel = r.duel;
  if (duel.status === "IN_PROGRESS") { go(`/duels/${id}`); return h("div"); }
  const [label, kind] = RESULT[r.result] ?? ["Terminé", ""];
  if (r.result === "WIN") setTimeout(confetti, 200);
  const me = S.me.user.username, opp = duel.opponent.username;

  return h("div.stack",
    h("a.muted", { href: "#/duels" }, "← Mes duels"),
    h("section.card.center.stack",
      h("div.rvs",
        h("div.dside.left", h("span.dav.big", avatarEl(S.me.user.avatar ?? null, S.catalog, 76)), h("span.dname", me)),
        h("div.dmid", scoreOf(duel.score.you, duel.score.opponent ?? 0), h("span.dres", { class: kind }, label)),
        h("div.dside.right", h("span.dav.big", avatarEl(duel.opponent.avatar ?? null, S.catalog, 76)), h("span.dname", opp))),
      h("div", h("span.chip.amber", `+${r.xpEarned} XP`), " ", h("span.chip", `Niveau ${lvl(r.level)}`)),
      duel.status === "ABANDONED" ? h("p.muted.small", "Duel abandonné sans réponse : aucun XP.") : null),
    h("div.row.wrap",
      h("button.btn.primary.grow", { onclick: () => rematch(id, sub) }, "Revanche"),
      shareButton({ kind: "Duel", title: `${me} contre ${opp}`, big: `${duel.score.you} – ${duel.score.opponent ?? 0}`, sub: label, chips: [`+${r.xpEarned} XP`, `Niveau ${lvl(r.level)}`], footer: r.result === "WIN" ? "Viens me défier !" : "Revanche ?" }),
      h("a.btn.ghost.grow", { href: "#/duels" }, "Mes duels")),
    h("h2", "Correction"),
    h("div.review", r.review.map((q) =>
      h("div.review-item", { class: q.you?.correct ? "ok" : "ko" },
        h("div.muted.small", `Manche ${q.round} · ${q.chapter?.name ?? q.chapter ?? ""}`),
        h("strong", rich(q.text)),
        h("ul", q.choices.map((c, i) => h("li", { class: i === q.correctIndex ? "right" : "" },
          rich(c), i === q.correctIndex ? " ✓" : "",
          i === q.you?.choice ? " · toi" : "", i === q.opponent?.choice ? ` · ${opp}` : ""))),
        q.explanation ? h("p.muted.small", rich(q.explanation)) : null))));
}

async function rematch(id, sub) {
  const ch = await get(`/api/subjects/${sub.id}/chapters`).catch(() => ({ chapters: [] }));
  sheet("Revanche : choisis le chapitre", (close) => h("div.chapters", ch.chapters.filter((c) => c.questionCount > 0).map((c) =>
    h("button.chapter", { style: chapStyle(c), onclick: async () => {
      try { const r = await post(`/api/duels/${id}/rematch`, { chapterId: c.id }); close(); go(`/duels/${r.duel.id}`); } catch (e) { fail(e); }
    } }, h("strong", c.name), h("span.muted.small", `${c.questionCount} questions`)))));
}
