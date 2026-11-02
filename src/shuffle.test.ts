import { test } from "node:test";
import assert from "node:assert/strict";
import { choiceOrder, displayChoices, toDisplayed, toOriginal } from "./shuffle.ts";

test("mélange : permutation valide, stable, désactivable", () => {
  assert.deepEqual(choiceOrder("q1", "u1", 4, false), [0, 1, 2, 3]);
  assert.deepEqual(choiceOrder("q1", "u1", 1, true), [0]);
  const o = choiceOrder("q1", "u1", 5, true);
  assert.deepEqual([...o].sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual(choiceOrder("q1", "u1", 5, true), o); // déterministe
  // sur beaucoup de questions, l'ordre change réellement et dépend du joueur
  let moved = 0;
  let differs = 0;
  for (let i = 0; i < 200; i++) {
    const a = choiceOrder(`q${i}`, "u1", 4, true);
    if (a.some((v, k) => v !== k)) moved++;
    if (a.join() !== choiceOrder(`q${i}`, "u2", 4, true).join()) differs++;
  }
  assert.ok(moved > 150, `moved=${moved}`);
  assert.ok(differs > 100, `differs=${differs}`);
});

test("mélange : aller-retour entre positions affichées et d'origine", () => {
  const order = choiceOrder("q9", "u9", 4, true);
  const shown = displayChoices(["a", "b", "c", "d"], order);
  for (let d = 0; d < 4; d++) {
    assert.equal(shown[d], ["a", "b", "c", "d"][toOriginal(order, d)]);
    assert.equal(toDisplayed(order, toOriginal(order, d)), d);
  }
  assert.equal(toDisplayed(order, null), null);
});

test("mélange : toutes les positions peuvent être atteintes (pas de biais fatal)", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 300; i++) seen.add(choiceOrder(`q${i}`, "u", 4, true)[0]);
  assert.equal(seen.size, 4);
});
