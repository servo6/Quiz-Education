import { h, get, post, put, api, fail, toast, sheet } from "../lib.js";
import { S, go, rerender } from "../state.js";

const patch = (u, b) => api("PATCH", u, b);
const del = (u, b) => api("DELETE", u, b);
const fmt = (iso) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
const isRoot = () => S.me.user.role === "ADMIN";

/** Alerte de confirmation pour une action sensible. */
export const sure = (message) => confirm(message);
/** Suppression définitive : il faut retaper le nom exact. Renvoie le texte saisi ou null. */
const typeName = (what, name) => prompt(`Suppression DÉFINITIVE de ${what} « ${name} ».\nPour confirmer, tape exactement son nom :`);

function accountForm(submitLabel, onSubmit) {
  const u = h("input.input", { required: true, minlength: 3, maxlength: 32, autocapitalize: "none", spellcheck: "false", "aria-label": "Pseudo" });
  const p = h("input.input", { type: "password", required: true, minlength: 8, autocomplete: "new-password", "aria-label": "Mot de passe" });
  const em = h("input.input", { type: "email", required: true, maxlength: 120, autocapitalize: "none", "aria-label": "Adresse e-mail" });
  return h("form.stack.tight", { onsubmit: async (e) => { e.preventDefault(); try { await onSubmit(u.value.trim(), p.value, em.value.trim()); u.value = ""; p.value = ""; em.value = ""; } catch (ex) { fail(ex); } } },
    h("div.field", h("label", "Pseudo"), u), h("div.field", h("label", "Adresse e-mail (un lien de vérification lui est envoyé ; 3 jours pour la vérifier)"), em), h("div.field", h("label", "Mot de passe (8 caractères minimum)"), p),
    h("button.btn.primary", { type: "submit" }, submitLabel));
}

// ───────── Organisations ─────────
export async function organisations() {
  const { organizations } = await get("/api/organizations");
  const name = h("input.input", { id: "o-n", required: true, maxlength: 80 });

  const renameSheet = (o) => sheet(`Renommer « ${o.name} »`, (close) => {
    const n = h("input.input", { value: o.name, maxlength: 80 });
    return h("form.stack", { onsubmit: async (e) => { e.preventDefault();
      try { await patch(`/api/organizations/${o.id}`, { name: n.value.trim() }); toast("Organisation renommée", "good"); close(); rerender(); } catch (ex) { fail(ex); } } },
      h("div.field", h("label", "Nom de l'organisation"), n),
      h("button.btn.primary.block", { type: "submit" }, "Enregistrer"));
  });

  const adminsSheet = (o) => sheet(`Administrateurs de « ${o.name} »`, (close) => {
    const list = h("div.list");
    const load = async () => {
      const r = await get(`/api/organizations/${o.id}`);
      list.replaceChildren(...(r.admins.length ? r.admins.map((a) => h("div.item",
        h("span.initial", a.username.slice(0, 1).toUpperCase()), h("div.grow", h("strong", a.username)),
        h("button.btn.small.danger", { onclick: async () => { if (!sure(`Retirer ${a.username} de l'administration de « ${o.name} » ?`)) return;
          try { await del(`/api/organizations/${o.id}/admins/${a.id}`); toast("Administrateur retiré", "good"); load(); } catch (e) { fail(e); } } }, "Retirer"))) : [h("p.muted", "Aucun administrateur.")]));
    };
    load();
    return h("div.stack", list, h("h3", "Créer un administrateur d'organisation"),
      h("p.muted.small", "Un nouveau compte est créé : un joueur existant ne peut pas être promu."),
      accountForm("Créer le compte", async (username, password, email) => {
        await post(`/api/organizations/${o.id}/admins`, { username, email, password }); toast("Administrateur créé", "good"); load(); }));
  });

  const card = (o) => h("div.item", { style: "flex-wrap:wrap" },
    h("div.grow", h("strong", o.name), h("div.muted.small", `${o.subjectCount} matière${o.subjectCount > 1 ? "s" : ""} · ${o.memberCount} joueur${o.memberCount > 1 ? "s" : ""}${isRoot() ? ` · ${o.adminCount} admin${o.adminCount > 1 ? "s" : ""}` : ""}`)),
    h("div.row.wrap",
      h("button.btn.small", { onclick: () => renameSheet(o) }, "Renommer"),
      isRoot() ? h("button.btn.small", { onclick: () => adminsSheet(o) }, "Administrateurs") : null,
      isRoot() ? h("button.btn.small.danger", { onclick: async () => {
        const c = typeName("l'organisation", o.name); if (c == null) return;
        try { await del(`/api/organizations/${o.id}`, { confirmName: c }); toast("Organisation supprimée", "good"); rerender(); } catch (e) { fail(e); } } }, "Supprimer") : null));

  return h("div.stack",
    organizations.length ? h("div.list", organizations.map(card)) : h("p.muted", "Aucune organisation : crée la première ci-dessous."),
    isRoot() ? h("form.card.stack", { onsubmit: async (e) => { e.preventDefault();
      try { await post("/api/organizations", { name: name.value.trim() }); toast("Organisation créée", "good"); rerender(); } catch (ex) { fail(ex); } } },
      h("h2", "Nouvelle organisation"),
      h("div.field", h("label", { for: "o-n" }, "Nom (ex. UTBM)"), name),
      h("button.btn.primary", { type: "submit" }, "Créer l'organisation")) : null);
}

// ───────── Matières et responsables ─────────
export async function matieres(loadAdminSubjects, chooseAdminSub) {
  const [subjects, { organizations }] = await Promise.all([loadAdminSubjects(true), get("/api/organizations")]);
  const name = h("input.input", { id: "m-n", required: true, maxlength: 60 });
  const an = h("input.input", { id: "m-a", required: true, minlength: 3, autocapitalize: "none", spellcheck: "false" });
  const ap = h("input.input", { id: "m-p", type: "password", required: true, minlength: 8, autocomplete: "off" });
  const org = h("select.input", { id: "m-o", "aria-label": "Organisation" }, organizations.map((o) => h("option", { value: o.id }, o.name)));

  const managersSheet = (s) => sheet(`Responsables de « ${s.name} »`, (close) => {
    const list = h("div.list");
    const others = h("div.stack.tight");
    const load = async () => {
      const [r, all] = await Promise.all([get(`/api/subjects/${s.id}`), loadAdminSubjects(true)]);
      const here = new Set(r.managers.map((m) => m.id));
      list.replaceChildren(...(r.managers.length ? r.managers.map((m) => h("div.item",
        h("span.initial", m.username.slice(0, 1).toUpperCase()), h("div.grow", h("strong", m.username)),
        h("button.btn.small.danger", { onclick: async () => { if (!sure(`Retirer ${m.username} de la matière « ${s.name} » ?`)) return;
          try { await del(`/api/subjects/${s.id}/managers/${m.id}`); toast("Responsable retiré", "good"); load(); } catch (e) { fail(e); } } }, "Retirer"))) : [h("p.muted", "Aucun responsable.")]));
      const pool = new Map();
      all.filter((x) => x.organizationId === s.organizationId && x.id !== s.id).forEach((x) => x.managers.forEach((m) => { if (!here.has(m.id)) pool.set(m.id, m); }));
      const pick = h("select.input", { "aria-label": "Responsable existant" }, [...pool.values()].map((m) => h("option", { value: m.id }, m.username)));
      others.replaceChildren(...(pool.size ? [h("h3", "Confier la matière à un responsable existant"),
        h("div.row", h("div.grow", pick), h("button.btn", { onclick: async () => { try { await put(`/api/subjects/${s.id}/managers/${pick.value}`, {}); toast("Responsable ajouté", "good"); load(); } catch (e) { fail(e); } } }, "Ajouter"))] : []));
    };
    load();
    return h("div.stack", list, others, h("h3", "Créer un responsable"),
      h("p.muted.small", "Un nouveau compte est créé : un joueur ne peut pas être promu responsable."),
      accountForm("Créer le compte", async (username, password, email) => { await post(`/api/subjects/${s.id}/managers`, { username, email, password }); toast("Responsable créé", "good"); load(); }));
  });

  const row = (s) => h("div.item", { style: "flex-wrap:wrap" },
    h("div.grow", h("strong", s.name), h("div.muted.small", `${s.memberCount} joueur${s.memberCount > 1 ? "s" : ""} · ${s.managers.length ? "responsable : " + s.managers.map((m) => m.username).join(", ") : "aucun responsable"}`)),
    h("div.row.wrap",
      h("button.btn.small", { onclick: () => { chooseAdminSub(s.id); go("/admin/questions"); } }, "Gérer"),
      h("button.btn.small", { onclick: () => managersSheet(s) }, "Responsables"),
      h("button.btn.small", { onclick: async () => { const n = prompt("Nouveau nom de la matière", s.name); if (!n?.trim() || n.trim() === s.name) return;
        try { await patch(`/api/subjects/${s.id}`, { name: n.trim() }); toast("Matière renommée", "good"); await loadAdminSubjects(true); rerender(); } catch (e) { fail(e); } } }, "Renommer"),
      h("button.btn.small.danger", { onclick: async () => {
        const c = typeName("la matière", s.name) ; if (c == null) return;
        try { await del(`/api/subjects/${s.id}`, { confirmName: c }); toast("Matière supprimée", "good"); await loadAdminSubjects(true); rerender(); } catch (e) { fail(e); } } }, "Supprimer")));

  const byOrg = new Map();
  subjects.forEach((s) => { if (!byOrg.has(s.organizationName)) byOrg.set(s.organizationName, []); byOrg.get(s.organizationName).push(s); });
  return h("div.stack",
    subjects.length ? [...byOrg].map(([orgName, list]) => h("section.stack.tight", organizations.length > 1 || isRoot() ? h("h2", orgName) : null, h("div.list", list.map(row)))) : h("p.muted", "Aucune matière : crée la première ci-dessous."),
    organizations.length ? h("form.card.stack", { onsubmit: async (e) => { e.preventDefault();
      try { const x = await post("/api/subjects", { name: name.value.trim(), organizationId: org.value, accessName: an.value.trim(), accessPassword: ap.value }); await loadAdminSubjects(true); chooseAdminSub(x.subject.id); toast("Matière créée", "good"); rerender(); } catch (ex) { fail(ex); } } },
      h("h2", "Nouvelle matière"),
      organizations.length > 1 ? h("div.field", h("label", { for: "m-o" }, "Organisation"), org) : null,
      h("div.field", h("label", { for: "m-n" }, "Nom"), name),
      h("div.field", h("label", { for: "m-a" }, "Nom d'accès (donné aux joueurs)"), an),
      h("div.field", h("label", { for: "m-p" }, "Mot de passe d'accès (8 caractères minimum)"), ap),
      h("button.btn.primary", { type: "submit" }, "Créer la matière")) : h("p.muted", "Crée d'abord une organisation."));
}

// ───────── Joueurs d'une organisation ─────────
export async function joueurs() {
  const { organizations } = await get("/api/organizations");
  if (!organizations.length) return h("p.muted", "Aucune organisation.");
  const sel = h("select.input", { "aria-label": "Organisation" }, organizations.map((o) => h("option", { value: o.id }, o.name)));
  const q = h("input.input", { type: "search", placeholder: "Chercher un joueur", "aria-label": "Chercher un joueur" });
  const list = h("div.list");
  async function load() {
    const { members } = await get(`/api/organizations/${sel.value}/members`);
    const term = q.value.trim().toLowerCase();
    const shown = members.filter((m) => !term || m.username.toLowerCase().includes(term));
    const act = (fn) => async () => { try { await fn(); load(); } catch (e) { fail(e); } };
    list.replaceChildren(...(shown.length ? shown.map((m) => h("div.item", { style: "flex-wrap:wrap" },
      h("span.initial", m.username.slice(0, 1).toUpperCase()),
      h("div.grow", h("strong", m.username), h("div.muted.small", `inscrit le ${fmt(m.joinedAt)}`)),
      m.banned ? h("span.chip.bad", "suspendu") : null,
      h("div.row.wrap",
        m.banned ? h("button.btn.small", { onclick: act(async () => { if (!sure(`Rétablir le compte de ${m.username} ?`)) return; await post(`/api/users/${m.userId}/unban`, {}); toast("Compte rétabli", "good"); }) }, "Rétablir")
          : h("button.btn.small.danger", { onclick: act(async () => { if (!sure(`Suspendre ${m.username} ? Ses duels en cours seront perdus.`)) return; await post(`/api/users/${m.userId}/ban`, {}); toast("Compte suspendu", "good"); }) }, "Suspendre"),
        h("button.btn.small", { onclick: act(async () => { const pw = prompt(`Nouveau mot de passe pour ${m.username} (8 caractères minimum) :`); if (!pw) return; await post(`/api/users/${m.userId}/reset-password`, { newPassword: pw }); toast("Mot de passe réinitialisé", "good"); }) }, "Mot de passe")))) : [h("p.muted", "Aucun joueur.")]));
  }
  sel.onchange = () => load().catch(fail);
  let t; q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => load().catch(fail), 200); });
  await load();
  return h("div.stack", organizations.length > 1 ? sel : null, q, list);
}
