import { createHash } from "node:crypto";

/**
 * Ordre d'affichage des choix : `order[i]` = position d'origine du choix affiché en i-ème position.
 * Déterministe (même question + même joueur = même ordre, même après un rechargement) et sans stockage.
 * Il ne révèle rien : l'ordre est indépendant de la bonne réponse.
 */
export function choiceOrder(gameQuestionId: string, userId: string, count: number, enabled: boolean): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  if (!enabled || count < 2) return order;
  const bytes = createHash("sha256").update(`${gameQuestionId}:${userId}`).digest();
  for (let i = count - 1; i > 0; i--) {
    const j = bytes[i % bytes.length] % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** Choix dans l'ordre d'affichage. */
export const displayChoices = <T>(choices: readonly T[], order: readonly number[]): T[] => order.map((o) => choices[o]);

/** Position affichée → position d'origine. */
export const toOriginal = (order: readonly number[], displayed: number): number => order[displayed];

/** Position d'origine → position affichée (null reste null). */
export const toDisplayed = (order: readonly number[], original: number | null): number | null => (original === null ? null : order.indexOf(original));
