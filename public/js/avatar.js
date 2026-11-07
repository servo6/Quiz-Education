/* Avatar : buste dessiné en SVG avec lumière, ombres et relief (effet 3D), sans aucune image externe.
   drawAvatar(avatar, catalog, size, opts) est utilisé partout dans l'application (classement, duels, amis, profil).
   `avatar` = { items, colors, look } ; `look` contient les choix de forme (visage, yeux, cheveux…), `colors` les teintes. */

const NS = "http://www.w3.org/2000/svg";

// ───────── Couleurs ─────────
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
function rgb(hex) { const n = parseInt(String(hex).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function hex([r, g, b]) { return "#" + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join(""); }
const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
const dark = (c, t) => mix(c, "#000000", t);
const light = (c, t) => mix(c, "#ffffff", t);

// ───────── Catalogue des options (identifiants, libellés, verrouillage éventuel côté serveur) ─────────
export const OPTIONS = {
  face: [["oval", "Ovale"], ["round", "Rond"], ["square", "Carré"], ["heart", "Cœur"], ["long", "Allongé"], ["diamond", "Diamant"]],
  eyes: [["almond", "Amande"], ["round", "Ronds"], ["wide", "Grands"], ["narrow", "Fins"], ["droopy", "Tombants"], ["cat", "Félins"]],
  brows: [["straight", "Droits"], ["arched", "Arqués"], ["thick", "Épais"], ["thin", "Fins"], ["soft", "Doux"], ["raised", "Relevés"], ["angry", "Sévères"]],
  nose: [["small", "Petit"], ["button", "Bouton"], ["straight", "Droit"], ["wide", "Large"], ["pointed", "Pointu"], ["round", "Rond"]],
  mouth: [["smile", "Sourire"], ["grin", "Grand sourire"], ["neutral", "Neutre"], ["smirk", "En coin"], ["laugh", "Rire"], ["pout", "Moue"], ["soft", "Doux"], ["oh", "Surpris"]],
  hair: [["bald", "Chauve"], ["buzz", "Rasé"], ["short", "Courts"], ["sidepart", "Raie sur le côté"], ["quiff", "Banane"], ["undercut", "Undercut"], ["crew", "Brosse"], ["spiky", "Hérissés"],
    ["afro", "Afro"], ["curly", "Bouclés"], ["waves", "Ondulés"], ["bun", "Chignon"], ["topknot", "Chignon haut"], ["ponytail", "Queue de cheval"], ["long", "Longs"], ["longwavy", "Longs ondulés"],
    ["bob", "Carré"], ["pixie", "Pixie"], ["braids", "Tresses"], ["dreads", "Dreadlocks"], ["mohawk", "Crête"]],
  beard: [["none", "Aucune"], ["stubble", "Barbe de 3 jours"], ["mustache", "Moustache"], ["goatee", "Bouc"], ["short", "Barbe courte"], ["full", "Barbe fournie"], ["soulpatch", "Mouche"]],
  glasses: [["none", "Aucunes"], ["round", "Rondes"], ["square", "Carrées"], ["aviator", "Aviateur"], ["cat", "Papillon"], ["shades", "Soleil"]],
  earrings: [["none", "Aucune"], ["studs", "Puces"], ["hoops", "Anneaux"], ["drops", "Pendantes"]],
  headwear: [["none", "Aucun"], ["cap", "Casquette"], ["beanie", "Bonnet"], ["headband", "Bandeau"], ["headphones", "Casque audio"], ["scarf", "Foulard"], ["crown", "Couronne"], ["gradcap", "Chapeau de diplômé"]],
  outfit: [["tshirt", "T-shirt"], ["hoodie", "Sweat à capuche"], ["polo", "Polo"], ["shirt", "Chemise"], ["blazer", "Veste"], ["suit", "Costume"], ["blouse", "Blouse"], ["vneck", "Col en V"], ["turtle", "Col roulé"], ["jersey", "Maillot"]],
  freckles: [["none", "Aucune"], ["light", "Légères"], ["many", "Nombreuses"]],
  mark: [["none", "Aucun"], ["mole", "Grain de beauté"]],
  blush: [["none", "Aucune"], ["soft", "Joues roses"]],
  bg: [["studio", "Studio"], ["gradient", "Dégradé"], ["rays", "Rayons"], ["dots", "Pois"], ["stripes", "Rayures"], ["sunset", "Coucher de soleil"], ["aurora", "Aurore"], ["solid", "Uni"]],
};
export const DEFAULTS = { face: "oval", eyes: "almond", brows: "straight", nose: "small", mouth: "smile", hair: "short", beard: "none", glasses: "none", earrings: "none", headwear: "none", outfit: "tshirt", freckles: "none", mark: "none", blush: "none", bg: "studio" };
export const COLOR_DEFAULTS = { skin: "#efc19a", hair: "#3b2a1a", eyes: "#6b3e1d", lips: "", outfit: "#ff5d6c", acc: "#2b2a4a", bga: "#7c88e8", bgb: "#363a85" };
export const PALETTES = {
  skin: ["#fbe3d0", "#f6d2b4", "#efc19a", "#e0a77c", "#c98a5e", "#a96e45", "#8a5733", "#6b4226", "#4f2f1d", "#3a2216"],
  hair: ["#0f0b09", "#2b1b12", "#4a2f1c", "#7a4a26", "#a56a35", "#c99a52", "#e6c27a", "#d9d2c3", "#a1a1a6", "#eeeeef", "#8a2d1c", "#c44a24", "#2f6fed", "#d93a8a", "#7a3df0", "#12b3a2", "#22b57a"],
  eyes: ["#2b1a10", "#6b3e1d", "#8d6a2f", "#3f7a4a", "#4a7fc1", "#7f95a8", "#6a4bb5"],
  lips: ["", "#c4736b", "#d9828a", "#b8323f", "#8e2a45", "#6b2e3a", "#e8a0a0"],
  outfit: ["#ff5d6c", "#f59e0b", "#facc15", "#22b57a", "#12b3a2", "#3b82f6", "#7a5cff", "#ec4899", "#2b2a4a", "#111827", "#f4f6ff", "#9ca3af"],
  acc: ["#2b2a4a", "#111827", "#f4f6ff", "#ffb020", "#c0c4cc", "#ff5d6c", "#3b82f6", "#22b57a", "#7a5cff"],
  bg: [["#7c88e8", "#363a85"], ["#4cc9f0", "#1d4e89"], ["#34d399", "#065f46"], ["#fbbf24", "#b45309"], ["#fb7185", "#9f1239"], ["#a78bfa", "#4c1d95"], ["#94a3b8", "#1e293b"], ["#f9a8d4", "#6d28d9"], ["#fde68a", "#f97316"], ["#e5e7eb", "#6b7280"]],
};

// Anciens objets du catalogue (avant les avatars détaillés) : traduction pour ne perdre aucun avatar existant.
const LEGACY = {
  hair: { Courts: "short", Longs: "long", "Bouclés": "curly", "Crête": "mohawk" },
  glasses: { Soleil: "shades" },
  face: { "Lunettes rondes": ["glasses", "round"], "Sérieux": ["mouth", "neutral"], Sourire: ["mouth", "smile"] },
  hat: { Casquette: "cap", "Couronne": "crown" },
  outfit: { "T-shirt": ["tshirt", "#ff5d6c"], Sweat: ["hoodie", "#7a5cff"], Costume: ["suit", "#2b2a4a"], Blouse: ["blouse", "#f4f6ff"] },
  background: { Bleu: ["gradient", "#60a5fa", "#1d4ed8"], Vert: ["gradient", "#34d399", "#047857"], Galaxie: ["gradient", "#2a1b78", "#c43b8f"] },
};
const FRAME = { Simple: "#ffffff", Or: "#ffb020", "Légende": "#ec4899" };
const BUILTIN_NAMES = new Set([...Object.keys(LEGACY.hair), ...Object.keys(LEGACY.glasses), ...Object.keys(LEGACY.face), ...Object.keys(LEGACY.hat), ...Object.keys(LEGACY.outfit), ...Object.keys(LEGACY.background), ...Object.keys(FRAME), "Aucune", "Aucun"]);
const IMG = /\.(svg|png|webp|jpe?g|gif)$/i;
/** Vrai pour un objet ajouté par un administrateur (image personnalisée) ; faux pour les objets d'origine. */
export const isCustomItem = (it) => !!it && !BUILTIN_NAMES.has(it.name) && IMG.test(it.assetPath || "");
export const isFrameItem = (it) => it?.category === "frame";

/** Réunit les choix enregistrés, les anciens objets du catalogue et les valeurs par défaut. */
export function resolveLook(avatar, catalog) {
  const byId = new Map((catalog || []).map((i) => [i.id, i]));
  const items = avatar?.items || {};
  const look = { ...DEFAULTS };
  const colors = { ...COLOR_DEFAULTS, ...(avatar?.colors || {}) };
  const saved = avatar?.look || {};
  const legacy = (cat) => byId.get(items[cat])?.name;
  const custom = {};
  for (const cat of ["hair", "face", "outfit", "glasses", "hat", "background", "frame"]) {
    const it = byId.get(items[cat]);
    if (it && !BUILTIN_NAMES.has(it.name) && IMG.test(it.assetPath || "")) custom[cat] = /^(https?:)?\//.test(it.assetPath) ? it.assetPath : "/" + it.assetPath;
  }
  const L = (n) => LEGACY.hair[n];
  if (!saved.hair && legacy("hair") && L(legacy("hair"))) look.hair = L(legacy("hair"));
  if (!saved.glasses && LEGACY.glasses[legacy("glasses")]) look.glasses = LEGACY.glasses[legacy("glasses")];
  const f = LEGACY.face[legacy("face")];
  if (f) { if (!saved[f[0]]) look[f[0]] = f[1]; }
  if (!saved.headwear && LEGACY.hat[legacy("hat")]) look.headwear = LEGACY.hat[legacy("hat")];
  const o = LEGACY.outfit[legacy("outfit")];
  if (o) { if (!saved.outfit) look.outfit = o[0]; if (!avatar?.colors?.outfit) colors.outfit = o[1]; }
  const bgl = LEGACY.background[legacy("background")];
  if (bgl && !saved.bg) { look.bg = bgl[0]; if (!avatar?.colors?.bga) colors.bga = bgl[1]; if (!avatar?.colors?.bgb) colors.bgb = bgl[2]; }
  for (const k of Object.keys(DEFAULTS)) if (saved[k] && OPTIONS[k]?.some(([id]) => id === saved[k])) look[k] = saved[k];
  const frame = FRAME[legacy("frame")] || null;
  return { look, colors, custom, frame };
}

// ───────── Géométrie ─────────
const FACE = { oval: { w: 20, cy: 73, a: 22, b: 12 }, round: { w: 22, cy: 71, a: 22, b: 17 }, square: { w: 21, cy: 72, a: 26, b: 19 }, heart: { w: 21, cy: 74, a: 14, b: 6 }, long: { w: 18, cy: 77, a: 28, b: 10 }, diamond: { w: 20, cy: 75, a: 12, b: 5 } };
const facePath = (f) => `M${50 - f.w} 44C${50 - f.w} 28 ${50 - f.w * 0.6} 22 50 22S${50 + f.w} 28 ${50 + f.w} 44C${50 + f.w} ${44 + f.a} ${50 + f.b} ${f.cy} 50 ${f.cy}S${50 - f.w} ${44 + f.a} ${50 - f.w} 44Z`;

const EYE = { almond: { w: 5.4, h: 2.9, t: 4 }, round: { w: 4.7, h: 3.9, t: 0 }, wide: { w: 5.8, h: 3.7, t: 2 }, narrow: { w: 5.5, h: 2.1, t: 3 }, droopy: { w: 5.3, h: 3, t: -6 }, cat: { w: 5.8, h: 2.7, t: 10 } };
const BROW = {
  straight: ["M-5.2 .8L5.2-.6", 1.7], arched: ["M-5.2 1.6Q-.5-3 5.4.2", 1.7], thick: ["M-5.2 1.2Q0-1.8 5.4-.2", 3.1], thin: ["M-5.2 1Q0-1.6 5.2-.2", 1],
  soft: ["M-5.2 1.2Q0-1.4 5.2.8", 2], raised: ["M-5.2 .4Q-.8-4 5.2-1.4", 1.8], angry: ["M-5.2-1.4L5.2 1.8", 2.2],
};

function defsFor(u, c, g) {
  const skin = c.skin, hair = c.hair;
  return `<defs>
  <clipPath id="${u}c"><circle cx="50" cy="50" r="48"/></clipPath>
  <clipPath id="${u}f"><path d="${g.face}"/></clipPath>
  <linearGradient id="${u}hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${light(hair, 0.22)}"/><stop offset=".45" stop-color="${hair}"/><stop offset="1" stop-color="${dark(hair, 0.3)}"/></linearGradient>
  <linearGradient id="${u}sk" x1=".2" y1="0" x2=".85" y2="1"><stop offset="0" stop-color="${light(skin, 0.14)}"/><stop offset=".55" stop-color="${skin}"/><stop offset="1" stop-color="${dark(skin, 0.18)}"/></linearGradient>
  <radialGradient id="${u}sh" cx=".5" cy=".45" r=".6"><stop offset=".62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="${dark(skin, 0.55)}" stop-opacity=".42"/></radialGradient>
  <linearGradient id="${u}ft" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".34"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
  <linearGradient id="${u}nk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".38"/><stop offset="1" stop-color="#000" stop-opacity=".02"/></linearGradient>
  <radialGradient id="${u}hl" cx=".34" cy=".26" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".34"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  <radialGradient id="${u}ir" cx=".4" cy=".35" r=".75"><stop offset="0" stop-color="${light(c.eyes, 0.35)}"/><stop offset=".6" stop-color="${c.eyes}"/><stop offset="1" stop-color="${dark(c.eyes, 0.5)}"/></radialGradient>
  <radialGradient id="${u}bl" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#f0647a" stop-opacity=".5"/><stop offset="1" stop-color="#f0647a" stop-opacity="0"/></radialGradient>
  <linearGradient id="${u}ou" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${light(c.outfit, 0.2)}"/><stop offset="1" stop-color="${dark(c.outfit, 0.28)}"/></linearGradient>
  <linearGradient id="${u}ac" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${light(c.acc, 0.25)}"/><stop offset="1" stop-color="${dark(c.acc, 0.25)}"/></linearGradient>
  <pattern id="${u}st" width="2.2" height="2.2" patternUnits="userSpaceOnUse"><circle cx=".6" cy=".6" r=".35" fill="${dark(hair, 0.3)}" opacity=".7"/><circle cx="1.7" cy="1.6" r=".3" fill="${dark(hair, 0.3)}" opacity=".6"/></pattern>
  </defs>`;
}

// ───────── Fond ─────────
function background(u, look, c) {
  const a = c.bga, b = c.bgb;
  switch (look.bg) {
    case "solid": return `<rect width="100" height="100" fill="${a}"/>`;
    case "gradient": return `<defs><linearGradient id="${u}bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100" height="100" fill="url(#${u}bg)"/>`;
    case "rays": { let r = ""; for (let i = 0; i < 12; i++) { const a1 = (i * 30) * Math.PI / 180, a2 = (i * 30 + 15) * Math.PI / 180; r += `<path d="M50 50L${50 + 90 * Math.cos(a1)} ${50 + 90 * Math.sin(a1)}L${50 + 90 * Math.cos(a2)} ${50 + 90 * Math.sin(a2)}Z" fill="${b}" opacity=".38"/>`; } return `<rect width="100" height="100" fill="${a}"/>${r}`; }
    case "dots": return `<defs><pattern id="${u}dp" width="9" height="9" patternUnits="userSpaceOnUse"><circle cx="4.5" cy="4.5" r="1.8" fill="${b}" opacity=".55"/></pattern></defs><rect width="100" height="100" fill="${a}"/><rect width="100" height="100" fill="url(#${u}dp)"/>`;
    case "stripes": return `<defs><pattern id="${u}sp" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(40)"><rect width="6" height="12" fill="${b}" opacity=".45"/></pattern></defs><rect width="100" height="100" fill="${a}"/><rect width="100" height="100" fill="url(#${u}sp)"/>`;
    case "sunset": return `<defs><linearGradient id="${u}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${b}"/><stop offset=".62" stop-color="${a}"/><stop offset="1" stop-color="${light(a, 0.35)}"/></linearGradient></defs><rect width="100" height="100" fill="url(#${u}bg)"/><circle cx="50" cy="62" r="26" fill="${light(a, 0.55)}" opacity=".55"/>`;
    case "aurora": return `<defs><radialGradient id="${u}b1" cx=".25" cy=".3" r=".7"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient><radialGradient id="${u}b2" cx=".8" cy=".75" r=".75"><stop offset="0" stop-color="${light(b, 0.15)}"/><stop offset="1" stop-color="${b}" stop-opacity="0"/></radialGradient></defs><rect width="100" height="100" fill="${dark(b, 0.55)}"/><rect width="100" height="100" fill="url(#${u}b1)"/><rect width="100" height="100" fill="url(#${u}b2)"/>`;
    default: return `<defs><radialGradient id="${u}bg" cx=".5" cy=".38" r=".75"><stop offset="0" stop-color="${light(a, 0.28)}"/><stop offset=".55" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient></defs><rect width="100" height="100" fill="url(#${u}bg)"/>`;
  }
}

// ───────── Cheveux : { back, mid, front } ─────────
const H = (u, d, extra = "") => `<path d="${d}" fill="url(#${u}hg)" ${extra}/>`;
function sheen(d) { return `<path d="${d}" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="1.6" stroke-linecap="round"/>`; }
function strands(d, c) { return `<path d="${d}" fill="none" stroke="${dark(c, 0.42)}" stroke-opacity=".35" stroke-width=".6" stroke-linecap="round"/>`; }
const circles = (u, list) => list.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="url(#${u}hg)"/>`).join("");

function hairParts(style, u, c) {
  const hc = c.hair;
  const cap = (top, side = 47, fr = 31.5) => H(u, `M29 ${side}C26 ${top + 9} 38 ${top} 50 ${top}S74 ${top + 9} 71 ${side}L69 43C67 ${fr + 5} 60 ${fr} 50 ${fr}S33 ${fr + 5} 31 43Z`);
  switch (style) {
    case "bald": return {};
    case "buzz": return { front: H(u, "M30.5 44C29 27 39 21.5 50 21.5S71 27 69.5 44C66 36 58 32.5 50 32.5S34 36 30.5 44Z", 'opacity=".62"') };
    case "short": return { front: cap(15.5) + sheen("M38 22Q50 16.5 62 22") + strands("M40 30Q44 23 50 21M60 30Q56 23 50 21", hc) };
    case "crew": return { front: H(u, "M29 47C26 25 37 16 50 16S74 25 71 47L69 42C67 34 60 29 50 29S33 34 31 42Z") + sheen("M38 21Q50 16 62 21") };
    case "sidepart": return { front: H(u, "M29 47C25 23 40 14 53 15C67 16 75 26 71 47L69.5 41C68.5 34 62 29.5 54 28.5C46 31 38 34 32 41Z") + `<path d="M54 15C50 22 44 28 36 33" fill="none" stroke="${dark(hc, 0.45)}" stroke-opacity=".5" stroke-width=".8"/>` + sheen("M44 20Q54 14.5 64 20.5") };
    case "quiff": return { front: H(u, "M28.5 47C22 22 36 8 53 9.5C70 11 77 22 71.5 47L69.5 40C67 33 59 30 52 31C45 27 36 32 31 42Z") + sheen("M38 14Q53 6 68 15") + strands("M36 22Q46 12 58 11M34 30Q40 20 48 16", hc) };
    case "undercut": return { front: H(u, "M31 40C28 26 37 14 52 13C67 13 73 24 69 40C66 33 60 29 50 29S35 33 31 40Z") + H(u, "M29 47C28 40 29 36 31 34L32 46Z", 'opacity=".5"') + H(u, "M71 47C72 40 71 36 69 34L68 46Z", 'opacity=".5"') + sheen("M40 18Q52 12 64 19") };
    case "spiky": return { front: H(u, "M29 47L27 28L35 33L36 18L43 27L49 12L55 27L63 17L65 32L73 27L71 47L69 41C67 35 60 31 50 31S33 35 31 41Z") };
    case "afro": return { back: H(u, "M50 6C30 6 19 19 20 36C20 48 25 52 28 54L72 54C75 52 80 48 80 36C81 19 70 6 50 6Z"), front: H(u, "M30 47C29 33 38 25 50 25S71 33 70 47L68 42C66 36 60 31 50 31S34 36 32 42Z") };
    case "curly": return { front: H(u, "M29 46C28 36 36 29 50 29S72 36 71 46L68 41C66 35 60 33 50 33S34 35 32 41Z") + circles(u, [[30, 36, 8], [40, 25, 9], [52, 22, 9.5], [63, 26, 9], [71, 36, 8], [27, 46, 5.5], [73, 46, 5.5]]) + `<g fill="#fff" fill-opacity=".14">${[[38, 22, 2.4], [51, 19, 2.6], [62, 23, 2.4]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join("")}</g>` };
    case "waves": return { front: H(u, "M28.5 47C23 25 36 12 51 12C67 12 77 24 71.5 47L69.5 40C68 34 62 30 55 30Q51 27 47 30Q43 33 39 31Q34 34 31.5 41Z") + sheen("M36 20Q51 9 66 19") + strands("M38 28Q42 20 48 17M50 29Q55 19 62 18", hc) };
    case "bun": return { back: circles(u, [[50, 11, 8.5]]), front: cap(16) + sheen("M38 22Q50 17 62 22") };
    case "topknot": return { front: H(u, "M31 40C28 27 37 17 50 17S72 27 69 40C66 33 60 29 50 29S34 33 31 40Z") + circles(u, [[50, 12, 8]]) + `<path d="M43 19Q50 22 57 19" stroke="${dark(hc, 0.5)}" stroke-width="1.2" fill="none"/>` };
    case "ponytail": return { back: H(u, "M62 28C72 24 82 32 80 48C79 58 82 66 76 76C75 66 72 60 70 52C69 44 64 36 60 30Z"), front: H(u, "M29 47C25 23 40 14 53 15C67 16 75 26 71 47L69.5 41C68.5 34 62 29.5 54 28.5C46 31 38 34 32 41Z") + sheen("M42 19Q54 12.5 66 20") };
    case "long": return { back: H(u, "M26 50C22 24 36 12 50 12S78 24 74 50L77 88L66 93L64 60H36L34 93L23 88Z"), mid: H(u, "M30 40L27 90L37 95L36 62L34 44ZM70 40L73 90L63 95L64 62L66 44Z"), front: H(u, "M29 50C25 24 40 14 50 14S75 24 71 50L69 42C67 34 58 29 50 29S33 34 31 42Z") + `<path d="M50 14C49 22 46 29 40 34M50 14C51 22 54 29 60 34" fill="none" stroke="${dark(hc, 0.4)}" stroke-opacity=".4" stroke-width=".7"/>` + sheen("M36 24Q50 12 64 24") };
    case "longwavy": return { back: H(u, "M26 50C21 24 36 11 50 11S79 24 74 50Q80 66 74 76Q79 86 72 92L62 90Q64 76 62 62H38Q36 76 38 90L28 92Q21 86 26 76Q20 66 26 50Z"), mid: H(u, "M30 40Q24 56 28 66Q24 78 30 90L38 92Q34 76 37 62L34 44ZM70 40Q76 56 72 66Q76 78 70 90L62 92Q66 76 63 62L66 44Z"), front: H(u, "M28.5 50C24 24 39 13 50 13S76 24 71.5 50L69 42C67 33 58 28 50 29C42 28 33 33 31 42Z") + sheen("M35 24Q50 11 65 24") + strands("M33 36Q36 26 44 20M67 36Q64 26 56 20", hc) };
    case "bob": return { back: H(u, "M25 52C21 25 36 12 50 12S79 25 75 52L74 72L62 70L38 70L26 72Z"), mid: H(u, "M29 42L26 70L37 72L35 52ZM71 42L74 70L63 72L65 52Z"), front: H(u, "M28 50C25 24 40 14 50 14S75 24 72 50L70 42C68 34 59 28 50 28S32 34 30 42Z") + sheen("M37 22Q50 12 63 22") };
    case "pixie": return { front: H(u, "M29 47C25 24 38 13 52 13C67 14 74 25 71 47L70 38C68 33 62 29 54 29C48 33 40 34 34 38L31 47Z") + sheen("M40 18Q54 10 66 19") };
    case "braids": return { back: H(u, "M27 50C24 26 37 14 50 14S76 26 73 50L72 58L28 58Z"), mid: [30, 70].map((x) => [0, 1, 2, 3, 4, 5].map((i) => `<ellipse cx="${x + (x < 50 ? -1 : 1) * (i % 2)}" cy="${48 + i * 9}" rx="3" ry="4.6" fill="url(#${u}hg)"/>`).join("")).join(""), front: cap(14.5, 50, 29) + `<path d="M50 15C50 23 49 28 47 32" stroke="${dark(hc, 0.5)}" stroke-width="1" fill="none" stroke-opacity=".7"/>` + sheen("M38 20Q50 14 62 20") };
    case "dreads": return { back: H(u, "M27 50C24 26 37 14 50 14S76 26 73 50L72 62L28 62Z"), mid: [28, 33, 67, 72].map((x, k) => `<path d="M${x - 2.5} 40C${x - 4} 55 ${x - 3} 72 ${x - 2} ${82 + (k % 2) * 6}L${x + 2.5} ${82 + (k % 2) * 6}C${x + 3} 72 ${x + 4} 55 ${x + 2.5} 40Z" fill="url(#${u}hg)"/>`).join(""), front: cap(14, 50, 30) + circles(u, [[34, 19, 4], [43, 15, 4.2], [53, 14.5, 4.2], [63, 17, 4], [70, 24, 3.6]]) };
    case "mohawk": return { front: H(u, "M31 42C30 36 31 33 33 31L34 40Z", 'opacity=".5"') + H(u, "M69 42C70 36 69 33 67 31L66 40Z", 'opacity=".5"') + `<path d="M43 30L41 15L45 9L50 3L55 9L59 15L57 30C54 26 46 26 43 30Z" fill="${c.hair}" /><path d="M43 30L41 15L45 9L50 3L55 9L59 15L57 30C54 26 46 26 43 30Z" fill="url(#${u}hg)"/>` };
    default: return {};
  }
}

// ───────── Visage ─────────
function eyeSvg(u, look, c, x, side) {
  const e = EYE[look.eyes] || EYE.almond, w = e.w * 1.1, h = e.h * 1.12;
  const top = `M${-w} 0Q0 ${-h * 1.75} ${w} 0`, shape = `${top}Q0 ${h * 1.5} ${-w} 0Z`;
  const rot = side < 0 ? e.t : -e.t, ir = h * 1.05;
  const lash = side < 0 ? `M${-w} 0L${-w - 1.5} ${-0.9}` : `M${w} 0L${w + 1.5} ${-0.9}`;
  return `<g transform="translate(${x} 49.2) rotate(${rot})"><clipPath id="${u}e${side < 0 ? "l" : "r"}"><path d="${shape}"/></clipPath>
    <path d="${shape}" fill="#f7f4ef"/>
    <g clip-path="url(#${u}e${side < 0 ? "l" : "r"})"><circle cx="0" cy="${-h * 0.05}" r="${ir}" fill="url(#${u}ir)"/><circle cx="0" cy="${-h * 0.05}" r="${ir * 0.48}" fill="#0b0a0d"/>
      <circle cx="${-ir * 0.34}" cy="${-ir * 0.4}" r="${ir * 0.3}" fill="#fff" opacity=".92"/><circle cx="${ir * 0.3}" cy="${ir * 0.3}" r="${ir * 0.14}" fill="#fff" opacity=".55"/>
      <path d="${top}" fill="none" stroke="#000" stroke-opacity=".28" stroke-width="2.4"/></g>
    <path d="${top}" fill="none" stroke="#17110f" stroke-width="1.15" stroke-linecap="round"/>
    <path d="M${-w + 0.5} ${-h * 1.2}Q0 ${-h * 2.5} ${w - 0.5} ${-h * 1.1}" fill="none" stroke="${dark(c.skin, 0.38)}" stroke-opacity=".5" stroke-width=".7" stroke-linecap="round"/>
    <path d="M${-w + 1.2} ${h * 0.9}Q0 ${h * 1.9} ${w - 1.2} ${h * 0.9}" fill="none" stroke="${dark(c.skin, 0.25)}" stroke-opacity=".16" stroke-width=".5"/></g>`;
}
function browSvg(look, c, x, side) {
  const [d, sw] = BROW[look.brows] || BROW.straight;
  const col = mix(c.hair, "#1a1210", 0.25);
  return `<g transform="translate(${x} 41.6) scale(${side < 0 ? 1 : -1} 1)"><path d="${d}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity=".92"/></g>`;
}
function noseSvg(look, c) {
  const s = dark(c.skin, 0.34), hl = light(c.skin, 0.5);
  const line = (d, w = 0.9, o = 0.75) => `<path d="${d}" fill="none" stroke="${s}" stroke-width="${w}" stroke-opacity="${o}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const dot = (x, y, r = 0.9) => `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 0.7}" fill="${dark(c.skin, 0.5)}" opacity=".6"/>`;
  const tip = (y, r = 2) => `<ellipse cx="50" cy="${y}" rx="${r}" ry="${r * 0.7}" fill="${hl}" opacity=".32"/>`;
  switch (look.nose) {
    case "button": return line("M47.4 57.4Q50 61 52.6 57.4") + dot(48.4, 58.2) + dot(51.6, 58.2) + tip(56.6, 2.2);
    case "straight": return line("M48.6 47.5Q48.2 54 47.6 57Q50 60 52.4 57Q51.8 54 51.4 47.5", 0.7, 0.45) + line("M47.6 57.6Q50 60 52.4 57.6") + dot(48.5, 58.4) + dot(51.5, 58.4) + tip(56, 1.6);
    case "wide": return line("M45.6 56.6Q46.4 60 50 60.4Q53.6 60 54.4 56.6") + line("M46.2 57Q45.6 58.6 47 59.4M53.8 57Q54.4 58.6 53 59.4", 0.7) + dot(48, 58.8, 1.1) + dot(52, 58.8, 1.1) + tip(56.4, 2.6);
    case "pointed": return line("M50 49L47.4 58.4Q50 60.4 52.6 58.4Z", 0.8, 0.55) + line("M47.6 58.2Q50 60 52.4 58.2") + dot(48.6, 58.6, 0.8) + dot(51.4, 58.6, 0.8) + tip(55.4, 1.3);
    case "round": return line("M46.6 56Q46.2 60.4 50 60.6Q53.8 60.4 53.4 56") + line("M47 58.2Q50 61.4 53 58.2", 0.7) + dot(48.4, 59) + dot(51.6, 59) + tip(56.4, 3);
    default: return line("M48.6 57.2Q50 59 51.4 57.2", 0.9, 0.8) + dot(49, 58.2, 0.7) + dot(51, 58.2, 0.7) + tip(56.6, 1.5);
  }
}
function mouthSvg(look, c) {
  const lip = c.lips || mix(c.skin, "#b3414d", 0.5), lipD = dark(lip, 0.32), lipL = light(lip, 0.22);
  const line = (d, w = 1.1) => `<path d="${d}" fill="none" stroke="${lipD}" stroke-width="${w}" stroke-linecap="round"/>`;
  const shine = `<ellipse cx="50" cy="66.6" rx="2.4" ry=".7" fill="#fff" opacity=".28"/>`;
  switch (look.mouth) {
    case "grin": return `<path d="M42.5 63.6Q50 73 57.5 63.6Z" fill="#fbfbf8" stroke="${lipD}" stroke-width="1.1" stroke-linejoin="round"/><path d="M44.5 66.4Q50 68.8 55.5 66.4" stroke="#d8d3cb" stroke-width=".5" fill="none"/><path d="M42.5 63.6Q50 65 57.5 63.6" stroke="${lip}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
    case "laugh": return `<path d="M43 63.8Q50 76 57 63.8Z" fill="#59202a"/><path d="M43.6 64.2Q50 66 56.4 64.2L56 66Q50 67.4 44 66Z" fill="#fbfbf8"/><ellipse cx="50" cy="70.4" rx="3.6" ry="2" fill="#d8667a"/><path d="M43 63.8Q50 65.2 57 63.8" stroke="${lip}" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M43 63.8Q50 76 57 63.8" stroke="${lipD}" stroke-width=".9" fill="none"/>`;
    case "neutral": return `<path d="M44.8 65.4Q50 64 55.2 65.4Q50 68 44.8 65.4Z" fill="${lip}"/>` + line("M44.6 65.4H55.4") + shine;
    case "smirk": return `<path d="M44.6 65.8Q50 66.6 55.8 63.8Q50 69 44.6 65.8Z" fill="${lip}"/>` + line("M44.4 65.8Q50 66.6 56 63.6") ;
    case "pout": return `<ellipse cx="50" cy="65.8" rx="4.2" ry="2.8" fill="${lip}"/><path d="M45.8 65.6Q50 64.6 54.2 65.6" stroke="${lipD}" stroke-width=".9" fill="none"/><ellipse cx="49" cy="66.6" rx="1.6" ry=".6" fill="#fff" opacity=".35"/>`;
    case "soft": return line("M45 65Q50 68.2 55 65", 1.3) + `<path d="M46 65.4Q50 67.4 54 65.4" stroke="${lip}" stroke-width="1.2" fill="none" stroke-linecap="round" opacity=".7"/>`;
    case "oh": return `<ellipse cx="50" cy="66" rx="3" ry="3.7" fill="#59202a" stroke="${lip}" stroke-width="1.6"/><ellipse cx="50" cy="67.6" rx="1.6" ry="1" fill="#d8667a"/>`;
    default: return `<path d="M43.8 64.2Q47 62.8 50 63.8Q53 62.8 56.2 64.2Q50 70.6 43.8 64.2Z" fill="${lip}"/><path d="M43.8 64.2Q50 67.4 56.2 64.2" fill="none" stroke="${lipD}" stroke-width="1.05" stroke-linecap="round"/><path d="M46 66.8Q50 69 54 66.8" fill="${lipL}" opacity=".4" stroke="none"/>` + shine;
  }
}
function beardSvg(u, look, c, f) {
  const hc = c.hair, st = look.beard;
  if (st === "none") return "";
  const fp = facePath(f);
  const edge = {
    stubble: `M${50 - f.w - 3} 47Q${50 - f.w + 1} 56 ${50 - 11} 58.5Q50 56.5 ${50 + 11} 58.5Q${50 + f.w - 1} 56 ${50 + f.w + 3} 47L${50 + f.w + 3} 90L${50 - f.w - 3} 90Z`,
    short: `M${50 - f.w - 3} 47Q${50 - f.w + 2} 58 ${50 - 10} 61Q50 58.4 ${50 + 10} 61Q${50 + f.w - 2} 58 ${50 + f.w + 3} 47L${50 + f.w + 3} 90L${50 - f.w - 3} 90Z`,
    full: `M${50 - f.w - 3} 46Q${50 - f.w + 3} 53 ${50 - 9} 59.5Q50 57.4 ${50 + 9} 59.5Q${50 + f.w - 3} 53 ${50 + f.w + 3} 46L${50 + f.w + 3} 92L${50 - f.w - 3} 92Z`,
    goatee: `M${50 - 8} 64Q50 62 ${50 + 8} 64L${50 + 8} 90L${50 - 8} 90Z`,
  };
  const must = `<path d="M43 63.4Q46.4 60.2 50 62.2Q53.6 60.2 57 63.4Q53.6 63.6 50 63Q46.4 63.6 43 63.4Z" fill="url(#${u}hg)"/>`;
  const fill = (e, op = 1) => `<clipPath id="${u}bd"><path d="${e}"/></clipPath><g clip-path="url(#${u}bd)" opacity="${op}"><path d="${fp}" fill="url(#${u}hg)" stroke="${hc}" stroke-width="3.2" stroke-linejoin="round"/></g>`;
  switch (st) {
    case "stubble": return fill(edge.stubble, 0.28) + `<g clip-path="url(#${u}f)"><rect x="20" y="56" width="60" height="30" fill="url(#${u}st)" opacity=".75" clip-path="url(#${u}bd)"/></g>`;
    case "mustache": return must;
    case "goatee": return fill(edge.goatee) + must;
    case "short": return fill(edge.short) + must;
    case "full": return fill(edge.full) + `<path d="M43 63.2Q46.4 59.6 50 61.8Q53.6 59.6 57 63.2Q53.6 64 50 63.2Q46.4 64 43 63.2Z" fill="url(#${u}hg)"/>`;
    case "soulpatch": return `<ellipse cx="50" cy="70" rx="2.6" ry="2.2" fill="url(#${u}hg)"/>`;
    default: return "";
  }
}
function glassesSvg(u, look, c) {
  const col = c.acc, g = (inner) => `<g fill="none" stroke="${col}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
  const glare = (x, y) => `<path d="M${x - 3} ${y + 1}L${x + 0.5} ${y - 3}" stroke="#fff" stroke-width="1.1" stroke-opacity=".5" stroke-linecap="round"/>`;
  const L = 40.4, R = 59.6, Y = 49.4;
  const temples = `<path d="M${L - 7} ${Y - 1}L${L - 10} ${Y - 2}M${R + 7} ${Y - 1}L${R + 10} ${Y - 2}"/>`;
  switch (look.glasses) {
    case "round": return g(`<circle cx="${L}" cy="${Y}" r="6.8" fill="#bfe3ff" fill-opacity=".16"/><circle cx="${R}" cy="${Y}" r="6.8" fill="#bfe3ff" fill-opacity=".16"/><path d="M${L + 6.8} ${Y - 0.6}Q50 ${Y - 3} ${R - 6.8} ${Y - 0.6}"/>${temples}`) + glare(L, Y) + glare(R, Y);
    case "square": return g(`<rect x="${L - 7.2}" y="${Y - 5}" width="14.4" height="10.4" rx="2.4" fill="#bfe3ff" fill-opacity=".16"/><rect x="${R - 7.2}" y="${Y - 5}" width="14.4" height="10.4" rx="2.4" fill="#bfe3ff" fill-opacity=".16"/><path d="M${L + 7.2} ${Y - 1.4}H${R - 7.2}"/>${temples}`) + glare(L, Y) + glare(R, Y);
    case "aviator": return g(`<path d="M${L - 7} ${Y - 3.4}Q${L} ${Y - 5.6} ${L + 7} ${Y - 3.4}Q${L + 7.4} ${Y + 6.4} ${L} ${Y + 7}Q${L - 7.2} ${Y + 6} ${L - 7} ${Y - 3.4}Z" fill="${dark(col, 0.2)}" fill-opacity=".32"/><path d="M${R - 7} ${Y - 3.4}Q${R} ${Y - 5.6} ${R + 7} ${Y - 3.4}Q${R + 7.2} ${Y + 6} ${R} ${Y + 7}Q${R - 7.4} ${Y + 6.4} ${R - 7} ${Y - 3.4}Z" fill="${dark(col, 0.2)}" fill-opacity=".32"/><path d="M${L + 7} ${Y - 3.6}Q50 ${Y - 5.6} ${R - 7} ${Y - 3.6}"/>${temples}`) + glare(L, Y) + glare(R, Y);
    case "cat": return g(`<path d="M${L - 7.4} ${Y - 4.8}Q${L + 2} ${Y - 5.2} ${L + 7} ${Y - 2}Q${L + 6.4} ${Y + 5.8} ${L} ${Y + 5.6}Q${L - 7} ${Y + 5} ${L - 7.4} ${Y - 4.8}Z" fill="#bfe3ff" fill-opacity=".16"/><path d="M${R + 7.4} ${Y - 4.8}Q${R - 2} ${Y - 5.2} ${R - 7} ${Y - 2}Q${R - 6.4} ${Y + 5.8} ${R} ${Y + 5.6}Q${R + 7} ${Y + 5} ${R + 7.4} ${Y - 4.8}Z" fill="#bfe3ff" fill-opacity=".16"/><path d="M${L + 7} ${Y - 2}Q50 ${Y - 3.6} ${R - 7} ${Y - 2}"/><path d="M${L - 7.4} ${Y - 4.6}L${L - 10} ${Y - 5.6}M${R + 7.4} ${Y - 4.6}L${R + 10} ${Y - 5.6}"/>`);
    case "shades": return `<g stroke="${dark(col, 0.2)}" stroke-width="1.2"><rect x="${L - 7.6}" y="${Y - 4.6}" width="15.2" height="10.4" rx="4.4" fill="#11131a"/><rect x="${R - 7.6}" y="${Y - 4.6}" width="15.2" height="10.4" rx="4.4" fill="#11131a"/><path d="M${L + 7.6} ${Y - 1.2}H${R - 7.6}M${L - 7.6} ${Y - 1}L${L - 10} ${Y - 2}M${R + 7.6} ${Y - 1}L${R + 10} ${Y - 2}" fill="none"/></g><path d="M${L - 5} ${Y - 2.4}L${L - 1.4} ${Y - 3.6}M${R - 5} ${Y - 2.4}L${R - 1.4} ${Y - 3.6}" stroke="#fff" stroke-opacity=".42" stroke-width="1.2" stroke-linecap="round"/>`;
    default: return "";
  }
}
function earringSvg(look, f) {
  const gold = "#ffb020", xs = [50 - f.w - 0.8, 50 + f.w + 0.8];
  switch (look.earrings) {
    case "studs": return xs.map((x) => `<circle cx="${x}" cy="55.6" r="1.4" fill="${gold}" stroke="#b97a00" stroke-width=".4"/>`).join("");
    case "hoops": return xs.map((x) => `<circle cx="${x}" cy="59" r="3.1" fill="none" stroke="${gold}" stroke-width="1.1"/>`).join("");
    case "drops": return xs.map((x) => `<line x1="${x}" y1="55.6" x2="${x}" y2="59" stroke="${gold}" stroke-width=".7"/><circle cx="${x}" cy="60.4" r="1.8" fill="${gold}" stroke="#b97a00" stroke-width=".4"/>`).join("");
    default: return "";
  }
}
function headwearSvg(u, look, c) {
  const col = c.acc, g = `url(#${u}ac)`;
  switch (look.headwear) {
    case "cap": return `<path d="M29.6 41C28.6 24 39 17 50 17S71.4 24 70.4 41C61 36 39 36 29.6 41Z" fill="${g}"/><path d="M29.6 41C39 36 61 36 70.4 41" fill="none" stroke="${dark(col, 0.4)}" stroke-width="1"/><path d="M27.4 41.6C38 37.6 62 37.6 72.6 41.6C70 47.6 30 47.6 27.4 41.6Z" fill="${dark(col, 0.18)}"/><circle cx="50" cy="17.6" r="1.6" fill="${dark(col, 0.35)}"/><path d="M38 22Q50 16.4 61 22" fill="none" stroke="#fff" stroke-opacity=".2" stroke-width="1.4" stroke-linecap="round"/>`;
    case "beanie": return `<path d="M28.6 45C27 22 40 14.6 50 14.6S73 22 71.4 45Q50 40 28.6 45Z" fill="${g}"/><path d="M28.4 41.6Q50 36.4 71.6 41.6L71.4 46.6Q50 41.4 28.6 46.6Z" fill="${dark(col, 0.14)}"/>${[34, 40, 46, 52, 58, 64].map((x) => `<path d="M${x} ${40.6 + (x === 34 || x === 64 ? 1 : 0)}V${45.8}" stroke="${dark(col, 0.35)}" stroke-width=".7" opacity=".6"/>`).join("")}<circle cx="50" cy="13.6" r="3.6" fill="${light(col, 0.2)}"/>`;
    case "headband": return `<path d="M30 37.6Q50 28.4 70 37.6L70.2 41.8Q50 33 29.8 41.8Z" fill="${g}"/>`;
    case "headphones": return `<path d="M28.4 51C25 20 75 20 71.6 51" fill="none" stroke="${dark(col, 0.2)}" stroke-width="3.2" stroke-linecap="round"/><path d="M28.4 51C25 20 75 20 71.6 51" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="1" stroke-linecap="round" transform="translate(0 -.8)"/><rect x="23.4" y="46" width="7.2" height="14" rx="3.4" fill="${g}"/><rect x="69.4" y="46" width="7.2" height="14" rx="3.4" fill="${g}"/>`;
    case "scarf": return `<path fill-rule="evenodd" fill="${g}" d="M22 56C20 24 38 12 50 12S80 24 78 56C80 72 70 86 50 88S20 72 22 56ZM32.4 46C32.6 35 40 30.4 50 30.4S67.4 35 67.6 46C68.4 58 66 66 60 71.4C56.4 74.4 43.6 74.4 40 71.4C34 66 31.6 58 32.4 46Z"/><path d="M33 45C33.6 35 40.4 31.2 50 31.2" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="1.2"/><path d="M33 40C27 26 35 17 46 15M67 40C73 26 65 17 54 15" fill="none" stroke="${dark(col, 0.3)}" stroke-opacity=".5" stroke-width=".8"/>`;
    case "crown": return `<path d="M31.6 31L34 11.6L43 22.4L50 8.6L57 22.4L66 11.6L68.4 31Q50 27.4 31.6 31Z" fill="#ffc83a" stroke="#c98a00" stroke-width="1.2" stroke-linejoin="round"/><circle cx="50" cy="26.4" r="1.7" fill="#ff5d6c"/><circle cx="40" cy="27.4" r="1.2" fill="#3b82f6"/><circle cx="60" cy="27.4" r="1.2" fill="#22b57a"/><path d="M36 25Q50 21.6 64 25" stroke="#fff" stroke-opacity=".45" fill="none" stroke-width="1"/>`;
    case "gradcap": return `<path d="M33 24V35C33 40 67 40 67 35V24Z" fill="${dark(col, 0.2)}"/><path d="M50 9L83 22L50 35L17 22Z" fill="${g}"/><path d="M50 9L83 22L50 35" fill="none" stroke="#fff" stroke-opacity=".16"/><circle cx="50" cy="22" r="1.5" fill="#ffc83a"/><path d="M50 22L76 26.6V40" fill="none" stroke="#ffc83a" stroke-width="1.2"/><rect x="74.6" y="38.6" width="2.8" height="7" rx="1.2" fill="#ffc83a"/>`;
    default: return "";
  }
}

// ───────── Corps et tenue ─────────
const TORSO = "M9 100C9 86 20 79 34 76.4C40 75.4 44 75 50 75S60 75.4 66 76.4C80 79 91 86 91 100Z";
function outfitSvg(u, look, c) {
  const col = c.outfit, g = `fill="url(#${u}ou)"`, dk = dark(col, 0.3), lt = light(col, 0.3);
  const shirt = "#f5f6fa";
  const body = `<path d="${TORSO}" ${g}/><path d="M9 100C9 86 20 79 34 76.4" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="1"/>`;
  switch (look.outfit) {
    case "hoodie": return { pre: `<path d="M26 70C28 56 38 52 50 52S72 56 74 70L78 88L22 88Z" fill="${dark(col, 0.2)}"/>`, body, post: `<path d="M38 76C42 86 46 90 47 99M62 76C58 86 54 90 53 99" stroke="${light(col, 0.5)}" stroke-width="1.2" fill="none" stroke-linecap="round"/><path d="M36 76.4C42 80 46 82 50 82S58 80 64 76.4" fill="none" stroke="${dk}" stroke-width="1.2"/>`, neck: "M42.6 66.6V77Q50 82.6 57.4 77V66.6Z" };
    case "polo": return { body, post: `<path d="M41 76L45 82L50 78L55 82L59 76L56 74L50 77L44 74Z" fill="${lt}" stroke="${dk}" stroke-width=".6"/><path d="M50 78V90" stroke="${dk}" stroke-width=".8"/><circle cx="50" cy="82" r=".9" fill="${dk}"/><circle cx="50" cy="86" r=".9" fill="${dk}"/>`, neck: "M42.6 66.6V76L50 79.6L57.4 76V66.6Z" };
    case "shirt": return { body: `<path d="${TORSO}" fill="${shirt}"/><path d="${TORSO}" fill="url(#${u}ou)" opacity=".16"/>`, post: `<path d="M50 80V100" stroke="#b9bdca" stroke-width=".8"/>${[84, 90, 96].map((y) => `<circle cx="50" cy="${y}" r=".9" fill="#aab0bf"/>`).join("")}<path d="M40.6 75.4L44.4 84L50 79L55.6 84L59.4 75.4L55 73.6L50 78L45 73.6Z" fill="#fff" stroke="#b9bdca" stroke-width=".7" stroke-linejoin="round"/>`, neck: "M42.6 66.6V76L50 80L57.4 76V66.6Z" };
    case "blazer": return { body, post: `<path d="M41 76L50 100L59 76L50 79Z" fill="${shirt}"/><path d="M36.6 76.4L45 100L50 80L40 74.6Z" fill="${dk}"/><path d="M63.4 76.4L55 100L50 80L60 74.6Z" fill="${dk}"/><path d="M36.6 76.4L46 91M63.4 76.4L54 91" stroke="${lt}" stroke-opacity=".5" stroke-width=".7"/>`, neck: "M42.6 66.6V76L50 80L57.4 76V66.6Z" };
    case "suit": return { body: `<path d="${TORSO}" fill="${dark(c.acc, 0.1)}"/><path d="${TORSO}" fill="url(#${u}ou)" opacity=".4"/>`, post: `<path d="M41 76L50 100L59 76L50 79Z" fill="${shirt}"/><path d="M36.6 76.4L45 100L50 80L40 74.6Z" fill="${dark(c.acc, 0.35)}"/><path d="M63.4 76.4L55 100L50 80L60 74.6Z" fill="${dark(c.acc, 0.35)}"/><path d="M47.6 79.4L52.4 79.4L51.4 83L52.6 98L50 101L47.4 98L48.6 83Z" fill="${col}"/><path d="M47.6 79.4L52.4 79.4L51 82.2L49 82.2Z" fill="${dark(col, 0.3)}"/>`, neck: "M42.6 66.6V76L50 80L57.4 76V66.6Z" };
    case "blouse": return { body: `<path d="${TORSO}" fill="#f7f8fc"/><path d="${TORSO}" fill="url(#${u}ou)" opacity=".12"/>`, post: `<path d="M40 74.6L46 100H34Z" fill="#fff" stroke="#c9cdd8" stroke-width=".7"/><path d="M60 74.6L54 100H66Z" fill="#fff" stroke="#c9cdd8" stroke-width=".7"/><path d="M43 76.4Q50 84 57 76.4L57 100H43Z" fill="${col === "#f4f6ff" ? "#8fb7e8" : col}" opacity=".85"/><path d="M71 86h7v5h-7z" fill="none" stroke="#c9cdd8" stroke-width=".7"/>`, neck: "M42.6 66.6V76L50 80.4L57.4 76V66.6Z" };
    case "vneck": return { body, post: `<path d="M40.6 75.4L50 90L59.4 75.4" fill="none" stroke="${dk}" stroke-width="1.4" stroke-linejoin="round"/>`, neck: "M42.6 66.6V75.6L50 89L57.4 75.6V66.6Z" };
    case "turtle": return { body, post: `<path d="M41 62.6C41 70 42 74 44 76Q50 79 56 76C58 74 59 70 59 62.6Z" fill="${lt}" stroke="${dk}" stroke-width=".8"/>${[66, 69.6, 73].map((y) => `<path d="M41.4 ${y}Q50 ${y + 1.8} 58.6 ${y}" fill="none" stroke="${dk}" stroke-width=".6" opacity=".6"/>`).join("")}`, neck: "" };
    case "jersey": return { body, post: `<path d="M9 100C9 90 14 84 22 80L26 100Z" fill="${c.acc}" opacity=".9"/><path d="M91 100C91 90 86 84 78 80L74 100Z" fill="${c.acc}" opacity=".9"/><path d="M40 75.6Q50 83 60 75.6" fill="none" stroke="${c.acc}" stroke-width="2.4" stroke-linecap="round"/><text x="50" y="96" font-size="11" font-weight="800" text-anchor="middle" fill="#fff" fill-opacity=".85" font-family="system-ui,sans-serif">10</text>`, neck: "M42.6 66.6V76.4Q50 82.6 57.4 76.4V66.6Z" };
    default: return { body, post: `<path d="M40.6 75.4Q50 83 59.4 75.4" fill="none" stroke="${dk}" stroke-width="1.2" opacity=".8"/>`, neck: "M42.6 66.6V76Q50 82.4 57.4 76V66.6Z" };
  }
}

// ───────── Assemblage ─────────
const FRECK = [[43.5, 55.4], [46, 56.6], [41.6, 57.4], [56.5, 55.4], [54, 56.6], [58.4, 57.4], [44.6, 58.6], [55.4, 58.6], [50, 54.8], [39.4, 55.6], [60.6, 55.6], [47.4, 54.6], [52.6, 54.6], [42.4, 59.4], [57.6, 59.4], [50, 57.8]];

export function avatarSvgString(avatar, catalog, opts = {}) {
  const u = opts.uid || "a" + Math.random().toString(36).slice(2, 8);
  const { look, colors: c, custom, frame } = resolveLook(avatar, catalog);
  const f = FACE[look.face] || FACE.oval;
  const g = { face: facePath(f) };
  let hairStyle = look.hair;
  const hw = look.headwear;
  const volume = ["quiff", "afro", "topknot", "bun", "mohawk", "spiky", "curly", "ponytail"];
  if ((hw === "cap" || hw === "gradcap" || hw === "crown" || hw === "headphones" || hw === "headband") && volume.includes(hairStyle)) hairStyle = hw === "crown" || hw === "headband" ? hairStyle : "short";
  const hideHair = hw === "beanie" || hw === "scarf";
  const hp = hideHair ? {} : hairParts(hairStyle, u, c);
  const o = outfitSvg(u, look, c);
  const img = (cat) => custom[cat] ? `<image href="${custom[cat].replace(/"/g, "")}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid slice"/>` : "";
  const ear = (side) => { const x = 50 + side * (f.w + 0.2); return `<ellipse cx="${x}" cy="53" rx="3.6" ry="5.6" fill="${c.skin}"/><ellipse cx="${x + side * 0.5}" cy="53.4" rx="1.7" ry="3.2" fill="${dark(c.skin, 0.28)}" opacity=".55"/>`; };
  const cheeks = look.blush === "soft" ? `<ellipse cx="36" cy="58" rx="6" ry="4" fill="url(#${u}bl)"/><ellipse cx="64" cy="58" rx="6" ry="4" fill="url(#${u}bl)"/>` : "";
  const fr = look.freckles === "none" ? "" : FRECK.slice(0, look.freckles === "light" ? 8 : 16).map(([x, y]) => `<circle cx="${x}" cy="${y}" r=".5" fill="${dark(c.skin, 0.42)}" opacity=".55"/>`).join("");
  const mole = look.mark === "mole" ? `<circle cx="57.4" cy="62" r=".8" fill="#2b1a10" opacity=".85"/>` : "";
  const scale = opts.view ? "" : "";
  const vb = opts.view ? opts.view.join(" ") : "0 0 100 100";
  const body = `
  <g class="z0">${background(u, look, c)}${img("background")}</g>
  <g class="z1">${hp.back || ""}${o.pre || ""}${o.body}${o.neck ? `<path d="${o.neck}" fill="${c.skin}"/><path d="${o.neck}" fill="url(#${u}nk)"/>` : ""}${o.post || ""}${hp.mid || ""}</g>
  <g class="z2">${ear(-1)}${ear(1)}<path d="${g.face}" fill="url(#${u}sk)"/>
    <g clip-path="url(#${u}f)"><path d="${g.face}" fill="url(#${u}sh)"/><rect x="0" y="20" width="100" height="20" fill="url(#${u}ft)" opacity="${hairStyle === "bald" || hideHair ? 0.1 : 0.9}"/><path d="${g.face}" fill="url(#${u}hl)"/>
      </g>
    ${cheeks}${fr}${mole}
    ${browSvg(look, c, 40.2, -1)}${browSvg(look, c, 59.8, 1)}${eyeSvg(u, look, c, 40.2, -1)}${eyeSvg(u, look, c, 59.8, 1)}${noseSvg(look, c)}${beardSvg(u, look, c, f)}${mouthSvg(look, c)}${earringSvg(look, f)}${glassesSvg(u, look, c)}
  </g>
  <g class="z3">${hp.front || ""}${headwearSvg(u, look, c)}${img("hair")}${img("outfit")}${img("face")}${img("glasses")}${img("hat")}</g>`;
  const ring = opts.noFrame ? "" : (frame ? `<circle cx="50" cy="50" r="47" fill="none" stroke="${frame}" stroke-width="4"/>` : "") + img("frame");
  return `<svg xmlns="${NS}" viewBox="${vb}" role="img" aria-label="Avatar">${defsFor(u, c, g)}<g clip-path="url(#${u}c)">${body}</g>${ring}</svg>`;
}

export function drawAvatar(avatar, catalog, size = 48, opts = {}) {
  const t = document.createElement("template");
  t.innerHTML = avatarSvgString(avatar, catalog, opts).trim();
  const node = t.content.firstChild;
  node.classList.add("avatar");
  node.setAttribute("width", size);
  node.setAttribute("height", size);
  return node;
}

/** Avatar aléatoire (bouton « Surprise » de l'éditeur). Ne choisit que des objets libres : `free(key, id)` filtre le reste. */
export function randomLook(free = () => true) {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const look = {};
  for (const k of Object.keys(DEFAULTS)) {
    const ids = OPTIONS[k].map(([id]) => id).filter((id) => free(k, id));
    if (ids.length) look[k] = pick(ids);
  }
  if (look.beard && Math.random() < 0.6) look.beard = "none";
  if (look.headwear && Math.random() < 0.65) look.headwear = "none";
  if (look.glasses && Math.random() < 0.55) look.glasses = "none";
  if (look.earrings && Math.random() < 0.6) look.earrings = "none";
  const colors = { skin: pick(PALETTES.skin), hair: pick(PALETTES.hair.slice(0, 12)), eyes: pick(PALETTES.eyes), outfit: pick(PALETTES.outfit), acc: pick(PALETTES.acc) };
  const [bga, bgb] = pick(PALETTES.bg);
  return { look, colors: { ...colors, bga, bgb } };
}
