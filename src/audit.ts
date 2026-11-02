import type { Prisma, PrismaClient } from "@prisma/client";

export type Db = PrismaClient | Prisma.TransactionClient;

/** Journal des actions d'administration (administrateur ou responsable de matière). */
export function logAction(
  db: Db,
  actorId: string,
  subjectId: string | null,
  action: string,
  details: Record<string, unknown> = {},
) {
  return db.adminLog.create({ data: { adminId: actorId, subjectId, action, details: JSON.stringify(details) } });
}
