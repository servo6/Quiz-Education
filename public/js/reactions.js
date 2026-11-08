// Réactions rapides du duel en direct : une barre d'émojis, et l'émoji de l'adversaire qui flotte à l'écran.
import { h } from "./lib.js";

const EMOJIS = ["👍", "😂", "😮", "😅", "🔥", "👏", "😭", "🤝"];
let sock = null, bar = null, active = false, cooldown = false;

export function initReactions(socket) {
  sock = socket;
  bar = h("div.react-bar", { hidden: true, role: "group", "aria-label": "Réactions" },
    EMOJIS.map((e) => h("button", { type: "button", "aria-label": `Envoyer ${e}`, onclick: () => send(e) }, e)));
  document.body.append(bar);
  socket.on("duel:reaction", (p) => { if (active && EMOJIS.includes(p?.emoji)) showReaction(p.emoji, "them"); });
}

function send(emoji) {
  if (cooldown || !active) return;
  cooldown = true; setTimeout(() => { cooldown = false; }, 800);
  sock.emit("duel:react", { emoji }, () => {});
  showReaction(emoji, "me");
}

/** Affiche un émoji qui monte et s'efface : en haut à droite pour l'adversaire, en bas à gauche pour toi. */
export function showReaction(emoji, who) {
  const el = h("div.react-float", { class: who, "aria-hidden": "true" }, emoji);
  el.style.setProperty("--dx", `${Math.round((Math.random() - 0.5) * 60)}px`);
  document.body.append(el);
  setTimeout(() => el.remove(), 2200);
}

export function reactionsSync(game) {
  active = !!game && game.phase !== "DONE";
  if (bar) bar.hidden = !active;
}
