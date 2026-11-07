import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Le dessin de l'avatar (public/js/avatar.js) est du JavaScript de navigateur : on vérifie ici qu'il produit un SVG sain pour chaque option.
const mod: any = await import(pathToFileURL(path.resolve("public/js/avatar.js")).href);
const { avatarSvgString, resolveLook, OPTIONS, DEFAULTS } = mod;

const healthy = (svg: string, label: string) => {
  assert.match(svg, /^<svg [^>]*viewBox="0 0 100 100"/, label);
  assert.doesNotMatch(svg, /undefined|NaN|\[object|null/, label);
  const open = (svg.match(/<(g|defs|clipPath|linearGradient|radialGradient|pattern)[ >]/g) ?? []).length;
  const close = (svg.match(/<\/(g|defs|clipPath|linearGradient|radialGradient|pattern)>/g) ?? []).length;
  assert.equal(open, close, `balises équilibrées : ${label}`);
};

test("avatar : chaque option de chaque catégorie produit un SVG valide", () => {
  let n = 0;
  for (const key of Object.keys(OPTIONS)) {
    for (const [id] of OPTIONS[key]) {
      healthy(avatarSvgString({ items: {}, colors: {}, look: { [key]: id } }, [], { uid: "t" }), `${key}:${id}`);
      n++;
    }
  }
  assert.ok(n > 100, `${n} options testées`);
});

test("avatar : valeurs inconnues ou absentes retombent sur les valeurs par défaut", () => {
  const r = resolveLook({ items: {}, colors: {}, look: { hair: "n-importe-quoi", face: "square" } }, []);
  assert.equal(r.look.hair, DEFAULTS.hair);
  assert.equal(r.look.face, "square");
  healthy(avatarSvgString(null, null, { uid: "t" }), "avatar vide");
});

test("avatar : les anciens avatars (objets du catalogue) sont traduits", () => {
  const cat = [
    { id: "h", category: "hair", name: "Longs", assetPath: "avatars/hair/longs.svg" },
    { id: "o", category: "outfit", name: "Costume", assetPath: "avatars/outfit/costume.svg" },
    { id: "b", category: "background", name: "Vert", assetPath: "avatars/background/vert.svg" },
    { id: "g", category: "glasses", name: "Soleil", assetPath: "avatars/glasses/soleil.svg" },
    { id: "f", category: "frame", name: "Or", assetPath: "avatars/frame/or.svg" },
  ];
  const r = resolveLook({ items: { hair: "h", outfit: "o", background: "b", glasses: "g", frame: "f" }, colors: {} }, cat);
  assert.equal(r.look.hair, "long");
  assert.equal(r.look.outfit, "suit");
  assert.equal(r.look.glasses, "shades");
  assert.equal(r.look.bg, "gradient");
  assert.equal(r.frame, "#ffb020");
  // un choix détaillé enregistré l'emporte sur l'ancien objet
  assert.equal(resolveLook({ items: { hair: "h" }, colors: {}, look: { hair: "bob" } }, cat).look.hair, "bob");
});

test("avatar : une image personnalisée d'administrateur est ajoutée, sans pouvoir sortir du SVG", () => {
  const cat = [{ id: "x", category: "hat", name: "Chapeau perso", assetPath: 'avatars/hat/a"b.svg' }];
  const svg = avatarSvgString({ items: { hat: "x" }, colors: {}, look: {} }, cat, { uid: "t" });
  assert.match(svg, /<image href="\/avatars\/hat\/ab\.svg"/);
  assert.doesNotMatch(svg, /a"b/);
});
