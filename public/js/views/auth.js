import { h, post, fail, errorMessage, icon } from "../lib.js";
import { loadMe } from "../state.js";
import { forgotSheet } from "./email.js";

export function authView(onLogged, opts = {}) {
  let mode = "login";
  const box = h("div.card");
  const err = h("div.error-box", { hidden: true, role: "alert" });
  const user = h("input.input", { id: "u", autocomplete: "username", required: true, minlength: 3, maxlength: 120, autocapitalize: "none", spellcheck: "false" });
  const email = h("input.input", { id: "em", type: "email", autocomplete: "email", maxlength: 120, autocapitalize: "none" });
  const userLabel = h("label", { for: "u" }, "Pseudo");
  const emailField = h("div.field", h("label", { for: "em" }, "Adresse e-mail"), email);
  const forgot = h("button.btn.ghost.small", { type: "button", onclick: () => forgotSheet(user.value.trim()) }, "Mot de passe oublié ?");
  const pass = h("input.input", { id: "p", type: "password", required: true, minlength: 8 });
  const submit = h("button.btn.primary.block", { type: "submit" }, "Se connecter");

  const tabLogin = h("button", { type: "button", role: "tab", onclick: () => set("login") }, "Connexion");
  const tabReg = h("button", { type: "button", role: "tab", onclick: () => set("register") }, "Inscription");
  function set(m) {
    mode = m;
    tabLogin.setAttribute("aria-selected", m === "login");
    tabReg.setAttribute("aria-selected", m === "register");
    submit.textContent = m === "login" ? "Se connecter" : "Créer mon compte";
    pass.autocomplete = m === "login" ? "current-password" : "new-password";
    userLabel.textContent = m === "login" ? "Pseudo ou adresse e-mail" : "Pseudo";
    user.maxLength = m === "login" ? 120 : 30;
    emailField.hidden = m !== "register";
    forgot.hidden = m !== "login";
    err.hidden = true;
  }
  const form = h("form.stack", {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true; err.hidden = true;
      try {
        await post(`/api/auth/${mode}`, mode === "register" ? { username: user.value.trim(), email: email.value.trim() || undefined, password: pass.value } : { username: user.value.trim(), password: pass.value });
        await loadMe();
        await onLogged();
      } catch (ex) {
        err.textContent = errorMessage(ex); err.hidden = false;
      } finally { submit.disabled = false; }
    },
  },
    h("div.field", userLabel, user),
    emailField,
    h("div.field", h("label", { for: "p" }, "Mot de passe"), pass),
    err, submit, forgot);
  box.append(h("div.tabs", { role: "tablist" }, tabLogin, tabReg), form);
  set(opts.invite ? "register" : "login");

  return h("div.auth", h("div.auth-box",
    h("div.brand",
      h("div.brand-mark", icon("logo")),
      h("h1", "Quiz"),
      h("p", "Révise, défie tes camarades et monte de niveau.")),
    box));
}

/** Rejoindre une matière avec son nom d'accès et son mot de passe (l'organisation en découle). */
export function joinForm(onJoined, prefill = {}) {
  const name = h("input.input", { id: "an", required: true, autocapitalize: "none", spellcheck: "false", value: prefill.name ?? "" });
  const pw = h("input.input", { id: "ap", type: "password", required: true, autocomplete: "off", value: prefill.password ?? "" });
  const btn = h("button.btn.primary.block", { type: "submit" }, "Rejoindre");
  return h("form.stack", {
    onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true;
      try {
        const r = await post("/api/subjects/join", { accessName: name.value.trim(), accessPassword: pw.value });
        await post("/api/me/active-subject", { subjectId: r.subject.id });
        await onJoined(r);
      } catch (ex) { fail(ex); } finally { btn.disabled = false; }
    },
  },
    h("div.field", h("label", { for: "an" }, "Nom d'accès de la matière"), name),
    h("div.field", h("label", { for: "ap" }, "Mot de passe de la matière"), pw),
    btn);
}
