/**
 * Met la base à jour (chronomètre des duels différés, amis, messagerie, couleur et blocage des chapitres) SANS passer par `prisma migrate`.
 *
 * À utiliser quand `npx prisma migrate dev` n'arrive pas à joindre la base (erreur P1001) alors que le serveur,
 * lui, s'y connecte : ce script utilise exactement la même connexion que le serveur.
 * Sans danger : il ne fait qu'ajouter ce qui manque (rien n'est supprimé) et peut être relancé à volonté.
 */
import pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "../src/password.ts";
import { pgPoolConfig } from "../src/pgConfig.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL manquant (fichier .env)");

const STEPS: string[] = [
  // Ligues hebdomadaires.
  `CREATE TABLE IF NOT EXISTS "LeagueMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "subjectId" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 0,
    "lastMove" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "LeagueMember_userId_subjectId_key" ON "LeagueMember"("userId", "subjectId")`,
  `CREATE INDEX IF NOT EXISTS "LeagueMember_subjectId_tier_idx" ON "LeagueMember"("subjectId", "tier")`,
  `CREATE TABLE IF NOT EXISTS "LeagueWeek" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subjectId" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "LeagueWeek_subjectId_weekKey_key" ON "LeagueWeek"("subjectId", "weekKey")`,
  `ALTER TABLE "LeagueMember" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "LeagueWeek" ENABLE ROW LEVEL SECURITY`,
  // Salons privés : historique, pièces et achats.
  `CREATE TABLE IF NOT EXISTS "RoomGame" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subjectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "RoomGame_subjectId_finishedAt_idx" ON "RoomGame"("subjectId", "finishedAt")`,
  `CREATE TABLE IF NOT EXISTS "RoomPlayer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gameId" TEXT NOT NULL REFERENCES "RoomGame"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "username" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "correct" INTEGER NOT NULL,
    "xpEarned" INTEGER NOT NULL DEFAULT 0,
    "coinsEarned" INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "RoomPlayer_gameId_userId_key" ON "RoomPlayer"("gameId", "userId")`,
  `CREATE INDEX IF NOT EXISTS "RoomPlayer_userId_idx" ON "RoomPlayer"("userId")`,
  `CREATE TABLE IF NOT EXISTS "CoinLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "CoinLedger_userId_idx" ON "CoinLedger"("userId")`,
  `CREATE TABLE IF NOT EXISTS "ItemUnlock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "itemId" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ItemUnlock_userId_itemId_key" ON "ItemUnlock"("userId", "itemId")`,
  `ALTER TABLE "RoomGame" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "RoomPlayer" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "CoinLedger" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "ItemUnlock" ENABLE ROW LEVEL SECURITY`,
  // Examen blanc.
  `CREATE TABLE IF NOT EXISTS "ExamAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "subjectId" TEXT NOT NULL,
    "questionIds" TEXT NOT NULL,
    "answers" TEXT NOT NULL DEFAULT '{}',
    "durationSec" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "correct" INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS "ExamAttempt_userId_subjectId_finishedAt_idx" ON "ExamAttempt"("userId", "subjectId", "finishedAt")`,
  `ALTER TABLE "ExamAttempt" ENABLE ROW LEVEL SECURITY`,
  // Rappel de cours par chapitre.
  `ALTER TABLE "Chapter" ADD COLUMN IF NOT EXISTS "lesson" TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3)`,
  // Salons privés : état conservé pour survivre à un redémarrage.
  `CREATE TABLE IF NOT EXISTS "RoomSnapshot" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "data" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `ALTER TABLE "RoomSnapshot" ENABLE ROW LEVEL SECURITY`,
  // Signalements de questions.
  `CREATE TABLE IF NOT EXISTS "QuestionReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "questionId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "QuestionReport_userId_questionId_key" ON "QuestionReport"("userId", "questionId")`,
  `CREATE INDEX IF NOT EXISTS "QuestionReport_subjectId_status_idx" ON "QuestionReport"("subjectId", "status")`,
  `ALTER TABLE "QuestionReport" ENABLE ROW LEVEL SECURITY`,
  // Révision espacée : une carte par (joueur, question ratée).
  `CREATE TABLE IF NOT EXISTS "ReviewCard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "questionId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "box" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lapses" INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ReviewCard_userId_questionId_key" ON "ReviewCard"("userId", "questionId")`,
  `CREATE INDEX IF NOT EXISTS "ReviewCard_userId_subjectId_dueAt_idx" ON "ReviewCard"("userId", "subjectId", "dueAt")`,
  `ALTER TABLE "ReviewCard" ENABLE ROW LEVEL SECURITY`,
  // Défi du jour : mêmes questions pour tous les membres d'une matière.
  `CREATE TABLE IF NOT EXISTS "DailyChallenge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subjectId" TEXT NOT NULL REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "day" TEXT NOT NULL,
    "questionIds" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "DailyChallenge_subjectId_day_key" ON "DailyChallenge"("subjectId", "day")`,
  `CREATE TABLE IF NOT EXISTS "DailyEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "challengeId" TEXT NOT NULL REFERENCES "DailyChallenge"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "answers" TEXT NOT NULL DEFAULT '[]',
    "servedAt" TIMESTAMP(3),
    "correct" INTEGER NOT NULL DEFAULT 0,
    "timeMs" INTEGER NOT NULL DEFAULT 0,
    "xpEarned" INTEGER NOT NULL DEFAULT 0,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "DailyEntry_challengeId_userId_key" ON "DailyEntry"("challengeId", "userId")`,
  `CREATE INDEX IF NOT EXISTS "DailyEntry_userId_idx" ON "DailyEntry"("userId")`,
  `ALTER TABLE "DailyChallenge" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "DailyEntry" ENABLE ROW LEVEL SECURITY`,
  // Notifications push : un appareil abonné par ligne.
  `CREATE TABLE IF NOT EXISTS "PushSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint")`,
  `CREATE INDEX IF NOT EXISTS "PushSubscription_userId_idx" ON "PushSubscription"("userId")`,
  `ALTER TABLE "PushSubscription" ENABLE ROW LEVEL SECURITY`,
  // Chronomètre propre à chaque joueur sur une question (duels différés) : c'est elle qui manquait si la manche ne démarrait pas.
  `CREATE TABLE IF NOT EXISTS "QuestionServe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gameQuestionId" TEXT NOT NULL REFERENCES "GameQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "userId" TEXT NOT NULL,
    "servedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "QuestionServe_gameQuestionId_userId_key" ON "QuestionServe"("gameQuestionId", "userId")`,
  `ALTER TABLE "QuestionServe" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "GamePlayer" ADD COLUMN IF NOT EXISTS "hiddenAt" TIMESTAMP(3)`,
  `ALTER TABLE "Chapter" ADD COLUMN IF NOT EXISTS "color" TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE "Chapter" ADD COLUMN IF NOT EXISTS "locked" BOOLEAN NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS "Friendship" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subjectId" TEXT NOT NULL REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "requesterId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "addresseeId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Friendship_subjectId_requesterId_addresseeId_key" ON "Friendship"("subjectId", "requesterId", "addresseeId")`,
  `CREATE INDEX IF NOT EXISTS "Friendship_addresseeId_status_idx" ON "Friendship"("addresseeId", "status")`,
  `CREATE INDEX IF NOT EXISTS "Friendship_requesterId_status_idx" ON "Friendship"("requesterId", "status")`,
  `CREATE TABLE IF NOT EXISTS "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "friendshipId" TEXT NOT NULL REFERENCES "Friendship"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "senderId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3)
  )`,
  `CREATE INDEX IF NOT EXISTS "Message_friendshipId_createdAt_idx" ON "Message"("friendshipId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "Message_createdAt_idx" ON "Message"("createdAt")`,
  // Comme les autres tables : inaccessibles par l'API publique de Supabase (voir scripts/enable-rls.ts).
  `ALTER TABLE "Friendship" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY`,

  // ── Organisations (organisation → matière → chapitre → question) et hiérarchie des comptes
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "createdById" TEXT`,
  `CREATE TABLE IF NOT EXISTS "Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "accessName" TEXT NOT NULL,
    "accessPasswordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Organization_name_key" ON "Organization"("name")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Organization_accessName_key" ON "Organization"("accessName")`,
  `CREATE TABLE IF NOT EXISTS "OrgAdmin" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "OrgAdmin_userId_organizationId_key" ON "OrgAdmin"("userId", "organizationId")`,
  `CREATE TABLE IF NOT EXISTS "OrgMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "OrgMember_userId_organizationId_key" ON "OrgMember"("userId", "organizationId")`,
  `ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "OrgAdmin" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "OrgMember" ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE "Subject" ADD COLUMN IF NOT EXISTS "organizationId" TEXT`,
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "email" TEXT`,
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3)`,
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "verifyDeadline" TIMESTAMP(3)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email")`,
  `CREATE TABLE IF NOT EXISTS "EmailToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "kind" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "EmailToken_tokenHash_key" ON "EmailToken"("tokenHash")`,
  `CREATE INDEX IF NOT EXISTS "EmailToken_userId_kind_idx" ON "EmailToken"("userId", "kind")`,
  `ALTER TABLE "EmailToken" ENABLE ROW LEVEL SECURITY`,
  // Comptes de gestion existants : 3 jours à partir de maintenant pour vérifier leur adresse (une seule fois)
  `UPDATE "User" SET "verifyDeadline" = now() + interval '3 days' WHERE "role" IN ('ORG_ADMIN','SUBJECT_MANAGER') AND "verifyDeadline" IS NULL AND "emailVerifiedAt" IS NULL`,
];

/** Étapes qui dépendent des données : organisation « Principale », rattachement des matières, joueurs, comptes de gestion. */
async function migrateToOrganizations(c: pg.Client): Promise<string[]> {
  const notes: string[] = [];
  const orphan = await c.query(`SELECT count(*)::int AS n FROM "Subject" WHERE "organizationId" IS NULL`);
  let orgId: string | null = null;
  if (orphan.rows[0].n > 0) {
    const existing = await c.query(`SELECT "id" FROM "Organization" WHERE "name" = 'Principale'`);
    if (existing.rows.length) orgId = existing.rows[0].id;
    else {
      orgId = randomUUID();
      const password = randomBytes(9).toString("base64url");
      await c.query(`INSERT INTO "Organization"("id","name","accessName","accessPasswordHash") VALUES ($1,'Principale','principale',$2)`, [orgId, await hashPassword(password)]);
      notes.push(`Organisation « Principale » créée. Nom d'accès : principale — mot de passe d'accès : ${password} (change-le dans l'interface).`);
    }
    await c.query(`UPDATE "Subject" SET "organizationId" = $1 WHERE "organizationId" IS NULL`, [orgId]);
    notes.push(`${orphan.rows[0].n} matière(s) placée(s) dans l'organisation « Principale ».`);
  }
  await c.query(`ALTER TABLE "Subject" ALTER COLUMN "organizationId" SET NOT NULL`);
  await c.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Subject_organizationId_fkey') THEN
      ALTER TABLE "Subject" ADD CONSTRAINT "Subject_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF; END $$`);
  await c.query(`DROP INDEX IF EXISTS "Subject_name_key"`);
  await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS "Subject_organizationId_name_key" ON "Subject"("organizationId","name")`);

  // Chaque joueur déjà inscrit à une matière devient membre de l'organisation de cette matière.
  const added = await c.query(`INSERT INTO "OrgMember"("id","userId","organizationId")
    SELECT gen_random_uuid()::text, m."userId", s."organizationId" FROM "Membership" m
    JOIN "Subject" s ON s."id" = m."subjectId" JOIN "User" u ON u."id" = m."userId" AND u."role" = 'USER'
    GROUP BY m."userId", s."organizationId" ON CONFLICT DO NOTHING`);
  if (added.rowCount) notes.push(`${added.rowCount} joueur(s) rattaché(s) à leur organisation.`);

  // Un seul super administrateur (le plus ancien) ; les autres ADMIN deviennent administrateurs de l'organisation de leurs matières / « Principale ».
  const admins = await c.query(`SELECT "id","username" FROM "User" WHERE "role" = 'ADMIN' ORDER BY "createdAt" ASC, "id" ASC`);
  for (const extra of admins.rows.slice(1)) {
    await c.query(`UPDATE "User" SET "role" = 'ORG_ADMIN' WHERE "id" = $1`, [extra.id]);
    await c.query(`INSERT INTO "OrgAdmin"("id","userId","organizationId") SELECT gen_random_uuid()::text, $1, "id" FROM "Organization" ON CONFLICT DO NOTHING`, [extra.id]);
    await c.query(`DELETE FROM "Membership" WHERE "userId" = $1`, [extra.id]);
    notes.push(`Le compte « ${extra.username} » n'est plus super administrateur : il devient administrateur d'organisation.`);
  }
  // Les comptes de gestion ne sont pas des joueurs.
  await c.query(`DELETE FROM "Membership" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "role" <> 'USER')`);
  await c.query(`DELETE FROM "OrgMember" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "role" <> 'USER')`);
  return notes;
}

const client = new pg.Client(pgPoolConfig(url));
await client.connect();
try {
  await client.query("BEGIN");
  for (const sql of STEPS) await client.query(sql);
  const notes = await migrateToOrganizations(client);
  await client.query("COMMIT");
  for (const n of notes) console.log(n);
  console.log("Base de données mise à jour : chronomètre des duels, amis, messagerie, chapitres, organisations. Relance `npm run dev`.");
} catch (e) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw e;
} finally {
  await client.end();
}
