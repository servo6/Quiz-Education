// Salons privés en direct : superposition plein écran pilotée par les événements `room:*` du serveur.
import { h, mount, toast, confetti, rich, avatarEl, sheet } from "./lib.js";
import { S } from "./state.js";

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const SIZES = [5, 8, 10, 15];
let socket = null, layer = null, pill = null, R = null, tick = null;
const me = () => S.me?.user?.id;

export const roomBusy = () => !!R;

export function initRooms(sock) {
  socket = sock;
  if (!layer) { layer = h("div.stage", { id: "room", hidden: true, role: "dialog", "aria-modal": "true", "aria-label": "Salon privé" }); document.body.append(layer); }
  const on = (ev, fn) => socket.on(ev, (p) => { try { fn(p ?? {}); } catch (e) { console.error(e); } });
  on("room:state", (p) => { if (R) { R.room = p.room; if (p.room.phase === "LOBBY" && R.phase !== "LOBBY") { R.phase = "LOBBY"; R.q = null; R.reveal = null; R.finished = null; R.ranking = null; } render(); } });
  on("room:started", (p) => { if (R) { R.room = p.room; R.phase = "STARTING"; R.min = false; render(); } });
  on("room:question", (q) => { if (!R) return; R.min = false; R.phase = "QUESTION"; R.q = q; R.answered = false; R.chosen = null; R.reveal = null; R.count = null; render(); });
  on("room:answered", (p) => { if (R) { R.count = p; if (p.userId === me()) R.answered = true; render(); } });
  on("room:reveal", (p) => { if (R) { R.phase = "REVEAL"; R.reveal = p; R.ranking = p.ranking; render(); } });
  on("room:finished", (p) => { if (R) { R.phase = "DONE"; R.finished = p; render(); } });
  on("room:closed", (p) => { if (R) { toast(p.reason ?? "Salon fermé"); close(); } });
  // À chaque (re)connexion, y compris après un redémarrage du serveur : on retrouve son salon.
  const resume = () => socket.emit("room:resume", {}, (r) => { if (r?.state) restore(r.state); else if (R) { toast("Le salon n'existe plus"); close(); } });
  socket.on("connect", resume);
  if (socket.connected) resume();
}

function restore(s) {
  R = { room: s.room, phase: s.room.phase === "LOBBY" ? "LOBBY" : "STARTING" };
  if (s.question) { R.phase = "QUESTION"; R.q = s.question; R.answered = s.question.answered; R.chosen = s.question.myPick; R.ranking = s.ranking; }
  if (s.reveal) { R.phase = "REVEAL"; R.reveal = s.reveal; }
  if (s.finished) { R.phase = "DONE"; R.finished = s.finished; }
  render();
}

function enter(room) { R = { room, phase: "LOBBY" }; render(); }

export function createRoom(subjectId) {
  if (R) return toast("Tu es déjà dans un salon", "bad");
  sheet("Créer un salon", (closeSheet) => h("div.stack",
    h("p.muted", "Choisis le nombre de questions. Tu recevras un code à partager (2 à 8 joueurs de cette matière)."),
    h("div.list", SIZES.map((n) => h("button.item", { onclick: () => {
      socket.emit("room:create", { subjectId, size: n }, (r) => {
        if (!r?.ok) return toast(r?.error?.message ?? "Création impossible", "bad");
        closeSheet(); enter(r.room);
      });
    } }, h("div.grow", h("strong", `${n} questions`)))))));
}

export function joinRoom() {
  if (R) return toast("Tu es déjà dans un salon", "bad");
  sheet("Rejoindre un salon", (closeSheet) => {
    const input = h("input", { type: "text", maxlength: "8", placeholder: "Code du salon", autocapitalize: "characters", autocomplete: "off", style: "text-transform:uppercase;letter-spacing:.2em;text-align:center;font-size:1.4rem" });
    const go = () => socket.emit("room:join", { code: input.value }, (r) => {
      if (!r?.ok) return toast(r?.error?.message ?? "Impossible de rejoindre", "bad");
      closeSheet(); enter(r.room);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    return h("div.stack", input, h("button.btn.primary.block", { onclick: go }, "Rejoindre"));
  });
}

/** Carte « Salon privé » (page Duels). */
export function roomCard(subjectId) {
  return h("section.card.stack.tight",
    h("h2", "Salon privé"),
    h("p.muted.small", "Jouez à plusieurs (jusqu'à 8) sur les mêmes questions, en direct, avec un classement final."),
    h("div.row.wrap", h("button.btn.primary", { onclick: () => createRoom(subjectId) }, "Créer un salon"), h("button.btn.ghost", { onclick: joinRoom }, "Rejoindre avec un code")));
}

function close() { clearInterval(tick); tick = null; R = null; pill?.remove(); pill = null; layer.hidden = true; document.body.style.overflow = ""; mount(layer); }
function leave() { socket.emit("room:leave", {}, () => {}); close(); }

const quitBtn = (label = "Quitter") => h("button.quit.wide", { onclick: () => { if (R.phase === "DONE" || R.phase === "LOBBY" || confirm("Quitter la partie ?")) leave(); } }, label);

function memberRow(m, extra) {
  return h("div.item", avatarEl(m.avatar ?? null, S.catalog, 36), h("div.grow", h("strong", m.username + (m.id === me() ? " (toi)" : "")), m.id === R.room.hostId ? h("div.muted.small", "Créateur du salon") : null), extra ?? null);
}

/** Salon réduit (salle d'attente seulement) : une pastille flottante permet d'y revenir pendant qu'on fait autre chose. */
function renderPill() {
  pill?.remove(); pill = null;
  if (!R?.min) return;
  const n = R.room.members.length;
  pill = h("button.room-pill", { type: "button", onclick: () => { R.min = false; render(); }, "aria-label": `Revenir au salon ${R.room.code}` },
    h("strong", `Salon ${R.room.code}`), h("span", `${n} / ${R.room.max} joueur${n > 1 ? "s" : ""}`), h("span.room-pill-go", "Revenir"));
  document.body.append(pill);
}

function render() {
  clearInterval(tick); tick = null;
  if (!R) { layer.hidden = true; document.body.style.overflow = ""; renderPill(); return; }
  if (R.min && R.phase === "LOBBY") { layer.hidden = true; document.body.style.overflow = ""; return renderPill(); }
  R.min = false; renderPill();
  layer.hidden = false; document.body.style.overflow = "hidden";
  if (R.phase === "LOBBY") return lobby();
  if (R.phase === "QUESTION" || R.phase === "REVEAL") return question();
  if (R.phase === "DONE") return done();
  mount(layer, h("div.stage-inner", h("div.stage-top", h("div.q-meta", { style: "flex:1" }, "Salon privé"), quitBtn()),
    h("div.q-wrap.center", h("div.spinner"), h("h1.q-text", "La partie démarre…")), h("div")));
}

function lobby() {
  const { room } = R;
  const host = room.hostId === me();
  const text = `Rejoins mon salon de quiz avec le code ${room.code}`;
  const share = async () => {
    try { if (navigator.share) return await navigator.share({ text }); } catch { return; }
    try { await navigator.clipboard.writeText(room.code); toast("Code copié"); } catch { toast(room.code); }
  };
  mount(layer, h("div.stage-inner", h("div.stage-top", h("div.q-meta", { style: "flex:1" }, `Salon privé · ${room.size} questions`),
      h("button.quit.wide", { onclick: () => { R.min = true; render(); toast("Salon réduit : touche la pastille pour y revenir"); } }, "Réduire"), quitBtn()),
    h("div.q-wrap.center.stack",
      h("p", "Code du salon"),
      h("h1.q-text", { style: "letter-spacing:.3em", "aria-label": `Code ${room.code.split("").join(" ")}` }, room.code),
      h("button.btn.ghost", { style: "color:#fff;box-shadow:inset 0 0 0 2px rgba(255,255,255,.4)", onclick: share }, "Partager le code"),
      h("div.list", { style: "text-align:left" }, room.members.map((m) => memberRow(m))),
      h("p.small", `${room.members.length} / ${room.max} joueurs`)),
    host
      ? h("button.btn.primary.block", { disabled: room.members.length < room.min, onclick: (e) => { e.currentTarget.disabled = true; socket.emit("room:start", {}, (r) => { if (!r?.ok) { toast(r?.error?.message ?? "Impossible de lancer", "bad"); render(); } }); } }, room.members.length < room.min ? `Il faut ${room.min} joueurs au moins` : "Lancer la partie")
      : h("p.center.small", "En attente du créateur du salon…")));
}

function question() {
  const q = R.q, rv = R.phase === "REVEAL" ? R.reveal : null;
  const num = h("b", ""); const ring = h("div.timer", num);
  const paint = () => { const left = Math.max(0, q.deadline - Date.now()); num.textContent = String(Math.ceil(left / 1000)); ring.classList.toggle("low", left < 5000); };
  if (!rv) { paint(); tick = setInterval(paint, 250); } else num.textContent = "·";
  const picks = new Map((rv?.results ?? []).map((r) => [r.id, r]));
  const buttons = q.choices.map((c, i) => {
    const b = h("button.answer", { disabled: !!rv || R.answered, onclick: () => {
      if (R.answered) return;
      R.answered = true; R.chosen = i; render();
      socket.emit("room:answer", { index: q.index, choiceIndex: i }, (r) => { if (!r?.ok) { R.answered = false; R.chosen = null; toast(r?.error?.message ?? "Réponse refusée", "bad"); render(); } });
    } }, h("span.tag", LETTERS[i] ?? i + 1), h("span", rich(c)));
    if (rv) {
      const mine = picks.get(me());
      if (i === rv.correctIndex) b.classList.add("correct"); else if (mine?.pick === i) b.classList.add("wrong"); else b.classList.add("dim");
    } else if (R.chosen === i) b.setAttribute("aria-pressed", "true"); else if (R.answered) b.classList.add("dim");
    return b;
  });
  const board = (R.ranking ?? []).length ? h("div.list", R.ranking.map((r) => h("div.item", h("span.chip", `${r.rank}`), h("div.grow", h("strong", r.username + (r.id === me() ? " (toi)" : ""))), h("span.chip.amber", `${r.score} pts`)))) : null;
  const mineRes = rv ? picks.get(me()) : null;
  const status = rv
    ? h("div.feedback", h("div.row.between", h("div.verdict", { class: mineRes?.correct ? "ok" : "ko" }, mineRes?.pick == null ? "Temps écoulé" : mineRes.correct ? "Bonne réponse !" : "Raté"), mineRes?.gained ? h("span.xp-pop", `+${mineRes.gained} pts`) : null),
        rv.explanation ? h("p", rich(rv.explanation)) : null, board)
    : h("div.feedback", R.answered ? `Réponse envoyée. ${R.count ? `${R.count.answered}/${R.count.total} ont répondu…` : "En attente des autres…"}` : (R.count ? `${R.count.answered}/${R.count.total} ont répondu` : "À toi de répondre !"));
  mount(layer, h("div.stage-inner",
    h("div.stage-top", h("div.q-meta", { style: "flex:1" }, `Salon ${R.room.code} · question ${q.index + 1}/${q.total}`), quitBtn("Quitter"), ring),
    h("div.q-wrap", h("h1.q-text", rich(q.text)), h("div.answers", buttons)),
    h("div.stack.tight", status)));
}

function reward(r) {
  if (!r) return null;
  if (r.capped) return h("p.center.small", "Limite de 5 parties récompensées par jour atteinte : pas d'XP ni de pièces cette fois.");
  return h("div.center", h("span.chip.amber", `+${r.xp} XP`), " ", h("span.chip", `+${r.coins} 🪙 pièces`));
}

function done() {
  const list = R.finished.ranking;
  const mineRow = list.find((r) => r.id === me());
  if (mineRow?.rank === 1) setTimeout(confetti, 150);
  const medal = (n) => ["🥇", "🥈", "🥉"][n - 1] ?? `${n}`;
  mount(layer, h("div.stage-inner", h("div.stage-top", h("div.q-meta", { style: "flex:1" }, `Salon ${R.finished.code} · terminé`)),
    h("div.q-wrap.stack", h("div.center", h("div.result-score", mineRow ? (mineRow.rank === 1 ? "Victoire !" : `${mineRow.rank}${mineRow.rank === 1 ? "er" : "e"} place`) : "Classement")),
      reward(R.finished.reward),
      h("div.list", list.map((r) => h("div.item", h("span", { style: "font-size:1.4rem;min-width:2rem;text-align:center" }, medal(r.rank)), avatarEl(r.avatar ?? null, S.catalog, 36),
        h("div.grow", h("strong", r.username + (r.id === me() ? " (toi)" : "")), h("div.muted.small", `${r.correct}/${R.finished.total} bonnes réponses`)), h("span.chip.amber", `${r.score} pts`))))),
    R.room.hostId === me()
      ? h("div.stack.tight", h("button.btn.primary.block", { onclick: (e) => { e.currentTarget.disabled = true; socket.emit("room:rematch", {}, (r) => { if (!r?.ok) { toast(r?.error?.message ?? "Impossible de rejouer", "bad"); e.target.disabled = false; } }); } }, "Rejouer"),
          h("button.btn.ghost.block", { onclick: leave }, "Terminer"))
      : h("div.stack.tight", h("p.center.small", "Le créateur du salon peut relancer une partie : reste ici pour rejouer."), h("button.btn.ghost.block", { onclick: leave }, "Terminer"))));
}
