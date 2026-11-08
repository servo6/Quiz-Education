/**
 * Archivage des identifiants d'un compte désactivé par son propriétaire.
 * Le compte n'est pas supprimé : on renomme son pseudo et son e-mail pour les libérer (on peut alors se réinscrire avec les mêmes),
 * et on les restaure si un administrateur rétablit le compte et qu'ils sont toujours libres.
 */
const USER_RE = /^(.*)~off~[a-z0-9]+$/;
const MAIL_RE = /^off\+[a-z0-9]+\+(.+)$/;

export function archivedUsername(username: string, id: string): string {
  return `${username}~off~${id.slice(-8).toLowerCase()}`;
}
export function archivedEmail(email: string, id: string): string {
  return `off+${id.slice(-8).toLowerCase()}+${email}`;
}
export function originalUsername(username: string): string {
  return USER_RE.exec(username)?.[1] ?? username;
}
export function originalEmail(email: string | null): string | null {
  return email ? MAIL_RE.exec(email)?.[1] ?? email : email;
}
