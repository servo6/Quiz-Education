import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSQLite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Comme Prisma Migrate, un chemin SQLite relatif est relatif au dossier `prisma/`
 * (ainsi `file:./dev.db` désigne le même fichier pour les migrations et pour le serveur).
 */
export function resolveSqlitePath(databaseUrl: string): string {
  const p = databaseUrl.replace(/^file:/, "");
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), "prisma", p);
}

/**
 * SQLite en local, PostgreSQL en ligne : le choix se fait uniquement avec DATABASE_URL.
 * (Pour PostgreSQL, penser aussi à changer `provider` dans prisma/schema.prisma.)
 */
export function createPrisma(databaseUrl: string): PrismaClient {
  const adapter = databaseUrl.startsWith("file:")
    ? new PrismaBetterSQLite3({ url: `file:${resolveSqlitePath(databaseUrl)}` })
    : new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}
