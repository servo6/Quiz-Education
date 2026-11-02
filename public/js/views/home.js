import { h, get, icon, svg, timeLeft } from "../lib.js";
import { S, activeSubject, refreshSummary, loadCatalog } from "../state.js";
import { avatarEl } from "../lib.js";
import { ticketRow, loadTickets } from "../tickets.js";

export async function homeView() {
  const sub = activeSubject();
  const [cat, board, tix] = await Promise.all([
    loadCatalog().catch(() => []),
    get(`/api/subjects/${sub.id}/leaderboard?limit=1`).catch(() => null),
    loadTickets(sub.id),
    refreshSummary(),
  ]);
  const sum = S.summary;
  const turn = (sum?.duels ?? []).filter((d) => d.yourTurn && d.subject?.id === sub.id);
  const pct = sub.xpForNext ? Math.min(100, Math.round((sub.xpIntoLevel / sub.xpForNext) * 100)) : 0;
  const solo = (sum?.soloInProgress ?? []).filter((g) => g.subjectId === sub.id);

  return h("div.stack",
    h("section.hero",
      avatarEl(S.me.user.avatar, cat, 84),
      h("div",
        h("div.title", { style: sub.title?.color ? `color:${sub.title.color}` : "" }, sub.title?.name ?? ""),
        h("h1", S.me.user.username),
        h("div.xpbar", { role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": "Progression vers le niveau suivant" }, h("i", { style: `width:${pct}%` })),
        h("div.xptext", `Niveau ${sub.level} · ${sub.xpIntoLevel} / ${sub.xpForNext} XP`
          + (board?.you?.rank ? ` · ${board.you.rank}${board.you.rank === 1 ? "er" : "e"} sur ${board.totalPlayers}` : "")))),
    solo.length ? h("a.card.flat.row.between", { href: `#/solo/play/${solo[0].gameId}` },
      h("strong", "Partie en cours"),
      h("span.btn.primary.small", "Reprendre")) : null,
    h("div.modes",
      h("a.mode.solo", { href: "#/solo" }, withArt(icon("play")), h("h2", "Solo"), tix ? ticketRow("solo", tix.solo.left, tix.solo.total) : null),
      h("a.mode.duel", { href: "#/duels" }, withArt(icon("duel")), turn.length ? h("span.chip", `${turn.length} à ton tour`) : null, h("h2", "Duel"), tix ? h("div.tickets-bar", ticketRow("duel", tix.duel.left, tix.duel.total), ticketRow("live", null, null)) : null)),
    turn.length ? h("section.stack.tight", h("h2", "À ton tour"),
      h("div.list", turn.map((d) => duelRow(d)))) : null);
}
function withArt(el) { el.classList.add("art"); return el; }
function duelRow(d) {
  return h("a.item", { href: `#/duels/${d.duelId}` },
    h("div.grow", h("strong", `contre ${d.opponent.username}`),
      h("div.muted.small", d.action === "pick" ? `Choisis le chapitre de la manche ${d.round}` : `Manche ${d.round} à jouer`)),
    h("span.chip", { class: d.expiresSoon ? "bad" : "amber" }, `fin dans ${timeLeft(d.deadlineAt)}`));
}
