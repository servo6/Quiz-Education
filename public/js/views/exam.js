import { h, get, post, put, fail, toast, rich, icon } from "../lib.js";
import { activeSubject, go } from "../state.js";
import { reportButton } from "../report.js";
import { hbars } from "../charts.js";
import { lessonButton } from "../lesson.js";

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const fmt = (sec) => { sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, "0")}`; };
const gradeText = (g) => String(g).replace(".", ",");

/** Carte d'accueil, toujours visible : mène à la page de l'examen blanc. */
export function examCard() {
  return h("a.card.flat.row.between", { href: "#/exam" },
    h("div", h("strong", "Examen blanc"), h("div.muted.small", "Un vrai contrôle chronométré, corrigé à la fin")),
    h("span.btn.ghost.small", "Passer"));
}

export async function examView() {
  const sub = activeSubject();
  const r = await get(`/api/subjects/${sub.id}/exam`);
  const picked = new Set(r.chapters.map((c) => c.id)); // tous les chapitres au départ
  const start = async (size) => {
    try { await post(`/api/subjects/${sub.id}/exam`, { size, ...(picked.size < r.chapters.length ? { chapterIds: [...picked] } : {}) }); go("/exam/play"); } catch (e) { fail(e); }
  };
  const count = () => r.chapters.filter((c) => picked.has(c.id)).reduce((n, c) => n + c.count, 0);
  const sizesBox = h("div.row.wrap");
  const info = h("p.muted.small");
  const chapBox = h("div.stack.tight");
  const paintSizes = () => {
    const n = count();
    const sizes = [10, 20, 30].filter((x) => x <= n);
    if (!sizes.length && n >= 5) sizes.push(n);
    info.textContent = n ? `${n} question${n > 1 ? "s" : ""} disponible${n > 1 ? "s" : ""} dans la sélection.` : "Choisis au moins un chapitre.";
    sizesBox.replaceChildren(...(sizes.length ? sizes.map((x) => h("button.btn.primary", { onclick: () => start(x) }, `${x} questions · ${x} min`)) : [h("p.muted", n ? "Pas assez de questions dans la sélection (5 au minimum)." : "")]));
  };
  const paintChaps = () => chapBox.replaceChildren(
    h("div.row.between", h("strong", "Chapitres"),
      h("button.btn.ghost.small", { type: "button", onclick: () => { if (picked.size === r.chapters.length) picked.clear(); else r.chapters.forEach((c) => picked.add(c.id)); paintChaps(); paintSizes(); } }, picked.size === r.chapters.length ? "Tout décocher" : "Tout cocher")),
    ...r.chapters.map((c) => h("label.row", { style: "gap:10px;cursor:pointer;padding:6px 0" },
      h("input", { type: "checkbox", checked: picked.has(c.id), onchange: (e) => { e.target.checked ? picked.add(c.id) : picked.delete(c.id); paintChaps(); paintSizes(); } }),
      h("span.grow", c.name), h("span.muted.small", `${c.count} q.`))));
  paintChaps(); paintSizes();
  return h("div.stack",
    h("a.muted", { href: "#/" }, "← Accueil"),
    h("h1", "Examen blanc"),
    h("section.card.stack",
      h("p", "Les questions sont tirées au hasard dans les chapitres choisis. Tu as 1 minute par question, sans correction pendant l'épreuve : tu peux revenir en arrière et changer tes réponses. Tu reçois une note sur 20 et la correction détaillée à la remise."),
      h("p.muted.small", "Un examen blanc ne rapporte pas d'XP et ne compte pas dans tes statistiques."),
      r.current
        ? h("div.stack.tight", h("strong", "Un examen est en cours."), h("a.btn.primary.block", { href: "#/exam/play" }, "Reprendre l'examen"))
        : r.chapters.length
          ? h("div.stack", chapBox, info, sizesBox)
          : h("p.muted", "Cette matière n'a pas encore assez de questions pour un examen.")),
    r.history.length ? h("section.stack.tight", h("h2", "Mes derniers examens"), h("div.list", r.history.map((x) => h("a.item", { href: `#/exam/${x.id}` },
      h("span.chip", { class: x.grade >= 10 ? "good" : "bad" }, `${gradeText(x.grade)}/20`),
      h("div.grow", h("strong", `${x.correct}/${x.total} bonnes réponses`), h("div.muted.small", new Date(x.finishedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }))))))) : null);
}

export async function examPlayView(_p, ctx) {
  const sub = activeSubject();
  const E = await get(`/api/subjects/${sub.id}/exam/current`);
  if (!E.id) { go("/exam"); return h("div"); }
  const offset = E.serverNow - Date.now(); // décalage d'horloge entre le serveur et l'appareil
  const left = () => (E.deadline - (Date.now() + offset)) / 1000;
  const answers = { ...E.answers };
  let i = 0, saveT = null, over = false;
  const root = h("div.stage");
  const timer = h("b", fmt(left()));

  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => put(`/api/exam/${E.id}/answers`, { answers }).catch(() => {}), 500); };
  const submit = async (auto = false) => {
    if (over) return; over = true; clearInterval(tick); clearTimeout(saveT);
    try { await post(`/api/exam/${E.id}/submit`, { answers }); if (auto) toast("Temps écoulé : examen remis"); go(`/exam/${E.id}`); }
    catch (e) { over = false; fail(e); }
  };
  const tick = setInterval(() => { timer.textContent = fmt(left()); timer.parentElement?.classList.toggle("low", left() < 60); if (left() <= 0) submit(true); }, 500);
  ctx.setCleanup(() => { clearInterval(tick); clearTimeout(saveT); });

  const paint = () => {
    const q = E.questions[i];
    const blank = E.questions.filter((x) => answers[x.id] == null).length;
    const grid = h("div.row.wrap", { style: "gap:6px;justify-content:center" }, E.questions.map((x, k) =>
      h("button.btn.small", { type: "button", class: k === i ? "primary" : answers[x.id] != null ? "" : "ghost", "aria-label": `Question ${k + 1}${answers[x.id] != null ? ", répondue" : ""}`, "aria-current": k === i ? "true" : null, style: "min-width:38px", onclick: () => { i = k; paint(); } }, String(k + 1))));
    root.replaceChildren(h("div.stage-inner",
      h("div.stage-top", h("div.q-meta", { style: "flex:1" }, `Examen blanc · question ${i + 1}/${E.questions.length}`), h("div.timer", { "aria-live": "off" }, timer)),
      h("div.q-wrap", h("h1.q-text", rich(q.text)),
        h("div.answers", q.choices.map((c, k) => h("button.answer", { "aria-pressed": answers[q.id] === k ? "true" : "false", onclick: () => { answers[q.id] = answers[q.id] === k ? null : k; save(); paint(); } },
          h("span.tag", LETTERS[k] ?? k + 1), h("span", rich(c)))))),
      h("div.stack.tight", grid,
        h("div.row.between", h("button.btn.ghost", { disabled: i === 0, onclick: () => { i--; paint(); } }, "Précédente"),
          i < E.questions.length - 1 ? h("button.btn.primary", { onclick: () => { i++; paint(); } }, "Suivante")
            : h("button.btn.primary", { onclick: confirmSubmit }, "Remettre")),
        h("button.btn.ghost.block", { onclick: confirmSubmit }, `Remettre l'examen${blank ? ` (${blank} sans réponse)` : ""}`))));
  };
  const confirmSubmit = () => {
    const blank = E.questions.filter((x) => answers[x.id] == null).length;
    if (confirm(blank ? `Il reste ${blank} question${blank > 1 ? "s" : ""} sans réponse. Remettre l'examen ?` : "Remettre l'examen ?")) submit();
  };
  paint();
  return root;
}

export async function examResultView({ id }) {
  const r = await get(`/api/exam/${id}`);
  const LET = LETTERS;
  const item = (c) => h("div.card.stack.tight", { class: c.correct ? "" : "flat" },
    h("div.row.between", h("strong", `Question ${c.n}`), h("span.chip", { class: c.correct ? "good" : c.choice == null ? "" : "bad" }, c.correct ? "Juste" : c.choice == null ? "Sans réponse" : "Faux")),
    h("p", rich(c.text)),
    h("div.stack.tight", c.choices.map((t, k) => h("div.small", { style: `padding:6px 10px;border-radius:8px;${k === c.correctIndex ? "background:color-mix(in srgb,var(--good,#2a9d6a) 22%,transparent)" : k === c.choice ? "background:color-mix(in srgb,var(--bad,#d64545) 22%,transparent)" : ""}` },
      `${LET[k] ?? k + 1}. `, rich(t), k === c.correctIndex ? " ✓" : k === c.choice ? " (ta réponse)" : ""))),
    c.explanation ? h("p.muted.small", rich(c.explanation)) : null,
    h("div.row.between", c.correct ? h("span") : lessonButton(c.id), reportButton(c.id)));
  return h("div.stack",
    h("a.muted", { href: "#/exam" }, "← Examen blanc"),
    h("h1", "Résultat de l'examen"),
    h("section.card.center.stack.tight", h("div.result-score", `${gradeText(r.grade)} / 20`),
      h("p", `${r.correct} bonne${r.correct > 1 ? "s" : ""} réponse${r.correct > 1 ? "s" : ""} sur ${r.total}${r.blank ? ` · ${r.blank} sans réponse` : ""}`),
      r.timeUsedSec != null ? h("p.muted.small", `Temps utilisé : ${fmt(r.timeUsedSec)} sur ${fmt(r.durationSec)}`) : null),
    r.chapters.length > 1 ? h("section.card.stack", h("h2", "Par chapitre"), hbars(r.chapters.map((c) => ({ label: c.name, value: c.accuracy, note: `${c.correct} / ${c.total}` })))) : null,
    h("section.stack", h("h2", "Correction"), ...r.corrections.map(item)));
}
