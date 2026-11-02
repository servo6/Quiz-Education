import { test } from "node:test";
import assert from "node:assert/strict";
import { friendlyResultBonus, levelFromXp, xpToNextLevel } from "./xp.ts";

test("courbe de niveaux par défaut", () => {
  assert.equal(xpToNextLevel(1), 100);
  assert.equal(xpToNextLevel(2), 230);
  assert.equal(xpToNextLevel(3), 374);
  assert.equal(xpToNextLevel(10), 1585);
});

test("niveau calculé depuis le total d'XP", () => {
  assert.deepEqual(levelFromXp(0), { level: 1, xpIntoLevel: 0, xpForNext: 100 });
  assert.equal(levelFromXp(99).level, 1);
  assert.equal(levelFromXp(100).level, 2);
  assert.equal(levelFromXp(329).level, 2);
  assert.equal(levelFromXp(330).level, 3);
  assert.deepEqual(levelFromXp(350), { level: 3, xpIntoLevel: 20, xpForNext: 374 });
});

test("une partie solo parfaite de 10 questions donne le niveau 2", () => {
  assert.equal(levelFromXp(10 * 10).level, 2);
});

test("bonus de fin de duel", () => {
  assert.equal(friendlyResultBonus("WIN"), 40);
  assert.equal(friendlyResultBonus("DRAW"), 20);
  assert.equal(friendlyResultBonus("LOSS"), 0);
  assert.equal(friendlyResultBonus("FORFEIT"), 0);
});
