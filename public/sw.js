/* Service worker du site Quiz.
   - Jamais de cache pour l'API ni pour le temps réel (/api, /socket.io) : les réponses sont toujours fraîches.
   - Pages et fichiers de l'interface : réseau d'abord (toujours à jour après un déploiement), cache en secours.
   - Hors connexion : une page d'information simple à la place de l'erreur du navigateur. */
const VERSION = "qp-v1";
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

const isStatic = (p) => /^\/(css|js|icons)\//.test(p) || p === "/manifest.webmanifest";

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
