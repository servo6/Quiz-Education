import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../auth.ts";
import type { Pusher } from "../push.ts";

const Sub = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }) });

export function registerPushRoutes(app: FastifyInstance, { prisma, auth, limit }: Deps, pusher: Pusher): void {
  app.get("/api/push/config", async () => ({ enabled: pusher.enabled, publicKey: pusher.publicKey }));

  app.post("/api/push/subscribe", { config: limit(30) }, async (req) => {
    const ctx = await auth(req);
    const s = Sub.parse(req.body);
    const ua = String(req.headers["user-agent"] ?? "").slice(0, 200);
    await prisma.pushSubscription.upsert({
      where: { endpoint: s.endpoint },
      create: { userId: ctx.user.id, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, userAgent: ua },
      update: { userId: ctx.user.id, p256dh: s.keys.p256dh, auth: s.keys.auth, userAgent: ua },
    });
    return { ok: true };
  });

  app.post("/api/push/unsubscribe", { config: limit(30) }, async (req) => {
    const ctx = await auth(req);
    const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(req.body);
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: ctx.user.id } });
    return { ok: true };
  });

  app.post("/api/push/test", { config: limit(5) }, async (req) => {
    const ctx = await auth(req);
    await pusher.send(ctx.user.id, { title: "Notifications activées", body: "Tu recevras ici tes défis et ton tour de jeu.", url: "/", tag: "push-test" });
    return { ok: true };
  });
}
