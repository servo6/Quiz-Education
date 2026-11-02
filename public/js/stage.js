import { h, mount, fail, toast, confetti, avatarEl } from "./lib.js";
import { S, lvl, activeSubject } from "./state.js";

const C = 2 * Math.PI * 26;
const LETTERS = ["A", "B", "C", "D", "E", "F"];

/** Carte joueur : avatar, nom, niveau (et score en duel direct). `side` = "left" | "right". */
export function playerCard(p, side, score) {
  return h("div.pcard", { class: side },
    h("div.pav", avatarEl(p?.avatar ?? null, S.catalog, 56)),
    h("div.pinfo", h("strong", p?.username ?? "?"), h("span.plvl", `Niv. ${lvl(p?.level) ?? 1}`)),
    score != null ? h("b.pscore", { "data-score": score }, String(score)) : null);
}
/** Les deux adversaires face à face : toi en haut à gauche, l'autre en haut à droite. */
export function versusBar(you, opponent, { scores, mid } = {}) {
  return h("div.versus", playerCard(you, "left", scores?.you), mid ?? h("span.vs-badge", "VS"), playerCard(opponent, "right", scores?.opponent));
}

/**
 * Écran de jeu partagé par le solo et les duels différés.
 * opts: { total, question, label, versus?: {you, opponent}, answer(gqId, idx) → réponse API,
 *         loadNext() → question | null, markServed?(q), onDone(res), onQuit() }
 */
export function playStage(opts) {
  const root = h("div.stage");
  let tick = null;
  let servedPending = null;
  const pips = Array.from({ length: opts.total }, () => "");
  const stop = () => { clearInterval(tick); tick = null; };
  const sub = activeSubject();
  const lvlNow = { level: sub?.level ?? 1, into: sub?.xpIntoLevel ?? 0, next: sub?.xpForNext ?? 100 };

  function show(q) {
    stop();
    const pos = Math.min(Math.max((q.position ?? 1) - 1, 0), opts.total - 1);
    // Temps illimité (0) : aucun minuteur, aucune réponse automatique — le joueur choisit.
    const unlimited = !(q.timeLimitSec > 0);
    const limit = unlimited ? 0 : q.timeLimitSec * 1000;
    const deadline = unlimited ? Infinity : Date.now() + (q.remainingMs ?? limit);
    let locked = false;

    const num = h("b", unlimited ? "∞" : String(Math.ceil((deadline - Date.now()) / 1000)));
    const ring = h("div.timer", { role: "timer", "aria-label": "Temps restant" });
    const NS = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 60 60");
    const bg = document.createElementNS(NS, "circle");
    bg.setAttribute("class", "bg"); bg.setAttribute("cx", 30); bg.setAttribute("cy", 30); bg.setAttribute("r", 26);
    const fg = document.createElementNS(NS, "circle");
    fg.setAttribute("class", "fg"); fg.setAttribute("cx", 30); fg.setAttribute("cy", 30); fg.setAttribute("r", 26);
    fg.setAttribute("stroke-dasharray", C); fg.setAttribute("stroke-dashoffset", 0);
    s.append(bg, fg);
    ring.append(s, num);

    const pipEls = pips.map((st, i) => h("i", { class: i === pos ? "now" : st }));
    const feedback = h("div.fb-slot", { "aria-live": "polite" });
    const buttons = q.choices.map((c, i) =>
      h("button.answer", { onclick: () => submit(i) }, h("span.tag", LETTERS[i] ?? i + 1), h("span.txt", c), h("span.mark")));
    const timeBar = h("i");

    // ── En-tête : duel = deux joueurs face à face (chrono au centre) ; solo = ton niveau, ta série et le chrono.
    let hud;
    if (opts.versus) {
      hud = versusBar(opts.versus.you, opts.versus.opponent, { mid: ring });
    } else {
      const me = { avatar: S.me?.user.avatar, username: S.me?.user.username, level: lvlNow.level };
      const xpFill = h("i", { style: `width:${Math.min(100, (lvlNow.into / Math.max(1, lvlNow.next)) * 100)}%` });
      hud = h("div.hud",
        h("div.hud-me", h("div.pav", avatarEl(me.avatar, S.catalog, 48)),
          h("div.pinfo", h("strong", `Niv. ${lvlNow.level}`), h("div.mini-xp", xpFill))),
        ring);
      hud.xpFill = xpFill;
    }

    function paint() {
      if (unlimited) { ring.classList.remove("low"); timeBar.style.width = "100%"; return; }
      const left = Math.max(0, deadline - Date.now());
      num.textContent = String(Math.ceil(left / 1000));
      fg.setAttribute("stroke-dashoffset", String(C * (1 - Math.min(1, left / limit))));
      timeBar.style.width = `${Math.min(100, (left / limit) * 100)}%`;
      ring.classList.toggle("low", left < 5000);
      if (left <= 0 && !locked) submit(0, true);
    }

    async function submit(i, timedOut = false) {
      if (locked) return;
      locked = true; stop();
      buttons.forEach((b) => (b.disabled = true));
      buttons[i]?.classList.add("picked");
      let res;
      try {
        if (servedPending) await servedPending;
        res = await opts.answer(q.gameQuestionId, i);
      } catch (e) {
        fail(e);
        feedback.replaceChildren(h("button.btn.primary.block", { onclick: resync }, "Continuer"));
        return;
      }
      pips[pos] = res.correct ? "ok" : "ko";
      pipEls[pos].className = res.correct ? "ok" : "ko";
      if (res.level) { lvlNow.level = lvl(res.level); lvlNow.into = res.level.xpIntoLevel ?? lvlNow.into; lvlNow.next = res.level.xpForNext ?? lvlNow.next; }
      if (hud.xpFill) hud.xpFill.style.width = `${Math.min(100, (lvlNow.into / Math.max(1, lvlNow.next)) * 100)}%`;
      buttons.forEach((b, k) => {
        if (k === res.correctIndex) { b.classList.add("correct"); b.querySelector(".mark").textContent = "✓"; }
        else if (k === i && !res.correct && !res.timedOut) { b.classList.add("wrong"); b.querySelector(".mark").textContent = "✕"; }
        else b.classList.add("dim");
      });
      const last = !!(res.finished || res.roundDone);
      feedback.replaceChildren(h("div.feedback", { class: res.correct ? "ok" : "ko" },
        h("div.row.between",
          h("div.verdict", { class: res.correct ? "ok" : "ko" }, res.timedOut ? "Temps écoulé" : res.correct ? "Bonne réponse" : "Réponse incorrecte"),
          h("div.fb-right",
            res.xpGained ? h("span.xp-pop", `+${res.xpGained} XP`) : null)),
        res.explanation ? h("p.expl", res.explanation) : null,
        h("button.btn.primary.block", { onclick: () => next(res, last) }, last ? "Continuer" : "Suivante")));
      feedback.querySelector("button")?.focus();
      if (res.leveledUp) { toast(`Niveau ${lvl(res.level)} atteint !`, "good"); confetti(); }
      for (const b of res.newBadges ?? []) toast(`Nouveau badge : ${b.name ?? b.code}`, "badge", 5200);
    }

    async function resync() { next(null, false); }
    async function next(res, last) {
      if (last) { stop(); opts.onDone(res); return; }
      try {
        // La question suivante est déjà dans la réponse : affichage immédiat, sans nouvelle requête bloquante.
        if (res?.next) {
          show(res.next);
          servedPending = opts.markServed ? Promise.resolve(opts.markServed(res.next)).catch(() => {}) : null;
          return;
        }
        const nq = await opts.loadNext();
        if (!nq) { opts.onDone(res); return; }
        show(nq);
      } catch (e) { fail(e); opts.onQuit(); }
    }

    const card = h("div.q-card",
      h("div.q-meta", h("span.q-num", `${pos + 1}`, h("small", ` / ${opts.total}`)), opts.label ? h("span.q-label", opts.label) : null),
      h("h1.q-text", { tabindex: "-1" }, q.text),
      unlimited ? null : h("div.time-bar", timeBar));

    mount(root, h("div.stage-inner",
      h("div.stage-top",
        h("button.quit", { onclick: opts.onQuit, "aria-label": "Quitter" }, "✕"),
        h("div.pips", pipEls)),
      hud,
      h("div.q-wrap", card, h("div.answers", buttons)),
      feedback));
    root.querySelector(".q-text")?.focus({ preventScroll: true });
    paint();
    tick = setInterval(paint, 200);
  }

  show(opts.question);
  return { el: root, cleanup: stop };
}
