import type { PrismaClient } from "@prisma/client";

/**
 * Super testeur : compte joueur créé par le super administrateur, qui peut s'inscrire dans toutes les matières de toutes
 * les organisations (un joueur normal n'appartient qu'à une organisation). Il a un profil (avatar) par organisation.
 * Marqueur : réglage `tester:<id>` ; avatars mémorisés : `tester-avatar:<id>:<organisation>` (celui de l'organisation
 * courante est dans `User.avatar`, comme pour tout le monde, donc rien d'autre n'a à changer dans la plateforme).
 */
export const testerKey = (userId: string) => `tester:${userId}`;
const avatarKey = (userId: string, orgId: string) => `tester-avatar:${userId}:${orgId}`;

export async function isTester(prisma: PrismaClient, userId: string): Promise<boolean> {
  return !!(await prisma.setting.findUnique({ where: { key: testerKey(userId) } }));
}

/** Change de matière active ; pour un testeur, change aussi d'avatar quand l'organisation change. */
export async function setActiveSubject(prisma: PrismaClient, user: { id: string; activeSubjectId: string | null; avatar: string }, subjectId: string): Promise<void> {
  const data: { activeSubjectId: string; avatar?: string } = { activeSubjectId: subjectId };
  if (await isTester(prisma, user.id)) {
    const [to, from] = await Promise.all([
      prisma.subject.findUnique({ where: { id: subjectId }, select: { organizationId: true } }),
      user.activeSubjectId ? prisma.subject.findUnique({ where: { id: user.activeSubjectId }, select: { organizationId: true } }) : null,
    ]);
    if (to && from && to.organizationId !== from.organizationId) {
      const value = user.avatar;
      const k = avatarKey(user.id, from.organizationId);
      await prisma.setting.upsert({ where: { key: k }, create: { key: k, value }, update: { value } });
      const saved = await prisma.setting.findUnique({ where: { key: avatarKey(user.id, to.organizationId) } });
      data.avatar = saved?.value ?? "{}";
    }
  }
  await prisma.user.update({ where: { id: user.id }, data });
}
