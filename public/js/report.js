import { h, post, sheet, toast, fail } from "./lib.js";

const REASONS = [["WRONG_ANSWER", "La bonne réponse est fausse"], ["AMBIGUOUS", "Question ambiguë ou incomplète"], ["TYPO", "Faute ou erreur de formule"], ["OTHER", "Autre problème"]];

/** Fenêtre de signalement d'une question (identifiant de question ou de question de partie). */
export function reportQuestion(id) {
  let reason = null;
  const note = h("textarea.input", { rows: 3, maxlength: 300, placeholder: "Précise le problème (facultatif)", "aria-label": "Précisions" });
  sheet("Signaler cette question", (close) => {
    const send = h("button.btn.primary.block", { type: "button", disabled: true, onclick: async () => {
      send.disabled = true;
      try { await post(`/api/questions/${id}/report`, { reason, comment: note.value.trim() }); close(); toast("Merci, ton signalement est transmis", "good"); }
      catch (e) { fail(e); send.disabled = false; }
    } }, "Envoyer le signalement");
    const opts = REASONS.map(([code, label]) => h("button.btn.block", { type: "button", "aria-pressed": "false", onclick: (e) => {
      reason = code; opts.forEach((o) => { o.setAttribute("aria-pressed", String(o === e.currentTarget)); o.classList.toggle("primary", o === e.currentTarget); }); send.disabled = false;
    } }, label));
    return h("div.stack", h("p.muted.small", "Le responsable de la matière sera prévenu et corrigera la question si besoin."), ...opts, note, send);
  });
}

/** Petit bouton « Signaler » à placer sous une correction. */
export const reportButton = (id) => h("button.btn.ghost.small.report-btn", { type: "button", onclick: () => reportQuestion(id) }, "⚑ Signaler");
