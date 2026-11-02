import { get } from "./lib.js";

export const S = { me: null, catalog: null, summary: null };

export async function loadMe() {
  try { S.me = await get("/api/me"); } catch (e) { if (e.status === 401) S.me = null; else throw e; }
  return S.me;
}
export const activeSubject = () => S.me?.subjects.find((s) => s.id === S.me.user.activeSubjectId) ?? null;
export const isAdminUser = () => S.me?.user.role === "ADMIN";
export const isStaff = () => !!S.me && S.me.user.role !== "USER";
export async function loadCatalog() {
  if (!S.catalog) S.catalog = (await get("/api/avatar/items")).items;
  return S.catalog;
}
export async function refreshSummary() {
  try { S.summary = await get("/api/me/summary"); } catch { S.summary = null; }
  document.dispatchEvent(new CustomEvent("summary"));
  return S.summary;
}
export const lvl = (l) => (typeof l === "object" && l ? l.level : l);

export const go = (p) => { if (location.hash === "#" + p) window.dispatchEvent(new Event("hashchange")); else location.hash = p; };
export const rerender = () => window.dispatchEvent(new Event("hashchange"));
