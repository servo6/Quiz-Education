import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Validation d'un bloc de questions collé par l'administrateur.
 *
 * Format attendu : un tableau JSON (ou un objet { "questions": [...] }) :
 * [
 *   { "question": "...", "choices": ["A", "B", "C", "D"], "answer": 1, "explanation": "..." }
 * ]
 *
 * - "answer" = position de la bonne réponse dans "choices", en partant de 0.
 * - "explanation" est optionnel. Aucun autre champ n'est accepté.
 * - Chaque question est validée séparément : les questions valides peuvent être importées
 *   même si d'autres contiennent des erreurs.
 */

export const LIMITS = {
  maxQuestionsPerImport: 5000,
  questionMaxLength: 1000,
  choiceMaxLength: 300,
  explanationMaxLength: 2000,
  minChoices: 2,
  maxChoices: 6,
} as const;

const ALLOWED_KEYS = new Set(["question", "choices", "answer", "explanation"]);

/** Nettoie les espaces et normalise l'Unicode (évite de faux doublons). */
export const normalize = (s: string): string => s.normalize("NFC").replace(/\s+/g, " ").trim();

const text = (label: string, max: number) =>
  z
    .string({
      required_error: `${label} manquant`,
      invalid_type_error: `${label} doit être un texte entre guillemets`,
    })
    .transform(normalize)
    .pipe(
      z
        .string()
        .min(1, `${label} est vide`)
        .max(max, `${label} trop long (maximum ${max} caractères)`),
    );

export const QuestionSchema = z
  .object({
    question: text("question", LIMITS.questionMaxLength),
    choices: z
      .array(text("un choix", LIMITS.choiceMaxLength), {
        required_error: "choices manquant",
        invalid_type_error: "choices doit être une liste de textes, ex. [\"A\", \"B\", \"C\"]",
      })
      .min(LIMITS.minChoices, `il faut au moins ${LIMITS.minChoices} choix`)
      .max(LIMITS.maxChoices, `il y a trop de choix (maximum ${LIMITS.maxChoices})`),
    answer: z
      .number({
        required_error: "answer manquant",
        invalid_type_error: "answer doit être un nombre (position de la bonne réponse, en partant de 0)",
      })
      .int("answer doit être un nombre entier")
      .min(0, "answer ne peut pas être négatif"),
    explanation: z
      .string({ invalid_type_error: "explanation doit être un texte" })
      .transform(normalize)
      .pipe(z.string().max(LIMITS.explanationMaxLength, `explanation trop long (maximum ${LIMITS.explanationMaxLength} caractères)`))
      .optional(),
  })
  .superRefine((q, ctx) => {
    if (q.answer >= q.choices.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answer"],
        message: `answer vaut ${q.answer} mais il n'y a que ${q.choices.length} choix (positions valides : 0 à ${q.choices.length - 1})`,
      });
    }
    const seen = new Set<string>();
    for (const c of q.choices) {
      const key = c.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["choices"],
          message: `le choix « ${c} » apparaît plusieurs fois`,
        });
        break;
      }
      seen.add(key);
    }
  });

export interface ValidQuestion {
  /** Position dans le bloc collé, en partant de 1 (pour les messages). */
  index: number;
  question: string;
  choices: string[];
  answer: number;
  explanation?: string;
  /** Empreinte du texte de la question (insensible à la casse et aux espaces). */
  hash: string;
}

export interface ImportReport {
  /** Erreur bloquante : rien n'a pu être lu (JSON invalide, bloc vide, trop de questions...). */
  fatalError?: string;
  /** Nombre de questions trouvées dans le bloc. */
  total: number;
  /** Questions valides et non dupliquées, prêtes à être importées. */
  valid: ValidQuestion[];
  /** Questions invalides, avec la liste des problèmes. */
  errors: { index: number; messages: string[] }[];
  /** Questions ignorées car déjà présentes. */
  duplicates: { index: number; reason: "in-batch" | "in-database"; sameAs?: number }[];
}

export interface ValidateOptions {
  /** Empreintes des questions déjà présentes (non supprimées) dans le chapitre cible. */
  existingHashes?: ReadonlySet<string>;
  maxQuestions?: number;
}

export function hashQuestion(questionText: string): string {
  return createHash("sha256").update(normalize(questionText).toLowerCase()).digest("hex");
}

function stripCodeFence(raw: string): string {
  let s = raw.replace(/^\uFEFF/, "").trim();
  const fenced = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  if (fenced) s = fenced[1].trim();
  return s;
}

function describeJsonError(source: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let location = "";
  const lineCol = message.match(/line (\d+) column (\d+)/);
  const position = message.match(/position (\d+)/);
  if (lineCol) {
    location = ` (ligne ${lineCol[1]}, colonne ${lineCol[2]})`;
  } else if (position) {
    const before = source.slice(0, Number(position[1]));
    const line = before.split("\n").length;
    const col = before.length - before.lastIndexOf("\n");
    location = ` (ligne ${line}, colonne ${col})`;
  }
  const hint = /[“”‘’«»]/.test(source)
    ? " Astuce : des guillemets typographiques (“ ” ‘ ’ « ») ont été détectés ; le JSON n'accepte que les guillemets droits \"."
    : " Vérifie les virgules, les crochets [ ] et les guillemets \".";
  return `Le bloc n'est pas un JSON valide${location}.${hint}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function validateImport(raw: string, options: ValidateOptions = {}): ImportReport {
  const maxQuestions = options.maxQuestions ?? LIMITS.maxQuestionsPerImport;
  const fail = (fatalError: string, total = 0): ImportReport => ({
    fatalError,
    total,
    valid: [],
    errors: [],
    duplicates: [],
  });

  const source = stripCodeFence(raw);
  if (!source) return fail("Le bloc est vide.");

  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (e) {
    return fail(describeJsonError(source, e));
  }

  if (isRecord(data) && Array.isArray(data.questions)) data = data.questions;
  if (!Array.isArray(data)) {
    return fail('Le bloc doit être une liste de questions : [ { ... }, { ... } ] (ou { "questions": [ ... ] }).');
  }
  if (data.length === 0) return fail("La liste de questions est vide.");
  if (data.length > maxQuestions) {
    return fail(
      `Trop de questions d'un coup : ${data.length} (maximum ${maxQuestions} par import). Découpe le bloc en plusieurs imports.`,
      data.length,
    );
  }

  const report: ImportReport = { total: data.length, valid: [], errors: [], duplicates: [] };
  const firstSeen = new Map<string, number>();

  data.forEach((item, i) => {
    const index = i + 1;

    if (!isRecord(item)) {
      report.errors.push({ index, messages: ["cet élément doit être un objet { \"question\": ..., \"choices\": ..., \"answer\": ... }"] });
      return;
    }

    const messages: string[] = Object.keys(item)
      .filter((k) => !ALLOWED_KEYS.has(k))
      .map((k) => `champ inconnu « ${k} » (champs autorisés : question, choices, answer, explanation)`);

    const parsed = QuestionSchema.safeParse(item);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) messages.push(issue.message);
    }
    if (!parsed.success || messages.length > 0) {
      report.errors.push({ index, messages });
      return;
    }

    const q = parsed.data;
    const hash = hashQuestion(q.question);

    if (options.existingHashes?.has(hash)) {
      report.duplicates.push({ index, reason: "in-database" });
      return;
    }
    const earlier = firstSeen.get(hash);
    if (earlier !== undefined) {
      report.duplicates.push({ index, reason: "in-batch", sameAs: earlier });
      return;
    }
    firstSeen.set(hash, index);

    report.valid.push({
      index,
      question: q.question,
      choices: q.choices,
      answer: q.answer,
      ...(q.explanation ? { explanation: q.explanation } : {}),
      hash,
    });
  });

  return report;
}
