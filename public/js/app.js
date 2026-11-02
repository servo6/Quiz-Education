import { h, mount, clear, get, post, icon, svg, sheet, toast, fail } from "./lib.js";
import { S, loadMe, activeSubject, refreshSummary, loadCatalog, go, rerender } from "./state.js";
import { authView, joinForm } from "./views/auth.js";
import { resetView, verifyView, verifyBanner } from "./views/email.js";
import { homeView } from "./views/home.js";
import { soloPickView, soloPlayView, soloResultView } from "./views/solo.js";
import { duelsView, duelNewView, duelDetailView, duelPlayView, duelResultView } from "./views/duels.js";
import { rankingView } from "./views/ranking.js";
import { profileView, staffProfileView } from "./views/profile.js";
import { statsView } from "./views/stats.js";
import { friendsView, chatView } from "./views/friends.js";
import { adminView, setStaffProfile, canOpenAdmin, visibleGroups, adminSub, adminSubjects, chooseAdminSub, loadAdminSubjects } from "./views/admin.js";
import { applyTheme, loadThemeConfig, themeConfig } from "./theme.js";
import { initLive } from "./live.js";

const appEl = document.getElementById("app");
setStaffProfile(() => staffProfileView(logout));

// ───────── Routeur ─────────
const routes = [];
function route(pattern, view, opts = {}) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:([a-z]+)/gi, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ re, keys, view, ...opts });
}

route("/", homeView, { tab: "/" });
route("/solo", soloPickView, { tab: "/solo" });
route("/solo/play/:id", soloPlayView, { full: true });
route("/solo/result/:id", soloResultView, { tab: "/solo" });
route("/duels", duelsView, { tab: "/duels" });
route("/duels/new", duelNewView, { tab: "/duels" });
route("/duels/:id", duelDetailView, { tab: "/duels" });
route("/duels/:id/play", duelPlayView, { full: true });
route("/duels/:id/result", duelResultView, { tab: "/duels" });
route("/ranking", rankingView, { tab: "/ranking" });
route("/stats", statsView, { tab: "/stats" });
route("/friends", friendsView, { tab: "/friends" });
route("/friends/:id", chatView, { tab: "/friends" });
route("/profile", profileView, { tab: "/profile" });
route("/admin", adminView, { admin: true });
route("/admin/:tab", adminView, { admin: true });

let cleanup = null;
let token = 0;
let shell = null;

async function render() {
  const my = ++token;
  cleanup?.(); cleanup = null;
  document.querySelectorAll(".sheet-back").forEach((e) => e.remove()); // une feuille ouverte ne survit pas à un changement de page
  // Liens reçus par e-mail : accessibles connecté ou non
  const link = /^#\/(reset|verify-email)\/([\w-]+)$/.exec(location.hash);
  if (link) { shell = null; mount(appEl, link[1] === "reset" ? resetView(link[2]) : verifyView(link[2])); return; }
  if (!S.me) await loadMe();
  if (my !== token) return;
  if (!S.me) { shell = null; socket?.disconnect(); socket = null; mount(appEl, authView(boot)); return; }
  const admin = S.me.user.role !== "USER"; // comptes de gestion : jamais des joueurs
  themeConfig.ignorePersonal = admin; themeConfig.scopeTheme = S.me.themeDefault ?? null; applyTheme();
  if (!admin && !S.me.subjects.length) { shell = null; mount(appEl, joinScreen()); return; }
  if (!admin && !activeSubject()) {
    await post("/api/me/active-subject", { subjectId: S.me.subjects[0].id }).catch(() => {});
    await loadMe();
  }
  const path = location.hash.replace(/^#/, "") || "/";
  const found = routes.map((r) => ({ r, m: r.re.exec(path) })).find((x) => x.m);
  if (!found) { go(admin ? "/admin" : "/"); return; }
  // L'administrateur n'est pas un joueur : il n'a accès qu'à son interface de gestion.
  if (admin && !found.r.admin) { go("/admin"); return; }
  const params = Object.fromEntries(found.r.keys.map((k, i) => [k, decodeURIComponent(found.m[i + 1])]));
  const ctx = { setCleanup: (fn) => { cleanup = fn; }, go };

  let host;
  if (found.r.full) { shell = null; host = appEl; clear(appEl); }
  else { host = found.r.admin ? ensureAdminShell(found.m[1] ? decodeURIComponent(found.m[1]) : "") : ensureShell(found.r.tab); }
  try {
    host.replaceChildren(h("div.center", { style: "padding:48px" }, h("div.spinner")));
    const node = await found.r.view(params, ctx);
    if (my !== token) return;
    mount(host, node);
    if (admin) { const b = verifyBanner(); if (b) host.prepend(b); }
    window.scrollTo(0, 0);
  } catch (e) {
    if (my !== token) return;
    if (e.status === 401) { S.me = null; render(); return; }
    mount(host, h("div.empty", { style: "padding:48px 16px" }, icon("help"), h("p", e.message ?? "Erreur"),
      h("button.btn", { onclick: () => render() }, "Réessayer")));
  }
}

// ───────── Coque (barre du haut + onglets) ─────────
const home = () => svg('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11 12 3l9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9Z"/></svg>');
const tabs = [["/", "Accueil", home], ["/solo", "Solo", () => icon("play")], ["/duels", "Duels", () => icon("duel")], ["/ranking", "Classement", () => icon("rank")], ["/stats", "Stats", () => icon("chart")], ["/friends", "Amis", () => icon("chat")]];

function ensureShell(tab) {
  if (shell && shell.kind !== "player") shell = null;
  if (!shell) {
    const page = h("main.page", { id: "main" });
    const top = h("header.topbar");
    const bar = h("nav.tabbar", { "aria-label": "Navigation" });
    shell = { kind: "player", page, top, bar };
    mount(appEl, h("div.shell", top, page, bar));
    shell.pip = null;
  }
  paintTop();
  mount(shell.bar, tabs.map(([path, label, ic]) => {
    const a = h("a", { href: "#" + path, "aria-current": path === tab ? "page" : false }, ic(), h("span", label));
    if (path === "/duels") a.append(h("span.pip", { id: "duel-pip", hidden: !(S.summary?.yourTurnCount > 0) }, String(S.summary?.yourTurnCount ?? "")));
    if (path === "/friends") a.append(h("span.pip.social", { id: "social-pip", hidden: socialCount() === 0 }, String(socialCount())));
    return a;
  }));
  return shell.page;
}
function paintTop() {
  if (!shell) return;
  if (shell.kind === "admin") return paintAdminTop();
  const sub = activeSubject();
  mount(shell.top,
    h("button.subject-btn", { onclick: openSubjects, "aria-label": "Changer de matière" },
      h("span.name", sub?.name ?? "Matière"), icon("chevron")),
    sub ? h("span.lvl-badge", `Niv. ${sub.level}`) : null,
    h("span.spacer"),
    canOpenAdmin() ? h("a.btn.small", { href: "#/admin", class: "admin-btn", "aria-label": "Administration" }, icon("gear"), "Administration") : null,
    h("a.btn.small", { href: "#/profile", "aria-label": "Mon profil", "aria-current": location.hash.startsWith("#/profile") ? "page" : false }, icon("user"), h("span.btn-label", "Profil")));
}

// ───────── Coque de l'administration : menu des panneaux, aucune navigation de joueur ─────────
async function logout() { if (!confirm("Te déconnecter ?")) return; await post("/api/auth/logout").catch(() => {}); S.me = null; S.summary = null; socket?.disconnect(); socket = null; render(); }

function ensureAdminShell(tab) {
  if (shell && shell.kind !== "admin") shell = null;
  if (!shell) {
    const page = h("main.page", { id: "main" });
    const top = h("header.topbar");
    const nav = h("nav.sidenav", { "aria-label": "Panneaux d'administration" });
    shell = { kind: "admin", page, top, bar: nav };
    mount(appEl, h("div.shell.admin", top, nav, page));
  }
  shell.tab = tab;
  paintAdminTop();
  const groups = visibleGroups();
  mount(shell.bar, groups.map((g, i) => [
    groups.length > 1 ? h("div.group", g.name) : null,
    ...g.items.map(([key, label, ic]) => h("a", { href: `#/admin/${key}`, "aria-current": key === tab ? "page" : false }, icon(ic), h("span", label))),
  ]));
  shell.bar.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "center" });
  return shell.page;
}
function paintAdminTop() {
  if (!shell || shell.kind !== "admin") return;
  const sub = adminSub();
  const role = S.me.user.role;
  mount(shell.top,
    h("div.wordmark", icon("logo"), h("span.wm-text", role === "ADMIN" ? "Quiz · Administration" : role === "ORG_ADMIN" ? "Quiz · Organisation" : "Quiz · Gestion")),
    h("span.spacer"),
    adminSubjects().length > 0 ? h("button.subject-btn", { onclick: openAdminSubjects, "aria-label": "Changer de matière gérée" },
      h("span.name", sub?.name ?? "Matière"), icon("chevron")) : null,
    h("a.btn.small", { href: "#/admin/profil", "aria-label": "Mon profil", "aria-current": location.hash.startsWith("#/admin/profil") ? "page" : false }, icon("user"), h("span.btn-label", "Profil")),
    h("button.btn.small", { onclick: logout, "aria-label": "Déconnexion" }, icon("logout"), h("span.btn-label", "Déconnexion")));
}
document.addEventListener("admin-subjects", () => paintAdminTop());
function openAdminSubjects() {
  const current = adminSub();
  sheet("Matière gérée", (close) => h("div.list", adminSubjects().map((s) =>
    h("button.item", { "aria-current": s.id === current?.id ? "true" : false, onclick: () => { chooseAdminSub(s.id); close(); rerender(); } },
      h("div.grow", h("strong", s.name), h("div.muted.small", `${s.memberCount} joueur${s.memberCount > 1 ? "s" : ""}`)),
      s.id === current?.id ? h("span.chip.good", "Active") : null))));
}
document.addEventListener("me", () => paintTop());
// Pastille « Amis » : messages non lus + invitations reçues.
const socialCount = () => (S.social?.unread ?? 0) + (S.social?.invitations ?? 0);
async function refreshSocial() {
  try { S.social = await get("/api/me/social-summary"); } catch { S.social = null; }
  const pip = document.getElementById("social-pip");
  if (pip) { pip.hidden = socialCount() === 0; pip.textContent = String(socialCount()); }
}
document.addEventListener("social-changed", refreshSocial);
document.addEventListener("summary", () => {
  const pip = document.getElementById("duel-pip");
  const n = S.summary?.yourTurnCount ?? 0;
  if (pip) { pip.hidden = n === 0; pip.textContent = String(n); }
});

function openSubjects() {
  sheet("Mes matières", (close) => h("div.stack",
    h("div.list", S.me.subjects.map((s) =>
      h("button.item", {
        "aria-current": s.id === S.me.user.activeSubjectId ? "true" : false,
        onclick: async () => {
          try { await post("/api/me/active-subject", { subjectId: s.id }); await loadMe(); close(); await refreshSummary(); go("/"); render(); }
          catch (e) { fail(e); }
        },
      }, h("div.grow", h("strong", s.name), h("div.muted.small", `Niveau ${s.level} · ${s.title?.name ?? ""}`)),
        s.id === S.me.user.activeSubjectId ? h("span.chip.good", "Active") : null))),
    h("h3", "Rejoindre une autre matière"),
    h("p.muted.small", "Chaque matière a son propre nom d'accès et son mot de passe. Tu ne peux rejoindre que des matières de ton organisation."),
    joinForm(async () => { close(); await loadMe(); render(); })));
}

function joinScreen() {
  const out = h("button.btn.ghost.block", { onclick: logout }, "Se déconnecter");
  return h("div.auth", h("div.auth-box",
    h("div.brand", h("div.brand-mark", icon("logo")), h("h1", "Rejoindre une matière"),
      h("p", "Demande à ton responsable le nom d'accès et le mot de passe de la matière.")),
    h("div.card", h("div.stack", joinForm(async () => { await loadMe(); render(); }))), out));
}

// ───────── Temps réel (notifications) ─────────
let socket = null;
function connectSocket(enabled = true) {
  if (!enabled || socket || !window.io) return;
  socket = window.io({ withCredentials: true });
  const refresh = () => refreshSummary();
  socket.on("chat:message", (p) => { document.dispatchEvent(new CustomEvent("chat:message", { detail: p })); if (!location.hash.startsWith("#/friends/" + p.friendshipId)) toast(`${p.from} : ${p.preview}`, "good"); refreshSocial(); });
  socket.on("friend:request", (p) => { toast(`${p.from} t'invite à devenir ami`, "good"); refreshSocial(); if (location.hash === "#/friends") rerender(); });
  socket.on("friend:accepted", (p) => { toast(`${p.by} a accepté ton invitation`, "good"); refreshSocial(); if (location.hash === "#/friends") rerender(); });
  socket.on("duel:turn", () => { toast("C'est à toi de jouer dans un duel !", "good"); refresh(); });
  socket.on("duel:challenged", () => { toast("Tu as reçu un défi !", "good"); refresh(); });
  initLive(socket);
  socket.on("duel:ended", () => { toast("Un duel vient de se terminer", ""); refresh(); });
}

async function boot() {
  await Promise.all([loadMe(), loadThemeConfig()]);
  if (S.me && S.me.user.role === "USER") { connectSocket(); refreshSummary(); refreshSocial(); loadCatalog().catch(() => {}); }
  render();
}
window.addEventListener("hashchange", render);
boot();
