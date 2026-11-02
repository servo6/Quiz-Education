import { h, mount, post, fail, toast, confetti, errorMessage } from "./lib.js";
import { lvl } from "./state.js";

const C = 2 * Math.PI * 26;
const LETTERS = ["A", "B", "C", "D", "E", "F"];

/**
 * Écran de jeu partagé par le solo et les duels.
 * opts: { total, question, label, answer(gqId, idx) → réponse API, loadNext() → question | null,
 *         onDone(res), onQuit() }
 */
export function playStage(opts) {
  const root = h("div.stage");
  let tick = null;
  const pips = Array.from({ length: opts.total }, () => "");
  const stop = () => { clearInterval(tick); tick = null; };

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
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 60 60");
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    bg.setAttribute("class", "bg"); bg.setAttribute("cx", 30); bg.setAttribute("cy", 30); bg.setAttribute("r", 26);
    const fgNs = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    fgNs.setAttribute("class", "fg"); fgNs.setAttribute("cx", 30); fgNs.setAttribute("cy", 30); fgNs.setAttribute("r", 26);
    fgNs.setAttribute("stroke-dasharray", C); fgNs.setAttribute("stroke-dashoffset", 0);
    s.append(bg, fgNs);
    ring.append(s, num);

    const pipEls = pips.map((st, i) => h("i", { class: i === pos ? "now" : st }));
    const feedback = h("div", { "aria-live": "polite" });
    const buttons = q.choices.map((c, i) =>
      h("button.answer", { onclick: () => submit(i) }, h("span.tag", LETTERS[i] ?? i + 1), h("span", c)));

    function paint() {
      if (unlimited) { ring.classList.remove("low"); return; }
      const left = Math.max(0, deadline - Date.now());
      num.textContent = String(Math.ceil(left / 1000));
      fgNs.setAttribute("stroke-dashoffset", String(C * (1 - Math.min(1, left / limit))));
      ring.classList.toggle("low", left < 5000);
      if (left <= 0 && !locked) submit(0, true);
    }

    let servedPending = null;
    async function submit(i, timedOut = false) {
      if (locked) return;
      locked = true; stop();
      buttons.forEach((b) => (b.disabled = true));
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
      buttons.forEach((b, k) => {
        if (k === res.correctIndex) b.classList.add("correct");
        else if (k === i && !res.correct && !res.timedOut) b.classList.add("wrong");
        else b.classList.add("dim");
      });
      const last = !!(res.finished || res.roundDone);
      feedback.replaceChildren(h("div.feedback",
        h("div.row.between",
          h("div.verdict", { class: res.correct ? "ok" : "ko" }, res.timedOut ? "Temps écoulé" : res.correct ? "Bonne réponse !" : "Raté"),
          res.xpGained ? h("span.xp-pop", `+${res.xpGained} XP`) : null),
        res.explanation ? h("p", res.explanation) : null,
        h("button.btn.primary.block", { onclick: () => next(res, last) }, last ? "Continuer" : "Question suivante")));
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

    mount(root, h("div.stage-inner",
      h("div.stage-top",
        h("button.quit", { onclick: opts.onQuit }, "Quitter"),
        h("div.pips", pipEls),
        ring),
      h("div.q-wrap",
        h("div.q-meta", `${opts.label ? opts.label + " · " : ""}Question ${pos + 1} sur ${opts.total}`),
        h("h1.q-text", { tabindex: "-1" }, q.text),
        h("div.answers", buttons)),
      feedback));
    root.querySelector(".q-text")?.focus({ preventScroll: true });
    paint();
    tick = setInterval(paint, 200);
  }

  show(opts.question);
  return { el: root, cleanup: stop };
}
