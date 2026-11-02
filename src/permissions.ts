/**
 * Rôles et permissions.
 *
 * - USER            : joue, personnalise son avatar.
 * - SUBJECT_MANAGER : gère le contenu et les membres des matières qui lui sont assignées (table SubjectManager).
 * - ADMIN           : tous les droits sur toute la plateforme.
 */
export type Role = "USER" | "SUBJECT_MANAGER" | "ADMIN";

/** Actions réservées à l'administrateur (jamais déléguées). */
const GLOBAL_ACTIONS = [
  "subject:create",
  "subject:delete",
  "subject:rename",
  "settings:global",
  "users:list",
  "users:ban",
  "users:setRole",
  "users:resetPassword",
  "managers:assign",
  "badges:manage",
  "avatars:manage",
  "tiers:manage",
  "backup:export",
  "logs:viewAll",
] as const;

/** Actions que l'administrateur ET le responsable de la matière concernée peuvent faire. */
const SUBJECT_ACTIONS = [
  "subject:settings", // paramètres de jeu propres à la matière
  "subject:access", // nom et mot de passe d'accès
  "chapter:manage", // créer, renommer, supprimer un chapitre
  "question:import",
  "question:delete", // chapitre, lot, ou à partir d'une date et heure
  "members:view",
  "members:revoke",
  "logs:viewSubject",
] as const;

export type GlobalAction = (typeof GLOBAL_ACTIONS)[number];
export type SubjectAction = (typeof SUBJECT_ACTIONS)[number];
export type Action = GlobalAction | SubjectAction;

export interface Actor {
  role: Role;
  /** Identifiants des matières gérées (lignes SubjectManager de l'utilisateur). */
  managedSubjectIds: ReadonlySet<string>;
}

const GLOBAL_SET: ReadonlySet<string> = new Set(GLOBAL_ACTIONS);
const SUBJECT_SET: ReadonlySet<string> = new Set(SUBJECT_ACTIONS);

export function isSubjectAction(action: Action): action is SubjectAction {
  return SUBJECT_SET.has(action);
}

/**
 * `subjectId` est obligatoire pour une action de matière : sans lui, seul l'administrateur est autorisé.
 * Toute action inconnue est refusée.
 */
export function can(actor: Actor, action: Action, subjectId?: string): boolean {
  if (actor.role === "ADMIN") return GLOBAL_SET.has(action) || SUBJECT_SET.has(action);
  if (actor.role === "SUBJECT_MANAGER" && SUBJECT_SET.has(action)) {
    return subjectId !== undefined && actor.managedSubjectIds.has(subjectId);
  }
  return false;
}

/** À appeler en tête de chaque route d'administration. */
export class ForbiddenError extends Error {
  constructor(action: Action, subjectId?: string) {
    super(`Action refusée : ${action}${subjectId ? ` (matière ${subjectId})` : ""}`);
    this.name = "ForbiddenError";
  }
}

export function assertCan(actor: Actor, action: Action, subjectId?: string): void {
  if (!can(actor, action, subjectId)) throw new ForbiddenError(action, subjectId);
}

/**
 * Un responsable ne peut agir que sur les utilisateurs de ses matières, et jamais sur un administrateur
 * ou un autre responsable. Utilisé pour la révocation d'accès.
 */
export function canActOnUser(actor: Actor, targetRole: Role, subjectId: string): boolean {
  if (actor.role === "ADMIN") return true;
  return actor.role === "SUBJECT_MANAGER" && targetRole === "USER" && actor.managedSubjectIds.has(subjectId);
}
