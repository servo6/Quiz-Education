import type { FastifyInstance } from "fastify";
import type { Chapter, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { loadSubject } from "../access.ts";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { parseMultiChapter, randomChapterColors, validateImport, type ImportReport } from "../import/validate.ts";
import { assertCan } from "../permissions.ts";
import { chapterColor, chapterName } from "./chapters.ts";

const ImportBody = z
  .object({
    raw: z.string().min(1, "Le bloc de questions est vide"),
    /** Chapitre existant... */
    chapterId: z.string().min(1).optional(),
    /** ...ou nom d'un chapitre à créer (ou réutiliser s'il existe déjà). */
    newChapterName: chapterName.optional(),
    /** Réglages d'un chapitre créé par cet import. */
    newChapterColor: chapterColor.optional(),
    newChapterLocked: z.boolean().optional(),
    /** "partial" : importe les questions valides ; "all_or_nothing" : refuse tout s'il y a une erreur. */
    mode: z.enum(["partial", "all_or_nothing"]).default("partial"),
  })
  .refine((b) => (b.chapterId === undefined) !== (b.newChapterName === undefined) || parseMultiChapter(b.raw).kind !== "single", {
    message: "Indique soit chapterId (chapitre existant), soit newChapterName (nouveau chapitre)",
  });

type ImportBodyT = z.infer<typeof ImportBody>;

const CHUNK = 500; // 500 lignes × 8 colonnes : sous la limite de paramètres de PostgreSQL (65 535)
const REPORT_LIMIT = 100;

interface Target {
  /** Chapitre actif existant, sinon null (à créer ou à réactiver au moment de l'import). */
  chapter: Chapter | null;
  name: string;
}

async function resolveTarget(prisma: PrismaClient, subjectId: string, body: ImportBodyT): Promise<Target> {
  if (body.chapterId !== undefined) {
    const chapter = await prisma.chapter.findUnique({ where: { id: body.chapterId } });
    if (!chapter || chapter.subjectId !== subjectId || chapter.deletedAt) {
      throw new HttpError(404, "chapter_not_found", "Chapitre introuvable dans cette matière");
    }
    return { chapter, name: chapter.name };
  }
  const name = body.newChapterName!;
  const existing = await prisma.chapter.findUnique({ where: { subjectId_name: { subjectId, name } } });
  return { chapter: existing && !existing.deletedAt ? existing : null, name };
}

async function analyse(prisma: PrismaClient, target: Target, raw: string, mode: ImportBodyT["mode"]) {
  const existingHashes = target.chapter
    ? new Set(
        (await prisma.question.findMany({ where: { chapterId: target.chapter.id, deletedAt: null }, select: { hash: true } })).map(
          (q) => q.hash,
        ),
      )
    : new Set<string>();
  const report = validateImport(raw, { existingHashes });
  const blocked = report.fatalError
    ? report.fatalError
    : mode === "all_or_nothing" && report.errors.length > 0
      ? `${report.errors.length} question(s) invalide(s) : en mode « tout ou rien », aucun import n'est effectué.`
      : report.valid.length === 0
        ? "Aucune question valide à importer."
        : undefined;
  return { report, blocked };
}

function summarise(report: ImportReport, target: Target) {
  return {
    chapter: { id: target.chapter?.id ?? null, name: target.name, isNew: target.chapter === null },
    total: report.total,
    validCount: report.valid.length,
    errorCount: report.errors.length,
    duplicateCount: report.duplicates.length,
    errors: report.errors.slice(0, REPORT_LIMIT),
    duplicates: report.duplicates.slice(0, REPORT_LIMIT),
    truncated: report.errors.length > REPORT_LIMIT || report.duplicates.length > REPORT_LIMIT,
    sample: report.valid.slice(0, 3).map(({ index, question, choices, answer, explanation }) => ({ index, question, choices, answer, explanation })),
  };
}

interface MultiTarget {
  name: string;
  chapter: Chapter | null; // chapitre actif existant
  deleted: Chapter | null; // chapitre de même nom dans la corbeille
  report: ImportReport;
}

/** Analyse un fichier multi-chapitres : un rapport par chapitre. */
async function analyseMulti(prisma: PrismaClient, subjectId: string, parsed: Extract<ReturnType<typeof parseMultiChapter>, { kind: "multi" }>, mode: ImportBodyT["mode"]) {
  const existing = await prisma.chapter.findMany({ where: { subjectId, name: { in: parsed.chapters.map((c) => c.name) } } });
  const byName = new Map(existing.map((c) => [c.name, c]));
  const targets: MultiTarget[] = [];
  for (const block of parsed.chapters) {
    const found = byName.get(block.name) ?? null;
    const active = found && !found.deletedAt ? found : null;
    const existingHashes = active
      ? new Set((await prisma.question.findMany({ where: { chapterId: active.id, deletedAt: null }, select: { hash: true } })).map((q) => q.hash))
      : new Set<string>();
    targets.push({ name: block.name, chapter: active, deleted: found && found.deletedAt ? found : null, report: validateImport(block.raw, { existingHashes }) });
  }
  const errors = targets.reduce((n, t) => n + t.report.errors.length + (t.report.fatalError ? 1 : 0), 0);
  const valid = targets.reduce((n, t) => n + t.report.valid.length, 0);
  const blocked = mode === "all_or_nothing" && errors > 0
    ? `${errors} question(s) invalide(s) : en mode « tout ou rien », aucun import n'est effectué.`
    : valid === 0 ? "Aucune question valide à importer." : undefined;
  return { targets, blocked };
}

function summariseMulti(targets: MultiTarget[]) {
  return {
    multi: true as const,
    chapters: targets.map((t) => ({
      name: t.name,
      isNew: t.chapter === null,
      total: t.report.total,
      validCount: t.report.valid.length,
      errorCount: t.report.errors.length + (t.report.fatalError ? 1 : 0),
      duplicateCount: t.report.duplicates.length,
      fatalError: t.report.fatalError ?? null,
      errors: t.report.errors.slice(0, 20),
    })),
    total: targets.reduce((n, t) => n + t.report.total, 0),
    validCount: targets.reduce((n, t) => n + t.report.valid.length, 0),
    errorCount: targets.reduce((n, t) => n + t.report.errors.length + (t.report.fatalError ? 1 : 0), 0),
    duplicateCount: targets.reduce((n, t) => n + t.report.duplicates.length, 0),
  };
}

export function registerImportRoutes(app: FastifyInstance, { prisma, auth }: Deps): void {
  const bodyLimit = 10 * 1024 * 1024; // 5000 questions peuvent dépasser le 1 Mo par défaut

  // ── Prévisualisation : ne modifie rien
  app.post<{ Params: { id: string } }>("/api/subjects/:id/import/preview", { bodyLimit }, async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "question:import", subject.id);
    const body = ImportBody.parse(req.body);

    const parsed = parseMultiChapter(body.raw);
    if (parsed.kind === "error") return { multi: true, canImport: false, blockedReason: parsed.fatalError, fatalError: parsed.fatalError, chapters: [], total: 0, validCount: 0, errorCount: 0, duplicateCount: 0 };
    if (parsed.kind === "multi") {
      const { targets, blocked } = await analyseMulti(prisma, subject.id, parsed, body.mode);
      return { canImport: !blocked, blockedReason: blocked ?? null, fatalError: null, ...summariseMulti(targets) };
    }

    const target = await resolveTarget(prisma, subject.id, body);
    const { report, blocked } = await analyse(prisma, target, body.raw, body.mode);
    return { canImport: !blocked, blockedReason: blocked ?? null, fatalError: report.fatalError ?? null, ...summarise(report, target) };
  });

  // ── Import réel
  app.post<{ Params: { id: string } }>("/api/subjects/:id/import/commit", { bodyLimit }, async (req, reply) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "question:import", subject.id);
    const body = ImportBody.parse(req.body);

    const parsed = parseMultiChapter(body.raw);
    if (parsed.kind === "error") throw new HttpError(422, "import_blocked", parsed.fatalError);
    if (parsed.kind === "multi") {
      const { targets, blocked } = await analyseMulti(prisma, subject.id, parsed, body.mode);
      if (blocked) throw new HttpError(422, "import_blocked", blocked, summariseMulti(targets));
      const toImport = targets.filter((t) => t.report.valid.length > 0);
      const colors = randomChapterColors(toImport.length);
      const created = await prisma.$transaction(
        async (tx) => {
          const out: { chapterId: string; name: string; isNew: boolean; imported: number; batchId: string }[] = [];
          for (const [i, t] of toImport.entries()) {
            let chapter = t.chapter;
            const isNew = chapter === null;
            if (!chapter) {
              chapter = t.deleted
                ? await tx.chapter.update({ where: { id: t.deleted.id }, data: { deletedAt: null, color: t.deleted.color || colors[i] } })
                : await tx.chapter.create({ data: { subjectId: subject.id, name: t.name, color: colors[i], locked: false } });
            }
            const batch = await tx.importBatch.create({ data: { chapterId: chapter.id, adminId: ctx.user.id, questionCount: t.report.valid.length } });
            for (let k = 0; k < t.report.valid.length; k += CHUNK) {
              await tx.question.createMany({
                data: t.report.valid.slice(k, k + CHUNK).map((q) => ({
                  chapterId: chapter!.id, batchId: batch.id, text: q.question, choices: JSON.stringify(q.choices),
                  answerIndex: q.answer, explanation: q.explanation ?? null, hash: q.hash,
                })),
              });
            }
            await logAction(tx, ctx.user.id, subject.id, "IMPORT_QUESTIONS", {
              batchId: batch.id, chapterId: chapter.id, imported: t.report.valid.length, errors: t.report.errors.length, duplicates: t.report.duplicates.length,
            });
            out.push({ chapterId: chapter.id, name: t.name, isNew, imported: t.report.valid.length, batchId: batch.id });
          }
          return out;
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
      return reply.status(201).send({
        multi: true,
        chapters: created,
        imported: created.reduce((n, c) => n + c.imported, 0),
        skippedInvalid: targets.reduce((n, t) => n + t.report.errors.length, 0),
        skippedDuplicates: targets.reduce((n, t) => n + t.report.duplicates.length, 0),
      });
    }

    const target = await resolveTarget(prisma, subject.id, body);
    const { report, blocked } = await analyse(prisma, target, body.raw, body.mode);
    if (blocked) throw new HttpError(422, "import_blocked", blocked, summarise(report, target));

    const result = await prisma.$transaction(
      async (tx) => {
        let chapter = target.chapter;
        if (!chapter) {
          const old = await tx.chapter.findUnique({ where: { subjectId_name: { subjectId: subject.id, name: target.name } } });
          chapter = old
            ? await tx.chapter.update({ where: { id: old.id }, data: { deletedAt: null, color: body.newChapterColor ?? old.color, locked: body.newChapterLocked ?? old.locked } })
            : await tx.chapter.create({ data: { subjectId: subject.id, name: target.name, color: body.newChapterColor ?? "", locked: body.newChapterLocked ?? false } });
        }
        const batch = await tx.importBatch.create({
          data: { chapterId: chapter.id, adminId: ctx.user.id, questionCount: report.valid.length },
        });
        for (let i = 0; i < report.valid.length; i += CHUNK) {
          await tx.question.createMany({
            data: report.valid.slice(i, i + CHUNK).map((q) => ({
              chapterId: chapter.id,
              batchId: batch.id,
              text: q.question,
              choices: JSON.stringify(q.choices),
              answerIndex: q.answer,
              explanation: q.explanation ?? null,
              hash: q.hash,
            })),
          });
        }
        await logAction(tx, ctx.user.id, subject.id, "IMPORT_QUESTIONS", {
          batchId: batch.id,
          chapterId: chapter.id,
          imported: report.valid.length,
          errors: report.errors.length,
          duplicates: report.duplicates.length,
        });
        return { chapterId: chapter.id, batchId: batch.id };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    return reply.status(201).send({
      ...result,
      imported: report.valid.length,
      skippedInvalid: report.errors.length,
      skippedDuplicates: report.duplicates.length,
    });
  });
}
