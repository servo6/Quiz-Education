export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}
/** État du dernier envoi (diagnostic administrateur). */
export interface MailState {
  lastOkAt?: string;
  lastError?: { at: string; message: string };
}
export interface Mailer {
  send(mail: Mail): Promise<void>;
  /** Faux si aucun fournisseur n'est configuré : les e-mails ne partent pas (ils sont seulement affichés dans le terminal). */
  readonly configured: boolean;
  readonly provider: string;
  readonly state: MailState;
  /** Boîte d'envoi en mémoire (tests). */
  outbox?: Mail[];
}
export interface MailConfig {
  provider: "console" | "brevo" | "resend" | "memory";
  apiKey?: string;
  from?: string;
  fromName?: string;
  /** Adresse de l'API du fournisseur (tests uniquement). */
  endpoint?: string;
  timeoutMs?: number;
}

/** Échec d'envoi : message technique pour les journaux et les administrateurs, jamais montré tel quel aux joueurs. */
export class MailError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

/** Envoi par l'API HTTP d'un fournisseur (aucun port SMTP : ils sont bloqués sur les hébergements gratuits). */
export function createMailer(cfg: MailConfig): Mailer {
  const state: MailState = {};
  const ok = () => { state.lastOkAt = new Date().toISOString(); };
  const ko = (e: unknown) => { state.lastError = { at: new Date().toISOString(), message: e instanceof Error ? e.message : String(e) }; };

  if (cfg.provider === "memory") {
    const outbox: Mail[] = [];
    return { outbox, state, configured: true, provider: "memory", async send(m) { outbox.push(m); ok(); } };
  }
  if (cfg.provider === "console" || !cfg.apiKey || !cfg.from) {
    return {
      state, configured: false, provider: cfg.provider,
      async send(m) {
        console.log(`\n✉ E-mail non envoyé (MAIL_PROVIDER non configuré) → ${m.to}\n  ${m.subject}\n  ${m.text.replace(/\n/g, "\n  ")}\n`);
      },
    };
  }
  const name = cfg.fromName ?? "Quiz";
  const timeout = cfg.timeoutMs ?? 10_000;
  return {
    state, configured: true, provider: cfg.provider,
    async send(m) {
      const brevo = cfg.provider === "brevo";
      const url = cfg.endpoint ?? (brevo ? "https://api.brevo.com/v3/smtp/email" : "https://api.resend.com/emails");
      const init: RequestInit = brevo
        ? {
            method: "POST",
            headers: { "api-key": cfg.apiKey!, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ sender: { email: cfg.from, name }, to: [{ email: m.to }], subject: m.subject, htmlContent: m.html, textContent: m.text }),
          }
        : {
            method: "POST",
            headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ from: `${name} <${cfg.from}>`, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
          };
      try {
        let res: Response;
        try {
          res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
        } catch (e) {
          const why = (e as Error)?.name === "TimeoutError" ? `délai de ${Math.round(timeout / 1000)} s dépassé` : String((e as Error)?.message ?? e);
          throw new MailError(`Connexion à ${cfg.provider} impossible : ${why}`);
        }
        if (!res.ok) throw new MailError(`${cfg.provider} a refusé l'envoi (${res.status}) : ${(await res.text()).slice(0, 300)}`, res.status);
        ok();
      } catch (e) {
        ko(e);
        throw e;
      }
    },
  };
}
