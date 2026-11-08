import { h, get, post, api, icon, toast, fail, avatarEl, sheet } from "../lib.js";
import { S, activeSubject, loadCatalog, lvl, go } from "../state.js";

const onlyEmoji = (t) => { const x = t.trim(); return x.length > 0 && x.length <= 24 && /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200d\ufe0f\u20e3]|\p{Emoji_Modifier}|\s)+$/u.test(x); };
const del = (u) => api("DELETE", u);
const hhmm = (iso) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const dayLabel = (iso) => {
  const d = new Date(iso), t = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const y = new Date(t); y.setDate(t.getDate() - 1);
  return same(d, t) ? "Aujourd'hui" : same(d, y) ? "Hier" : d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
};
const retentionText = (d) => (d === 2 ? "2 jours" : d === 7 ? "1 semaine" : d === 30 ? "1 mois" : `${d} jours`);

// ───────── Amis ─────────
import { emojiPanel, insertAtCursor } from "../emojiPicker.js";
export async function friendsView() {
  const sub = activeSubject();
  const [cat, data, pl] = await Promise.all([loadCatalog().catch(() => []), get(`/api/subjects/${sub.id}/friends`), get(`/api/subjects/${sub.id}/players`)]);
  const root = h("div.stack");
  const known = new Set([...data.friends, ...data.incoming, ...data.outgoing].map((f) => f.user.id));

  const act = (fn, msg) => async () => { try { await fn(); if (msg) toast(msg, "good"); refresh(); } catch (e) { fail(e); } };
  async function refresh() {
    const fresh = await get(`/api/subjects/${sub.id}/friends`);
    Object.assign(data, fresh);
    known.clear(); [...data.friends, ...data.incoming, ...data.outgoing].forEach((f) => known.add(f.user.id));
    document.dispatchEvent(new Event("social-changed"));
    paint();
  }

  const q = h("input.input", { type: "search", placeholder: "Chercher un joueur à inviter", "aria-label": "Chercher un joueur" });
  const results = h("div.list");
  let timer;
  const search = async () => {
    const r = await get(`/api/subjects/${sub.id}/players?q=${encodeURIComponent(q.value)}`).catch(() => ({ players: [] }));
    const people = r.players.filter((p) => p.id !== S.me.user.id && !known.has(p.id));
    results.replaceChildren(...(people.length ? people.slice(0, 20).map((p) => h("div.item",
      avatarEl(p.avatar, cat, 40), h("div.grow", h("strong", p.username), h("div.muted.small", `Niveau ${lvl(p.level)}`)),
      h("button.btn.small", { onclick: act(() => post(`/api/subjects/${sub.id}/friends`, { userId: p.id }), `Invitation envoyée à ${p.username}`) }, icon("userplus"), "Inviter")))
      : [h("p.muted", q.value ? "Aucun joueur trouvé." : "Tous les joueurs de la matière sont déjà dans tes amis ou invités.")]));
  };
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(search, 250); };

  function paint() {
    root.replaceChildren(...[
      h("div.row.between", h("h1", "Amis"), h("span.muted.small", `Messages effacés après ${retentionText(data.retentionDays)}`)),
      data.incoming.length ? h("section.stack.tight", h("h2", `Invitations reçues (${data.incoming.length})`),
        h("div.list", data.incoming.map((f) => h("div.item", avatarEl(f.user.avatar, cat, 44),
          h("div.grow", h("strong", f.user.username), h("div.muted.small", "veut devenir ton ami")),
          h("button.btn.primary.small", { onclick: act(() => post(`/api/friendships/${f.id}/accept`), `Tu es maintenant ami avec ${f.user.username}`) }, "Accepter"),
          h("button.btn.ghost.small", { onclick: act(() => del(`/api/friendships/${f.id}`)) }, "Refuser"))))) : null,
      h("section.stack.tight", h("h2", `Mes amis (${data.friends.length})`),
        data.friends.length ? h("div.list", data.friends.map((f) => h("a.item", { href: `#/friends/${f.id}` },
          avatarEl(f.user.avatar, cat, 44),
          h("div.grow", h("strong", f.user.username, f.online ? h("span.chip.good.dot", { style: "margin-left:8px" }, "en ligne") : null),
            h("div.muted.small", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%" }, f.last ? `${f.last.mine ? "Toi : " : ""}${f.last.body}` : "Aucun message pour l'instant")),
          f.unread ? h("span.unread", String(f.unread)) : null)))
          : h("div.empty", icon("chat"), h("p", "Aucun ami"))),
      data.outgoing.length ? h("section.stack.tight", h("h2", "Invitations envoyées"),
        h("div.list", data.outgoing.map((f) => h("div.item", avatarEl(f.user.avatar, cat, 40), h("div.grow", h("strong", f.user.username), h("div.muted.small", "en attente de réponse")),
          h("button.btn.ghost.small", { onclick: act(() => del(`/api/friendships/${f.id}`)) }, "Annuler"))))) : null,
      h("section.stack.tight", h("h2", "Inviter un joueur"), q, results)].filter(Boolean));
  }
  paint(); search();
  return root;
}

// ───────── Conversation ─────────
export async function chatView({ id }, ctx) {
  const first = await get(`/api/friendships/${id}/messages`);
  const sub = activeSubject();
  const cat = await loadCatalog().catch(() => []);
  const friends = await get(`/api/subjects/${sub.id}/friends`).catch(() => ({ friends: [] }));
  const meta = friends.friends.find((f) => f.id === id);
  const body = h("div.chat-body", { role: "log", "aria-live": "polite", "aria-label": "Messages" });
  const input = h("textarea.input", { rows: 1, maxlength: 1000, placeholder: "Écris un message…", "aria-label": "Message", enterkeyhint: "send" });
  let lastIso = null, lastDay = null;
  const seen = new Set();

  const bubble = (m) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    const day = dayLabel(m.createdAt);
    if (day !== lastDay) { body.append(h("div.day-sep", day)); lastDay = day; }
    body.append(h("div.bubble", { class: (m.mine ? "mine" : "") + (onlyEmoji(m.body) ? " big-emoji" : "") }, m.body, h("time", { datetime: m.createdAt }, hhmm(m.createdAt))));
    lastIso = m.createdAt;
  };
  const toBottom = () => { body.scrollTop = body.scrollHeight; };
  first.messages.forEach(bubble);
  if (!first.messages.length) body.append(h("p.muted.center", { id: "chat-empty", style: "margin:auto" }, "Dis bonjour !"));

  async function fetchNew() {
    try {
      const r = await get(`/api/friendships/${id}/messages${lastIso ? `?after=${encodeURIComponent(lastIso)}` : ""}`);
      if (r.messages.length) { document.getElementById("chat-empty")?.remove(); const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 80; r.messages.forEach(bubble); if (stick) toBottom(); document.dispatchEvent(new Event("social-changed")); }
    } catch { /* hors ligne : on réessaiera */ }
  }
  const onMsg = (e) => { if (e.detail?.friendshipId === id) fetchNew(); };
  document.addEventListener("chat:message", onMsg);
  const poll = setInterval(fetchNew, 15000);
  ctx.setCleanup(() => { document.removeEventListener("chat:message", onMsg); clearInterval(poll); });

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = ""; input.style.height = "auto";
    try {
      const m = await post(`/api/friendships/${id}/messages`, { body: text });
      document.getElementById("chat-empty")?.remove();
      bubble(m); toBottom();
    } catch (e) { input.value = text; fail(e); }
  }
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 110) + "px"; });

  const menu = () => sheet(first.friend.username, (close) => h("div.stack",
    h("a.btn.block", { href: "#/duels/new", onclick: close }, icon("duel"), "Défier"),
    h("a.btn.block", { href: `#/stats/compare/${first.friend.id}`, onclick: close }, "Comparer nos statistiques"),
    h("button.btn.danger.block", { onclick: async () => {
      if (!confirm(`Retirer ${first.friend.username} de tes amis ? La conversation sera supprimée pour vous deux.`)) return;
      try { await del(`/api/friendships/${id}`); close(); toast("Ami retiré", "good"); go("/friends"); } catch (e) { fail(e); }
    } }, "Retirer des amis")));

  const emo = emojiPanel((ch) => { insertAtCursor(input, ch); });
  const el = h("div.stack",
    h("a.muted", { href: "#/friends" }, "← Amis"),
    h("div.chat",
      h("div.chat-head", meta ? avatarEl(meta.user.avatar, cat, 38) : null,
        h("div.grow", h("strong", first.friend.username), h("div.muted.small", `Messages effacés après ${retentionText(first.retentionDays)}`)),
        h("button.btn.ghost.small", { onclick: menu, "aria-label": "Options" }, "⋯")),
      body,
      emo.el,
      h("form.chat-form", { onsubmit: (e) => { e.preventDefault(); send(); } },
        h("button.btn.ghost.emoji-toggle", { type: "button", "aria-label": "Émojis", title: "Émojis", onclick: () => emo.toggle() }, "😊"),
        input, h("button.btn.primary", { type: "submit", "aria-label": "Envoyer" }, icon("send")))));
  queueMicrotask(toBottom);
  setTimeout(toBottom, 60);
  document.dispatchEvent(new Event("social-changed"));
  return el;
}
