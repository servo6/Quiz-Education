import { h, api, post, fail, toast, sheet, errorMessage, icon } from "../lib.js";
import { S, loadMe, rerender } from "../state.js";

const fmtDate = (iso) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" });
const isStaffRole = (r) => r === "ORG_ADMIN" || r === "SUBJECT_MANAGER";

/** Écran plein page pour les liens reçus par e-mail (#/reset/… et #/verify-email/…). */
function page(title, ...body) {
  return h("div.auth", h("div.auth-box",
    h("div.brand", h("div.brand-mark", icon("logo")), h("h1", "Quiz")),
    h("div.card.stack", h("h2", title), ...body)));
}
const backBtn = (label = "Continuer") => h("a.btn.primary.block", { href: "#/", onclick: () => { S.me = null; } }, label);

export function resetView(token) {
  const pw = h("input.input", { type: "password", id: "rp", required: true, minlength: 8, maxlength: 128, autocomplete: "new-password" });
  const err = h("div.error-box", { hidden: true, role: "alert" });
  const box = h("div.stack");
  box.append(h("form.stack", {
    onsubmit: async (e) => {
      e.preventDefault(); err.hidden = true;
      try {
        await post("/api/auth/reset", { token, newPassword: pw.value });
        box.replaceChildren(h("p", "Ton mot de passe a été modifié. Tu peux te connecter."), backBtn("Se connecter"));
      } catch (ex) { err.textContent = errorMessage(ex); err.hidden = false; }
    },
  }, h("div.field", h("label", { for: "rp" }, "Nouveau mot de passe"), pw), err,
    h("button.btn.primary.block", { type: "submit" }, "Changer le mot de passe")));
  return page("Nouveau mot de passe", box);
}

export function verifyView(token) {
  const box = h("div.center", h("div.spinner"));
  post("/api/auth/verify-email", { token }).then(
    () => box.replaceChildren(h("div.stack", h("p", "Ton adresse e-mail est vérifiée. Merci !"), backBtn())),
    (ex) => box.replaceChildren(h("div.stack", h("div.error-box", errorMessage(ex)), backBtn("Retour"))));
  return page("Vérification de l'adresse e-mail", box);
}

/** « Mot de passe oublié ? » depuis l'écran de connexion. */
export function forgotSheet(prefill = "") {
  sheet("Mot de passe oublié", (close) => {
    const id = h("input.input", { id: "fg", required: true, maxlength: 120, autocapitalize: "none", spellcheck: "false", value: prefill });
    return h("form.stack", {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await post("/api/auth/forgot", { identifier: id.value.trim() });
          toast("Si un e-mail est associé à ce compte, un lien de réinitialisation vient d'être envoyé (valable 1 heure).", "good", 7000);
          close();
        } catch (ex) { fail(ex); }
      },
    },
      h("div.field", h("label", { for: "fg" }, "Pseudo ou adresse e-mail"), id),
      h("button.btn.primary.block", { type: "submit" }, "Envoyer le lien"));
  });
}

/** Section « Adresse e-mail » du Profil : ajouter, changer, vérifier. */
export function emailSection() {
  const u = S.me.user;
  const staff = isStaffRole(u.role);
  const status = !u.email ? h("span.chip", "aucune adresse")
    : u.emailVerified ? h("span.chip.good", "vérifiée") : h("span.chip.amber", "non vérifiée");
  const overdue = staff && !u.emailVerified && u.verifyDeadline;
  const sendLink = async () => {
    try { await post("/api/me/email/send-verification"); toast("E-mail de vérification envoyé", "good"); } catch (ex) { fail(ex); }
  };
  const editSheet = () => sheet(u.email ? "Changer l'adresse e-mail" : "Ajouter une adresse e-mail", (close) => {
    const em = h("input.input", { id: "em", type: "email", required: true, maxlength: 120, autocomplete: "email", value: u.email ?? "" });
    const cp = h("input.input", { id: "emp", type: "password", required: true, autocomplete: "current-password" });
    return h("form.stack", {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await post("/api/me/email", { email: em.value.trim(), currentPassword: cp.value });
          toast("Un lien de vérification vient d'être envoyé à cette adresse", "good", 6000);
          close(); await loadMe(); rerender();
        } catch (ex) { fail(ex); }
      },
    }, h("div.field", h("label", { for: "em" }, "Adresse e-mail"), em),
      h("div.field", h("label", { for: "emp" }, "Mot de passe actuel"), cp),
      h("button.btn.primary.block", { type: "submit" }, "Enregistrer et envoyer le lien"));
  });
  return h("section.stack.tight", h("h2", "Adresse e-mail"),
    h("div.card.stack.tight",
      h("div.row.wrap", h("strong", u.email ?? "Aucune adresse enregistrée"), status),
      overdue ? h("span.chip.bad", `à vérifier avant le ${fmtDate(u.verifyDeadline)}`) : null,
      h("div.row.wrap",
        h("button.btn", { onclick: editSheet }, u.email ? "Changer l'adresse" : "Ajouter une adresse"),
        u.email && !u.emailVerified ? h("button.btn", { onclick: sendLink }, "Renvoyer le mail de vérification") : null,
        u.email && !staff ? h("button.btn.ghost", { onclick: async () => {
          if (!confirm("Retirer l'adresse e-mail de ce compte ? Tu ne pourras plus réinitialiser ton mot de passe par e-mail.")) return;
          try { await api("DELETE", "/api/me/email"); await loadMe(); rerender(); } catch (ex) { fail(ex); }
        } }, "Retirer l'adresse") : null)));
}

/** Bandeau affiché aux comptes de gestion tant que leur adresse n'est pas vérifiée. */
export function verifyBanner() {
  const u = S.me?.user;
  if (!u || !isStaffRole(u.role) || u.emailVerified) return null;
  const left = u.verifyDeadline ? new Date(u.verifyDeadline).getTime() - Date.now() : null;
  if (location.hash.startsWith("#/admin/profil")) return null; // le détail est déjà dans la page
  const hrs = left == null ? null : Math.max(0, Math.floor(left / 3_600_000));
  const rest = hrs == null ? "" : hrs >= 24 ? `${Math.floor(hrs / 24)} j ${hrs % 24} h` : `${hrs} h`;
  const txt = !u.email ? "Ajoute ton adresse e-mail dans Profil et vérifie-la"
    : "Vérifie ton adresse e-mail (lien envoyé par mail, voir Profil)";
  return h("div.error-box", { role: "status", style: "margin:8px 12px" },
    `${txt}${hrs == null ? "" : ` avant le ${fmtDate(u.verifyDeadline)} (reste ${rest})`} : sinon ton compte sera suspendu. `,
    h("a", { href: "#/admin/profil" }, "Ouvrir mon profil"));
}
