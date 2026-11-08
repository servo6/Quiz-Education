import { h, get, sheet, rich } from "./lib.js";

/** Texte du cours : paragraphes séparés par une ligne vide, formules $…$ acceptées. */
export function lessonBody(text) {
  return h("div.stack.tight", text.split(/\n{2,}/).map((p) => h("p", { style: "white-space:pre-line;margin:0" }, rich(p.trim()))));
}

/** Bouton « Revoir le cours » : n'apparaît que si le chapitre de la question a un rappel de cours. */
export function lessonButton(questionId) {
  const slot = h("span");
  get(`/api/questions/${questionId}/lesson`).then((r) => {
    if (!r.lesson) return;
    slot.replaceChildren(h("button.btn.ghost.small", { type: "button", onclick: () => sheet(`Cours : ${r.chapter.name}`, () => lessonBody(r.lesson)) }, "📖 Revoir le cours"));
  }).catch(() => {});
  return slot;
}
