import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIERS, titleFor } from "./titles.ts";
import { longestDayStreak, longestFastStreak } from "./badges.ts";
import { lockReason } from "./avatar.ts";

test("titre : palier le plus élevé atteint", () => {
  assert.equal(titleFor(1, DEFAULT_TIERS).name, "Novice");
  assert.equal(titleFor(4, DEFAULT_TIERS).name, "Novice");
  assert.equal(titleFor(5, DEFAULT_TIERS).name, "Apprenti");
  assert.equal(titleFor(29, DEFAULT_TIERS).name, "Confirmé");
  assert.equal(titleFor(500, DEFAULT_TIERS).name, "Légende");
  // paliers désordonnés
  assert.equal(titleFor(7, [{ name: "B", minLevel: 6, color: "#000000" }, { name: "A", minLevel: 1, color: "#000000" }]).name, "B");
});

test("série de jours consécutifs", () => {
  assert.equal(longestDayStreak([]), 0);
  assert.equal(longestDayStreak(["2026-01-01"]), 1);
  assert.equal(longestDayStreak(["2026-01-01", "2026-01-02", "2026-01-02", "2026-01-03", "2026-01-10"]), 3);
  assert.equal(longestDayStreak(["2026-02-28", "2026-03-01"]), 2); // fin de mois
  assert.equal(longestDayStreak(["2026-12-31", "2027-01-01"]), 2); // fin d'année
  assert.equal(longestDayStreak(["2026-01-01", "2026-01-03"]), 1);
});

test("série de bonnes réponses rapides", () => {
  const f = (c: boolean, t: number | null) => ({ isCorrect: c, timeMs: t });
  assert.equal(longestFastStreak([f(true, 1000), f(true, 5000), f(true, 5001), f(true, 100)]), 2);
  assert.equal(longestFastStreak([f(true, 1000), f(false, 1000), f(true, 1000)]), 1);
  assert.equal(longestFastStreak([f(true, null)]), 0);
});

test("verrouillage des objets d'avatar", () => {
  const ctx = { maxLevel: 12, badgeCodes: new Set(["wins_1"]), tiers: [{ name: "Initié", minLevel: 10 }, { name: "Expert", minLevel: 30 }] };
  assert.equal(lockReason({ unlockType: "FREE", unlockValue: null }, ctx), null);
  assert.equal(lockReason({ unlockType: "LEVEL", unlockValue: "12" }, ctx), null);
  assert.match(lockReason({ unlockType: "LEVEL", unlockValue: "13" }, ctx)!, /Niveau 13/);
  assert.equal(lockReason({ unlockType: "BADGE", unlockValue: "wins_1" }, ctx), null);
  assert.notEqual(lockReason({ unlockType: "BADGE", unlockValue: "wins_50" }, ctx), null);
  assert.equal(lockReason({ unlockType: "TIER", unlockValue: "Initié" }, ctx), null);
  assert.notEqual(lockReason({ unlockType: "TIER", unlockValue: "Expert" }, ctx), null);
  assert.notEqual(lockReason({ unlockType: "TIER", unlockValue: "Inconnu" }, ctx), null);
  assert.notEqual(lockReason({ unlockType: "???", unlockValue: null }, ctx), null);
});
