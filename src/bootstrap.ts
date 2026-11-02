import type { PrismaClient } from "@prisma/client";
import { hashPassword } from "./password.ts";
import { usernameSchema } from "./routes/auth.ts";

/** Crée le premier administrateur s'il n'y en a aucun. Ne modifie jamais un compte existant. */
export async function ensureAdmin(prisma: PrismaClient, username: string, password: string): Promise<"created" | "exists"> {
  if ((await prisma.user.count({ where: { role: "ADMIN" } })) > 0) return "exists";
  const name = usernameSchema.parse(username);
  if (password.length < 8) throw new Error("ADMIN_PASSWORD doit faire au moins 8 caractères");
  await prisma.user.create({ data: { username: name, passwordHash: await hashPassword(password), role: "ADMIN" } });
  return "created";
}
