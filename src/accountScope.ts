import type { PrismaClient, User } from "@prisma/client";
import { HttpError } from "./http.ts";
import type { AuthContext } from "./auth.ts";
import { isProtectedAccount } from "./permissions.ts";

/**
 * Le compte `target` est-il à la portée de `ctx` (suspension, mot de passe) ?
 * - Le compte du super administrateur n'est à la portée de PERSONNE.
 * - Le super administrateur agit sur tous les autres comptes.
 * - L'administrateur d'organisation agit sur les joueurs de ses organisations et sur les responsables de ses matières
 *   (ou créés par lui) ; jamais sur un autre administrateur.
 * - Un responsable n'agit sur aucun compte (il révoque des accès, voir members.ts).
 */
export async function assertAccountInReach(prisma: PrismaClient, ctx: AuthContext, target: Pick<User, "id" | "role" | "createdById">): Promise<void> {
  if (isProtectedAccount(target.role)) throw new HttpError(403, "super_admin_protected", "Le compte du super administrateur ne peut pas être modifié");
  if (target.id === ctx.user.id) throw new HttpError(422, "self_target", "Tu ne peux pas faire cela sur ton propre compte");
  if (ctx.actor.role === "ADMIN") return;
  if (ctx.actor.role === "ORG_ADMIN") {
    const orgs = [...(ctx.actor.adminOrgIds ?? [])];
    if (target.role === "USER") {
      const n = await prisma.orgMember.count({ where: { userId: target.id, organizationId: { in: orgs } } });
      if (n > 0) return;
    } else if (target.role === "SUBJECT_MANAGER") {
      if (target.createdById === ctx.user.id) return;
      const n = await prisma.subjectManager.count({ where: { userId: target.id, subject: { organizationId: { in: orgs } } } });
      if (n > 0) return;
    }
  }
  throw new HttpError(403, "forbidden", "Tu ne peux pas agir sur ce compte");
}
