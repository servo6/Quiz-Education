import { h, get, post, fail, confetti, avatarEl } from "../lib.js";
import { activeSubject, go, loadCatalog, refreshSummary } from "../state.js";
import { playStage } from "../stage.js";
import { shareButton } from "../shareResult.js";

const fmtTime = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s` : `${s} s`; };

/** Pastille « série » : jours consécutifs où le défi a été terminé. */
function streakChip(st, doneToday) {
  const n = st?.current ?? 0;
  return h("span.chip", { class: n > 0 ? "amber" : "", title: "Jours de suite avec le défi terminé" }, `🔥 ${n} jour${n > 1 ? "s" : ""}${n > 0 && !doneToday ? " · à prolonger" : ""}`);
}

/** Carte de l'accueil : l'état du défi du jour en un coup d'œil. */
export async function dailyCard(sub) {
  let d;
  try { d = await get(`/api/subjects/${sub.id}/daily`); } catch { return null; }
  if (!d.available) return null;
  const done = d.status === "DONE";
  return h("a.card.flat.row.between.daily-card", { href: "#/daily" },
    h("div", h("strong", "Défi du jour"),
      h("div.muted.small", done ? `Terminé : ${d.mine.correct}/${d.mine.total}${d.mine.rank ? ` · ${d.mine.rank}e` : ""}` : d.status === "IN_PROGRESS" ? "À reprendre" : `${d.total} questions, un seul essai`)),
    h("div.row", streakChip(d.streak, done), done ? null : h("span.btn.primary.small", d.status === "IN_PROGRESS" ? "Reprendre" : "Jouer")));
}

export async function dailyView() {
  const sub = activeSubject();
  const [d, cat] = await Promise.all([get(`/api/subjects/${sub.id}/daily`), loadCatalog().catch(() => [])]);
  if (!d.available) {
    return h("div.stack", h("a.muted", { href: "#/" }, "← Accueil"), h("h1", "Défi du jour"),
      h("div.empty", h("p", "Cette matière n'a pas encore assez de questions pour un défi du jour.")));
  }
  const done = d.status === "DONE";
  const head = h("section.card.center.stack",
    h("div.muted", new Date(d.day + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })),
    h("h1", "Défi du jour"),
    streakChip(d.streak, done),
    d.streak.longest > 1 ? h("div.muted.small", `Record : ${d.streak.longest} jours`) : null);

  if (!done) {
    return h("div.stack", h("a.muted", { href: "#/" }, "← Accueil"), head,
      h("section.card.stack",
        h("p", `${d.total} questions, les mêmes pour tous les joueurs de ${sub.name}. Un seul essai : ton score et ton temps te placent au classement du jour.`),
        h("p.muted.small", "Chaque jour terminé prolonge ta série et rapporte un bonus d'XP qui grandit avec elle."),
        h("a.btn.primary.block", { href: "#/daily/play" }, d.status === "IN_PROGRESS" ? "Reprendre le défi" : "Lancer le défi")));
  }
  if (d.mine.correct >= Math.ceil(d.mine.total * 0.7)) setTimeout(confetti, 200);
  return h("div.stack", h("a.muted", { href: "#/" }, "← Accueil"), head,
    h("section.card.center.stack",
      h("div.result-score", `${d.mine.correct} / ${d.mine.total}`),
      h("div", h("span.chip.amber", `+${d.mine.xpEarned} XP`), " ", h("span.chip", `⏱ ${fmtTime(d.mine.timeMs)}`), d.mine.rank ? [" ", h("span.chip.good", `${d.mine.rank}e sur ${d.participants}`)] : null),
      h("p.muted.small", "Reviens demain pour un nouveau défi et prolonger ta série."),
      h("div.row.wrap", shareButton({ kind: "Défi du jour", title: sub.name, big: `${d.mine.correct}/${d.mine.total}`, sub: d.mine.rank ? `${d.mine.rank}e sur ${d.participants} aujourd'hui` : "bonnes réponses", chips: [`🔥 ${d.streak.current} jour${d.streak.current > 1 ? "s" : ""}`, `+${d.mine.xpEarned} XP`], footer: "Relève le défi du jour !" }))),
    h("section.stack.tight", h("h2", "Classement du jour"),
      h("div.list", d.ranking.map((r) => h("div.item", { class: r.mine ? "me" : "" },
        h("b", { style: "min-width:1.8em" }, String(r.rank)),
        avatarEl(r.avatar, cat, 34),
        h("div.grow", h("strong", r.username + (r.mine ? " (toi)" : ""))),
        h("span.chip", `${r.correct}/${d.total}`), h("span.muted.small", fmtTime(r.timeMs)))))));
}

export async function dailyPlayView(_p, ctx) {
  const sub = activeSubject();
  const base = `/api/subjects/${sub.id}/daily`;
  const [cur] = await Promise.all([get(`${base}/current`), loadCatalog().catch(() => null)]);
  if (cur.status !== "IN_PROGRESS") { go("/daily"); return h("div"); }
  const { el, cleanup } = playStage({
    total: cur.question.total, question: cur.question, label: "Défi du jour",
    answer: (gq, idx) => post(`${base}/answer`, { gameQuestionId: gq, choiceIndex: idx }),
    markServed: () => get(`${base}/current`),
    loadNext: async () => { const n = await get(`${base}/current`); return n.status === "IN_PROGRESS" ? n.question : null; },
    onDone: () => { refreshSummary(); go("/daily"); },
    onQuit: () => go("/daily"),
  });
  ctx.setCleanup(cleanup);
  return el;
}
