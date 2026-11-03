/* Installation de l'application (PWA) : service worker + invitation à l'installer.
   Android / Samsung Internet / Chrome : bouton « Installer ». iPhone / iPad : explication du menu Partager. */
(function () {
  "use strict";

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function () { /* sans service worker, le site reste utilisable */ });
    });
  }

  var KEY = "qp-install-dismissed";
  var DAYS = 14;
  var store = {
    get: function () { try { return localStorage.getItem(KEY); } catch (e) { return null; } },
    set: function (v) { try { localStorage.setItem(KEY, v); } catch (e) { /* ignoré */ } }
  };

  var standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  if (standalone) return;

  var last = Number(store.get());
  if (last && Date.now() - last < DAYS * 86400000) return;

  var ua = navigator.userAgent || "";
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var deferred = null;
  var banner = null;

  function hide(remember) {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
    if (remember) store.set(String(Date.now()));
  }

  function show(text, actionLabel, onAction) {
    if (banner) return;
    banner = document.createElement("div");
    banner.setAttribute("role", "region");
    banner.setAttribute("aria-label", "Installer l'application");
    banner.style.cssText = "position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9999;" +
      "max-width:460px;margin:0 auto;display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:14px;" +
      "background:var(--surface,#16171a);color:var(--text,#e9eaed);border:1px solid var(--line,#26282d);" +
      "box-shadow:0 10px 30px rgba(0,0,0,.35);font:14px/1.4 var(--font-body,system-ui,sans-serif)";

    var img = document.createElement("img");
    img.src = "/icons/icon-192.png"; img.alt = ""; img.width = 40; img.height = 40;
    img.style.cssText = "border-radius:10px;flex:none";

    var msg = document.createElement("div");
    msg.style.cssText = "flex:1;min-width:0";
    msg.textContent = text;

    banner.appendChild(img);
    banner.appendChild(msg);

    if (actionLabel) {
      var go = document.createElement("button");
      go.type = "button"; go.textContent = actionLabel;
      go.style.cssText = "flex:none;font:inherit;font-weight:600;border:0;border-radius:10px;padding:9px 14px;cursor:pointer;" +
        "background:var(--accent,#6670e0);color:var(--on-accent,#fff)";
      go.addEventListener("click", onAction);
      banner.appendChild(go);
    }

    var close = document.createElement("button");
    close.type = "button"; close.textContent = "Plus tard";
    close.style.cssText = "flex:none;font:inherit;border:0;background:transparent;color:var(--muted,#8b8f99);padding:9px 6px;cursor:pointer";
    close.addEventListener("click", function () { hide(true); });
    banner.appendChild(close);

    document.body.appendChild(banner);
  }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    setTimeout(function () {
      if (!deferred) return;
      show("Installe Quiz sur ton écran d'accueil pour l'ouvrir comme une application.", "Installer", function () {
        var p = deferred; deferred = null; hide(false);
        p.prompt();
        if (p.userChoice) p.userChoice.then(function (r) { if (r && r.outcome === "dismissed") store.set(String(Date.now())); });
      });
    }, 4000);
  });

  window.addEventListener("appinstalled", function () { deferred = null; hide(false); });

  if (isIOS) {
    setTimeout(function () {
      show("Pour installer Quiz : touche Partager, puis « Sur l'écran d'accueil ».", null, null);
    }, 5000);
  }
})();
