import { h, get, post, fail, icon, sheet, timeLeft, confetti, toast, chapStyle } from "../lib.js";
import { S, activeSubject, go, lvl, refreshSummary, loadCatalog } from "../state.js";
import { playStage } from "../stage.js";
import { challengeLive } from "../live.js";
import { avatarEl } from "../lib.js";

const initial = (name) => h("span.initial", (name ?? "?").slice(0, 1).toUpperCase());
const RESULT = { WIN: ["Victoire", "good"], DRAW: ["Égalité", "amber"], LOSS: ["Défaite", "bad"], FORFEIT: ["Forfait", "bad"] };

// ───────── Liste ─────────
export async function duelsView() {
  const sub = activeSubject();
  const { duels } = await get(`/api/subjects/${sub.id}/duels`);
  refreshSummary();
  const active = duels.filter((d) => d.status === "IN_PROGRESS");
  const mine = active.filter((d) => d.yourTurn);
  const waiting = active.filter((d) => !d.yourTurn);
  const done = duels.filter((d) => d.status !== "IN_PROGRESS");

  const row = (d) => h("a.item", { href: `#/duels/${d.id}` },
    initial(d.opponent.username),
    h("div.grow", h("strong", d.opponent.username),
      h("div.muted.small", d.status === "IN_PROGRESS" ? statusText(d) : resultText(d))),
    d.status === "IN_PROGRESS"
      ? h("span.chip", { class: d.yourTurn ? "amber" : "" }, d.yourTurn ? "À toi" : `fin dans ${timeLeft(d.deadlineAt)}`)
      : h("span.chip", { class: RESULT[d.result]?.[1] ?? "" }, RESULT[d.result]?.[0] ?? "Terminé"));
  const section = (title, list) => list.length ? h("section.stack.tight", h("h2", title), h("div.list", list.map(row))) : null;

  return h("div.stack",
    h("div.row.between", h("h1", "Duels"), h("a.btn.primary", { href: "#/duels/new" }, "Nouveau duel")),
    duels.length === 0 ? h("div.empty", icon("duel"), h("p", "Aucun duel pour l'instant."), h("a.btn.primary", { href: "#/duels/new" }, "Défier un camarade")) : null,
    section("À ton tour", mine), section("En attente de l'adversaire", waiting), section("Terminés", done.slice(0, 15)));
}
function statusText(d) {
  const n = d.next;
  if (n.action === "pick") return `Choisis le chapitre de la manche ${n.round}`;
  if (n.action === "play") return `Manche ${n.round} à jouer`;
  return `${d.opponent.username} doit jouer`;
}
function resultText(d) { return d.score.opponent == null ? "" : `${d.score.you} – ${d.score.opponent}`; }

// ───────── Nouveau duel ─────────
export async function duelNewView() {
  const sub = activeSubject();
  const [ch, pl] = await Promise.all([
    get(`/api/subjects/${sub.id}/chapters`),
    get(`/api/subjects/${sub.id}/players`),
  ]);
  const usable = ch.chapters.filter((c) => c.questionCount > 0);
  let chosen = null;
  const playersBox = h("div.list");
  const q = h("input.input", { type: "search", placeholder: "Chercher un joueur", "aria-label": "Chercher un joueur",
    oninput: debounce(async () => { const r = await get(`/api/subjects/${sub.id}/players?q=${encodeURIComponent(q.value)}`).catch(() => null); if (r) paint(r.players); }, 250) });
  const random = h("button.btn.block", { disabled: true, onclick: () => create(() => post(`/api/subjects/${sub.id}/duels/random`, { chapterId: chosen.id })) }, "Adversaire au hasard");

  async function create(fn) {
    if (!chosen) return toast("Choisis d'abord un chapitre", "bad");
    try { const r = await fn(); toast("Défi lancé !", "good"); go(`/duels/${r.duel.id}`); } catch (e) { fail(e); }
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
    }, initial(p.username), h("div.grow", h("strong", p.username), h("div.muted.small", `Niveau ${lvl(p.level)}`)),
      p.online ? h("span.chip.good.dot", "en ligne") : null)) : [h("p.muted", "Aucun joueur trouvé.")]));
  }
  paint(pl.players);
  const online = pl.players.filter((p) => p.online && !p.busy);
  const liveBox = h("section.card.stack", h("h2", "Choisis un joueur en ligne"),
    h("p.muted.small", "Les deux joueurs sont connectés et reçoivent les mêmes questions en même temps. Le chapitre de chaque manche est choisi à tour de rôle. Aucun duel différé n'est créé."),
    online.length ? h("div.list", online.map((p) => h("button.item", { onclick: () => challengeLive(sub.id, p) }, initial(p.username),
      h("div.grow", h("strong", p.username), h("div.muted.small", `Niveau ${lvl(p.level)}`)), h("span.chip.good.dot", "en ligne")))) : h("p.muted", "Aucun joueur de ta matière n'est en ligne pour l'instant."));

  // Deux modes distincts : le duel différé (chacun joue à son rythme) et le duel en direct (les deux en même temps).
  const deferred = h("div.stack",
    h("p.muted.small", "Chacun joue ses manches quand il veut, avant la date limite. Rien n'exige que l'adversaire soit connecté."),
    h("section.stack", h("h2", "1. Choisis le chapitre de la première manche"),
      usable.length ? h("div.chapters", buttons) : h("p.muted", "Aucun chapitre ne contient de questions.")),
    h("section.stack", h("h2", "2. Choisis ton adversaire"),
      h("p.muted.small", "Le duel démarre tout de suite : tu joues la manche 1, puis ton adversaire joue à son rythme."),
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
  const d = await get(`/api/duels/${id}`);
  const duel = d.duel;
  if (duel.status !== "IN_PROGRESS") { go(`/duels/${id}/result`); return h("div"); }
  const me = S.me.user.username;
  const n = duel.next;

  let action;
  if (n.action === "play") {
    action = h("a.btn.primary.block", { href: `#/duels/${id}/play` }, `Jouer la manche ${n.round}`);
  } else if (n.action === "pick") {
    action = h("div.stack", h("strong", `À toi de choisir le chapitre de la manche ${n.round}`),
      h("div.chapters", (d.chapters ?? []).filter((c) => c.questionCount > 0).map((c) =>
        h("button.chapter", { style: chapStyle(c), onclick: async () => {
          try { await post(`/api/duels/${id}/pick`, { chapterId: c.id }); go(`/duels/${id}/play`); } catch (e) { fail(e); }
        } }, h("strong", c.name), h("span.muted.small", `${c.questionCount} questions`)))));
  } else {
    action = h("p.muted", `${duel.opponent.username} doit jouer. Tu seras prévenu quand ce sera ton tour.`);
  }

  return h("div.stack",
    h("a.muted", { href: "#/duels" }, "← Mes duels"),
    h("section.card.stack",
      h("div.vs",
        h("div", initial(me), h("div", me)),
        h("div.score", `${duel.score.you} – ${duel.score.opponent ?? "?"}`),
        h("div", initial(duel.opponent.username), h("div", duel.opponent.username))),
      h("div.center.muted.small", `Fin automatique dans ${timeLeft(duel.deadlineAt)} · le plus de bonnes réponses gagne`)),
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
  const cur = await get(`/api/duels/${id}/current`);
  if (cur.status !== "IN_PROGRESS") { go(`/duels/${id}`); return h("div"); }
  const total = cur.question.total;
  const { el, cleanup } = playStage({
    total, question: cur.question, label: "Duel",
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
  const r = await get(`/api/duels/${id}/result`);
  const duel = r.duel;
  if (duel.status === "IN_PROGRESS") { go(`/duels/${id}`); return h("div"); }
  const [label, kind] = RESULT[r.result] ?? ["Terminé", ""];
  if (r.result === "WIN") setTimeout(confetti, 200);
  const me = S.me.user.username, opp = duel.opponent.username;

  return h("div.stack",
    h("a.muted", { href: "#/duels" }, "← Mes duels"),
    h("section.card.center.stack",
      h("span.chip", { class: kind }, label),
      h("div.result-score", `${duel.score.you} – ${duel.score.opponent ?? 0}`),
      h("div.muted", `${me} contre ${opp}`),
      h("div", h("span.chip.amber", `+${r.xpEarned} XP`), " ", h("span.chip", `Niveau ${lvl(r.level)}`)),
      duel.status === "ABANDONED" ? h("p.muted.small", "Duel abandonné sans réponse : aucun XP.") : null),
    h("div.row.wrap",
      h("button.btn.primary.grow", { onclick: () => rematch(id, sub) }, "Revanche"),
      h("a.btn.ghost.grow", { href: "#/duels" }, "Mes duels")),
    h("h2", "Correction"),
    h("div.review", r.review.map((q) =>
      h("div.review-item", { class: q.you?.correct ? "ok" : "ko" },
        h("div.muted.small", `Manche ${q.round} · ${q.chapter?.name ?? q.chapter ?? ""}`),
        h("strong", q.text),
        h("ul", q.choices.map((c, i) => h("li", { class: i === q.correctIndex ? "right" : "" },
          c, i === q.correctIndex ? " ✓" : "",
          i === q.you?.choice ? " · toi" : "", i === q.opponent?.choice ? ` · ${opp}` : ""))),
        q.explanation ? h("p.muted.small", q.explanation) : null))));
}

async function rematch(id, sub) {
  const ch = await get(`/api/subjects/${sub.id}/chapters`).catch(() => ({ chapters: [] }));
  sheet("Revanche : choisis le chapitre", (close) => h("div.chapters", ch.chapters.filter((c) => c.questionCount > 0).map((c) =>
    h("button.chapter", { style: chapStyle(c), onclick: async () => {
      try { const r = await post(`/api/duels/${id}/rematch`, { chapterId: c.id }); close(); go(`/duels/${r.duel.id}`); } catch (e) { fail(e); }
    } }, h("strong", c.name), h("span.muted.small", `${c.questionCount} questions`)))));
}
