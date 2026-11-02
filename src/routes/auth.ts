import { parseAvatar } from "../avatar.ts";
import { loadTiers, titleFor, type TierDef } from "../titles.ts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { COOKIE_NAME, SESSION_DAYS, type Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { fakeVerify, hashPassword, verifyPassword } from "../password.ts";
import { DEFAULT_SETTINGS, mergeSettings, parseStoredSettings } from "../settings.ts";
import { levelFromXp } from "../xp.ts";

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "3 caractères minimum")
  .max(30, "30 caractères maximum")
  .regex(/^[a-z0-9_.-]+$/, "lettres, chiffres, point, tiret et underscore uniquement");

const RegisterBody = z.object({
  username: usernameSchema,
  password: z.string().min(8, "8 caractères minimum").max(128, "128 caractères maximum"),
});

const LoginBody = z.object({
  username: z.string().trim().toLowerCase().min(1),
  password: z.string().min(1).max(128),
});

export function registerAuthRoutes(app: FastifyInstance, { prisma, auth, registrationOpen, limit }: Deps, secure: boolean): void {
  const startSession = (reply: FastifyReply, userId: string) => {
    const token = app.jwt.sign({ sub: userId }, { expiresIn: `${SESSION_DAYS}d` });
    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: SESSION_DAYS * 24 * 3600,
    });
  };

  app.post("/api/auth/register", { config: limit(10) }, async (req, reply) => {
    if (!registrationOpen) throw new HttpError(403, "registration_closed", "Les inscriptions sont fermées");
    const { username, password } = RegisterBody.parse(req.body);

    if (await prisma.user.findUnique({ where: { username } })) {
      throw new HttpError(409, "username_taken", "Ce nom d'utilisateur est déjà pris");
    }
    let user;
    try {
      user = await prisma.user.create({ data: { username, passwordHash: await hashPassword(password) } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new HttpError(409, "username_taken", "Ce nom d'utilisateur est déjà pris");
      }
      throw e;
    }
    startSession(reply, user.id);
    return reply.status(201).send({ user: { id: user.id, username: user.username, role: user.role } });
  });

  app.post("/api/auth/login", { config: limit(10) }, async (req, reply) => {
    const { username, password } = LoginBody.parse(req.body);
    const user = await prisma.user.findUnique({ where: { username } });
    const ok = user ? await verifyPassword(password, user.passwordHash) : await fakeVerify(password);
    if (!user || !ok) throw new HttpError(401, "bad_credentials", "Nom d'utilisateur ou mot de passe incorrect");
    if (user.bannedAt) throw new HttpError(403, "banned", "Ce compte est suspendu");
    startSession(reply, user.id);
    return { user: { id: user.id, username: user.username, role: user.role } };
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  /** Profil + matières rejointes (avec XP et niveau dans chacune) + matières gérées. */
  app.get("/api/me", async (req) => {
    const { user, actor } = await auth(req);

    if (user.role === "ADMIN") {
      const all = await prisma.subject.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
      return {
        user: { id: user.id, username: user.username, role: user.role, activeSubjectId: user.activeSubjectId, avatar: null },
        managedSubjectIds: [],
        subjects: all.map((s) => ({ id: s.id, name: s.name })),
      };
    }

    const [globalRows, memberships] = await Promise.all([
      prisma.setting.findMany(),
      prisma.membership.findMany({
        where: { userId: user.id, revokedAt: null },
        include: { subject: { select: { id: true, name: true, settings: true } } },
        orderBy: { joinedAt: "asc" },
      }),
    ]);
    const globals: Record<string, unknown> = {};
    for (const row of globalRows) {
      try {
        globals[row.key] = JSON.parse(row.value);
      } catch {
        /* valeur illisible : ignorée */
      }
    }
    const globalSettings = parseStoredSettings(JSON.stringify(globals));
    const tiersBySubject = new Map<string, TierDef[]>();
    for (const m of memberships) tiersBySubject.set(m.subject.id, (await loadTiers(prisma, m.subject.id)).tiers);

    return {
      user: { id: user.id, username: user.username, role: user.role, activeSubjectId: user.activeSubjectId, avatar: parseAvatar(user.avatar) },
      managedSubjectIds: [...actor.managedSubjectIds],
      subjects: memberships.map((m) => {
        const s = mergeSettings(globalSettings, parseStoredSettings(m.subject.settings));
        const lvl = levelFromXp(m.xp, { base: s.levelBase ?? DEFAULT_SETTINGS.levelBase, exponent: s.levelExponent });
        const t = titleFor(lvl.level, tiersBySubject.get(m.subject.id) ?? []);
        return { id: m.subject.id, name: m.subject.name, xp: m.xp, ...lvl, title: { name: t.name, color: t.color } };
      }),
    };
  });
}
