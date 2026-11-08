import { h, get, post, icon } from "../lib.js";
import { activeSubject, go, loadCatalog } from "../state.js";
import { playStage } from "../stage.js";

/** Carte de l'accueil : nombre de questions à réviser (masquée quand il n'y en a pas). */
export async function reviewCard(sub) {
  let r;
  try { r = await get(`/api/subjects/${sub.id}/review`); } catch { return null; }
  if (!r.due) return null;
  return h("a.card.flat.row.between.review-card", { href: "#/review" },
    h("div", h("strong", "À réviser"), h("div.muted.small", `${r.due} question${r.due > 1 ? "s" : ""} à revoir pour mieux les retenir`)),
    h("span.btn.primary.small", "Réviser"));
}

export async function reviewView() {
  const sub = activeSubject();
  const r = await get(`/api/subjects/${sub.id}/review`);
  return h("div.stack",
    h("a.muted", { href: "#/" }, "← Accueil"),
    h("h1", "Révision"),
    h("section.card.stack",
      r.due
        ? h("div.stack", h("p", `${r.due} question${r.due > 1 ? "s" : ""} à réviser. Les questions que tu as ratées reviennent à intervalles de plus en plus longs, jusqu'à ce que tu les maîtrises.`),
            h("a.btn.primary.block", { href: "#/review/play" }, `Réviser ${r.sessionSize} question${r.sessionSize > 1 ? "s" : ""}`))
        : h("div.empty", icon("check"), h("p", "Rien à réviser pour le moment."), h("p.muted.small", "Les questions que tu rates en solo ou en duel apparaîtront ici."))),
    h("div.grid-2",
      h("div.card.center.stack.tight", h("div.result-score", String(r.learning)), h("div.muted.small", "en cours d'apprentissage")),
      h("div.card.center.stack.tight", h("div.result-score", String(r.mastered)), h("div.muted.small", "maîtrisées"))));
}

export async function reviewPlayView(_p, ctx) {
  const sub = activeSubject();
  const base = `/api/subjects/${sub.id}/review`;
  const [first] = await Promise.all([get(`${base}/next?done=0`), loadCatalog().catch(() => null)]);
  if (first.status !== "IN_PROGRESS") { go("/review"); return h("div"); }
  const size = first.question.total;
  let done = 0;
  const { el, cleanup } = playStage({
    total: size, question: first.question, label: "Révision",
    answer: async (gq, idx) => { const res = await post(`${base}/answer`, { gameQuestionId: gq, choiceIndex: idx, done, size }); done++; return res; },
    loadNext: async () => { const n = await get(`${base}/next?done=${done}&size=${size}`); return n.status === "IN_PROGRESS" ? n.question : null; },
    onDone: () => go("/review"),
    onQuit: () => go("/review"),
  });
  ctx.setCleanup(cleanup);
  return el;
}
