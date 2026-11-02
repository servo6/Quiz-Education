/**
 * Rôles et permissions.
 *
 * Hiérarchie (chaque niveau est CRÉÉ par le niveau au-dessus : on ne promeut jamais un joueur) :
 * - ADMIN           : super administrateur. Crée les organisations et leurs administrateurs. Personne ne peut modifier son compte.
 * - ORG_ADMIN       : administrateur d'une ou plusieurs organisations. Crée les matières et leurs responsables, dans SON organisation.
 * - SUBJECT_MANAGER : responsable de matières. Gère le contenu et les membres de SES matières, rien d'autre.
 * - USER            : joueur. Rejoint une organisation, puis choisit ses matières.
 *
 * Seuls les USER jouent : les trois autres rôles sont des comptes de gestion.
 */
export type Role = "USER" | "SUBJECT_MANAGER" | "ORG_ADMIN" | "ADMIN";

/** Actions réservées au super administrateur (jamais déléguées). */
const GLOBAL_ACTIONS = [
  "org:create",
  "org:delete",
  "orgadmin:manage", // créer / retirer les administrateurs d'une organisation
  "settings:global",
  "users:list",
  "users:ban",
  "users:resetPassword",
  "badges:manage",
  "avatars:manage",
  "tiers:manage",
  "backup:export",
  "logs:viewAll",
] as const;

/** Actions sur une organisation (identifiant d'organisation en paramètre) : super admin ou admin de cette organisation. */
const ORG_ACTIONS = [
  "org:manage", // nom, mot de passe d'accès, liste des matières et des joueurs
  "subject:create",
  "logs:viewOrg",
] as const;

/** Actions sur une matière réservées au super admin et à l'admin de l'organisation qui la contient. */
const SUBJECT_ORG_ACTIONS = ["subject:delete", "subject:rename", "managers:assign"] as const;

/** Actions sur une matière : super admin, admin de son organisation, ou responsable de la matière. */
const SUBJECT_ACTIONS = [
  "subject:settings", // paramètres de jeu propres à la matière
  "subject:access", // nom d'accès et mot de passe de la matière (donnés aux joueurs)
  "chapter:manage", // créer, renommer, supprimer un chapitre
  "question:import",
  "question:delete", // chapitre, lot, ou à partir d'une date et heure
  "members:view",
  "members:revoke",
  "logs:viewSubject",
] as const;

export type GlobalAction = (typeof GLOBAL_ACTIONS)[number];
export type OrgAction = (typeof ORG_ACTIONS)[number];
export type SubjectOrgAction = (typeof SUBJECT_ORG_ACTIONS)[number];
export type SubjectAction = (typeof SUBJECT_ACTIONS)[number];
export type Action = GlobalAction | OrgAction | SubjectOrgAction | SubjectAction;

export interface Actor {
  role: Role;
  /** Matières dont le compte est responsable (lignes SubjectManager). */
  managedSubjectIds: ReadonlySet<string>;
  /** Organisations administrées (lignes OrgAdmin). */
  adminOrgIds?: ReadonlySet<string>;
  /** Toutes les matières des organisations administrées. */
  orgSubjectIds?: ReadonlySet<string>;
}

const GLOBAL_SET: ReadonlySet<string> = new Set(GLOBAL_ACTIONS);
const ORG_SET: ReadonlySet<string> = new Set(ORG_ACTIONS);
const SUBJECT_ORG_SET: ReadonlySet<string> = new Set(SUBJECT_ORG_ACTIONS);
const SUBJECT_SET: ReadonlySet<string> = new Set(SUBJECT_ACTIONS);

export function isSubjectAction(action: Action): action is SubjectAction {
  return SUBJECT_SET.has(action);
}

/** Vrai pour tout compte de gestion (non joueur). */
export const isStaff = (role: string): boolean => role !== "USER";

/**
 * `scopeId` : identifiant d'organisation pour une action d'organisation, de matière pour une action de matière.
 * Sans lui, seul le super administrateur est autorisé. Toute action inconnue est refusée.
 */
export function can(actor: Actor, action: Action, scopeId?: string): boolean {
  const known = GLOBAL_SET.has(action) || ORG_SET.has(action) || SUBJECT_ORG_SET.has(action) || SUBJECT_SET.has(action);
  if (!known) return false;
  if (actor.role === "ADMIN") return true;
  if (scopeId === undefined) return false;
  if (actor.role === "ORG_ADMIN") {
    if (ORG_SET.has(action)) return !!actor.adminOrgIds?.has(scopeId);
    if (SUBJECT_ORG_SET.has(action) || SUBJECT_SET.has(action)) return !!actor.orgSubjectIds?.has(scopeId);
    return false;
  }
  if (actor.role === "SUBJECT_MANAGER" && SUBJECT_SET.has(action)) return actor.managedSubjectIds.has(scopeId);
  return false;
}

/** À appeler en tête de chaque route d'administration. */
export class ForbiddenError extends Error {
  constructor(action: Action, scopeId?: string) {
    super(`Action refusée : ${action}${scopeId ? ` (${scopeId})` : ""}`);
    this.name = "ForbiddenError";
  }
}

export function assertCan(actor: Actor, action: Action, scopeId?: string): void {
  if (!can(actor, action, scopeId)) throw new ForbiddenError(action, scopeId);
}

/** Le compte du super administrateur est intouchable : personne ne peut le suspendre, le rétrograder ou changer son mot de passe. */
export const isProtectedAccount = (role: string): boolean => role === "ADMIN";

/**
 * Qui peut agir (révoquer un accès, etc.) sur un compte dans une matière donnée :
 * le super admin jamais sur un autre super admin ; l'admin d'organisation sur les joueurs et responsables de ses matières ;
 * le responsable uniquement sur les joueurs de ses matières.
 */
export function canActOnUser(actor: Actor, targetRole: Role, subjectId: string): boolean {
  if (isProtectedAccount(targetRole)) return false;
  if (actor.role === "ADMIN") return true;
  if (actor.role === "ORG_ADMIN") return (targetRole === "USER" || targetRole === "SUBJECT_MANAGER") && !!actor.orgSubjectIds?.has(subjectId);
  return actor.role === "SUBJECT_MANAGER" && targetRole === "USER" && actor.managedSubjectIds.has(subjectId);
}
