import { h, get, post, put, fail, toast, sheet, avatarEl, pct } from "../lib.js";
import { S, activeSubject, loadCatalog, loadMe, rerender } from "../state.js";
import { personalThemeSection } from "./appearance.js";
import { emailSection } from "./email.js";
import { appSection } from "./appShare.js";

const CATS = { hair: "Cheveux", face: "Visage", outfit: "Tenue", glasses: "Lunettes", hat: "Chapeau", background: "Fond", frame: "Cadre" };
const SKINS = ["#f8d9bd", "#f2c9a0", "#d9a273", "#b07a4f", "#8a5a38", "#5e3b24"];

export async function profileView() {
  const sub = activeSubject();
  const [st, bd, cat] = await Promise.all([
    get(`/api/subjects/${sub.id}/stats`),
    get("/api/me/badges"),
    loadCatalog().catch(() => []),
  ]);
  const a = st.answers, d = st.duels;
  const avatarSlot = h("div", avatarEl(S.me.user.avatar, cat, 96));
  const stat = (label, value) => h("div.stat", h("b", String(value)), h("span.muted.small", label));

  return h("div.stack",
    h("section.card.row", { style: "gap:16px" },
      avatarSlot,
      h("div.grow",
        h("h1", S.me.user.username),
        h("div", { style: sub.title?.color ? `color:${sub.title.color};font-weight:700` : "font-weight:700" }, sub.title?.name ?? ""),
        h("div.muted.small", `${sub.name} · niveau ${sub.level} · ${sub.xp} XP${st.rank ? ` · ${st.rank}e` : ""}`)),
      h("button.btn.small", { onclick: () => editAvatar(cat, () => rerender()) }, "Mon avatar")),
    h("section.stack.tight", h("h2", "Statistiques"),
      h("div.stats",
        stat("Réponses", a.total), stat("Réussite", pct(a.accuracy)),
        stat("Duels gagnés", d.wins), stat("Duels joués", d.played),
        stat("Égalités", d.draws), stat("Parties solo", st.solo?.played ?? st.solo?.games ?? 0))),
    st.chapters?.length ? h("section.stack.tight", h("h2", "Par chapitre"),
      h("div.list", st.chapters.map((c) => h("div.item",
        h("div.grow", h("strong", c.name), h("div.mini-bar", h("i", { style: `width:${c.accuracy ?? 0}%` }))),
        h("span.muted", `${pct(c.accuracy)}`))))) : null,
    h("section.stack.tight", h("h2", `Badges (${bd.earnedCount}/${bd.badges.length})`),
      h("div.badges", bd.badges.map((b) => h("div.badge", { class: b.earned ? "" : "locked", title: b.description },
        h("span.ico", b.icon || "🏅"), h("strong", b.name),
        h("span.muted.small", b.earned ? b.description : `${Math.min(b.current ?? 0, b.threshold ?? 0)} / ${b.threshold ?? "?"}`))))),
    personalThemeSection(),
    appSection(),
    emailSection(),
    h("section.stack.tight", h("h2", "Compte"),
      h("div.row.wrap",
        h("button.btn", { onclick: passwordSheet }, "Changer le mot de passe"),
        h("button.btn.ghost", { onclick: async () => { if (!confirm("Te déconnecter ?")) return; await post("/api/auth/logout").catch(() => {}); S.me = null; S.summary = null; rerender(); } }, "Se déconnecter"))));
}

export function passwordSheet() {
  const cur = h("input.input", { type: "password", autocomplete: "current-password", required: true, id: "cp" });
  const nw = h("input.input", { type: "password", autocomplete: "new-password", required: true, minlength: 8, id: "np" });
  sheet("Changer le mot de passe", (close) => h("form.stack", {
    onsubmit: async (e) => {
      e.preventDefault();
      try { await post("/api/me/password", { currentPassword: cur.value, newPassword: nw.value }); toast("Mot de passe modifié", "good"); close(); }
      catch (ex) { fail(ex); }
    },
  }, h("div.field", h("label", { for: "cp" }, "Mot de passe actuel"), cur),
    h("div.field", h("label", { for: "np" }, "Nouveau mot de passe"), nw),
    h("button.btn.primary.block", { type: "submit" }, "Enregistrer")));
}

async function editAvatar(_cat, done) {
  const r = await get("/api/avatar/items").catch((e) => { fail(e); return null; });
  if (!r) return;
  const items = r.items;
  const draft = { items: { ...(r.avatar?.items ?? {}) }, colors: { ...(r.avatar?.colors ?? {}) } };
  sheet("Mon avatar", (close) => {
    const preview = h("div.center");
    const body = h("div.catalog");
    const paint = () => {
      preview.replaceChildren(avatarEl(draft, items, 120));
      body.replaceChildren(
        h("div.stack.tight", h("strong", "Teint"), h("div.row.wrap", SKINS.map((c) =>
          h("button.swatch", { style: `background:${c}`, "aria-label": `Teint ${c}`, "aria-pressed": String(draft.colors.skin === c),
            onclick: () => { draft.colors.skin = c; paint(); } })))),
        ...Object.entries(CATS).map(([key, label]) => {
          const list = items.filter((i) => i.category === key);
          if (!list.length) return null;
          return h("div.stack.tight", h("strong", label), h("div.opts", list.map((it) =>
            h("button.opt", {
              "aria-pressed": String(draft.items[key] === it.id), disabled: !it.unlocked,
              title: it.unlocked ? it.name : it.lockReason,
              onclick: () => { draft.items[key] = it.id; paint(); },
            }, it.name, !it.unlocked ? h("span.small.muted", it.lockReason ?? "Verrouillé") : null))));
        }));
    };
    paint();
    return h("div.stack", preview, body,
      h("button.btn.primary.block", { onclick: async () => {
        try { await put("/api/me/avatar", draft); await loadMe(); S.catalog = null; toast("Avatar enregistré", "good"); close(); done(); } catch (e) { fail(e); }
      } }, "Enregistrer"));
  });
}

const ROLE_LABEL = { ADMIN: "Super administrateur", ORG_ADMIN: "Administrateur d'organisation", SUBJECT_MANAGER: "Responsable de matière" };
/** Profil d'un compte de gestion (administrateur, administrateur d'organisation, responsable). */
export async function staffProfileView(logout) {
  const me = S.me;
  const orgs = me.organizations ?? [];
  return h("div.stack",
    h("div.admin-head", h("h1", "Mon profil")),
    h("section.card.stack",
      h("div.row", h("span.initial", { style: "width:48px;height:48px;font-size:1.3rem" }, me.user.username.slice(0, 1).toUpperCase()),
        h("div", h("strong", me.user.username), h("div.muted", ROLE_LABEL[me.user.role] ?? ""))),
      me.user.role !== "ADMIN" && orgs.length ? h("div.muted.small", `Organisation${orgs.length > 1 ? "s" : ""} : ${orgs.map((o) => o.name).join(", ")}`) : null,
      me.user.role === "SUBJECT_MANAGER" && me.subjects.length ? h("div.muted.small", `Matière${me.subjects.length > 1 ? "s" : ""} gérée${me.subjects.length > 1 ? "s" : ""} : ${me.subjects.map((s) => s.name).join(", ")}`) : null),
    appSection(),
    emailSection(),
    h("section.stack.tight", h("h2", "Compte"),
      h("div.row.wrap",
        h("button.btn", { onclick: passwordSheet }, "Changer le mot de passe"),
        h("button.btn.ghost", { onclick: logout }, "Se déconnecter"))));
}
