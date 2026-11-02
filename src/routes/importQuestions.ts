import type { FastifyInstance } from "fastify";
import type { Chapter, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { loadSubject } from "../access.ts";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { validateImport, type ImportReport } from "../import/validate.ts";
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
  .refine((b) => (b.chapterId === undefined) !== (b.newChapterName === undefined), {
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

export function registerImportRoutes(app: FastifyInstance, { prisma, auth }: Deps): void {
  const bodyLimit = 10 * 1024 * 1024; // 5000 questions peuvent dépasser le 1 Mo par défaut

  // ── Prévisualisation : ne modifie rien
  app.post<{ Params: { id: string } }>("/api/subjects/:id/import/preview", { bodyLimit }, async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "question:import", subject.id);
    const body = ImportBody.parse(req.body);

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
