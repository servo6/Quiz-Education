import { get, post } from "./lib.js";

/** Pièces gagnées en salon et articles achetés (thèmes, animations). */
export const W = { coins: 0, unlocked: new Set(), shop: [], loaded: false };

export async function loadWallet() {
  try {
    const r = await get("/api/wallet");
    W.coins = r.coins; W.unlocked = new Set(r.unlocked); W.shop = r.shop; W.loaded = true;
  } catch { /* le portefeuille reste vide */ }
  return W;
}
export const priceOf = (id) => W.shop.find((i) => i.id === id)?.price ?? null;
export async function buyItem(id) {
  const r = await post("/api/shop/buy", { itemId: id });
  W.coins = r.coins; W.unlocked.add(id);
  return r;
}
