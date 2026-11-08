import { h, get, post, del, fail, icon, confetti, toast, chapStyle, rich } from "../lib.js";
import { S, activeSubject, go, lvl, loadCatalog } from "../state.js";
import { playStage } from "../stage.js";
import { ticketRow, spendTicket } from "../tickets.js";
import { shareButton } from "../shareResult.js";

export async function soloPickView() {
  const sub = activeSubject();
  const [status, ch, hist] = await Promise.all([
    get(`/api/subjects/${sub.id}/solo/status`),
    get(`/api/subjects/${sub.id}/chapters`),
    get(`/api/subjects/${sub.id}/solo/history`).catch(() => ({ games: [] })),
  ]);
  let chosen = null;
  const M = status.modes ?? { ADVENTURE: { enabled: true }, SURVIVAL: { enabled: false }, TIMEATTACK: { enabled: false } };
  const mmss = (sec) => `${Math.floor(sec / 60)} min${sec % 60 ? ` ${sec % 60} s` : ""}`;
  const MODES = [
    ["ADVENTURE", "🧭", "Aventure", `${M.ADVENTURE.questions ?? status.questionsPerGame ?? 10} questions`],
    ["SURVIVAL", "❤️", "Survie", `${M.SURVIVAL.hearts ?? 3} cœurs · ${M.SURVIVAL.questions ?? 15} questions`],
    ["TIMEATTACK", "⏱️", "Contre la montre", `${mmss(M.TIMEATTACK.durationSec ?? 180)} chrono`],
  ].filter(([k]) => M[k].enabled);
  let mode = MODES[0]?.[0] ?? "ADVENTURE";
  const modeBtns = MODES.map(([k, ico, name, sub]) => {
    const b = h("button.mode-opt", { type: "button", "aria-pressed": String(k === mode), onclick: () => { mode = k; modeBtns.forEach((x) => x.setAttribute("aria-pressed", String(x === b))); } },
      h("span.mo-ico", ico), h("strong", name), h("span.muted.small", sub));
    return b;
  });
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
      const r = await post("/api/solo/start", { subjectId: sub.id, chapterId: chosen.id, mode });
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
      ? h("section.stack", MODES.length > 1 ? [h("h2", "Mode de jeu"), h("div.modes-pick", modeBtns)] : null, h("h2", "Chapitre"), h("div.chapters", buttons))
      : h("div.empty", icon("help"), h("p", "Aucun chapitre")),
    ch.chapters.length ? start : null,
    historyBlock(sub, hist.games));
}

const fmtDay = (d) => new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
/** Historique des parties solo : chaque ligne s'ouvre sur son résultat, la croix la retire de l'historique. */
function historyBlock(sub, games) {
  if (!games.length) return null;
  const list = h("div.list");
  const box = h("section.stack.tight", h("div.row.between", h("h2", "Historique"),
    h("button.btn.ghost.small", { onclick: async () => {
      if (!confirm("Effacer tout l'historique solo ? Tes statistiques et ton XP restent acquis.")) return;
      try { await del(`/api/subjects/${sub.id}/history?mode=solo`); box.remove(); } catch (e) { fail(e); }
    } }, "Tout effacer")), list);
  for (const g of games) {
    const row = h("div.item.hist",
      h("a.grow.hist-link", { href: `#/solo/result/${g.id}` },
        h("strong", g.chapter?.name ?? "Solo", g.variant === "SURVIVAL" ? " ❤️" : g.variant === "TIMEATTACK" ? " ⏱️" : ""),
        h("div.muted.small", `${fmtDay(g.at)}${g.status === "ABANDONED" ? " · abandonnée" : ""}`)),
      h("span.chip", g.variant === "TIMEATTACK" ? `${g.correct} ✓` : `${g.correct}/${g.total}`),
      h("button.btn.ghost.small.x", { "aria-label": "Supprimer cette partie", onclick: async () => {
        try { await del(`/api/games/${g.id}`); row.remove(); if (!list.children.length) box.remove(); } catch (e) { fail(e); }
      } }, "✕"));
    list.append(row);
  }
  return box;
}

export async function soloPlayView({ id }, ctx) {
  const [cur] = await Promise.all([get(`/api/solo/${id}/current`), loadCatalog().catch(() => null)]);
  if (cur.status !== "IN_PROGRESS" || !cur.question) { go(`/solo/result/${id}`); return h("div"); }
  const { el, cleanup } = playStage({
    total: cur.question.total,
    question: cur.question,
    label: cur.question.variant === "SURVIVAL" ? "Survie" : cur.question.variant === "TIMEATTACK" ? "Contre la montre" : "Solo",
    hearts: cur.question.heartsMax ? { max: cur.question.heartsMax, left: cur.question.hearts } : null,
    open: cur.question.variant === "TIMEATTACK",
    okCount: cur.question.okSoFar ?? 0,
    answer: (gq, idx, timedOut) => post(`/api/solo/${id}/answer`, { gameQuestionId: gq, choiceIndex: idx, ...(timedOut ? { timedOut: true } : {}) }),
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
      h("div.result-score", r.variant === "TIMEATTACK" ? `${r.correct}` : `${r.correct}/${r.total}`),
      r.variant === "TIMEATTACK" ? h("div.muted", `bonne${r.correct > 1 ? "s" : ""} réponse${r.correct > 1 ? "s" : ""} sur ${r.total} question${r.total > 1 ? "s" : ""}`) : null,
      r.variant === "SURVIVAL" ? h("div.muted", r.status === "FINISHED" && r.answered < r.total ? "Plus de cœurs" : "Parcours terminé") : null,
      h("div", h("span.chip.amber", `+${r.xpEarned} XP`), " ", h("span.chip", `Niveau ${lvl(r.level)}`)),
      r.leveledUp ? h("strong", "Nouveau niveau !") : null),
    h("div.row.wrap",
      h("a.btn.primary.grow", { href: "#/solo" }, "Rejouer"),
      shareButton({ kind: "Partie solo", title: r.chapter?.name ?? r.chapter ?? "Quiz", big: `${r.correct}/${r.total}`, sub: "bonnes réponses", chips: [`+${r.xpEarned} XP`, `Niveau ${lvl(r.level)}`], footer: ratio >= 0.7 ? "Essaie de faire mieux !" : "Tu fais mieux ?" }),
      h("a.btn.ghost.grow", { href: "#/" }, "Accueil")),
    h("h2", "Correction"),
    reviewList(r.review));
}

export function reviewList(items) {
  return h("div.review", items.map((q) =>
    h("div.review-item", { class: q.isCorrect ? "ok" : "ko" },
      h("strong", `${q.position}. `, rich(q.text)),
      h("ul", q.choices.map((c, i) =>
        h("li", { class: i === q.correctIndex ? "right" : "" },
          rich(c), i === q.correctIndex ? " ✓" : "", i === q.yourChoice && !q.isCorrect ? " (ta réponse)" : ""))),
      q.timedOut ? h("div.muted.small", "Temps écoulé") : null,
      q.explanation ? h("p.muted.small", rich(q.explanation)) : null)));
}
