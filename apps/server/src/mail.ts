import { createTransport } from "nodemailer";

export type Mail = { to: string; subject: string; text: string; html?: string };
export type SendMail = (mail: Mail) => Promise<void>;

export type MailConfig = {
  plunkApiKey?: string;
  plunkApiUrl: string;
  smtpUrl?: string;
  mailFrom?: string;
};

// Plunk wins over SMTP, and SMTP over the console. The console branch only writes the code or invite link to the log,
// so it is for development. Nothing else can reach the user.
export function createMailer(config: MailConfig, fetchFn: typeof fetch = fetch): SendMail {
  if (config.plunkApiKey) return viaPlunk(config.plunkApiKey, config.plunkApiUrl, config.mailFrom, fetchFn);
  if (config.smtpUrl) return viaSmtp(config.smtpUrl, config.mailFrom);
  return async (mail) => {
    console.log(`mail to ${mail.to}: ${mail.subject}\n${mail.text}`);
  };
}

// https://docs.useplunk.com: POST /v1/send, with the body as plain text or HTML.
function viaPlunk(apiKey: string, apiUrl: string, from: string | undefined, fetchFn: typeof fetch): SendMail {
  const endpoint = `${apiUrl.replace(/\/+$/, "")}/v1/send`;
  return async (mail) => {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ to: mail.to, subject: mail.subject, body: mail.html ?? mail.text, from }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Plunk send failed with ${res.status}: ${await res.text()}`);
  };
}

// SMTP_URL is a connection URL such as smtps://user:pass@smtp.example.com:465.
function viaSmtp(smtpUrl: string, from: string | undefined): SendMail {
  const transport = createTransport(smtpUrl);
  return async (mail) => {
    await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
  };
}
