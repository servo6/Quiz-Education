import { test } from "node:test";
import assert from "node:assert/strict";
import { startOfDay } from "../src/time.ts";

const iso = (d: Date) => d.toISOString();

test("minuit à Paris, heure d'hiver (UTC+1)", () => {
  assert.equal(iso(startOfDay(new Date("2026-11-02T00:56:00Z"))), "2026-11-01T23:00:00.000Z");
  assert.equal(iso(startOfDay(new Date("2026-11-01T23:00:00Z"))), "2026-11-01T23:00:00.000Z"); // pile minuit
  assert.equal(iso(startOfDay(new Date("2026-11-01T22:59:59Z"))), "2026-10-31T23:00:00.000Z"); // 23h59 la veille
});

test("minuit à Paris, heure d'été (UTC+2)", () => {
  assert.equal(iso(startOfDay(new Date("2026-07-14T10:00:00Z"))), "2026-07-13T22:00:00.000Z");
});

test("jours de changement d'heure", () => {
  // 25 octobre 2026 : retour à l'heure d'hiver à 3h ; minuit était encore en UTC+2
  assert.equal(iso(startOfDay(new Date("2026-10-25T12:00:00Z"))), "2026-10-24T22:00:00.000Z");
  // 29 mars 2026 : passage à l'heure d'été à 2h ; minuit était encore en UTC+1
  assert.equal(iso(startOfDay(new Date("2026-03-29T12:00:00Z"))), "2026-03-28T23:00:00.000Z");
});

test("autre fuseau", () => {
  // New York : le 1er novembre 2026 le changement d'heure a lieu à 2h, minuit était encore en UTC-4
  assert.equal(iso(startOfDay(new Date("2026-11-02T03:00:00Z"), "America/New_York")), "2026-11-01T04:00:00.000Z");
  assert.equal(iso(startOfDay(new Date("2026-11-10T12:00:00Z"), "America/New_York")), "2026-11-10T05:00:00.000Z");
});
