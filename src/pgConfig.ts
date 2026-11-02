import fs from "node:fs";
import type { PoolConfig } from "pg";

export interface PgOptions {
  /** Nombre maximum de connexions ouvertes par ce processus. */
  max?: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Prépare la configuration du pool PostgreSQL à partir de DATABASE_URL.
 *
 * - Les paramètres `sslmode`, `pgbouncer` et `schema` sont retirés de l'URL : le pilote `pg` les laisserait
 *   écraser nos réglages SSL, et `schema` est géré à part (voir db.ts).
 * - Hors machine locale, la connexion est chiffrée (SSL). Si `DATABASE_SSL_CA` pointe vers le certificat
 *   racine du fournisseur (téléchargeable dans les réglages de la base Supabase), l'identité du serveur est vérifiée.
 *   Sans lui, la connexion est chiffrée mais l'identité du serveur n'est pas vérifiée.
 */
export function pgPoolConfig(databaseUrl: string, options: PgOptions = {}): PoolConfig {
  const url = new URL(databaseUrl);
  for (const key of ["sslmode", "pgbouncer", "schema"]) url.searchParams.delete(key);

  // Connexions gardées ouvertes : le défaut de `pg` les ferme après 10 s d'inactivité, et chaque réouverture vers une base
  // distante (TCP + TLS + authentification) coûte plusieurs aller-retours, soit des secondes à chaque pause du joueur.
  const config: PoolConfig = { connectionString: url.toString(), idleTimeoutMillis: 10 * 60_000, keepAlive: true, keepAliveInitialDelayMillis: 10_000 };
  if (options.max !== undefined) config.max = options.max;

  if (!LOCAL_HOSTS.has(url.hostname)) {
    const caPath = process.env.DATABASE_SSL_CA;
    config.ssl = caPath ? { ca: fs.readFileSync(caPath, "utf8"), rejectUnauthorized: true } : { rejectUnauthorized: false };
  }
  return config;
}
