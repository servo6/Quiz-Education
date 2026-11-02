import type { PrismaClient } from "@prisma/client";
import { invalidateSettings, loadEffectiveSettings } from "./settingsStore.ts";

/** Ce que le solo garde en mémoire sur une partie (voir routes/solo.ts) ; vidé quand un réglage change. */
export const runningGameListeners: Array<() => void> = [];

/**
 * Le temps par question s'applique tout de suite, y compris aux parties déjà en cours : sinon un administrateur qui
 * met « 0 = illimité » ne verrait aucun effet sur la partie qu'il vient de rouvrir. Les autres réglages restent figés
 * au lancement (une partie ne change pas de nombre de questions en route).
 * `subjectId` = null : réglage global, toutes les matières sont concernées.
 */
export async function applyTimeToRunningGames(prisma: PrismaClient, subjectId: string | null): Promise<number> {
  invalidateSettings();
  const games = await prisma.game.findMany({
    where: { status: "IN_PROGRESS", mode: { in: ["SOLO", "DUEL"] }, ...(subjectId ? { subjectId } : {}) },
    select: { id: true, config: true, subjectId: true, subject: { select: { settings: true, organizationId: true } } },
  });
  const perSubject = new Map<string, number>();
  let n = 0;
  for (const g of games) {
    let t = perSubject.get(g.subjectId);
    if (t === undefined) {
      t = (await loadEffectiveSettings(prisma, g.subject.settings, g.subject.organizationId)).timePerQuestionSec;
      perSubject.set(g.subjectId, t);
    }
    try {
      const cfg = JSON.parse(g.config) as Record<string, unknown>;
      if (cfg.timePerQuestionSec === t) continue;
      cfg.timePerQuestionSec = t;
      await prisma.game.update({ where: { id: g.id }, data: { config: JSON.stringify(cfg) } });
      n++;
    } catch {
      /* configuration illisible : on n'y touche pas */
    }
  }
  for (const f of runningGameListeners) f();
  return n;
}
