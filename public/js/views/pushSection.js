import { h, get, post, toast, fail } from "../lib.js";

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const b64ToBytes = (b64) => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

async function currentSub() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Bloc « Notifications » du profil : active ou coupe les alertes (tour de jeu, défis, messages) sur cet appareil. */
export function pushSection() {
  const box = h("section.card.stack", h("h2", "Notifications"));
  const status = h("p.muted.small");
  const btn = h("button.btn.primary.block", { type: "button", hidden: true });
  const test = h("button.btn.ghost.block", { type: "button", hidden: true }, "Envoyer une notification de test");
  box.append(status, btn, test);

  (async () => {
    if (!supported()) {
      status.textContent = isIOS() && !window.qpPwa?.standalone
        ? "Sur iPhone, installe d'abord l'application sur l'écran d'accueil (Partager → Sur l'écran d'accueil), puis reviens ici pour activer les notifications."
        : "Ce navigateur ne gère pas les notifications.";
      return;
    }
    let cfg;
    try { cfg = await get("/api/push/config"); } catch { status.textContent = "Notifications indisponibles pour le moment."; return; }
    if (!cfg.enabled) { status.textContent = "Les notifications ne sont pas encore activées sur le serveur."; return; }

    async function paint() {
      const sub = await currentSub().catch(() => null);
      const denied = Notification.permission === "denied";
      status.textContent = denied
        ? "Les notifications sont bloquées pour ce site. Autorise-les dans les réglages du navigateur, puis reviens ici."
        : sub ? "Activées sur cet appareil : tu es prévenu quand c'est ton tour, qu'on te défie ou qu'on t'écrit."
              : "Reçois une alerte quand c'est ton tour, qu'on te défie ou qu'on t'écrit, même appli fermée.";
      btn.hidden = denied;
      btn.textContent = sub ? "Désactiver les notifications" : "Activer les notifications";
      btn.classList.toggle("ghost", !!sub); btn.classList.toggle("primary", !sub);
      test.hidden = !sub;
    }
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const sub = await currentSub();
        if (sub) {
          await post("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
          await sub.unsubscribe();
          toast("Notifications désactivées");
        } else {
          const perm = await Notification.requestPermission();
          if (perm !== "granted") { toast("Autorisation refusée", "bad"); return; }
          const reg = await navigator.serviceWorker.ready;
          const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.publicKey) });
          await post("/api/push/subscribe", s.toJSON());
          toast("Notifications activées", "good");
        }
      } catch (e) { fail(e); } finally { btn.disabled = false; paint(); }
    };
    test.onclick = () => post("/api/push/test").then(() => toast("Notification envoyée", "good")).catch(fail);
    await paint();
    btn.hidden = Notification.permission === "denied";
  })();
  return box;
}
