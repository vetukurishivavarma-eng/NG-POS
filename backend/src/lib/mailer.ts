import nodemailer, { type Transporter } from 'nodemailer';

import { env, passwordResetConfigured } from '../env.js';

let transporter: Transporter | null = null;

/**
 * Built once, lazily — creating it at import time would make every test and
 * every CLI script open an SMTP connection they never use.
 */
function getTransporter(): Transporter | null {
  if (!passwordResetConfigured) return null;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  });
  return transporter;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends a mail, or reports why it could not.
 *
 * Returns a result instead of throwing: the caller is an endpoint that must not
 * change its answer based on whether delivery worked, or it would leak which
 * addresses are real.
 */
export async function sendMail(mail: Mail): Promise<{ sent: boolean; error?: string }> {
  const tx = getTransporter();

  if (!tx) {
    // In development there is usually no SMTP server. Printing the mail keeps
    // the whole flow testable without one; guarded on NODE_ENV so a
    // misconfigured production box can never print a reset code to its logs.
    if (env.NODE_ENV !== 'production') {
      console.log(`\n--- mail (not sent: SMTP not configured) ---\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n---\n`);
      return { sent: false, error: 'SMTP not configured' };
    }
    return { sent: false, error: 'SMTP not configured' };
  }

  try {
    await tx.sendMail({ from: env.SMTP_FROM, to: mail.to, subject: mail.subject, text: mail.text });
    return { sent: true };
  } catch (err) {
    // Logged, never surfaced: the message can contain the recipient and the
    // SMTP server's own error text.
    console.error('[mail] send failed:', err instanceof Error ? err.message : err);
    return { sent: false, error: 'delivery failed' };
  }
}
