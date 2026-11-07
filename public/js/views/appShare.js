import { h, toast, sheet } from "../lib.js";

/** État de l'installation, fourni par /js/pwa.js (valeurs sûres si le script n'est pas chargé). */
const pwa = () => window.qpPwa ?? { standalone: false, isIOS: false, canPrompt: () => false, prompt: async () => "unavailable" };

/** Adresse envoyée aux autres : toujours la page d'installation du site (jamais l'adresse interne de l'application ouverte). */
export const shareUrl = () => `${location.origin}/installer.html`;
const SHARE_TEXT = "Rejoins-moi sur Quiz : des quiz pour réviser et des duels en direct. Installe l'application ici :";

async function copyLink() {
  const url = shareUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast("Lien copié", "good");
  } catch {
    const ta = h("textarea", { style: "position:fixed;opacity:0" }, url);
    document.body.append(ta); ta.select();
    try { document.execCommand("copy"); toast("Lien copié", "good"); } catch { toast(url, "", 8000); }
    ta.remove();
  }
}

/** Fenêtre de secours quand le partage du téléphone n'existe pas (ordinateur) : WhatsApp, Telegram, e-mail, SMS, copie. */
function shareSheet() {
  const url = shareUrl();
  const msg = `${SHARE_TEXT} ${url}`;
  const link = (label, href) => h("a.btn.block", { href, target: "_blank", rel: "noopener noreferrer" }, label);
  sheet("Partager l'application", () => h("div.stack",
    h("p.muted.small", "Envoie ce lien : la personne y trouve le bouton pour installer l'application."),
    h("input.input", { readonly: true, value: url, "aria-label": "Lien de l'application", onfocus: (e) => e.target.select() }),
    link("WhatsApp", `https://wa.me/?text=${encodeURIComponent(msg)}`),
    link("Telegram", `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(SHARE_TEXT)}`),
    link("E-mail", `mailto:?subject=${encodeURIComponent("Quiz : l'application")}&body=${encodeURIComponent(msg)}`),
    link("SMS", `sms:?&body=${encodeURIComponent(msg)}`),
    h("button.btn.primary.block", { type: "button", onclick: copyLink }, "Copier le lien")));
}

/** Partage via le menu natif du téléphone (WhatsApp, Telegram, Messages, etc.), sinon via la fenêtre de secours. */
export async function shareApp() {
  if (navigator.share) {
    try {
      await navigator.share({ title: "Quiz", text: SHARE_TEXT, url: shareUrl() });
      return;
    } catch (e) {
      if (e?.name === "AbortError") return; // la personne a fermé le menu
    }
  }
  shareSheet();
}

function iosHelp() {
  sheet("Installer sur iPhone / iPad", () => h("ol.stack.tight",
    h("li", "Ouvre ce site dans Safari (pas dans une autre application)."),
    h("li", "Touche le bouton Partager (le carré avec une flèche)."),
    h("li", "Choisis « Sur l'écran d'accueil », puis « Ajouter ».")));
}
function manualHelp() {
  sheet("Installer l'application", () => h("div.stack.tight",
    h("p", "Dans le menu de ton navigateur (les trois points), choisis « Installer l'application » ou « Ajouter à l'écran d'accueil »."),
    h("p.muted.small", "Si l'option n'apparaît pas, ouvre le site dans Chrome (Android) ou dans Safari (iPhone).")));
}

async function install() {
  const p = pwa();
  if (p.canPrompt()) { await p.prompt(); return; }
  if (p.isIOS) iosHelp(); else manualHelp();
}

/** Section « Application » du Profil.
 *  Dans le navigateur : Installer + Partager. Dans l'application déjà installée : Partager seulement. */
export function appSection() {
  const box = h("section.stack.tight", { id: "app-section" });
  const paint = () => {
    const p = pwa();
    box.replaceChildren(
      h("h2", "Application"),
      h("div.card.stack.tight",
        h("div.muted.small", p.standalone
          ? "Tu utilises l'application. Fais-la découvrir à tes amis."
          : "Installe Quiz sur ton téléphone pour l'ouvrir comme une application, ou envoie-la à tes amis."),
        h("div.row.wrap",
          p.standalone ? null : h("button.btn.primary", { type: "button", onclick: install }, "Télécharger l'application"),
          h("button.btn", { type: "button", onclick: shareApp }, "Partager l'application"))));
  };
  paint();
  // L'invitation d'installation du navigateur peut arriver après l'affichage de la page.
  const on = () => { if (box.isConnected) paint(); else window.removeEventListener("qp:pwa", on); };
  window.addEventListener("qp:pwa", on);
  return box;
}
