import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { assertCan } from "../permissions.ts";
import { addDaysKey, localDayKey } from "../time.ts";

const Query = z.object({
  scope: z.enum(["platform", "organization"]),
  organizationId: z.string().min(1).optional(),
  days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d)).catch(30).default(30),
});

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);

export function registerOverviewRoutes(app: FastifyInstance, { prisma, auth, timezone }: Deps): void {
  /** Tableau de bord : plateforme entière (super admin) ou une organisation (son administrateur). */
  app.get("/api/overview", async (req) => {
    const ctx = await auth(req);
    const q = Query.parse(req.query);
    let orgIds: string[];
    if (q.scope === "platform") {
      if (ctx.actor.role !== "ADMIN") throw new HttpError(403, "forbidden", "Action non autorisée");
      orgIds = (await prisma.organization.findMany({ select: { id: true } })).map((o) => o.id);
    } else {
      if (!q.organizationId) throw new HttpError(422, "organization_required", "Choisis une organisation");
      assertCan(ctx.actor, "org:manage", q.organizationId);
      orgIds = [q.organizationId];
    }

    const now = new Date();
    const today = localDayKey(now, timezone);
    const keys = Array.from({ length: q.days }, (_, i) => addDaysKey(today, i - (q.days - 1)));
    const since = new Date(now.getTime() - (q.days + 1) * 86_400_000);
    const week = new Date(now.getTime() - 7 * 86_400_000);

    const [orgs, subjects] = await Promise.all([
      prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }),
      prisma.subject.findMany({ where: { organizationId: { in: orgIds } }, select: { id: true, name: true, organizationId: true } }),
    ]);
    const subjectIds = subjects.map((s) => s.id);
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    const orgOfSubject = new Map(subjects.map((s) => [s.id, s.organizationId]));

    const [chapters, orgMembers, answers, games, orgAdmins, managers] = await Promise.all([
      prisma.chapter.findMany({ where: { subjectId: { in: subjectIds }, deletedAt: null }, select: { id: true, subjectId: true } }),
      prisma.orgMember.findMany({ where: { organizationId: { in: orgIds }, revokedAt: null, user: { role: "USER" } }, select: { userId: true, organizationId: true, joinedAt: true, user: { select: { bannedAt: true } } } }),
      prisma.answer.findMany({
        where: { answeredAt: { gte: since < week ? since : week }, gameQuestion: { game: { subjectId: { in: subjectIds } } } },
        select: { userId: true, isCorrect: true, answeredAt: true, gameQuestion: { select: { game: { select: { subjectId: true } } } } },
      }),
      prisma.game.groupBy({ by: ["subjectId", "mode"], where: { subjectId: { in: subjectIds }, createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.orgAdmin.count({ where: { organizationId: { in: orgIds } } }),
      prisma.subjectManager.findMany({ where: { subjectId: { in: subjectIds } }, select: { userId: true }, distinct: ["userId"] }),
    ]);
    const qByChapter = await prisma.question.groupBy({ by: ["chapterId"], where: { deletedAt: null, chapterId: { in: chapters.map((c) => c.id) } }, _count: { _all: true } });
    const chapterSubject = new Map(chapters.map((c) => [c.id, c.subjectId]));
    const memberships = await prisma.membership.findMany({ where: { subjectId: { in: subjectIds }, revokedAt: null, user: { role: "USER" } }, select: { subjectId: true } });

    type Acc = { chapters: number; questions: number; players: number; answers: number; correct: number; games: number; active: Set<string> };
    const blank = (): Acc => ({ chapters: 0, questions: 0, players: 0, answers: 0, correct: 0, games: 0, active: new Set() });
    const perSubject = new Map(subjects.map((s) => [s.id, blank()]));
    const perOrg = new Map(orgs.map((o) => [o.id, blank()]));
    for (const c of chapters) { perSubject.get(c.subjectId)!.chapters++; perOrg.get(orgOfSubject.get(c.subjectId)!)!.chapters++; }
    for (const r of qByChapter) { const sid = chapterSubject.get(r.chapterId)!; perSubject.get(sid)!.questions += r._count._all; perOrg.get(orgOfSubject.get(sid)!)!.questions += r._count._all; }
    for (const m of memberships) perSubject.get(m.subjectId)!.players++;
    for (const m of orgMembers) perOrg.get(m.organizationId)!.players++;

    const series = new Map(keys.map((k) => [k, { date: k, answers: 0, correct: 0, active: new Set<string>(), newPlayers: 0 }]));
    const active7 = new Set<string>(), activeWin = new Set<string>();
    let totalAnswers = 0, totalCorrect = 0;
    for (const a of answers) {
      const sid = a.gameQuestion.game.subjectId;
      const inWindow = a.answeredAt >= since;
      if (a.answeredAt >= week) {
        active7.add(a.userId);
        perSubject.get(sid)!.active.add(a.userId); perOrg.get(orgOfSubject.get(sid)!)!.active.add(a.userId);
      }
      if (!inWindow) continue;
      activeWin.add(a.userId);
      totalAnswers++; if (a.isCorrect) totalCorrect++;
      for (const acc of [perSubject.get(sid)!, perOrg.get(orgOfSubject.get(sid)!)!]) { acc.answers++; if (a.isCorrect) acc.correct++; }
      const day = series.get(localDayKey(a.answeredAt, timezone));
      if (day) { day.answers++; if (a.isCorrect) day.correct++; day.active.add(a.userId); }
    }
    for (const m of orgMembers) { const d = series.get(localDayKey(m.joinedAt, timezone)); if (d) d.newPlayers++; }
    const modes: Record<string, number> = { SOLO: 0, DUEL: 0, FRIENDLY: 0 };
    for (const g of games) {
      modes[g.mode] = (modes[g.mode] ?? 0) + g._count._all;
      perSubject.get(g.subjectId)!.games += g._count._all; perOrg.get(orgOfSubject.get(g.subjectId)!)!.games += g._count._all;
    }
    const row = (acc: Acc) => ({ chapters: acc.chapters, questions: acc.questions, players: acc.players, active7: acc.active.size, answers: acc.answers, accuracy: pct(acc.correct, acc.answers), games: acc.games });

    const platformExtra = q.scope === "platform"
      ? await Promise.all([prisma.user.count({ where: { role: "USER" } }), prisma.user.count({ where: { bannedAt: { not: null } } })])
      : null;
    const players = new Set(orgMembers.map((m) => m.userId)).size;

    return {
      scope: q.scope, days: q.days,
      totals: {
        organizations: orgs.length, subjects: subjects.length, chapters: chapters.length,
        questions: qByChapter.reduce((n, r) => n + r._count._all, 0),
        players: platformExtra ? platformExtra[0] : players,
        unaffiliated: platformExtra ? Math.max(0, platformExtra[0] - players) : 0,
        banned: platformExtra ? platformExtra[1] : orgMembers.filter((m) => m.user.bannedAt).length,
        orgAdmins, managers: managers.length,
        active7: active7.size, activeWindow: activeWin.size,
        answers: totalAnswers, accuracy: pct(totalCorrect, totalAnswers),
        games: modes,
      },
      series: [...series.values()].map((d) => ({ date: d.date, answers: d.answers, correct: d.correct, activePlayers: d.active.size, newPlayers: d.newPlayers, accuracy: pct(d.correct, d.answers) })),
      subjects: subjects.map((s) => ({ id: s.id, name: s.name, organizationId: s.organizationId, organizationName: orgName.get(s.organizationId), ...row(perSubject.get(s.id)!) })),
      organizations: q.scope === "platform" ? orgs.map((o) => ({ id: o.id, name: o.name, subjects: subjects.filter((s) => s.organizationId === o.id).length, ...row(perOrg.get(o.id)!) })) : [],
    };
  });
}
