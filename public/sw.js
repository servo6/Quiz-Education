/* Service worker du site Quiz.
   - Jamais de cache pour l'API ni pour le temps réel (/api, /socket.io) : les réponses sont toujours fraîches.
   - Pages et fichiers de l'interface : réseau d'abord (toujours à jour après un déploiement), cache en secours.
   - Hors connexion : une page d'information simple à la place de l'erreur du navigateur. */
const VERSION = "qp-v6";
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const PRECACHE = ["/offline.html", "/icons/icon-192.png", "/icons/icon-512.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isStatic = (p) => /^\/(css|js|icons|vendor)\//.test(p) || p === "/manifest.webmanifest";

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/") || url.pathname === "/sw.js") return;

  // Navigation : réseau, sinon page « hors connexion ».
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
    return;
  }

  if (!isStatic(url.pathname)) return;

  // Icônes : cache d'abord. CSS/JS : réseau d'abord, cache si hors connexion.
  if (url.pathname.startsWith("/icons/")) {
    event.respondWith(caches.match(req).then((hit) => hit || fetchAndStore(req)));
    return;
  }
  event.respondWith(fetchAndStore(req).catch(() => caches.match(req)));
});

async function fetchAndStore(req) {
  const res = await fetch(req);
  if (res.ok) {
    const copy = res.clone();
    caches.open(RUNTIME).then((c) => c.put(req, copy)).catch(() => {});
  }
  return res;
}

// ── Notifications push : affichées seulement si l'appli n'est pas déjà à l'écran (elle a ses propres alertes).
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: "Quiz", body: event.data ? event.data.text() : "" }; }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.some((w) => w.visibilityState === "visible" && w.focused)) return;
    await self.registration.showNotification(d.title || "Quiz", {
      body: d.body || "", tag: d.tag, renotify: !!d.tag, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: d.url || "/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if ("focus" in w) { await w.focus(); if ("navigate" in w) { try { await w.navigate(url); } catch { /* autre origine */ } } return; }
    }
    await self.clients.openWindow(url);
  })());
});
