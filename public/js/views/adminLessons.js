import { h, get, put, fail, toast } from "../lib.js";

/** Panneau « Cours » : un rappel de cours par chapitre, montré aux joueurs après une mauvaise réponse. */
export async function lessonsPanel(sub) {
  const { chapters } = await get(`/api/subjects/${sub.id}/lessons`);
  return h("div.stack",
    h("div", h("h2", "Rappels de cours"), h("p.muted.small", "Écris un court rappel pour chaque chapitre. Il est proposé aux joueurs (« Revoir le cours ») quand ils se trompent. Sépare les paragraphes par une ligne vide ; les formules s'écrivent entre $…$. Laisse vide pour ne rien proposer.")),
    chapters.length ? chapters.map((c) => {
      const area = h("textarea.input", { rows: 6, maxlength: 8000, "aria-label": `Cours : ${c.name}`, placeholder: "Rappel de cours…" }, c.lesson);
      const btn = h("button.btn.primary.small", { type: "button", onclick: async () => {
        btn.disabled = true;
        try { await put(`/api/chapters/${c.id}/lesson`, { lesson: area.value }); toast("Cours enregistré", "good"); } catch (e) { fail(e); }
        btn.disabled = false;
      } }, "Enregistrer");
      return h("section.card.stack.tight", h("strong", c.name), area, h("div", btn));
    }) : h("p.muted", "Aucun chapitre."));
}
