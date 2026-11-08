// Partage d'un résultat sous forme d'image (1080 × 1350) : score, matière, contexte et lien d'installation.
import { h, toast } from "./lib.js";
import { shareUrl } from "./views/appShare.js";

const W = 1080, H = 1350;

function wrap(ctx, text, maxW, maxLines) {
  const words = String(text).split(/\s+/); const lines = []; let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "…"); }
  return lines;
}

/** Dessine la carte et renvoie un Blob PNG. `d` = { kind, title, big, sub, chips[], footer }. */
export async function renderResultImage(d) {
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#1b1f3b"); g.addColorStop(0.55, "#2c3170"); g.addColorStop(1, "#5a4fcf");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // Motif discret : cercles
  ctx.globalAlpha = 0.08; ctx.fillStyle = "#fff";
  for (const [x, y, r] of [[950, 160, 260], [120, 1180, 320], [880, 1100, 150]]) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;

  const font = (w, s) => `${w} ${s}px system-ui, -apple-system, "Segoe UI", Roboto, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = "center"; ctx.fillStyle = "#c9ccff";
  ctx.font = font(600, 44); ctx.fillText(d.kind, W / 2, 170);
  ctx.fillStyle = "#fff"; ctx.font = font(800, 64);
  let y = 270;
  for (const line of wrap(ctx, d.title, W - 160, 2)) { ctx.fillText(line, W / 2, y); y += 78; }

  // Score
  ctx.fillStyle = "#fff"; ctx.font = font(900, 250);
  ctx.fillText(d.big, W / 2, 720);
  if (d.sub) { ctx.fillStyle = "#c9ccff"; ctx.font = font(600, 52); ctx.fillText(d.sub, W / 2, 800); }

  // Pastilles
  const chips = (d.chips ?? []).slice(0, 3);
  ctx.font = font(700, 44);
  const widths = chips.map((t) => ctx.measureText(t).width + 70);
  const total = widths.reduce((a, b) => a + b, 0) + 24 * (chips.length - 1);
  let x = (W - total) / 2;
  chips.forEach((t, i) => {
    ctx.fillStyle = "rgba(255,255,255,.16)"; ctx.beginPath(); ctx.roundRect(x, 880, widths[i], 90, 45); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.fillText(t, x + widths[i] / 2, 940);
    x += widths[i] + 24;
  });

  // Pied : invitation
  ctx.fillStyle = "rgba(255,255,255,.12)"; ctx.fillRect(0, 1110, W, 240);
  ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.font = font(800, 56);
  ctx.fillText(d.footer ?? "Rejoins-moi sur Quiz !", W / 2, 1200);
  ctx.fillStyle = "#c9ccff"; ctx.font = font(600, 40);
  ctx.fillText(shareUrl().replace(/^https?:\/\//, ""), W / 2, 1268);

  return new Promise((res) => c.toBlob(res, "image/png"));
}

/** Partage l'image via le menu du téléphone ; sinon la propose en téléchargement. */
export async function shareResult(d) {
  let blob;
  try { blob = await renderResultImage(d); } catch { return toast("Impossible de créer l'image", "bad"); }
  const file = new File([blob], "mon-resultat-quiz.png", { type: "image/png" });
  const text = `${d.title} : ${d.big}${d.sub ? " " + d.sub : ""}. Rejoins-moi sur Quiz : ${shareUrl()}`;
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text, title: "Quiz" }); return; }
    catch (e) { if (e?.name === "AbortError") return; }
  }
  const a = h("a", { href: URL.createObjectURL(blob), download: "mon-resultat-quiz.png" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast("Image enregistrée : envoie-la à tes amis", "good");
}

export const shareButton = (d) => h("button.btn.ghost.grow", { type: "button", onclick: () => shareResult(typeof d === "function" ? d() : d) }, "Partager mon score");
