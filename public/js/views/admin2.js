import { h, mount, get, post, put, api, fail, toast, sheet, errorMessage } from "../lib.js";
import { S, loadMe, rerender } from "../state.js";

const patch = (u, b) => api("PATCH", u, b);
const del = (u, b) => api("DELETE", u, b);
const fmt = (iso) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

export function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = h("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const slug = (s) => s.normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "export";

// ───────── Modifier une question ─────────
export function editQuestion(q, chapters, chapterId, onSaved) {
  sheet("Modifier la question", (close) => {
    const text = h("textarea.input", { rows: 3, "aria-label": "Question" }, q.question);
    text.value = q.question;
    let answer = q.answer;
    const rows = h("div.stack.tight");
    let choices = [...q.choices];
    const paint = () => rows.replaceChildren(...choices.map((c, i) => {
      const inp = h("input.input", { value: c, "aria-label": `Choix ${i + 1}`, oninput: () => { choices[i] = inp.value; } });
      return h("div.row", h("input", { type: "radio", name: "ans", checked: answer === i, "aria-label": `Bonne réponse : choix ${i + 1}`, onchange: () => { answer = i; } }),
        h("div.grow", inp),
        choices.length > 2 ? h("button.btn.ghost.small", { type: "button", onclick: () => { choices.splice(i, 1); if (answer >= choices.length) answer = choices.length - 1; else if (answer > i) answer--; paint(); } }, "✕") : null);
    }));
    paint();
    const expl = h("textarea.input", { rows: 2, "aria-label": "Explication" }); expl.value = q.explanation ?? "";
    const chap = h("select.input", { "aria-label": "Chapitre" }, chapters.map((c) => h("option", { value: c.id }, c.name)));
    chap.value = chapterId;
    return h("form.stack", {
      onsubmit: async (e) => {
        e.preventDefault();
        const body = { question: text.value, choices, answer, explanation: expl.value.trim() ? expl.value : null };
        if (chap.value !== chapterId) body.chapterId = chap.value;
        try { await patch(`/api/questions/${q.id}`, body); toast("Question modifiée", "good"); close(); onSaved(); } catch (ex) { fail(ex); }
      },
    },
      h("div.field", h("label", "Question"), text),
      h("div.field", h("label", "Choix (coche la bonne réponse)"), rows,
        choices.length < 6 ? h("button.btn.small", { type: "button", onclick: () => { choices.push(""); paint(); } }, "Ajouter un choix") : null),
      h("div.field", h("label", "Explication (facultatif)"), expl),
      h("div.field", h("label", "Chapitre"), chap),
      h("button.btn.primary.block", { type: "submit" }, "Enregistrer"));
  });
}

// ───────── Comptes + vue d'ensemble + sauvegarde ─────────
export async function comptes() {
  const ov = await get("/api/admin/overview");
  const q = h("input.input", { type: "search", placeholder: "Chercher un compte", "aria-label": "Chercher un compte" });
  const filter = h("select.input", { "aria-label": "Filtre" }, [["", "Tous"], ["banned", "Suspendus"], ["ORG_ADMIN", "Administrateurs d'organisation"], ["SUBJECT_MANAGER", "Responsables"], ["USER", "Joueurs"]].map(([v, l]) => h("option", { value: v }, l)));
  const list = h("div.list");
  const more = h("button.btn.ghost.block", { hidden: true });
  let cursor = null;
  const stat = (label, v) => h("div.stat", h("b", String(v)), h("span.muted.small", label));

  async function load(reset = true) {
    if (reset) { cursor = null; list.replaceChildren(); }
    const p = new URLSearchParams({ q: q.value, limit: "20" });
    if (filter.value === "banned") p.set("banned", "true"); else if (filter.value) p.set("role", filter.value);
    if (cursor) p.set("cursor", cursor);
    const r = await get(`/api/users?${p}`);
    r.users.forEach((u) => list.append(row(u)));
    if (!r.users.length && reset) list.append(h("p.muted", "Aucun compte."));
    cursor = r.nextCursor; more.hidden = !cursor; more.textContent = "Afficher plus";
  }
  more.onclick = () => load(false).catch(fail);
  const act = (fn) => async () => { try { await fn(); load(); } catch (e) { fail(e); } };
  function row(u) {
    const me = u.id === S.me.user.id;
    return h("div.item", { style: "flex-wrap:wrap" },
      h("span.initial", u.username.slice(0, 1).toUpperCase()),
      h("div.grow", h("strong", u.username, me ? " (toi)" : ""), h("div.muted.small", `${u.email ? u.email + " · " : ""}${u.subjectCount} matière${u.subjectCount > 1 ? "s" : ""} · inscrit le ${fmt(u.createdAt)}`)),
      u.role !== "USER" ? h("span.chip.amber", u.role === "ADMIN" ? "super admin" : u.role === "ORG_ADMIN" ? "admin d'organisation" : "responsable") : null,
      u.banned ? h("span.chip.bad", "suspendu") : null,
      u.overdue ? h("span.chip.bad", "vérification dépassée") : null,
      u.role !== "USER" && u.role !== "ADMIN" ? (u.emailVerified ? h("span.chip.good", "e-mail vérifié") : !u.overdue ? h("span.chip.amber", u.verifyDeadline ? `à vérifier avant le ${fmt(u.verifyDeadline)}` : "e-mail non vérifié") : null) : null,
      !me && u.role !== "USER" && u.role !== "ADMIN" && !u.emailVerified && S.me.user.role === "ADMIN" ? h("button.btn.small", { onclick: act(async () => { const d = prompt(`Prolonger le délai de vérification de ${u.username} de combien de jours ? (1 à 90)`, "3"); if (!d) return; await post(`/api/users/${u.id}/extend-verification`, { days: Number(d) }); toast("Délai prolongé", "good"); }) }, "Prolonger") : null,
      me || u.role === "ADMIN" ? null : h("div.row.wrap",
        u.banned ? h("button.btn.small", { onclick: act(async () => { if (!confirm(`Rétablir le compte de ${u.username} ?`)) return; await post(`/api/users/${u.id}/unban`, {}); }) }, "Rétablir")
          : h("button.btn.small.danger", { onclick: act(async () => { const reason = prompt(`Suspendre ${u.username} ? Ses duels en cours seront perdus. Motif (facultatif) :`); if (reason === null) return; await post(`/api/users/${u.id}/ban`, reason ? { reason } : {}); toast("Compte suspendu", "good"); }) }, "Suspendre"),
        h("button.btn.small", { onclick: act(async () => { const pw = prompt(`Nouveau mot de passe pour ${u.username} (8 caractères minimum) :`); if (!pw) return; await post(`/api/users/${u.id}/reset-password`, { newPassword: pw }); toast("Mot de passe réinitialisé", "good"); }) }, "Mot de passe")));
  }
  let t; q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => load().catch(fail), 250); });
  filter.onchange = () => load().catch(fail);
  await load();
  return h("div.stack",
    h("section.stack.tight", h("h2", "Vue d'ensemble"),
      h("div.stats", stat("Comptes", ov.users.total), stat("Actifs sur 7 jours", ov.users.activeLast7Days), stat("Suspendus", ov.users.banned), stat("Matières", ov.subjects),
        stat("Chapitres", ov.chapters), stat("Questions", ov.questions), stat("Réponses données", ov.answers), stat("Parties aujourd'hui", ov.gamesToday))),
    h("section.card.stack", h("h2", "Sauvegarde"),
      h("p.muted.small", "Télécharge toutes les données (comptes sans mots de passe, matières, questions, XP, badges…) dans un fichier JSON. Garde-le en lieu sûr."),
      h("button.btn", { onclick: async () => { try { const d = await get("/api/admin/export"); download(`sauvegarde-${new Date().toISOString().slice(0, 10)}.json`, d); toast("Sauvegarde téléchargée", "good"); } catch (e) { fail(e); } } }, "Télécharger la sauvegarde")),
    h("section.stack.tight", h("h2", "Comptes"), q, filter, list, more));
}

// ───────── Titres ─────────
export async function titres(sub) {
  let scope = "global";
  const box = h("div.stack");
  const scopeSel = h("select.input", { "aria-label": "Portée" }, h("option", { value: "global" }, "Toutes les matières (par défaut)"), h("option", { value: "subject" }, `Seulement « ${sub.name} »`));
  scopeSel.onchange = () => { scope = scopeSel.value; load(); };
  async function load() {
    const r = await get(scope === "global" ? "/api/tiers" : `/api/subjects/${sub.id}/tiers`);
    let tiers = r.tiers.map((t) => ({ ...t }));
    const rows = h("div.stack.tight");
    const paint = () => rows.replaceChildren(...tiers.map((t, i) => h("div.row",
      h("div.grow", h("input.input", { value: t.name, "aria-label": "Nom du titre", maxlength: 40, oninput: (e) => { t.name = e.target.value; } })),
      h("input.input", { type: "number", min: 1, value: t.minLevel, style: "width:84px", "aria-label": "Niveau minimum", oninput: (e) => { t.minLevel = Number(e.target.value); } }),
      h("input", { type: "color", value: t.color ?? "#9ca3af", "aria-label": "Couleur", oninput: (e) => { t.color = e.target.value; } }),
      tiers.length > 1 ? h("button.btn.ghost.small", { onclick: () => { tiers.splice(i, 1); paint(); } }, "✕") : null)));
    paint();
    const note = scope === "subject" ? (r.source === "subject" ? "Cette matière a ses propres titres." : "Cette matière utilise les titres par défaut. Enregistrer crée ses titres à elle.") : (r.source === "default" ? "Titres d'origine, jamais modifiés." : "Titres personnalisés.");
    box.replaceChildren(h("p.muted.small", note), h("div.row.small.muted", h("span.grow", "Titre"), h("span", { style: "width:84px" }, "Niveau min."), h("span", { style: "width:44px" }, "Couleur"), h("span", { style: "width:36px" })), rows,
      h("div.row.wrap", h("button.btn", { onclick: () => { tiers.push({ name: "Nouveau titre", minLevel: Math.max(1, ...tiers.map((t) => t.minLevel)) + 5, color: "#9ca3af" }); paint(); } }, "Ajouter un titre"),
        h("button.btn.primary", { onclick: async () => { try { await put(scope === "global" ? "/api/tiers" : `/api/subjects/${sub.id}/tiers`, { tiers: tiers.map((t) => ({ name: t.name.trim(), minLevel: t.minLevel, color: t.color })) }); toast("Titres enregistrés", "good"); load(); } catch (e) { fail(e); } } }, "Enregistrer"),
        scope === "subject" && r.source === "subject" ? h("button.btn.ghost", { onclick: async () => { try { await del(`/api/subjects/${sub.id}/tiers`); toast("Titres par défaut rétablis", "good"); load(); } catch (e) { fail(e); } } }, "Revenir aux titres par défaut") : null));
  }
  await load();
  return h("section.card.stack", h("h2", "Titres selon le niveau"), h("p.muted.small", "Le titre d'un joueur est celui du plus haut niveau minimum qu'il a atteint. Il faut un titre au niveau 1."), scopeSel, box);
}

// ───────── Badges ─────────
const BADGE_TYPES = { CORRECT_TOTAL: "Bonnes réponses au total", PERFECT_SOLO: "Parties solo sans faute", FRIENDLY_WINS: "Victoires en duel", PERFECT_DUEL: "Duels parfaits", STREAK_DAYS: "Jours consécutifs de jeu", SUBJECTS_PLAYED: "Matières jouées", FAST_STREAK: "Série de réponses rapides" };
export async function badges() {
  const r = await get("/api/badges");
  const edit = (b) => sheet(b ? "Modifier le badge" : "Nouveau badge", (close) => {
    const f = { code: h("input.input", { value: b?.code ?? "", disabled: !!b, placeholder: "ex. correct_500" }), name: h("input.input", { value: b?.name ?? "", maxlength: 60 }),
      description: h("input.input", { value: b?.description ?? "", maxlength: 200 }), icon: h("input.input", { value: b?.icon ?? "🏅", maxlength: 8 }),
      type: h("select.input", Object.entries(BADGE_TYPES).map(([k, l]) => h("option", { value: k }, l))), threshold: h("input.input", { type: "number", min: 1, value: b?.threshold ?? 10 }) };
    if (b) f.type.value = b.conditionType;
    return h("form.stack", { onsubmit: async (e) => { e.preventDefault();
      const body = { name: f.name.value.trim(), description: f.description.value.trim(), icon: f.icon.value.trim(), conditionType: f.type.value, threshold: Number(f.threshold.value) };
      try { if (b) await patch(`/api/badges/${b.id}`, body); else await post("/api/badges", { ...body, code: f.code.value.trim() }); toast("Badge enregistré", "good"); close(); rerender(); } catch (ex) { fail(ex); } } },
      !b ? h("div.field", h("label", "Code (lettres minuscules, chiffres, _)"), f.code) : null,
      h("div.field", h("label", "Nom"), f.name), h("div.field", h("label", "Description"), f.description), h("div.field", h("label", "Icône (un emoji)"), f.icon),
      h("div.field", h("label", "Condition"), f.type), h("div.field", h("label", "Seuil à atteindre"), f.threshold),
      h("button.btn.primary.block", { type: "submit" }, "Enregistrer"));
  });
  return h("div.stack",
    h("div.row.between", h("h2", `Badges (${r.badges.length})`), h("button.btn.primary", { onclick: () => edit(null) }, "Nouveau badge")),
    h("div.list", r.badges.map((b) => h("div.item", h("span", { style: "font-size:1.6rem" }, b.icon || "🏅"),
      h("div.grow", h("strong", b.name), h("div.muted.small", `${b.description} · ${BADGE_TYPES[b.conditionType] ?? b.conditionType} ≥ ${b.threshold}`)),
      h("button.btn.small", { onclick: () => edit(b) }, "Modifier"),
      h("button.btn.small.danger", { onclick: async () => { if (!confirm(`Supprimer le badge « ${b.name} » ? Les joueurs qui l'avaient le perdent.`)) return; try { await del(`/api/badges/${b.id}`); toast("Badge supprimé", "good"); rerender(); } catch (e) { fail(e); } } }, "Supprimer")))));
}

// ───────── Objets d'avatar ─────────
const CATS = { hair: "Cheveux", face: "Visage", outfit: "Tenue", glasses: "Lunettes", hat: "Chapeau", background: "Fond", frame: "Cadre" };
const UNLOCKS = { FREE: "Libre", LEVEL: "Niveau minimum", BADGE: "Badge obtenu", TIER: "Titre atteint" };
export async function avatars() {
  const r = await get("/api/avatar/items");
  const edit = (it) => sheet(it ? "Modifier l'objet" : "Nouvel objet", (close) => {
    const cat = h("select.input", Object.entries(CATS).map(([k, l]) => h("option", { value: k }, l))); if (it) cat.value = it.category;
    const name = h("input.input", { value: it?.name ?? "", maxlength: 60 });
    const asset = h("input.input", { value: it?.assetPath ?? "", placeholder: "ex. avatars/hat-wizard.svg" });
    const ut = h("select.input", Object.entries(UNLOCKS).map(([k, l]) => h("option", { value: k }, l))); ut.value = it?.unlockType ?? "FREE";
    const uv = h("input.input", { value: it?.unlockValue ?? "", placeholder: "niveau, code du badge ou nom du titre" });
    const hint = h("p.muted.small");
    const upd = () => { uv.hidden = ut.value === "FREE"; hint.textContent = { FREE: "", LEVEL: "Valeur : le niveau minimum (ex. 10).", BADGE: "Valeur : le code du badge (ex. wins_1).", TIER: "Valeur : le nom exact du titre (ex. Expert)." }[ut.value]; };
    ut.onchange = upd; upd();
    return h("form.stack", { onsubmit: async (e) => { e.preventDefault();
      const body = { category: cat.value, name: name.value.trim(), assetPath: asset.value.trim() || name.value.trim(), unlockType: ut.value, unlockValue: ut.value === "FREE" ? null : uv.value.trim() };
      try { if (it) await patch(`/api/avatar/items/${it.id}`, body); else await post("/api/avatar/items", body); toast("Objet enregistré", "good"); close(); rerender(); } catch (ex) { fail(ex); } } },
      h("div.field", h("label", "Catégorie"), cat), h("div.field", h("label", "Nom"), name), h("div.field", h("label", "Fichier image"), asset),
      h("div.field", h("label", "Déblocage"), ut, uv, hint), h("button.btn.primary.block", { type: "submit" }, "Enregistrer"));
  });
  return h("div.stack",
    h("div.row.between", h("h2", `Objets d'avatar (${r.items.length})`), h("button.btn.primary", { onclick: () => edit(null) }, "Nouvel objet")),
    h("p.muted.small", "Pour un nouvel objet, mets son image (SVG ou PNG carré, de préférence transparent) dans le dossier public/avatars de ton projet, puis indique « avatars/nom-du-fichier.svg » dans « Fichier image ». L'image est affichée par-dessus l'avatar."),
    Object.entries(CATS).map(([k, label]) => { const list = r.items.filter((i) => i.category === k); return list.length ? h("section.stack.tight", h("h3", label),
      h("div.list", list.map((i) => h("div.item", h("div.grow", h("strong", i.name), h("div.muted.small", i.unlockType === "FREE" ? "Libre" : `${UNLOCKS[i.unlockType]} : ${i.unlockValue}`)),
        h("button.btn.small", { onclick: () => edit(i) }, "Modifier"),
        h("button.btn.small.danger", { onclick: async () => { if (!confirm(`Supprimer « ${i.name} » ?`)) return; try { await del(`/api/avatar/items/${i.id}`); toast("Objet supprimé", "good"); rerender(); } catch (e) { fail(e); } } }, "Supprimer"))))) : null; }));
}
