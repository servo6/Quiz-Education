import { h, get, avatarEl, timeLeft } from "../lib.js";
import { activeSubject, loadCatalog } from "../state.js";

const MEDAL = ["🥉", "🥈", "🥇", "💎"];

/** Carte de l'accueil : ligue actuelle et place cette semaine. */
export async function leagueCard(sub) {
  let l;
  try { l = await get(`/api/subjects/${sub.id}/league`); } catch { return null; }
  return h("a.card.flat.row.between.league-card", { href: "#/league" },
    h("div", h("strong", `${MEDAL[l.tier]} Ligue ${l.tierName}`),
      h("div.muted.small", l.myXp > 0 ? `${l.myRank}e cette semaine · ${l.myXp} XP` : "Gagne de l'XP pour entrer au classement")),
    h("span.chip", `fin dans ${timeLeft(l.endsAt)}`));
}

export async function leagueView() {
  const sub = activeSubject();
  const [l, cat] = await Promise.all([get(`/api/subjects/${sub.id}/league`), loadCatalog().catch(() => [])]);
  const move = l.lastMove;
  const moveBox = move && move.result !== "STAY" ? h("div.feedback", { class: move.result === "UP" ? "ok" : "ko" },
    move.result === "UP" ? `🎉 Tu es monté en ligue ${move.toName} (${move.rank}e sur ${move.of} la semaine dernière).` : `Tu es redescendu en ligue ${move.toName} (${move.rank}e sur ${move.of}). Reviens plus fort !`) : null;
  return h("div.stack",
    h("a.muted", { href: "#/ranking" }, "← Classement"),
    h("section.card.center.stack",
      h("div", { style: "font-size:3rem;line-height:1" }, MEDAL[l.tier]),
      h("h1", `Ligue ${l.tierName}`),
      h("div.row.wrap", { style: "justify-content:center" }, l.tiers.map((t, i) => h("span.chip", { class: i === l.tier ? "amber" : "", "aria-current": i === l.tier ? "true" : null }, `${MEDAL[i]} ${t}`))),
      h("p.muted.small", `La semaine se termine dans ${timeLeft(l.endsAt)}. Les ${l.zone || "meilleurs"} premiers montent${l.tier < 3 ? "" : " (ligue maximale)"}, les derniers descendent. Seuls les joueurs qui ont gagné de l'XP comptent.`)),
    moveBox,
    h("section.stack.tight", h("h2", "Classement de la semaine"),
      h("div.list", l.standings.map((s) => h("div.item", { class: s.mine ? "me" : "" },
        h("b", { style: "min-width:1.8em" }, String(s.rank)),
        avatarEl(s.avatar, cat, 34),
        h("div.grow", h("strong", s.username + (s.mine ? " (toi)" : ""))),
        s.zone === "up" ? h("span.chip.good", "▲ monte") : s.zone === "down" ? h("span.chip.bad", "▼ descend") : null,
        h("span.chip", `${s.xp} XP`))))));
}
