import { h, get, post, fail, icon, confetti, toast, chapStyle } from "../lib.js";
import { S, activeSubject, go, lvl, loadCatalog } from "../state.js";
import { playStage } from "../stage.js";
import { ticketRow, spendTicket } from "../tickets.js";

export async function soloPickView() {
  const sub = activeSubject();
  const [status, ch] = await Promise.all([
    get(`/api/subjects/${sub.id}/solo/status`),
    get(`/api/subjects/${sub.id}/chapters`),
  ]);
  let chosen = null;
  const start = h("button.btn.primary.block", { disabled: true }, "Lancer la partie");
  const buttons = ch.chapters.map((c) => {
    const b = h("button.chapter", {
      "aria-pressed": "false", disabled: c.questionCount === 0, style: chapStyle(c),
      onclick: () => {
        chosen = c;
        buttons.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        start.disabled = status.remaining <= 0 && !status.activeGameId;
        start.textContent = `Jouer « ${c.name} »`;
      },
    }, h("strong", c.name), h("span.muted.small", `${c.questionCount} question${c.questionCount > 1 ? "s" : ""}`));
    return b;
  });
  const tix = ticketRow("solo", status.limit ? status.remaining : null, status.limit || null, { big: true });
  start.onclick = async () => {
    start.disabled = true;
    try {
      const r = await post("/api/solo/start", { subjectId: sub.id, chapterId: chosen.id });
      if (!r.resumed) await spendTicket(tix); // le ticket part : −1
      go(`/solo/play/${r.game.id}`);
    } catch (e) { fail(e); start.disabled = false; }
  };

  return h("div.stack",
    h("h1", "Partie solo"),
    status.activeGameId ? h("a.card.flat.row.between", { href: `#/solo/play/${status.activeGameId}` },
      h("strong", "Partie en cours"),
      h("span.btn.primary.small", "Reprendre")) : null,
    h("div.tickets-bar", tix),
    ch.chapters.length
      ? h("section.stack", h("h2", "Chapitre"), h("div.chapters", buttons))
      : h("div.empty", icon("help"), h("p", "Aucun chapitre")),
    ch.chapters.length ? start : null);
}

export async function soloPlayView({ id }, ctx) {
  const [cur] = await Promise.all([get(`/api/solo/${id}/current`), loadCatalog().catch(() => null)]);
  if (cur.status !== "IN_PROGRESS" || !cur.question) { go(`/solo/result/${id}`); return h("div"); }
  const { el, cleanup } = playStage({
    total: cur.question.total,
    question: cur.question,
    label: "Solo",
    answer: (gq, idx) => post(`/api/solo/${id}/answer`, { gameQuestionId: gq, choiceIndex: idx }),
    markServed: () => get(`/api/solo/${id}/current`),
    loadNext: async () => {
      const n = await get(`/api/solo/${id}/current`);
      return n.status === "IN_PROGRESS" ? n.question : null;
    },
    onDone: () => go(`/solo/result/${id}`),
    onQuit: async () => {
      if (!confirm("Abandonner cette partie ? Les XP déjà gagnés sont conservés.")) return;
      try { await post(`/api/solo/${id}/abandon`); } catch (e) { fail(e); }
      go("/solo");
    },
  });
  ctx.setCleanup(cleanup);
  return el;
}

export async function soloResultView({ id }) {
  const r = await get(`/api/solo/${id}/result`);
  const ratio = r.total ? r.correct / r.total : 0;
  if (ratio >= 0.7) setTimeout(confetti, 200);
  return h("div.stack",
    h("section.card.center.stack",
      h("div.muted", r.chapter?.name ?? r.chapter ?? ""),
      h("div.result-score", `${r.correct}/${r.total}`),
      h("div", h("span.chip.amber", `+${r.xpEarned} XP`), " ", h("span.chip", `Niveau ${lvl(r.level)}`)),
      r.leveledUp ? h("strong", "Nouveau niveau !") : null),
    h("div.row.wrap",
      h("a.btn.primary.grow", { href: "#/solo" }, "Rejouer"),
      h("a.btn.ghost.grow", { href: "#/" }, "Accueil")),
    h("h2", "Correction"),
    reviewList(r.review));
}

export function reviewList(items) {
  return h("div.review", items.map((q) =>
    h("div.review-item", { class: q.isCorrect ? "ok" : "ko" },
      h("strong", `${q.position}. ${q.text}`),
      h("ul", q.choices.map((c, i) =>
        h("li", { class: i === q.correctIndex ? "right" : "" },
          c, i === q.correctIndex ? " ✓" : "", i === q.yourChoice && !q.isCorrect ? " (ta réponse)" : ""))),
      q.timedOut ? h("div.muted.small", "Temps écoulé") : null,
      q.explanation ? h("p.muted.small", q.explanation) : null)));
}
