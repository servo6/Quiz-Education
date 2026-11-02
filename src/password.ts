import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Hachage scrypt (intégré à Node, résistant aux attaques par GPU).
 * Format stocké : scrypt$N$r$p$sel(base64)$hash(base64)
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const OPTIONS: ScryptOptions = { N, r: R, p: P, maxmem: 128 * N * R * 2 };

function derive(password: string, salt: Buffer, opts: ScryptOptions, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, OPTIONS, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const opts: ScryptOptions = { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2 };
  const actual = await derive(password, Buffer.from(saltB64, "base64"), opts, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/** Vérification factice pour que "utilisateur inconnu" et "mot de passe faux" prennent le même temps. */
export async function fakeVerify(password: string): Promise<false> {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  await verifyPassword(password, await dummyHash);
  return false;
}
