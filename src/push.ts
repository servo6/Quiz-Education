import type { PrismaClient } from "@prisma/client";
import webpush from "web-push";

export type PushMessage = { title: string; body: string; url: string; tag?: string };

export interface Pusher {
  enabled: boolean;
  publicKey: string | null;
  /** Envoie à tous les appareils abonnés de `userId` ; ne lève jamais d'erreur. */
  send(userId: string, msg: PushMessage): Promise<void>;
}

export const disabledPusher: Pusher = { enabled: false, publicKey: null, send: async () => {} };

type Sender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<unknown>;

/** Notifications push (Web Push + VAPID). Sans clés, tout est désactivé sans erreur. `sender` sert aux tests. */
export function createPusher(prisma: PrismaClient, opts: { publicKey?: string; privateKey?: string; subject?: string }, sender?: Sender): Pusher {
  if (!opts.publicKey || !opts.privateKey) return disabledPusher;
  const subject = opts.subject || "mailto:contact@quiz-education.org";
  const doSend: Sender = sender ?? ((sub, payload) => webpush.sendNotification(sub, payload, { TTL: 86_400, urgency: "high", vapidDetails: { subject, publicKey: opts.publicKey!, privateKey: opts.privateKey! } }));
  return {
    enabled: true,
    publicKey: opts.publicKey,
    async send(userId, msg) {
      try {
        const subs = await prisma.pushSubscription.findMany({ where: { userId } });
        const payload = JSON.stringify(msg);
        await Promise.all(subs.map(async (s) => {
          try {
            await doSend({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          } catch (e) {
            const code = (e as { statusCode?: number }).statusCode;
            // Abonnement expiré ou désinstallé : on le supprime.
            if (code === 404 || code === 410) await prisma.pushSubscription.deleteMany({ where: { id: s.id } }).catch(() => {});
          }
        }));
      } catch { /* la notification est un plus : jamais bloquante */ }
    },
  };
}

type Payload = Record<string, any>;
/** Traduit un événement temps réel en notification (null = pas de notification). */
export function notificationFor(event: string, p: Payload): PushMessage | null {
  switch (event) {
    case "duel:turn": return { title: "C'est ton tour !", body: `${p.from?.username ?? "Ton adversaire"} a joué : à toi de répondre.`, url: "/#/duels", tag: `duel-${p.duelId}` };
    case "duel:challenged": return { title: "Nouveau défi", body: `${p.from?.username ?? "Un camarade"} te défie en duel.`, url: "/#/duels", tag: `duel-${p.duelId}` };
    case "duel:invited": return { title: "Défi en direct", body: `${p.from?.username ?? "Un camarade"} te défie maintenant !`, url: "/#/duels", tag: "live-invite" };
    case "chat:message": return { title: String(p.from ?? "Nouveau message"), body: String(p.preview ?? ""), url: `/#/friends/${p.friendshipId}`, tag: `chat-${p.friendshipId}` };
    case "friend:request": return { title: "Invitation d'ami", body: `${p.from} t'invite à devenir ami.`, url: "/#/friends", tag: "friend-request" };
    case "friend:accepted": return { title: "Nouvel ami", body: `${p.by} a accepté ton invitation.`, url: "/#/friends", tag: "friend-accepted" };
    default: return null;
  }
}
