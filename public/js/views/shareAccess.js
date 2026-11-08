import { h, post, fail, toast, sheet, errorMessage } from "../lib.js";

/** Lien d'inscription : #/join?n=<nom d'accès>&c=<mot de passe>. Le « # » garde les clés hors des journaux du serveur. */
export function joinLink(accessName, accessPassword) {
  const base = location.origin + location.pathname;
  return `${base}#/join?n=${encodeURIComponent(accessName)}&c=${encodeURIComponent(accessPassword)}`;
}

const noteKey = (id) => `qp.shareNote.${id}`;
const defaultNote = (name) => `Lien d'inscription à la matière « ${name} ».`;
const readNote = (id) => { try { return localStorage.getItem(noteKey(id)); } catch { return null; } };
const saveNote = (id, v) => { try { localStorage.setItem(noteKey(id), v); } catch { /* facultatif */ } };

/** Feuille « Partager l'accès » d'une matière : message personnalisable + lien, à copier ou à envoyer. */
export function shareAccessSheet(subject) {
  sheet(`Partager l'accès à « ${subject.name} »`, (close) => {
    const box = h("div.stack", h("p.muted", "Chargement…"));
    const show = (data) => {
      const link = joinLink(data.accessName, data.accessPassword);
      const note = h("textarea.input", { rows: 4, maxlength: 400, id: "sh-note", "aria-label": "Message" }, readNote(subject.id) ?? defaultNote(subject.name));
      const full = () => `${note.value.trim()}\n${link}`;
      const copy = async (text, ok) => { try { await navigator.clipboard.writeText(text); toast(ok, "good"); } catch { window.prompt("Copie ce texte :", text); } };
      box.replaceChildren(
        h("div.field", h("label", { for: "sh-note" }, "Message qui accompagne le lien"), note),
        h("div.field", h("label", { for: "sh-link" }, "Lien d'inscription"), h("input.input", { id: "sh-link", readonly: true, value: link, onfocus: (e) => e.target.select() })),
        h("div.row.wrap",
          h("button.btn.primary", { type: "button", onclick: () => { saveNote(subject.id, note.value); copy(full(), "Message copié"); } }, "Copier le message"),
          h("button.btn", { type: "button", onclick: () => copy(link, "Lien copié") }, "Copier le lien seul"),
          navigator.share ? h("button.btn", { type: "button", onclick: () => { saveNote(subject.id, note.value); navigator.share({ title: subject.name, text: note.value.trim(), url: link }).catch(() => {}); } }, "Partager…") : null));
    };
    const askPassword = (why) => {
      const pw = h("input.input", { id: "sh-pw", type: "password", autocomplete: "off", required: true });
      box.replaceChildren(h("form.stack", {
        onsubmit: async (e) => { e.preventDefault();
          try { show(await post(`/api/subjects/${subject.id}/share`, { accessPassword: pw.value })); } catch (ex) { fail(ex); } },
      }, h("p", why), h("div.field", h("label", { for: "sh-pw" }, "Mot de passe d'accès actuel de la matière"), pw),
        h("button.btn.primary", { type: "submit" }, "Créer le lien")));
    };
    post(`/api/subjects/${subject.id}/share`, {}).then(show).catch((ex) => {
      if (ex?.code === "share_unavailable" || ex?.status === 409) askPassword("Pour créer le lien, entre une fois le mot de passe d'accès de la matière. Il sera mémorisé (chiffré) : la prochaine fois, un clic suffira.");
      else box.replaceChildren(h("div.error-box", errorMessage(ex)));
    });
    return box;
  });
}
