import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { loadSubject } from "../access.ts";
import { logAction } from "../audit.ts";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { assertCan, can } from "../permissions.ts";

const DeleteBody = z.object({ confirmName: z.string() });
const LogsQuery = z.object({
  subjectId: z.string().min(1).optional(),
  action: z.string().trim().min(1).max(60).optional(),
  adminId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).catch(50).default(50),
  cursor: z.string().min(1).optional(),
});

export function registerAdminRoutes(app: FastifyInstance, { prisma, auth }: Deps): void {
  // ── Supprimer définitivement une matière et tout ce qui s'y rattache (administrateur)
  app.delete<{ Params: { id: string } }>("/api/subjects/:id", async (req) => {
    const ctx = await auth(req);
    const subject = await loadSubject(prisma, req.params.id);
    assertCan(ctx.actor, "subject:delete", subject.id);
    const { confirmName } = DeleteBody.parse(req.body ?? {});
    if (confirmName !== subject.name) {
      throw new HttpError(422, "confirmation_mismatch", "Pour confirmer, saisis exactement le nom de la matière", { expected: "name" });
    }
    const live = await prisma.game.count({ where: { subjectId: subject.id, mode: "FRIENDLY", status: { in: ["IN_PROGRESS", "WAITING"] } } });
    if (live > 0) throw new HttpError(409, "live_duels_active", "Des duels en direct sont en cours dans cette matière : réessaie dans quelques minutes");

    const subjectId = subject.id;
    const summary = await prisma.$transaction(
      async (tx) => {
        // Suppression explicite et ordonnée : ne dépend pas des suppressions en cascade de la base.
        const inGame = { game: { subjectId } };
        const counts = {
          answers: (await tx.answer.deleteMany({ where: { gameQuestion: inGame } })).count,
          games: 0,
          questions: 0,
          chapters: 0,
          members: 0,
        };
        await tx.questionServe.deleteMany({ where: { gameQuestion: inGame } });
        await tx.gameQuestion.deleteMany({ where: inGame });
        await tx.round.deleteMany({ where: inGame });
        await tx.gamePlayer.deleteMany({ where: inGame });
        await tx.xpEvent.deleteMany({ where: { subjectId } });
        counts.games = (await tx.game.deleteMany({ where: { subjectId } })).count;
        counts.questions = (await tx.question.deleteMany({ where: { chapter: { subjectId } } })).count;
        await tx.importBatch.deleteMany({ where: { chapter: { subjectId } } });
        counts.chapters = (await tx.chapter.deleteMany({ where: { subjectId } })).count;
        await tx.tier.deleteMany({ where: { subjectId } });
        await tx.subjectManager.deleteMany({ where: { subjectId } });
        counts.members = (await tx.membership.deleteMany({ where: { subjectId } })).count;
        await tx.user.updateMany({ where: { activeSubjectId: subjectId }, data: { activeSubjectId: null } });
        // Un responsable sans matière reste un compte de gestion (jamais un joueur).
        await tx.setting.deleteMany({ where: { key: `ui.theme:subject:${subjectId}` } });
        await tx.subject.delete({ where: { id: subjectId } });
        await logAction(tx, ctx.user.id, subjectId, "DELETE_SUBJECT", { name: subject.name, ...counts });
        return counts;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    return { ok: true, deleted: { name: subject.name, ...summary } };
  });

  // ── Journal d'administration
  //   administrateur : tout ; responsable : uniquement les matières qu'il gère ; filtres et pagination par curseur.
  app.get("/api/logs", async (req) => {
    const ctx = await auth(req);
    const q = LogsQuery.parse(req.query);
    const where: Prisma.AdminLogWhereInput = {};

    if (q.subjectId) {
      assertCan(ctx.actor, "logs:viewSubject", q.subjectId);
      where.subjectId = q.subjectId;
    } else if (can(ctx.actor, "logs:viewAll")) {
      /* tout le journal */
    } else if (ctx.actor.role === "ORG_ADMIN") {
      where.subjectId = { in: [...(ctx.actor.orgSubjectIds ?? [])] };
    } else if (ctx.actor.role === "SUBJECT_MANAGER") {
      where.subjectId = { in: [...ctx.actor.managedSubjectIds] };
    } else {
      throw new HttpError(403, "forbidden", "Action non autorisée");
    }
    if (q.action) where.action = q.action;
    if (q.adminId) where.adminId = q.adminId;

    const rows = await prisma.adminLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { admin: { select: { id: true, username: true } } },
    });
    const page = rows.slice(0, q.limit);

    const ids = [...new Set(page.map((r) => r.subjectId).filter((x): x is string => !!x))];
    const subjects = await prisma.subject.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const names = new Map(subjects.map((s) => [s.id, s.name]));

    return {
      logs: page.map((r) => {
        let details: unknown = {};
        try {
          details = JSON.parse(r.details);
        } catch {
          /* détails illisibles */
        }
        const deletedName = r.action === "DELETE_SUBJECT" ? (details as { name?: string }).name : undefined;
        return {
          id: r.id,
          createdAt: r.createdAt,
          action: r.action,
          actor: r.admin,
          subjectId: r.subjectId,
          subjectName: r.subjectId ? (names.get(r.subjectId) ?? deletedName ?? null) : null,
          details,
        };
      }),
      nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
    };
  });
}
