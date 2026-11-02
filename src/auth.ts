import type { FastifyRequest } from "fastify";
import type { PrismaClient, User } from "@prisma/client";
import { HttpError } from "./http.ts";
import type { Actor, Role } from "./permissions.ts";

export const COOKIE_NAME = "token";
export const SESSION_DAYS = 7;

export interface AuthContext {
  user: User;
  actor: Actor;
}

export interface Deps {
  prisma: PrismaClient;
  /** Identifie l'utilisateur de la requête (cookie de session) ou lève 401/403. */
  auth: (request: FastifyRequest) => Promise<AuthContext>;
  registrationOpen: boolean;
  /** Fuseau horaire qui définit un "jour" (ex. Europe/Paris). */
  timezone: string;
  /** Configuration du rate limit des routes sensibles ; `false` pour le désactiver (tests). */
  limit: (max: number) => { rateLimit: { max: number; timeWindow: string } | false };
}

/** Cache court des comptes : évite une requête base par appel d'API (la base est distante). */
const AUTH_TTL_MS = 10_000;
const authCache = new Map<string, { at: number; user: User; managed: string[] }>();
/** À appeler après tout changement de compte (bannissement, rôle, matières gérées). */
export function invalidateAuth(userId?: string): void {
  if (userId) authCache.delete(userId);
  else authCache.clear();
}

export function makeAuth(prisma: PrismaClient, useCache = false) {
  return async function authenticate(request: FastifyRequest): Promise<AuthContext> {
    let sub: string | undefined;
    try {
      const payload = await request.jwtVerify<{ sub?: string }>({ onlyCookie: true });
      sub = payload.sub;
    } catch {
      throw new HttpError(401, "unauthenticated", "Connexion requise");
    }
    if (!sub) throw new HttpError(401, "unauthenticated", "Connexion requise");

    let hit = authCache.get(sub);
    if (!useCache || !hit || Date.now() - hit.at > AUTH_TTL_MS) {
      const user = await prisma.user.findUnique({
        where: { id: sub },
        include: { managedSubjects: { select: { subjectId: true } } },
      });
      if (!user) {
        authCache.delete(sub);
        throw new HttpError(401, "unauthenticated", "Connexion requise");
      }
      const { managedSubjects, ...plain } = user;
      hit = { at: Date.now(), user: plain as User, managed: managedSubjects.map((m) => m.subjectId) };
      if (useCache) authCache.set(sub, hit);
    }
    if (hit.user.bannedAt) throw new HttpError(403, "banned", "Ce compte est suspendu");
    return { user: hit.user, actor: { role: hit.user.role as Role, managedSubjectIds: new Set(hit.managed) } };
  };
}
