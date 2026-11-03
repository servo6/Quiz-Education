// Duel en direct (Socket.IO) : superposition plein écran pilotée par les événements du serveur.
import { h, mount, toast, confetti, svg, rich } from "./lib.js";
import { S, refreshSummary, loadMe, lvl, loadCatalog } from "./state.js";
import { versusBar } from "./stage.js";

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const C = 2 * Math.PI * 26;
let socket = null;
let layer = null;
let G = null;          // état de la partie en cours
let invite = null;     // { challengeId, from, expiresAt }
let waiting = null;    // défi envoyé : { challengeId, opponent, expiresAt }
let tick = null;

export const liveBusy = () => !!(G || invite || waiting);

function applyState(s) {
  if (!s) return;
  G = { gameId: s.gameId, you: s.you, opponent: s.opponent, rounds: s.rounds, round: s.round, phase: s.phase, scores: s.scores, oppConnected: s.opponent.connected };
  if (s.pick) G.pick = s.pick;
  if (s.question) { G.question = s.question; G.answered = !!s.question.answered; G.chosen = null; }
  if (s.reveal) G.reveal = s.reveal;
  render();
}

export function initLive(sock) {
  socket = sock;
  if (!layer) { layer = h("div.stage", { id: "live", hidden: true, role: "dialog", "aria-modal": "true", "aria-label": "Duel en direct" }); document.body.append(layer); }
  const on = (ev, fn) => socket.on(ev, (p) => { try { fn(p ?? {}); } catch (e) { console.error(e); } });

  on("duel:invited", (p) => { invite = p; render(); });
  on("duel:challenge_declined", () => { waiting = null; toast("Défi refusé", "bad"); render(); });
  on("duel:challenge_expired", () => { const had = waiting || invite; waiting = null; invite = null; if (had) toast("Le défi a expiré"); render(); });
  on("duel:challenge_cancelled", () => { invite = null; toast("Le défi a été annulé"); render(); });
  on("duel:started", (p) => {
    waiting = null; invite = null;
    loadCatalog().then(() => render()).catch(() => {});
    G = { gameId: p.gameId, you: p.you, opponent: p.opponent, rounds: p.rounds, round: 0, phase: "STARTING", scores: { you: 0, opponent: 0 }, oppConnected: true, timePerQuestionSec: p.timePerQuestionSec };
    render();
  });
  on("duel:pick_chapter", (p) => { if (!G) return; G.phase = "PICKING"; G.round = p.round; G.pick = { picker: p.picker, chapters: p.chapters, deadline: p.deadline }; render(); });
  on("duel:round_started", (p) => { if (!G) return; G.round = p.round; G.chapter = p.chapter; G.roundBanner = true; render(); });
  on("duel:question", (p) => { if (!G) return; G.phase = "QUESTION"; G.question = p; G.answered = false; G.chosen = null; G.oppAnswered = false; G.reveal = null; G.roundBanner = false; render(); });
  on("duel:opponent_answered", () => { if (G) { G.oppAnswered = true; render(); } });
  on("duel:reveal", (p) => { if (!G) return; G.phase = "REVEAL"; G.reveal = p; G.scores = p.scores; render(); });
  on("duel:opponent_status", (p) => { if (G) { G.oppConnected = p.connected; G.graceUntil = p.graceMs ? Date.now() + p.graceMs : null; render(); } });
  on("duel:state", applyState);
  on("duel:finished", (p) => { if (!G) G = { you: {}, opponent: {}, scores: {} }; G.phase = "DONE"; G.finished = p; render(); loadMe().then(() => document.dispatchEvent(new CustomEvent("me"))); refreshSummary(); });
  socket.emit("duel:resume", {}, (r) => { if (r?.state) applyState(r.state); });
}

/** Envoie un défi en direct à un joueur en ligne. */
export function challengeLive(subjectId, opponent) {
  if (liveBusy()) return toast("Tu es déjà dans un duel ou un défi", "bad");
  socket.emit("duel:challenge", { subjectId, opponentId: opponent.id }, (r) => {
    if (!r?.ok) return toast(r?.error?.message ?? "Défi impossible", "bad");
    waiting = { challengeId: r.challengeId, opponent, expiresAt: r.expiresAt };
    render();
  });
}

function stopTick() { clearInterval(tick); tick = null; }
function close() { stopTick(); G = null; invite = null; waiting = null; layer.hidden = true; document.body.style.overflow = ""; mount(layer); }

function frame(...children) {
  return h("div.stage-inner",
    h("div.stage-top", h("div.q-meta", { style: "flex:1" }, G ? `Duel en direct${G.round ? ` · manche ${G.round}/${G.rounds}` : ""}` : "Duel en direct"),
      G && G.phase !== "DONE" ? h("button.quit", { onclick: () => { if (confirm("Abandonner ce duel ? Ton adversaire sera déclaré vainqueur.")) socket.emit("duel:forfeit", { gameId: G.gameId }, () => {}); } }, "Abandonner") : null),
    ...children);
}
const scoreBar = () => versusBar(G.you, G.opponent, { scores: { you: G.scores?.you ?? 0, opponent: G.scores?.opponent ?? 0 } });

function render() {
  stopTick();
  if (!G && !invite && !waiting) { layer.hidden = true; document.body.style.overflow = ""; return; }
  layer.hidden = false; document.body.style.overflow = "hidden";
  if (G) return renderGame();
  if (invite) {
    const left = () => Math.max(0, Math.ceil((invite.expiresAt - Date.now()) / 1000));
    const cnt = h("span", String(left()));
    tick = setInterval(() => { cnt.textContent = String(left()); if (left() <= 0) { stopTick(); invite = null; render(); } }, 500);
    return mount(layer, h("div.stage-inner", h("div.stage-top", h("div.q-meta", "Duel en direct")),
      h("div.q-wrap.center", h("h1.q-text", `${invite.from.username} te défie !`), 
        h("p", "Temps pour répondre : ", cnt, " s")),
      h("div.stack",
        h("button.btn.primary.block", { onclick: () => { const id = invite.challengeId; socket.emit("duel:respond", { challengeId: id, accept: true }, (r) => { if (!r?.ok) { toast(r?.error?.message ?? "Impossible d'accepter", "bad"); invite = null; render(); } }); } }, "Accepter"),
        h("button.btn.ghost.block", { style: "color:#fff;box-shadow:inset 0 0 0 2px rgba(255,255,255,.4)", onclick: () => { socket.emit("duel:respond", { challengeId: invite.challengeId, accept: false }, () => {}); invite = null; render(); } }, "Refuser"))));
  }
  // défi envoyé
  const left = () => Math.max(0, Math.ceil((waiting.expiresAt - Date.now()) / 1000));
  const cnt = h("span", String(left()));
  tick = setInterval(() => { cnt.textContent = String(left()); if (left() <= 0) { stopTick(); waiting = null; render(); } }, 500);
  mount(layer, h("div.stage-inner", h("div.stage-top", h("div.q-meta", "Duel en direct")),
    h("div.q-wrap.center", h("div.spinner"), h("h1.q-text", `En attente de ${waiting.opponent.username}…`), h("p", cnt, " s")),
    h("button.btn.ghost.block", { style: "color:#fff;box-shadow:inset 0 0 0 2px rgba(255,255,255,.4)", onclick: () => { socket.emit("duel:cancel", { challengeId: waiting.challengeId }, () => {}); waiting = null; render(); } }, "Annuler le défi")));
}

function renderGame() {
  const banner = !G.oppConnected ? h("div.feedback", "⚠ Adversaire déconnecté…") : null;
  if (G.phase === "DONE") return renderDone();
  if (G.phase === "PICKING" && G.pick) {
    const mine = G.pick.picker === S.me.user.id;
    const cnt = h("b", ""); const upd = () => { cnt.textContent = String(Math.max(0, Math.ceil((G.pick.deadline - Date.now()) / 1000))); };
    upd(); tick = setInterval(upd, 500);
    return mount(layer, frame(h("div.q-wrap", scoreBar(),
      mine ? h("div.stack", h("h1.q-text", "Choisis le chapitre de cette manche"), h("p", "Temps restant : ", cnt, " s"),
        h("div.answers", G.pick.chapters.map((c, i) => h("button.answer", { style: c.color ? `--chap:${c.color}` : "", onclick: (e) => { e.currentTarget.disabled = true; socket.emit("duel:pick", { gameId: G.gameId, chapterId: c.id }, (r) => { if (!r?.ok) toast(r?.error?.message ?? "Choix impossible", "bad"); }); } },
          h("span.tag", LETTERS[i % 6]), h("span", `${c.name} (${c.questionCount})`)))))
        : h("div.center.stack", h("div.spinner"), h("h1.q-text", `${G.opponent.username} choisit le chapitre…`), h("p", cnt, " s")), banner), h("div")));
  }
  if ((G.phase === "QUESTION" || G.phase === "REVEAL") && G.question) return renderQuestion(banner);
  mount(layer, frame(h("div.q-wrap.center", scoreBar(), h("div.spinner"), h("h1.q-text", G.roundBanner && G.chapter ? `Manche ${G.round} : ${G.chapter.name ?? G.chapter}` : "Préparation de la partie…"), banner), h("div")));
}

function renderQuestion(banner) {
  const q = G.question, rv = G.phase === "REVEAL" ? G.reveal : null;
  const unlimited = !(q.timeLimitSec > 0);
  const limit = unlimited ? 0 : q.timeLimitSec * 1000;
  const fgNs = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  for (const [el, cls] of [[bg, "bg"], [fgNs, "fg"]]) { el.setAttribute("class", cls); el.setAttribute("cx", 30); el.setAttribute("cy", 30); el.setAttribute("r", 26); }
  fgNs.setAttribute("stroke-dasharray", C);
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 60 60"); s.append(bg, fgNs);
  const num = h("b", ""); const ring = h("div.timer", s, num);
  const paint = () => {
    if (unlimited) { num.textContent = "∞"; fgNs.setAttribute("stroke-dashoffset", 0); return; }
    const left = Math.max(0, Math.min(limit, q.deadline - Date.now()));
    num.textContent = String(Math.ceil(left / 1000));
    fgNs.setAttribute("stroke-dashoffset", String(C * (1 - left / limit)));
    ring.classList.toggle("low", left < 5000);
  };
  if (!rv) { paint(); tick = setInterval(paint, 250); } else { num.textContent = "·"; }

  const buttons = q.choices.map((c, i) => {
    const b = h("button.answer", { disabled: !!rv || G.answered, onclick: () => {
      if (G.answered) return;
      G.answered = true; G.chosen = i; render();
      socket.emit("duel:answer", { gameId: G.gameId, gameQuestionId: q.gameQuestionId, choiceIndex: i }, (r) => { if (!r?.ok) { G.answered = false; G.chosen = null; toast(r?.error?.message ?? "Réponse refusée", "bad"); render(); } });
    } }, h("span.tag", LETTERS[i] ?? i + 1), h("span", rich(c)));
    if (rv) {
      if (i === rv.correctIndex) b.classList.add("correct");
      else if (i === rv.you.choiceIndex) b.classList.add("wrong");
      else b.classList.add("dim");
      const marks = [i === rv.you.choiceIndex ? "toi" : null, i === rv.opponent.choiceIndex ? "adversaire" : null].filter(Boolean);
      if (marks.length) b.append(h("span.small", { style: "margin-left:auto;opacity:.8" }, marks.join(" + ")));
    } else if (G.chosen === i) b.setAttribute("aria-pressed", "true");
    else if (G.answered) b.classList.add("dim");
    return b;
  });
  const status = rv ? h("div.feedback",
    h("div.row.between", h("div.verdict", { class: rv.you.correct ? "ok" : "ko" }, rv.you.timedOut ? "Temps écoulé" : rv.you.correct ? "Bonne réponse !" : "Raté"), rv.you.xpGained ? h("span.xp-pop", `+${rv.you.xpGained} XP`) : null),
    h("div.small", rv.opponent.timedOut ? `${G.opponent.username} n'a pas répondu à temps.` : rv.opponent.correct ? `${G.opponent.username} a bon.` : `${G.opponent.username} s'est trompé.`),
    rv.explanation ? h("p", rich(rv.explanation)) : null, h("p.small", { style: "opacity:.8" }, "Question suivante dans un instant…"))
    : h("div.feedback", G.answered ? (G.oppAnswered ? "Réponse envoyée…" : `Réponse envoyée. En attente de ${G.opponent.username}…`) : (G.oppAnswered ? `${G.opponent.username} a déjà répondu !` : "À toi de répondre !"));
  mount(layer, h("div.stage-inner",
    h("div.stage-top", h("div.q-meta", { style: "flex:1" }, `Duel en direct · manche ${q.round}/${G.rounds} · question ${q.indexInRound}/${q.questionsInRound}`),
      h("button.quit", { onclick: () => { if (confirm("Abandonner ce duel ? Ton adversaire sera déclaré vainqueur.")) socket.emit("duel:forfeit", { gameId: G.gameId }, () => {}); } }, "Abandonner"), ring),
    h("div.q-wrap", scoreBar(), h("h1.q-text", rich(q.text)), h("div.answers", buttons)),
    h("div.stack.tight", banner, status)));
}

function renderDone() {
  const f = G.finished ?? {};
  const label = { WIN: "Victoire !", DRAW: "Égalité", LOSS: "Défaite", FORFEIT: "Forfait" }[f.result] ?? (f.reason === "abandoned" || f.reason === "error" ? "Partie interrompue" : "Duel terminé");
  if (f.result === "WIN") setTimeout(confetti, 150);
  const gained = (f.you?.xpFromAnswers ?? 0) + (f.you?.bonus ?? 0);
  mount(layer, h("div.stage-inner", h("div.stage-top", h("div.q-meta", "Duel en direct")),
    h("div.q-wrap.center", h("div.result-score", label),
      h("p", `${G.you?.username ?? "Toi"} ${f.you?.correct ?? 0} – ${f.opponent?.correct ?? 0} ${f.opponent?.username ?? ""}`),
      h("div", h("span.chip.amber", `+${gained} XP`), " ", f.you?.level ? h("span.chip", `Niveau ${lvl(f.you.level)}`) : null),
      f.you?.leveledUp ? h("strong", "Nouveau niveau !") : null,
      f.you?.bonus ? h("p.small", `Dont ${f.you.bonus} XP de bonus.`) : null),
    h("button.btn.primary.block", { onclick: () => { close(); location.hash = "#/duels"; document.dispatchEvent(new CustomEvent("me")); } }, "Terminer")));
}
