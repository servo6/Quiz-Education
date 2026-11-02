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
