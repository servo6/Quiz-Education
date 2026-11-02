import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { pgPoolConfig, type PgOptions } from "./pgConfig.ts";

export interface CreatePrismaOptions extends PgOptions {
  /** Schéma PostgreSQL à utiliser (par défaut `public`). Sert aux tests, qui travaillent dans un schéma temporaire. */
  schema?: string;
}

/** Client Prisma connecté à PostgreSQL (Supabase) par l'adaptateur `pg`. */
export function createPrisma(databaseUrl: string, options: CreatePrismaOptions = {}): PrismaClient {
  const adapter = new PrismaPg(pgPoolConfig(databaseUrl, options), options.schema ? { schema: options.schema } : undefined);
  return new PrismaClient({ adapter });
}
