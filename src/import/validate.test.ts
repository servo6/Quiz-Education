import { test } from "node:test";
import assert from "node:assert/strict";
import { hashQuestion, validateImport } from "./validate.ts";

const q = (over: Record<string, unknown> = {}) => ({
  question: "Quelle est la capitale de la France ?",
  choices: ["Lyon", "Paris", "Marseille", "Lille"],
  answer: 1,
  ...over,
});

test("accepte un bloc valide", () => {
  const r = validateImport(JSON.stringify([q(), q({ question: "2 + 2 ?", choices: ["3", "4"], answer: 1, explanation: "Simple." })]));
  assert.equal(r.fatalError, undefined);
  assert.equal(r.total, 2);
  assert.equal(r.valid.length, 2);
  assert.equal(r.valid[1].explanation, "Simple.");
  assert.deepEqual(r.errors, []);
});

test("accepte un bloc entouré de ```json et un objet { questions }", () => {
  const fenced = "```json\n" + JSON.stringify({ questions: [q()] }) + "\n```";
  assert.equal(validateImport(fenced).valid.length, 1);
});

test("JSON invalide : erreur bloquante avec position", () => {
  const r = validateImport('[\n  { "question": "x", }\n]');
  assert.match(r.fatalError ?? "", /pas un JSON valide/);
  assert.match(r.fatalError ?? "", /ligne 2/);
});

test("guillemets typographiques : astuce affichée", () => {
  const r = validateImport("[{“question”: “x”}]");
  assert.match(r.fatalError ?? "", /guillemets typographiques/);
});

test("bloc vide, liste vide, mauvais type", () => {
  assert.match(validateImport("   ").fatalError ?? "", /vide/);
  assert.match(validateImport("[]").fatalError ?? "", /vide/);
  assert.match(validateImport('"bonjour"').fatalError ?? "", /liste de questions/);
});

test("trop de questions", () => {
  const r = validateImport(JSON.stringify([q(), q()]), { maxQuestions: 1 });
  assert.match(r.fatalError ?? "", /Trop de questions/);
});

test("answer hors limites", () => {
  const r = validateImport(JSON.stringify([q({ answer: 4 })]));
  assert.equal(r.valid.length, 0);
  assert.match(r.errors[0].messages[0], /positions valides : 0 à 3/);
});

test("answer pas un entier / négatif / texte", () => {
  for (const answer of [1.5, -1, "B"]) {
    const r = validateImport(JSON.stringify([q({ answer })]));
    assert.equal(r.errors.length, 1, `answer=${String(answer)}`);
  }
});

test("choix en double, trop peu, trop nombreux, vide", () => {
  assert.match(validateImport(JSON.stringify([q({ choices: ["A", "a", "C"], answer: 0 })])).errors[0].messages[0], /plusieurs fois/);
  assert.match(validateImport(JSON.stringify([q({ choices: ["A"], answer: 0 })])).errors[0].messages[0], /au moins 2/);
  assert.match(validateImport(JSON.stringify([q({ choices: ["1", "2", "3", "4", "5", "6", "7"], answer: 0 })])).errors[0].messages[0], /trop de choix/);
  assert.match(validateImport(JSON.stringify([q({ choices: ["A", "  "], answer: 0 })])).errors[0].messages[0], /vide/);
});

test("champ inconnu et champ manquant signalés", () => {
  const r = validateImport(JSON.stringify([q({ reponse: 1 }), { question: "x" }]));
  assert.match(r.errors[0].messages[0], /champ inconnu « reponse »/);
  assert.ok(r.errors[1].messages.some((m) => /choices manquant/.test(m)));
  assert.ok(r.errors[1].messages.some((m) => /answer manquant/.test(m)));
});

test("import partiel : les questions valides passent malgré les erreurs", () => {
  const r = validateImport(JSON.stringify([q(), q({ question: "Autre ?", answer: 9 }), q({ question: "Encore ?" })]));
  assert.equal(r.total, 3);
  assert.deepEqual(r.valid.map((v) => v.index), [1, 3]);
  assert.deepEqual(r.errors.map((e) => e.index), [2]);
});

test("doublons dans le bloc (insensible à la casse et aux espaces)", () => {
  const r = validateImport(JSON.stringify([q(), q({ question: "  QUELLE est la capitale   de la France ? " })]));
  assert.equal(r.valid.length, 1);
  assert.deepEqual(r.duplicates, [{ index: 2, reason: "in-batch", sameAs: 1 }]);
});

test("doublons avec la base", () => {
  const existing = new Set([hashQuestion("Quelle est la capitale de la France ?")]);
  const r = validateImport(JSON.stringify([q()]), { existingHashes: existing });
  assert.equal(r.valid.length, 0);
  assert.deepEqual(r.duplicates, [{ index: 1, reason: "in-database" }]);
});

test("les textes sont nettoyés", () => {
  const r = validateImport(JSON.stringify([q({ question: "  Hello   world ?  ", choices: [" A ", "B  b"], answer: 0 })]));
  assert.equal(r.valid[0].question, "Hello world ?");
  assert.deepEqual(r.valid[0].choices, ["A", "B b"]);
});
