/**
 * Met la base à jour (chronomètre des duels différés, amis, messagerie, couleur et blocage des chapitres) SANS passer par `prisma migrate`.
 *
 * À utiliser quand `npx prisma migrate dev` n'arrive pas à joindre la base (erreur P1001) alors que le serveur,
 * lui, s'y connecte : ce script utilise exactement la même connexion que le serveur.
 * Sans danger : il ne fait qu'ajouter ce qui manque (rien n'est supprimé) et peut être relancé à volonté.
 */
import pg from "pg";
import { pgPoolConfig } from "../src/pgConfig.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL manquant (fichier .env)");

const STEPS: string[] = [
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
];

const client = new pg.Client(pgPoolConfig(url));
await client.connect();
try {
  await client.query("BEGIN");
  for (const sql of STEPS) await client.query(sql);
  await client.query("COMMIT");
  console.log("Base de données mise à jour : chronomètre des duels, amis, messagerie, chapitres. Relance `npm run dev`.");
} catch (e) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw e;
} finally {
  await client.end();
}
