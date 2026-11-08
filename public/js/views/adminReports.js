import { h, get, post, fail, toast, rich } from "../lib.js";
import { rerender } from "../state.js";

const REASON = { WRONG_ANSWER: "Réponse fausse", AMBIGUOUS: "Ambiguë", TYPO: "Faute / formule", OTHER: "Autre" };
const when = (iso) => new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });

/** Panneau « Signalements » : questions signalées par les joueurs, à corriger puis à clore. */
export async function reportsPanel(sub) {
  let all = false;
  const root = h("div.stack");
  async function paint() {
    const r = await get(`/api/subjects/${sub.id}/reports${all ? "?status=all" : ""}`);
    const resolve = async (q, status) => { try { await post(`/api/subjects/${sub.id}/reports/${q.questionId}/resolve`, { status }); toast(status === "RESOLVED" ? "Marquée comme corrigée" : "Signalement rejeté", "good"); paint(); } catch (e) { fail(e); } };
    root.replaceChildren(
      h("div.row.between.wrap", h("h2", `Signalements (${r.openCount} à traiter)`),
        h("button.btn.ghost.small", { type: "button", onclick: () => { all = !all; paint(); } }, all ? "Voir seulement à traiter" : "Voir aussi les clos")),
      r.reports.length ? h("div.stack", r.reports.map((q) => h("section.card.stack",
        h("div.row.between.wrap", h("span.muted.small", q.chapter), h("div.row", Object.entries(q.reasons).map(([k, n]) => h("span.chip", `${REASON[k] ?? k} × ${n}`)))),
        h("strong", rich(q.text)),
        q.choices.length ? h("ol.small", { type: "A", style: "margin:0;padding-left:1.4em" }, q.choices.map((c, i) => h("li", { class: i === q.answerIndex ? "right" : "" }, rich(c), i === q.answerIndex ? " ✓" : ""))) : null,
        q.explanation ? h("p.muted.small", rich(q.explanation)) : null,
        q.comments.length ? h("div.stack.tight", q.comments.map((c) => h("p.small", { style: "margin:0" }, h("b", c.username), ` (${when(c.createdAt)}) : ${c.comment}`))) : null,
        q.deleted ? h("p.chip.amber", { style: "justify-self:start" }, "Question supprimée") : null,
        q.open ? h("div.row.wrap",
          h("button.btn.primary.small", { type: "button", onclick: () => resolve(q, "RESOLVED") }, "J'ai corrigé"),
          h("button.btn.ghost.small", { type: "button", onclick: () => resolve(q, "DISMISSED") }, "Rien à corriger"),
          h("a.btn.ghost.small", { href: "#/admin/questions" }, "Ouvrir les questions"))
          : h("span.chip.good", { style: "justify-self:start" }, "Clos"))))
        : h("div.empty", h("p", "Aucun signalement à traiter.")));
  }
  await paint();
  return root;
}
