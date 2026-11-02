import { purgeExpiredMessages } from "./routes/social.ts";
import { buildApp } from "./app.ts";
import { ensureAdmin } from "./bootstrap.ts";
import { loadEnv } from "./config.ts";
import { createPrisma } from "./db.ts";
import { ensureDefaultAvatarItems } from "./avatar.ts";
import { ensureDefaultBadges } from "./badges.ts";
import { expireDueDuels, notifyEnded } from "./routes/duelAsync.ts";

const env = loadEnv();
const prisma = createPrisma(env.DATABASE_URL);

// La base est distante (Supabase) : on patiente si le réseau est lent ou coupé au démarrage, au lieu de planter.
for (let attempt = 1; ; attempt++) {
  try {
    await prisma.$queryRaw`SELECT 1`;
    break;
  } catch (e) {
    if (attempt >= 6) {
      console.error("\n✖ Impossible de joindre la base de données après 6 essais.\n  Vérifie ta connexion Internet (Wi-Fi, VPN, pare-feu) puis relance : npm run dev\n  Détail : " + String((e as Error).message ?? e).split("\n").filter(Boolean).slice(-1)[0] + "\n");
      process.exit(1);
    }
    console.warn(`Base de données injoignable (essai ${attempt}/6), nouvelle tentative dans 5 s…`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

if (env.ADMIN_USERNAME && env.ADMIN_PASSWORD) {
  const status = await ensureAdmin(prisma, env.ADMIN_USERNAME, env.ADMIN_PASSWORD);
  if (status === "created") console.log(`Compte administrateur « ${env.ADMIN_USERNAME} » créé.`);
}

// Un administrateur n'est pas un joueur : on retire d'anciennes appartenances éventuelles.
await prisma.membership.deleteMany({ where: { user: { role: "ADMIN" } } });
// Et on clôt les duels non terminés où figurait un administrateur : ils ne pourraient plus être joués.
await prisma.game.updateMany({ where: { status: "IN_PROGRESS", mode: { in: ["DUEL", "FRIENDLY"] }, players: { some: { user: { role: "ADMIN" } } } }, data: { status: "ABANDONED" } });
// Messagerie : suppression des messages expirés au démarrage, puis toutes les heures.
await Promise.all([purgeExpiredMessages(prisma), prisma.questionServe.count({ take: 1 }), prisma.friendship.count({ take: 1 }), prisma.chapter.findFirst({ select: { locked: true } })]).catch((e: unknown) => {
  const text = String((e as Error)?.message ?? e);
  if (/undefined \(reading/.test(text)) {
    console.error("\n⚠ Le client Prisma n'a pas été régénéré après la mise à jour.\n  Arrête le serveur, lance : npx prisma generate  puis : npm run dev\n");
  } else {
    console.error("\n⚠ La base de données n'est pas à jour (tables amis/messagerie absentes ?).\n  Arrête le serveur, lance : npm run db:patch  puis : npm run dev\n  Détail : " + text.split("\n").filter(Boolean).slice(-1)[0] + "\n");
  }
});
setInterval(() => purgeExpiredMessages(prisma).catch((e) => console.error("purge messages", e)), 3_600_000).unref();
await ensureDefaultBadges(prisma);
await ensureDefaultAvatarItems(prisma);

// Réchauffe le pool (ouvre plusieurs connexions d'avance) et le garde chaud : la première requête n'attend plus la connexion.
const warm = () => Promise.all(Array.from({ length: 4 }, () => prisma.$queryRaw`SELECT 1`)).catch(() => {});
await warm();
setInterval(warm, 20_000).unref();

const app = await buildApp({
  prisma,
  jwtSecret: env.JWT_SECRET,
  secureCookies: env.NODE_ENV === "production",
  registrationOpen: env.REGISTRATION_OPEN,
  logger: true,
  cache: true,
  staticDir: "public",
});

const orphans = await app.duels.recoverOrphans();
if (orphans > 0) console.log(`${orphans} duel(s) interrompu(s) par le redémarrage marqué(s) comme abandonné(s).`);

// Duels différés : ceux dont le délai est dépassé sont clôturés (au démarrage, puis toutes les 5 minutes).
const sweep = () => expireDueDuels(prisma, new Date(), (id) => notifyEnded(prisma, app.hub, id)).catch((e) => app.log.error(e, "expiration des duels"));
await sweep();
const sweeper = setInterval(sweep, 5 * 60_000);
sweeper.unref();

const stop = async () => {
  clearInterval(sweeper);
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await app.listen({ port: env.PORT, host: env.HOST });
