import { loadOrgSettings } from "../settingsStore.ts";
import { defaultTheme } from "./theme.ts";
import { parseAvatar } from "../avatar.ts";
import { loadTiers, titleFor, type TierDef } from "../titles.ts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { COOKIE_NAME, SESSION_DAYS, type Deps } from "../auth.ts";
import { HttpError } from "../http.ts";
import { emailSchema } from "./email.ts";
import { sendVerificationMail, verificationOverdue } from "../emailService.ts";
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
  email: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), emailSchema.optional()),
  password: z.string().min(8, "8 caractères minimum").max(128, "128 caractères maximum"),
});

const LoginBody = z.object({
  /** Pseudo ou adresse e-mail (le champ s'appelle toujours « username » pour rester compatible). */
  username: z.string().trim().toLowerCase().min(1).max(120),
  password: z.string().min(1).max(128),
});

export function registerAuthRoutes(app: FastifyInstance, deps: Deps, secure: boolean): void {
  const { prisma, auth, registrationOpen, limit } = deps;
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
    const { username, email, password } = RegisterBody.parse(req.body);

    if (await prisma.user.findUnique({ where: { username } })) {
      throw new HttpError(409, "username_taken", "Ce pseudo est déjà pris");
    }
    if (email && (await prisma.user.findUnique({ where: { email } }))) throw new HttpError(409, "email_taken", "Cette adresse e-mail est déjà utilisée");
    let user;
    try {
      user = await prisma.user.create({ data: { username, email: email ?? null, passwordHash: await hashPassword(password) } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new HttpError(409, String(e.meta?.target).includes("email") ? "email_taken" : "username_taken", String(e.meta?.target).includes("email") ? "Cette adresse e-mail est déjà utilisée" : "Ce pseudo est déjà pris");
      }
      throw e;
    }
    if (email) {
      try {
        await sendVerificationMail(deps, req, user, email);
      } catch (e) {
        req.log.error(e, "envoi du mail de vérification");
      }
    }
    startSession(reply, user.id);
    return reply.status(201).send({ user: { id: user.id, username: user.username, role: user.role } });
  });

  app.post("/api/auth/login", { config: limit(10) }, async (req, reply) => {
    const { username, password } = LoginBody.parse(req.body);
    const user = await prisma.user.findUnique({ where: username.includes("@") ? { email: username } : { username } });
    const ok = user ? await verifyPassword(password, user.passwordHash) : await fakeVerify(password);
    if (!user || !ok) throw new HttpError(401, "bad_credentials", "Pseudo (ou e-mail) ou mot de passe incorrect");
    if (user.bannedAt) throw new HttpError(403, "banned", user.deactivatedAt ? "Ce compte a été désactivé. Contacte un administrateur pour le réactiver." : "Ce compte est suspendu");
    if (verificationOverdue(user)) throw new HttpError(403, "verification_overdue", "Délai de vérification de l'adresse e-mail dépassé : le compte est suspendu. Contacte le super administrateur.");
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

    if (user.role !== "USER") {
      // Comptes de gestion : jamais des joueurs. Ils ne voient que ce qu'ils gèrent.
      const ids = user.role === "ADMIN" ? null : user.role === "ORG_ADMIN" ? [...(actor.orgSubjectIds ?? [])] : [...actor.managedSubjectIds];
      const list = await prisma.subject.findMany({
        where: ids ? { id: { in: ids } } : {},
        orderBy: [{ organization: { name: "asc" } }, { name: "asc" }],
        select: { id: true, name: true, organizationId: true, organization: { select: { name: true } } },
      });
      const orgIds = user.role === "ADMIN" ? null : user.role === "ORG_ADMIN" ? [...(actor.adminOrgIds ?? [])] : [...new Set(list.map((x) => x.organizationId))];
      const orgs = await prisma.organization.findMany({ where: orgIds ? { id: { in: orgIds } } : {}, orderBy: { name: "asc" }, select: { id: true, name: true } });
      return {
        user: { id: user.id, username: user.username, email: user.email, emailVerified: !!user.emailVerifiedAt, verifyDeadline: user.emailVerifiedAt ? null : user.verifyDeadline, role: user.role, activeSubjectId: user.activeSubjectId, avatar: parseAvatar(user.avatar) },
        themeDefault: await defaultTheme(prisma, user, actor),
        managedSubjectIds: list.map((x) => x.id),
        adminOrgIds: user.role === "ORG_ADMIN" ? orgs.map((o) => o.id) : [],
        organizations: orgs,
        subjects: list.map((x) => ({ id: x.id, name: x.name, organizationId: x.organizationId, organizationName: x.organization.name })),
      };
    }

    const [globalRows, memberships, orgMemberships] = await Promise.all([
      prisma.setting.findMany(),
      prisma.membership.findMany({
        where: { userId: user.id, revokedAt: null },
        include: { subject: { select: { id: true, name: true, settings: true, organizationId: true } } },
        orderBy: { joinedAt: "asc" },
      }),
      prisma.orgMember.findMany({ where: { userId: user.id, revokedAt: null }, include: { organization: { select: { id: true, name: true } } }, orderBy: { joinedAt: "asc" } }),
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
    const orgSettings = new Map<string, Partial<ReturnType<typeof parseStoredSettings>>>();
    for (const m of memberships) if (!orgSettings.has(m.subject.organizationId)) orgSettings.set(m.subject.organizationId, await loadOrgSettings(prisma, m.subject.organizationId));
    for (const m of memberships) tiersBySubject.set(m.subject.id, (await loadTiers(prisma, m.subject.id)).tiers);

    return {
      user: { id: user.id, username: user.username, email: user.email, emailVerified: !!user.emailVerifiedAt, verifyDeadline: user.emailVerifiedAt ? null : user.verifyDeadline, role: user.role, activeSubjectId: user.activeSubjectId, avatar: parseAvatar(user.avatar) },
      themeDefault: await defaultTheme(prisma, user, actor),
      managedSubjectIds: [],
      adminOrgIds: [],
      organizations: orgMemberships.map((o) => ({ id: o.organization.id, name: o.organization.name })),
      subjects: memberships.map((m) => {
        const s = mergeSettings({ ...globalSettings, ...orgSettings.get(m.subject.organizationId) }, parseStoredSettings(m.subject.settings));
        const lvl = levelFromXp(m.xp, { base: s.levelBase ?? DEFAULT_SETTINGS.levelBase, exponent: s.levelExponent });
        const t = titleFor(lvl.level, tiersBySubject.get(m.subject.id) ?? []);
        return { id: m.subject.id, name: m.subject.name, xp: m.xp, ...lvl, title: { name: t.name, color: t.color } };
      }),
    };
  });
}
