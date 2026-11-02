import type { Chapter, PrismaClient, Subject } from "@prisma/client";
import { HttpError } from "./http.ts";
import type { AuthContext } from "./auth.ts";

export async function loadSubject(prisma: PrismaClient, id: string): Promise<Subject> {
  const subject = await prisma.subject.findUnique({ where: { id } });
  if (!subject) throw new HttpError(404, "subject_not_found", "Matière introuvable");
  return subject;
}

export async function loadChapter(prisma: PrismaClient, id: string): Promise<Chapter> {
  const chapter = await prisma.chapter.findUnique({ where: { id } });
  if (!chapter || chapter.deletedAt) throw new HttpError(404, "chapter_not_found", "Chapitre introuvable");
  return chapter;
}

/** Peut consulter le contenu d'une matière : administrateur, responsable de la matière, ou membre actif. */
export async function canReadSubject(prisma: PrismaClient, ctx: AuthContext, subjectId: string): Promise<boolean> {
  if (ctx.actor.role === "ADMIN" || ctx.actor.managedSubjectIds.has(subjectId)) return true;
  const membership = await prisma.membership.findUnique({
    where: { userId_subjectId: { userId: ctx.user.id, subjectId } },
  });
  return !!membership && !membership.revokedAt;
}

/** Un chapitre bloqué n'est jamais proposé aux joueurs : on refuse de le jouer, quelle que soit la route. */
export function assertChapterUnlocked(chapter: { locked: boolean }): void {
  if (chapter.locked) throw new HttpError(403, "chapter_locked", "Ce chapitre n'est pas encore débloqué");
}

/** Membre actif d'une matière (accès non révoqué), sinon 403. */
export async function requireMembership(prisma: PrismaClient, userId: string, subjectId: string, knownRole?: string) {
  // Le rôle est déjà connu de l'appelant (session) : inutile de le relire (un aller-retour de moins).
  const m = knownRole
    ? await prisma.membership.findUnique({ where: { userId_subjectId: { userId, subjectId } } })
    : await prisma.membership.findUnique({ where: { userId_subjectId: { userId, subjectId } }, include: { user: { select: { role: true } } } });
  const role = knownRole ?? (m as { user?: { role: string } } | null)?.user?.role;
  if (m && role === "ADMIN") throw new HttpError(403, "admin_cannot_play", "Un administrateur ne joue pas : il gère la plateforme");
  if (!m || m.revokedAt) throw new HttpError(403, "not_a_member", "Tu n'as pas accès à cette matière");
  return m;
}
