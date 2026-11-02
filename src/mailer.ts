export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export interface Mailer {
  send(mail: Mail): Promise<void>;
  /** Boîte d'envoi en mémoire (tests). */
  outbox?: Mail[];
}
export interface MailConfig {
  provider: "console" | "brevo" | "resend" | "memory";
  apiKey?: string;
  from?: string;
  fromName?: string;
}

/** Envoi par l'API HTTP d'un fournisseur (aucun port SMTP : ils sont bloqués sur les hébergements gratuits). */
export function createMailer(cfg: MailConfig): Mailer {
  if (cfg.provider === "memory") {
    const outbox: Mail[] = [];
    return { outbox, async send(m) { outbox.push(m); } };
  }
  if (cfg.provider === "console" || !cfg.apiKey || !cfg.from) {
    return {
      async send(m) {
        console.log(`\n✉ E-mail non envoyé (MAIL_PROVIDER non configuré) → ${m.to}\n  ${m.subject}\n  ${m.text.replace(/\n/g, "\n  ")}\n`);
      },
    };
  }
  const name = cfg.fromName ?? "Quiz";
  return {
    async send(m) {
      const res =
        cfg.provider === "brevo"
          ? await fetch("https://api.brevo.com/v3/smtp/email", {
              method: "POST",
              headers: { "api-key": cfg.apiKey!, "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({ sender: { email: cfg.from, name }, to: [{ email: m.to }], subject: m.subject, htmlContent: m.html, textContent: m.text }),
            })
          : await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
              body: JSON.stringify({ from: `${name} <${cfg.from}>`, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
            });
      if (!res.ok) throw new Error(`Envoi d'e-mail refusé (${res.status}) : ${(await res.text()).slice(0, 200)}`);
    },
  };
}
