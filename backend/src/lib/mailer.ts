import nodemailer, { type Transporter } from 'nodemailer';

import { env, mailFrom, passwordResetConfigured } from '../env.js';

/**
 * There are two ways out of the box, because the host decides which is even
 * possible:
 *
 * - **Resend, over HTTPS.** Render's free plan drops outbound traffic to ports
 *   25, 465 and 587, so SMTP from a free web service does not fail cleanly — it
 *   hangs until the socket gives up. An HTTP API on 443 is untouched by that.
 * - **SMTP**, for local development and for any host that permits it.
 *
 * Resend wins when both are configured: if someone went to the trouble of
 * setting an API key, the SMTP block is the reason.
 */

/**
 * Every path out of here is capped at this.
 *
 * Nodemailer's own defaults are two minutes to connect and ten on the socket,
 * which on a host that silently drops SMTP is exactly how long the caller
 * waits. Nothing here is worth more than a few seconds — the reply does not
 * depend on the outcome.
 */
const MAIL_TIMEOUT_MS = 8_000;

let transporter: Transporter | null = null;

/**
 * Built lazily — creating it at import time would open an SMTP connection in
 * every test run and every CLI script that never sends anything.
 */
function getTransporter(): Transporter | null {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD) return null;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    connectionTimeout: MAIL_TIMEOUT_MS,
    greetingTimeout: MAIL_TIMEOUT_MS,
    socketTimeout: MAIL_TIMEOUT_MS,
  });
  return transporter;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface MailResult {
  sent: boolean;
  error?: string;
}

/**
 * Posts to Resend's HTTP API. No SDK: this is one JSON request, and a
 * dependency that wraps `fetch` is a dependency to keep patched.
 */
async function sendViaResend(mail: Mail): Promise<MailResult> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: mailFrom,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
    }),
    signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
  });

  if (!res.ok) {
    // Resend puts the useful part in the body — an unverified sending domain
    // and a bad key are both 403 and indistinguishable by status alone.
    const body = await res.text().catch(() => '');
    return { sent: false, error: `resend ${res.status}: ${body.slice(0, 300)}` };
  }
  return { sent: true };
}

async function sendViaSmtp(tx: Transporter, mail: Mail): Promise<MailResult> {
  await tx.sendMail({ from: mailFrom, to: mail.to, subject: mail.subject, text: mail.text });
  return { sent: true };
}

/**
 * Sends a mail, or reports why it could not.
 *
 * Returns a result and never throws: the caller is an endpoint that must not
 * change its answer based on whether delivery worked, or it would leak which
 * addresses are real.
 */
export async function sendMail(mail: Mail): Promise<MailResult> {
  if (!passwordResetConfigured) {
    // In development there is usually neither an API key nor an SMTP server.
    // Printing the mail keeps the whole flow testable without one; guarded on
    // NODE_ENV so a misconfigured production box can never print a reset code
    // into its logs, where it would outlive the code's own expiry.
    if (env.NODE_ENV !== 'production') {
      console.log(
        `\n--- mail (not sent: no mail transport configured) ---\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n---\n`
      );
    }
    return { sent: false, error: 'no mail transport configured' };
  }

  try {
    if (env.RESEND_API_KEY) return await sendViaResend(mail);

    const tx = getTransporter();
    if (tx) return await sendViaSmtp(tx, mail);

    return { sent: false, error: 'no mail transport configured' };
  } catch (err) {
    // Returned, not thrown, and never surfaced to the caller: the message can
    // carry the recipient and the provider's own error text.
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}
