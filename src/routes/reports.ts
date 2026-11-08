import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadSubject, requireMembership } from "../access.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { assertCan } from "../permissions.ts";

export const REPORT_REASONS = ["WRONG_ANSWER", "AMBIGUOUS", "TYPO", "OTHER"] as const;
const ReportBody = z.object({ reason: z.enum(REPORT_REASONS), comment: z.string().trim().max(300).optional() });

/** Signalement d'une question (fausse, ambiguë, faute…) par un joueur, et traitement par les responsables. */
export function registerReportRoutes(app: FastifyInstance, { prisma, auth, limit }: Deps): void {
  /** Accepte l'identifiant d'une question ou celui d'une question de partie (ce que voit le client en jeu). */
  async function resolveQuestion(id: string) {
    const direct = await prisma.question.findUnique({ where: { id }, include: { chapter: { select: { subjectId: true } } } });
    if (direct) return direct;
    const gq = await prisma.gameQuestion.findUnique({ where: { id }, include: { question: { include: { chapter: { select: { subjectId: true } } } } } });
    if (!gq) throw new HttpError(404, "question_not_found", "Question introuvable");
    return gq.question;
  }

  app.post<{ Params: { id: string } }>("/api/questions/:id/report", { config: limit(20) }, async (req) => {
    const ctx = await auth(req);
    const body = ReportBody.parse(req.body);
    const q = await resolveQuestion(req.params.id);
    await requireMembership(prisma, ctx.user.id, q.chapter.subjectId, ctx.user.role);
    await prisma.questionReport.upsert({
      where: { userId_questionId: { userId: ctx.user.id, questionId: q.id } },
      create: { userId: ctx.user.id, questionId: q.id, subjectId: q.chapter.subjectId, reason: body.reason, comment: body.comment ?? "" },
      update: { reason: body.reason, comment: body.comment ?? "", status: "OPEN", createdAt: new Date(), resolvedAt: null },
    });
    return { ok: true };
  });

  // ── Liste des signalements d'une matière, regroupés par question
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>("/api/subjects/:id/reports", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "question:delete", subject.id);
    const openOnly = req.query.status !== "all";
    const rows = await prisma.questionReport.findMany({
      where: { subjectId: subject.id, ...(openOnly ? { status: "OPEN" } : {}) },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { user: { select: { username: true } } },
    });
    const ids = [...new Set(rows.map((r) => r.questionId))];
    const questions = await prisma.question.findMany({ where: { id: { in: ids } }, include: { chapter: { select: { name: true } } } });
    const reports = ids.map((qid) => {
      const mine = rows.filter((r) => r.questionId === qid);
      const q = questions.find((x) => x.id === qid);
      const reasons: Record<string, number> = {};
      for (const r of mine) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
      return {
        questionId: qid,
        text: q?.text ?? "(question supprimée)",
        choices: q ? (JSON.parse(q.choices) as string[]) : [],
        answerIndex: q?.answerIndex ?? null,
        explanation: q?.explanation ?? null,
        chapter: q?.chapter.name ?? "",
        deleted: !q || !!q.deletedAt,
        count: mine.length,
        open: mine.filter((r) => r.status === "OPEN").length,
        reasons,
        comments: mine.filter((r) => r.comment).slice(0, 5).map((r) => ({ username: r.user.username, comment: r.comment, reason: r.reason, createdAt: r.createdAt })),
        lastAt: mine[0].createdAt,
      };
    }).sort((a, b) => b.open - a.open || b.count - a.count);
    return { reports, openCount: await prisma.questionReport.count({ where: { subjectId: subject.id, status: "OPEN" } }) };
  });

  // ── Clore les signalements d'une question (traité ou rejeté)
  app.post<{ Params: { id: string; questionId: string } }>("/api/subjects/:id/reports/:questionId/resolve", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "question:delete", subject.id);
    const { status } = z.object({ status: z.enum(["RESOLVED", "DISMISSED"]) }).parse(req.body);
    const r = await prisma.questionReport.updateMany({ where: { subjectId: subject.id, questionId: req.params.questionId, status: "OPEN" }, data: { status, resolvedAt: new Date() } });
    return { closed: r.count };
  });
}
