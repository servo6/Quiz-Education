import { h, mount, get, post, put, api, fail, toast, errorMessage, icon } from "../lib.js";
import { statsPanel, chatPanel } from "./adminStats.js";
import { S, go, rerender } from "../state.js";
import { editQuestion, managersSection, comptes, titres, badges, avatars, download } from "./admin2.js";
import { appearancePanel } from "./appearance.js";

/** Panneaux d'administration : [clé, libellé, icône]. Le dernier élément d'un groupe réservé à l'administrateur le marque. */
export const ADMIN_GROUPS = [
  { name: "Matière", items: [["stats", "Statistiques", "chart"], ["questions", "Questions", "list"], ["corbeille", "Corbeille", "trash"], ["membres", "Membres", "users"], ["reglages", "Réglages", "sliders"], ["journal", "Journal", "journal"]] },
  { name: "Plateforme", adminOnly: true, items: [["matieres", "Matières", "book"], ["comptes", "Comptes", "shield"], ["globaux", "Réglages globaux", "sliders"], ["messagerie", "Messagerie", "chat"], ["journalg", "Journal global", "journal"], ["titres", "Titres", "layers"], ["badges", "Badges", "award"], ["avatars", "Avatars", "image"], ["apparence", "Apparence", "palette"]] },
];
const patch = (u, b) => api("PATCH", u, b);
const del = (u, b) => api("DELETE", u, b);
const fmt = (iso) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
const isAdmin = () => S.me.user.role === "ADMIN";
export const canOpenAdmin = () => isAdmin() || (S.me.managedSubjectIds?.length ?? 0) > 0;
export const visibleGroups = () => ADMIN_GROUPS.filter((g) => !g.adminOnly || isAdmin());

// ───────── Matière gérée (l'administrateur n'est membre d'aucune matière) ─────────
let subjectList = null;
export const adminSubjects = () => subjectList ?? [];
export async function loadAdminSubjects(force = false) {
  if (!subjectList || force) subjectList = (await get("/api/subjects")).subjects;
  document.dispatchEvent(new Event("admin-subjects"));
  return subjectList;
}
export function adminSub() {
  let id = null;
  try { id = localStorage.getItem("qp-admin-subject"); } catch { /* stockage indisponible */ }
  return adminSubjects().find((s) => s.id === id) ?? adminSubjects()[0] ?? null;
}
export function chooseAdminSub(id) {
  try { localStorage.setItem("qp-admin-subject", id); } catch { /* stockage indisponible */ }
  document.dispatchEvent(new Event("admin-subjects"));
}

export async function adminView({ tab }) {
  if (!canOpenAdmin()) { go("/"); return h("div"); }
  await loadAdminSubjects();
  const sub = adminSub();
  const groups = visibleGroups();
  const flat = groups.flatMap((g) => g.items.map((it) => ({ it, scoped: !g.adminOnly })));
  if (!tab || !flat.some((x) => x.it[0] === tab)) { go(`/admin/${sub || !isAdmin() ? "stats" : "matieres"}`); return h("div"); }
  const { it, scoped } = flat.find((x) => x.it[0] === tab);
  const body = h("div.stack", h("div.center", h("div.spinner")));
  const views = { stats: statsPanel, messagerie: () => chatPanel(), globaux: () => reglages(null), journalg: () => journal(null), questions, corbeille, membres, reglages, journal, matieres, comptes, titres, badges, avatars, apparence: () => appearancePanel() };
  if (scoped && !sub) {
    body.replaceChildren(h("div.empty", icon("book"), h("p", "Aucune matière pour le moment."),
      isAdmin() ? h("a.btn.primary", { href: "#/admin/matieres" }, "Créer une matière") : null));
  } else {
    views[tab](sub).then((n) => body.replaceChildren(n)).catch((e) => body.replaceChildren(h("p.error-box", errorMessage(e))));
  }
  return h("div.stack",
    h("div.admin-head", h("h1", it[1]), scoped && sub ? h("span.chip", sub.name) : null),
    body);
}

// ───────── Questions et chapitres ─────────
const PALETTE = ["#6670e0", "#2f8f5b", "#d4a017", "#d9534f", "#e07b39", "#a14fbf", "#1f9fb5", "#c2548a", "#6b7280"];
/** Choix de couleur : pastilles prédéfinies, couleur libre, ou aucune (couleur du thème). */
function colorPicker(initial, onChange) {
  let value = initial ?? "";
  const box = h("div.swatches", { role: "group", "aria-label": "Couleur du chapitre" });
  const custom = h("input", { type: "color", "aria-label": "Couleur personnalisée", value: /^#[0-9a-f]{6}$/i.test(value) ? value : "#6670e0", oninput: () => set(custom.value) });
  const paint = () => box.replaceChildren(
    h("button.none", { type: "button", title: "Aucune couleur", "aria-label": "Aucune couleur", "aria-pressed": String(value === ""), onclick: () => set("") }),
    ...PALETTE.map((c) => h("button", { type: "button", title: c, "aria-label": `Couleur ${c}`, style: `--c:${c}`, "aria-pressed": String(value.toLowerCase() === c), onclick: () => set(c) })), custom);
  function set(v) { value = v; paint(); onChange?.(v); }
  paint();
  return { el: box, get value() { return value; } };
}
const chapterChips = (c) => [c.locked ? h("span.chip.amber", "Bloqué") : null];
async function questions(sub) {
  const root = h("div.stack");
  let selected = null;
  const chaptersBox = h("div.stack.tight");
  const detail = h("div.stack");

  async function refresh() {
    const { chapters } = await get(`/api/subjects/${sub.id}/chapters`);
    chaptersBox.replaceChildren(
      h("h2", `Chapitres (${chapters.length})`),
      chapters.length ? h("div.chapters", chapters.map((c) => h("button.chapter", {
        "aria-pressed": String(selected === c.id), style: c.color ? `--chap:${c.color}` : "", onclick: () => { selected = c.id; refresh(); openChapter(c); },
      }, h("strong", c.name), h("span.row", { style: "gap:6px" }, h("span.muted.small", `${c.questionCount} question${c.questionCount > 1 ? "s" : ""}`), chapterChips(c))))) : h("p.muted", "Aucun chapitre. Crée-en un ou importe des questions dans un nouveau chapitre."),
      newChapterForm(),
      chapters.length ? h("button.btn.ghost", { onclick: async () => { try { const x = await get(`/api/subjects/${sub.id}/export`); download(`${sub.name.replace(/[^\w]+/g, "-")}-questions.json`, x); toast("Export téléchargé", "good"); } catch (e) { fail(e); } } }, "Exporter toute la matière") : null);
    importCard.update(chapters);
  }
  function newChapterForm() {
    const name = h("input.input", { placeholder: "Nom du nouveau chapitre", maxlength: 80, "aria-label": "Nom du nouveau chapitre" });
    const pick = colorPicker("");
    const lock = h("input", { type: "checkbox", id: "new-lock" });
    return h("form.stack.tight.card.flat", { onsubmit: async (e) => { e.preventDefault(); if (!name.value.trim()) return;
      try { await post(`/api/subjects/${sub.id}/chapters`, { name: name.value.trim(), color: pick.value, locked: lock.checked }); toast(lock.checked ? "Chapitre créé (bloqué)" : "Chapitre créé", "good"); refresh(); } catch (ex) { fail(ex); } } },
      h("strong", "Nouveau chapitre"), h("div.row", h("div.grow", name), h("button.btn", { type: "submit" }, "Créer")),
      h("div.field", h("label", "Couleur"), pick.el),
      h("label.row", { for: "new-lock" }, lock, " Bloquer l'accès : les joueurs ne le voient pas tant qu'il n'est pas débloqué"));
  }

  async function openChapter(c) {
    detail.replaceChildren(h("div.center", h("div.spinner")));
    const [qs, bs] = await Promise.all([get(`/api/chapters/${c.id}/questions?limit=100`), get(`/api/chapters/${c.id}/batches`)]);
    const since = h("input.input", { type: "datetime-local", "aria-label": "Date et heure" });
    detail.replaceChildren(h("section.card.stack",
      h("div.row.between.wrap", h("h2", h("span.chap-dot", { style: c.color ? `--chap:${c.color}` : "" }), c.name, " ", chapterChips(c)), h("div.row",
        h("button.btn.small", { onclick: async () => { try { await patch(`/api/chapters/${c.id}`, { locked: !c.locked }); toast(c.locked ? "Chapitre débloqué : les joueurs peuvent le jouer" : "Chapitre bloqué : caché des joueurs", "good"); selected = c.id; await refresh(); openChapter({ ...c, locked: !c.locked }); } catch (e) { fail(e); } } }, c.locked ? "Débloquer" : "Bloquer"),
        h("button.btn.small", { onclick: async () => { try { const x = await get(`/api/subjects/${sub.id}/export?chapterId=${c.id}`); download(`${c.name.replace(/[^\w]+/g, "-")}.json`, { questions: x.chapters[0].questions }); } catch (e) { fail(e); } } }, "Exporter"),
        h("button.btn.small", { onclick: async () => { const n = prompt("Nouveau nom du chapitre", c.name); if (!n?.trim()) return;
          try { await patch(`/api/chapters/${c.id}`, { name: n.trim() }); toast("Chapitre renommé", "good"); refresh(); detail.replaceChildren(); } catch (e) { fail(e); } } }, "Renommer"),
        h("button.btn.small.danger", { onclick: async () => { if (!confirm(`Supprimer le chapitre « ${c.name} » et ses ${c.questionCount} questions ? Tu pourras les restaurer depuis la corbeille.`)) return;
          try { await del(`/api/chapters/${c.id}`); toast("Chapitre supprimé", "good"); selected = null; detail.replaceChildren(); refresh(); } catch (e) { fail(e); } } }, "Supprimer"))),
      h("div.stack.tight", h("strong", "Couleur du chapitre"), colorPicker(c.color, async (v) => { try { await patch(`/api/chapters/${c.id}`, { color: v }); c.color = v; toast("Couleur enregistrée", "good"); refresh(); } catch (e) { fail(e); } }).el),
      h("div.stack.tight", h("strong", "Imports"),
        bs.batches.length ? bs.batches.map((b) => h("div.item", h("div.grow", h("div", fmt(b.createdAt)), h("div.muted.small", `${b.importedBy?.username ?? ""} · ${b.activeCount}/${b.importedCount} questions actives`)),
          b.deletedAt ? h("span.chip", "annulé") : h("button.btn.small.danger", { onclick: async () => { if (!confirm("Annuler cet import et supprimer ses questions ?")) return;
            try { const r = await del(`/api/batches/${b.id}`); toast(`${r.deletedQuestions} questions supprimées`, "good"); refresh(); openChapter(c); } catch (e) { fail(e); } } }, "Annuler"))) : h("p.muted.small", "Aucun import.")),
      h("div.stack.tight", h("strong", "Supprimer les questions ajoutées depuis…"),
        h("div.row", h("div.grow", since), h("button.btn.small.danger", { onclick: async () => {
          if (!since.value) return toast("Choisis une date et une heure", "bad");
          const iso = new Date(since.value).toISOString();
          if (!confirm(`Supprimer les questions ajoutées depuis le ${fmt(iso)} ?`)) return;
          try { const r = await post(`/api/chapters/${c.id}/questions/delete-since`, { since: iso }); toast(`${r.deletedQuestions} questions supprimées`, "good"); refresh(); openChapter(c); } catch (e) { fail(e); } } }, "Supprimer"))),
      h("div.stack.tight", h("strong", `Questions (${qs.questions.length}${qs.nextCursor ? "+" : ""})`),
        qs.questions.length ? h("div.review", qs.questions.map((q) => h("div.review-item",
          h("div.row.between", h("strong", q.question), h("div.row",
            h("button.btn.small", { onclick: async () => { const { chapters } = await get(`/api/subjects/${sub.id}/chapters`); editQuestion(q, chapters, c.id, () => { refresh(); openChapter(c); }); } }, "Modifier"),
            h("button.btn.small.danger", { onclick: async () => {
              try { await del(`/api/questions/${q.id}`); toast("Question supprimée", "good"); refresh(); openChapter(c); } catch (e) { fail(e); } } }, "Supprimer"))),
          h("ul", q.choices.map((ch, i) => h("li", { class: i === q.answer ? "right" : "" }, ch, i === q.answer ? " ✓" : ""))),
          q.stats.answered ? h("div.muted.small", `Réussite ${q.stats.accuracy} % sur ${q.stats.answered} réponses`) : null))) : h("p.muted.small", "Aucune question."))));
  }

  const importCard = importCardFor(sub, () => refresh());
  root.append(importCard.el, chaptersBox, detail);
  await refresh();
  return root;
}

function importCardFor(sub, onDone) {
  let chapters = [];
  const target = h("select.input", { "aria-label": "Chapitre cible" });
  const newName = h("input.input", { placeholder: "Nom du nouveau chapitre", maxlength: 80 });
  const newPick = colorPicker("");
  const newLock = h("input", { type: "checkbox", id: "imp-lock" });
  const newOpts = h("div.stack.tight", { hidden: true }, h("div.field", h("label", "Couleur du nouveau chapitre"), newPick.el), h("label.row", { for: "imp-lock" }, newLock, " Bloquer l'accès (caché des joueurs)"));
  const raw = h("textarea.input", { rows: 8, placeholder: '[\n  { "question": "…", "choices": ["A", "B", "C", "D"], "answer": 1, "explanation": "…" }\n]', style: "font-family:ui-monospace,monospace;font-size:.85rem", spellcheck: "false", "aria-label": "Questions au format JSON" });
  const file = h("input", { type: "file", accept: ".json,application/json", onchange: async () => { if (file.files[0]) raw.value = await file.files[0].text(); preview.replaceChildren(); } });
  const strict = h("input", { type: "checkbox", id: "strict" });
  const preview = h("div.stack.tight");
  let ok = false;
  const commit = h("button.btn.primary", { disabled: true, onclick: doCommit }, "Importer");
  const check = h("button.btn", { onclick: doCheck }, "Vérifier");
  const payload = () => ({ raw: raw.value, mode: strict.checked ? "all_or_nothing" : "partial", ...(target.value === "__new" ? { newChapterName: newName.value.trim(), newChapterColor: newPick.value, newChapterLocked: newLock.checked } : { chapterId: target.value }) });
  target.onchange = () => { newName.hidden = target.value !== "__new"; newOpts.hidden = target.value !== "__new"; };
  async function doCheck() {
    if (!raw.value.trim()) return toast("Colle ou charge des questions d'abord", "bad");
    check.disabled = true;
    try {
      const r = await post(`/api/subjects/${sub.id}/import/preview`, payload());
      ok = r.canImport;
      commit.disabled = !ok;
      mount(preview,
        h("div.row.wrap", h("span.chip.good", `${r.validCount} valide${r.validCount > 1 ? "s" : ""}`), h("span.chip", { class: r.errorCount ? "bad" : "" }, `${r.errorCount} erreur${r.errorCount > 1 ? "s" : ""}`), h("span.chip", `${r.duplicateCount} doublon${r.duplicateCount > 1 ? "s" : ""}`),
          h("span.muted.small", r.chapter.isNew ? `Nouveau chapitre « ${r.chapter.name} »` : `Chapitre « ${r.chapter.name} »`)),
        r.fatalError ? h("p.error-box", r.fatalError) : null,
        r.blockedReason ? h("p.error-box", r.blockedReason) : null,
        r.errors.length ? h("ul.small", r.errors.slice(0, 10).map((e) => h("li", `${e.index != null ? "n°" + (e.index + 1) + " : " : ""}${(e.messages ?? [e.message]).filter(Boolean).join(", ")}`))) : null);
    } catch (e) { ok = false; commit.disabled = true; preview.replaceChildren(h("p.error-box", errorMessage(e))); } finally { check.disabled = false; }
  }
  async function doCommit() {
    commit.disabled = true;
    try {
      const r = await post(`/api/subjects/${sub.id}/import/commit`, payload());
      toast(`${r.imported} question${r.imported > 1 ? "s" : ""} importée${r.imported > 1 ? "s" : ""}`, "good");
      raw.value = ""; file.value = ""; preview.replaceChildren(); onDone();
    } catch (e) { fail(e); commit.disabled = false; }
  }
  raw.addEventListener("input", () => { ok = false; commit.disabled = true; });
  const el = h("section.card.stack", h("h2", "Importer des questions"),
    h("p.muted.small", 'Format : un tableau JSON. "answer" est la position de la bonne réponse (0 pour la première). "explanation" est facultatif.'),
    target, newName, newOpts, file, raw,
    h("label.row.small", strict, " Tout refuser s'il y a une seule erreur"),
    preview, h("div.row", check, commit));
  return {
    el,
    update(list) {
      chapters = list;
      const prev = target.value;
      target.replaceChildren(...list.map((c) => h("option", { value: c.id }, c.name)), h("option", { value: "__new" }, "+ Nouveau chapitre"));
      target.value = list.some((c) => c.id === prev) || prev === "__new" ? prev : (list[0]?.id ?? "__new");
      newName.hidden = target.value !== "__new"; newOpts.hidden = target.value !== "__new";
    },
  };
}

// ───────── Corbeille ─────────
async function corbeille(sub) {
  const t = await get(`/api/subjects/${sub.id}/trash`);
  const act = (label, url) => h("button.btn.small", { onclick: async () => { try { const r = await post(url); toast(`Restauré${r.restored != null ? ` (${r.restored})` : ""}`, "good"); rerender(); } catch (e) { fail(e); } } }, label);
  const empty = !t.chapters.length && !t.batches.length && !t.questions.length;
  return h("div.stack",
    empty ? h("div.empty", h("p", "La corbeille est vide.")) : null,
    t.chapters.length ? h("section.stack.tight", h("h2", "Chapitres supprimés"), t.chapters.map((c) => h("div.item", h("div.grow", h("strong", c.name), h("div.muted.small", `supprimé le ${fmt(c.deletedAt)} · ${c.questions} questions`)), act("Restaurer", `/api/chapters/${c.id}/restore`)))) : null,
    t.batches.length ? h("section.stack.tight", h("h2", "Imports annulés"), t.batches.map((b) => h("div.item", h("div.grow", h("strong", b.chapter.name), h("div.muted.small", `annulé le ${fmt(b.deletedAt)} · ${b.importedCount} questions`)), act("Restaurer", `/api/batches/${b.id}/restore`)))) : null,
    t.questions.length ? h("section.stack.tight", h("h2", `Questions supprimées (${t.totalDeletedQuestions})`), t.questions.map((q) => h("div.item", h("div.grow", h("div", q.question), h("div.muted.small", `${q.chapter.name} · ${fmt(q.deletedAt)}`)), act("Restaurer", `/api/questions/${q.id}/restore`)))) : null,
    !empty ? h("button.btn.ghost.danger", { onclick: async () => { if (!confirm("Supprimer définitivement ce qui est dans la corbeille et n'a jamais été joué ?")) return;
      try { const r = await post(`/api/subjects/${sub.id}/trash/purge`, {}); toast("Corbeille purgée", "good"); rerender(); } catch (e) { fail(e); } } }, "Vider la corbeille") : null);
}

// ───────── Membres ─────────
async function membres(sub) {
  const q = h("input.input", { type: "search", placeholder: "Chercher un membre", "aria-label": "Chercher un membre" });
  const list = h("div.list");
  const mg = isAdmin() ? await managersSection(sub) : null;
  async function load() {
    const r = await get(`/api/subjects/${sub.id}/members?q=${encodeURIComponent(q.value)}`);
    list.replaceChildren(...(r.members.length ? r.members.map((m) => h("div.item", { style: "flex-wrap:wrap" },
      h("span.initial", m.username.slice(0, 1).toUpperCase()),
      h("div.grow", h("strong", m.username), h("div.muted.small", `Niv. ${m.level} · ${m.xp} XP · inscrit le ${fmt(m.joinedAt)}`)),
      m.banned ? h("span.chip.bad", "suspendu") : null,
      mg?.ids.has(m.userId) ? h("span.chip.amber", "responsable") : null,
      h("div.row.wrap",
        mg && m.role !== "ADMIN" && !m.revokedAt ? h("button.btn.small", { onclick: () => mg.toggle(m, rerender) }, mg.ids.has(m.userId) ? "Retirer responsable" : "Nommer responsable") : null,
        m.revokedAt ? h("button.btn.small", { onclick: () => run("restore", m) }, "Rétablir")
          : m.role === "ADMIN" ? h("span.chip", "admin") : h("button.btn.small.danger", { onclick: () => run("revoke", m) }, "Révoquer")))) : [h("p.muted", "Aucun membre.")]));
  }
  async function run(what, m) {
    if (what === "revoke" && !confirm(`Révoquer l'accès de ${m.username} à cette matière ? Son XP est conservé.`)) return;
    try { await post(`/api/subjects/${sub.id}/members/${m.userId}/${what}`, {}); load(); } catch (e) { fail(e); }
  }
  let t; q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(load, 250); });
  await load();
  return h("div.stack", mg ? h("p.muted.small", "Un responsable gère les questions, les chapitres, les réglages et les membres de cette matière.") : null, q, list);
}

// ───────── Réglages ─────────
const LABELS = {
  timePerQuestionSec: ["Solo et duel différé : temps par question (secondes, 0 = illimité)", "number"], soloQuestions: ["Questions par partie solo", "number"], soloGamesPerDay: ["Parties solo par jour (0 = illimité)", "number"],
  roundsPerDuel: ["Duel différé : manches", "number"], questionsPerRound: ["Duel différé : questions par manche", "number"],
  liveRoundsPerDuel: ["Duel en direct : manches", "number"], liveQuestionsPerRound: ["Duel en direct : questions par manche", "number"], liveTimePerQuestionSec: ["Duel en direct : temps par question (secondes, 0 = illimité)", "number"], duelDeadlineDays: ["Durée maximale d'un duel (jours)", "number"], maxActiveDuels: ["Duels simultanés par joueur (0 = illimité)", "number"],
  chapterPickSec: ["Temps pour choisir un chapitre (duel direct, secondes)", "number"], reconnectSec: ["Délai de reconnexion (duel direct, secondes)", "number"], shuffleChoices: ["Mélanger l'ordre des réponses", "bool"],
  xpPerCorrect: ["XP par bonne réponse", "number"], friendlyWinBonus: ["Bonus de victoire (XP)", "number"], friendlyDrawBonus: ["XP pour chaque joueur en cas d'égalité", "number"],
  levelBase: ["Courbe de niveaux : base", "number"], levelExponent: ["Courbe de niveaux : exposant", "number"],
};
async function reglages(sub) {
  const G = !sub;
  const r = G ? { ...(await get("/api/settings")), subject: {} } : await get(`/api/subjects/${sub.id}`);
  const inputs = {};
  const fields = Object.entries(LABELS).map(([k, [label, type]]) => {
    const el = type === "bool" ? h("input", { type: "checkbox", id: "s-" + k, checked: !!r.settings[k] }) : h("input.input", { id: "s-" + k, type: "number", step: k === "levelExponent" ? "0.1" : "1", value: r.settings[k] });
    inputs[k] = el;
    return h("div.field", type === "bool" ? h("label.row", el, " " + label) : [h("label", { for: "s-" + k }, label, r.overrides[k] !== undefined ? h("span.chip.amber", { style: "margin-left:8px" }, "personnalisé") : null), el]);
  });
  const read = () => Object.fromEntries(Object.entries(LABELS).map(([k, [, type]]) => [k, type === "bool" ? inputs[k].checked : Number(inputs[k].value)]));
  const an = h("input.input", { id: "acc-n", value: r.subject.accessName, autocapitalize: "none" });
  const ap = h("input.input", { id: "acc-p", type: "password", placeholder: "Laisser vide pour ne pas changer", autocomplete: "off" });
  return h("div.stack",
    h("form.card.stack", { onsubmit: async (e) => { e.preventDefault(); try { const now = read(); const changed = Object.fromEntries(Object.entries(now).filter(([k, v]) => v !== r.settings[k])); if (!Object.keys(changed).length) return toast("Aucun changement"); if (G) await put("/api/settings", changed); else await patch(`/api/subjects/${sub.id}`, { settings: changed }); toast("Réglages enregistrés", "good"); rerender(); } catch (ex) { fail(ex); } } },
      h("h2", G ? "Réglages globaux" : "Réglages de la matière"), G ? h("p.muted.small", "Valables pour toutes les matières, sauf celles qui ont leurs propres réglages.") : null, fields,
      h("div.row.wrap", h("button.btn.primary", { type: "submit" }, "Enregistrer"),
        h("button.btn.ghost", { type: "button", onclick: async () => { if (!confirm("Revenir aux réglages par défaut pour cette matière ?")) return;
          try { const nul = Object.fromEntries(Object.keys(LABELS).map((k) => [k, null])); if (G) await put("/api/settings", nul); else await patch(`/api/subjects/${sub.id}`, { settings: nul }); toast("Réglages par défaut rétablis", "good"); rerender(); } catch (ex) { fail(ex); } } }, "Valeurs par défaut"))),
    G ? null : h("form.card.stack", { onsubmit: async (e) => { e.preventDefault(); const b = { accessName: an.value.trim() }; if (ap.value) b.accessPassword = ap.value;
      try { await patch(`/api/subjects/${sub.id}`, b); toast("Accès mis à jour", "good"); ap.value = ""; } catch (ex) { fail(ex); } } },
      h("h2", "Accès des joueurs"), h("p.muted.small", "Les joueurs rejoignent la matière avec ce nom et ce mot de passe. Changer le mot de passe n'exclut personne déjà inscrit."),
      h("div.field", h("label", { for: "acc-n" }, "Nom d'accès"), an), h("div.field", h("label", { for: "acc-p" }, "Nouveau mot de passe d'accès"), ap),
      h("button.btn", { type: "submit" }, "Mettre à jour")));
}

// ───────── Journal ─────────
const ACTIONS = { CREATE_SUBJECT: "Matière créée", DELETE_SUBJECT: "Matière supprimée", IMPORT_QUESTIONS: "Import de questions", CREATE_CHAPTER: "Chapitre créé", LOCK_CHAPTER: "Chapitre bloqué", UNLOCK_CHAPTER: "Chapitre débloqué", CHAPTER_COLOR: "Couleur de chapitre", RENAME_CHAPTER: "Chapitre renommé", DELETE_CHAPTER: "Chapitre supprimé", DELETE_BATCH: "Import annulé", DELETE_BY_DATE: "Suppression par date", ASSIGN_MANAGER: "Responsable nommé", REMOVE_MANAGER: "Responsable retiré", EDIT_QUESTION: "Question modifiée", UPDATE_QUESTION: "Question modifiée", REVOKE_MEMBER: "Accès révoqué", RESTORE_MEMBER: "Accès rétabli", UPDATE_SUBJECT: "Matière modifiée", SET_TIERS: "Titres modifiés", RESET_TIERS: "Titres réinitialisés", UPDATE_GLOBAL_SETTINGS: "Réglages globaux modifiés", BAN_USER: "Compte suspendu", UNBAN_USER: "Compte rétabli", RESET_PASSWORD: "Mot de passe réinitialisé", SET_ROLE: "Rôle modifié", CREATE_BADGE: "Badge créé", UPDATE_BADGE: "Badge modifié", DELETE_BADGE: "Badge supprimé", CREATE_AVATAR_ITEM: "Objet d'avatar créé", UPDATE_AVATAR_ITEM: "Objet d'avatar modifié", DELETE_AVATAR_ITEM: "Objet d'avatar supprimé", EXPORT_BACKUP: "Sauvegarde téléchargée" };
async function journal(sub) {
  const filter = h("select.input", { "aria-label": "Type d'action" }, h("option", { value: "" }, "Toutes les actions"), Object.entries(ACTIONS).map(([k, l]) => h("option", { value: k }, l)));
  const list = h("div.list");
  const more = h("button.btn.ghost.block", { hidden: true }, "Afficher plus");
  let cursor = null;
  async function load(reset) {
    if (reset) { cursor = null; list.replaceChildren(); }
    const p = new URLSearchParams({ limit: "50" });
    if (sub) p.set("subjectId", sub.id);
    if (filter.value) p.set("action", filter.value);
    if (cursor) p.set("cursor", cursor);
    const r = await get(`/api/logs?${p}`);
    if (!r.logs.length && reset) list.append(h("div.empty", h("p", "Aucune action enregistrée.")));
    r.logs.forEach((l) => list.append(h("div.item", h("div.grow", h("strong", ACTIONS[l.action] ?? l.action.toLowerCase().replaceAll("_", " ")),
      h("div.muted.small", `${l.actor?.username ?? "?"} · ${fmt(l.createdAt)}${!sub && l.subjectName ? " · " + l.subjectName : ""}`),
      Object.keys(l.details ?? {}).length ? h("div.muted.small", Object.entries(l.details).filter(([k, v]) => typeof v !== "object" && !/Id$/.test(k)).map(([k, v]) => `${k}: ${v}`).join(" · ")) : null))));
    cursor = r.nextCursor; more.hidden = !cursor;
  }
  filter.onchange = () => load(true).catch(fail);
  more.onclick = () => load(false).catch(fail);
  await load(true);
  return h("div.stack", filter, list, more);
}

// ───────── Matières (administrateur) ─────────
async function matieres() {
  const r = await loadAdminSubjects(true).then((subjects) => ({ subjects }));
  const name = h("input.input", { id: "m-n", required: true, maxlength: 80 });
  const an = h("input.input", { id: "m-a", required: true, autocapitalize: "none" });
  const ap = h("input.input", { id: "m-p", type: "password", required: true, minlength: 8, autocomplete: "off" });
  return h("div.stack",
    r.subjects.length ? h("section.stack.tight", h("h2", "Toutes les matières"), h("div.list", r.subjects.map((s) => h("div.item",
      h("div.grow", h("strong", s.name), h("div.muted.small", `accès « ${s.accessName} » · ${s.memberCount} joueur${s.memberCount > 1 ? "s" : ""}`)),
      h("button.btn.small", { onclick: () => { chooseAdminSub(s.id); go("/admin/questions"); } }, "Gérer"),
      h("button.btn.small.danger", { onclick: async () => {
        const c = prompt(`Suppression DÉFINITIVE de « ${s.name} » avec ses questions, parties et statistiques.\nPour confirmer, tape exactement le nom de la matière :`);
        if (c == null) return;
        try { await del(`/api/subjects/${s.id}`, { confirmName: c }); toast("Matière supprimée", "good"); await loadAdminSubjects(true); rerender(); } catch (e) { fail(e); } } }, "Supprimer"))))) : h("p.muted", "Aucune matière : crée la première ci-dessous."),
    h("form.card.stack", { onsubmit: async (e) => { e.preventDefault();
      try { const x = await post("/api/subjects", { name: name.value.trim(), accessName: an.value.trim(), accessPassword: ap.value }); await loadAdminSubjects(true); chooseAdminSub(x.subject.id); toast("Matière créée", "good"); go("/admin/questions"); } catch (ex) { fail(ex); } } },
      h("h2", "Nouvelle matière"),
      h("div.field", h("label", { for: "m-n" }, "Nom"), name), h("div.field", h("label", { for: "m-a" }, "Nom d'accès (donné aux joueurs)"), an), h("div.field", h("label", { for: "m-p" }, "Mot de passe d'accès (8 caractères minimum)"), ap),
      h("button.btn.primary", { type: "submit" }, "Créer la matière")));
}
async function apparence() { return appearancePanel(); }
