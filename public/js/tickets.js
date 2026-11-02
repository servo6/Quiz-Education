// Tickets : le nombre de parties restantes se lit d'un coup d'œil, sans phrase.
// Un type de partie = une forme et une couleur (solo ▶, duel ✕, direct ⚡). Un ticket plein est disponible, un ticket vide est utilisé.
import { h, svg, get } from "./lib.js";

const GLYPH = {
  solo: '<path d="M10 7.5v9l7.5-4.5z" fill="currentColor"/>',
  duel: '<path d="M8 8l8 8M16 8l-8 8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/>',
  live: '<path d="M13 5L8 13h3.5L10.5 19 16 11h-3.5z" fill="currentColor"/>',
};
export const TICKET_LABEL = { solo: "Solo", duel: "Duel", live: "Direct" };
const MAX_ICONS = 8;

function ticketSvg(kind) {
  return svg(`<svg viewBox="0 0 24 24" aria-hidden="true"><path class="body" d="M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5V9a2.5 2.5 0 0 0 0 5v3.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5V14a2.5 2.5 0 0 0 0-5Z"/>${GLYPH[kind]}</svg>`);
}

/** Rangée de tickets. `left`/`total` = null → illimité (un ticket marqué ∞). Au-delà de 8 : un ticket et un nombre. */
export function ticketRow(kind, left, total, { big = false } = {}) {
  const unlimited = total == null || left == null;
  const label = unlimited ? `Tickets ${TICKET_LABEL[kind]} : illimités` : `Tickets ${TICKET_LABEL[kind]} : ${left} sur ${total}`;
  const row = h("div.tickets", { class: `${kind}${big ? " big" : ""}${!unlimited && left <= 0 ? " empty" : ""}`, role: "img", "aria-label": label });
  row.dataset.mode = unlimited ? "inf" : total > MAX_ICONS ? "count" : "icons";
  if (unlimited) {
    row.append(h("span.tk.on", ticketSvg(kind)), h("b.tk-n", "∞"));
  } else if (total > MAX_ICONS) {
    row.append(h("span.tk.on", ticketSvg(kind)), h("b.tk-n", String(left)), h("span.tk-of", `/${total}`));
  } else {
    for (let i = 0; i < total; i++) row.append(h("span.tk", { class: i < left ? "on" : "used" }, ticketSvg(kind)));
  }
  return row;
}

/** Un ticket est consommé : il se déchire, un « −1 » s'envole. Résout quand l'animation est finie. */
export function spendTicket(row) {
  return new Promise((resolve) => {
    if (!row) return resolve();
    const on = [...row.querySelectorAll(".tk.on")];
    const target = row.dataset.mode === "icons" ? on[on.length - 1] : on[0];
    if (target && row.dataset.mode === "icons") target.classList.add("burn");
    else if (target) target.classList.add("pulse");
    if (row.dataset.mode === "count") {
      const n = row.querySelector(".tk-n");
      if (n) n.textContent = String(Math.max(0, Number(n.textContent) - 1));
    }
    const pop = h("span.tk-minus", "−1");
    row.append(pop);
    setTimeout(() => { pop.remove(); resolve(); }, 760);
  });
}

export const loadTickets = (subjectId) => get(`/api/subjects/${subjectId}/tickets`).catch(() => null);
