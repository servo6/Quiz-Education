import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z
    .string({ required_error: "DATABASE_URL manquant (chaîne de connexion Supabase, voir README)" })
    .regex(/^postgres(ql)?:\/\//, "DATABASE_URL doit commencer par postgresql://")
    .refine((v) => !v.includes("MOT_DE_PASSE"), "DATABASE_URL contient encore le texte d'exemple : colle ta vraie chaîne de connexion"),
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET doit faire au moins 32 caractères")
    .refine((v) => !v.startsWith("remplace-moi"), "JWT_SECRET contient encore la valeur d'exemple"),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("127.0.0.1"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  ADMIN_USERNAME: z.string().optional(),
  ADMIN_PASSWORD: z
    .string()
    .optional()
    .refine((v) => v === undefined || !v.startsWith("change-moi"), "ADMIN_PASSWORD contient encore la valeur d'exemple"),
  /** Envoi d'e-mails : "console" (affiche les liens dans le terminal), "brevo" ou "resend". */
  MAIL_PROVIDER: z.enum(["console", "brevo", "resend"]).default("console"),
  MAIL_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().email().optional(),
  MAIL_FROM_NAME: z.string().default("Quiz"),
  /** Adresse publique du site, utilisée dans les liens des e-mails (ex. https://quiz-education.onrender.com). */
  APP_URL: z.string().url().optional(),
  REGISTRATION_OPEN: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")} : ${i.message}`);
    throw new Error(`Configuration invalide :\n${lines.join("\n")}`);
  }
  return parsed.data;
}
