/**
 * Active la sécurité par ligne (RLS) sur toutes les tables du schéma `public`.
 *
 * Pourquoi : Supabase expose les tables de `public` par une API REST publique. Sans RLS, quiconque possède la clé
 * publique du projet pourrait lire ou modifier les données. Sans aucune politique, RLS bloque tout accès par cette
 * API ; le serveur, lui, se connecte directement à PostgreSQL (rôle propriétaire) et n'est pas concerné.
 *
 * À relancer après chaque migration qui ajoute des tables : `npm run db:rls` (sans danger si déjà fait).
 */
import pg from "pg";
import { pgPoolConfig } from "../src/pgConfig.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL manquant (fichier .env)");

const client = new pg.Client(pgPoolConfig(url));
await client.connect();
try {
  const { rows } = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  for (const { tablename } of rows) {
    await client.query(`ALTER TABLE "public"."${tablename}" ENABLE ROW LEVEL SECURITY`);
  }
  const check = await client.query<{ tablename: string; rowsecurity: boolean }>(
    "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const off = check.rows.filter((r) => !r.rowsecurity);
  console.log(`RLS activé sur ${check.rows.length - off.length}/${check.rows.length} tables.`);
  if (off.length) {
    console.error("Sans RLS :", off.map((r) => r.tablename).join(", "));
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
