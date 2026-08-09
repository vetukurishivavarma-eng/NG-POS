import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('30d'),
  /** Comma-separated list, or `*` to allow any origin. */
  CORS_ORIGINS: z.string().default('*'),

  /**
   * The shops' timezone. Reporting days are cut here, not on the server clock —
   * Railway containers run UTC, which would otherwise push every evening sale
   * onto the next day's Z-report.
   */
  REPORT_TIMEZONE: z.string().default('Africa/Lusaka'),

  /**
   * How much of a line a CASHIER may discount, as a percentage. Managers and
   * admins are unlimited — that is what a manager override is for.
   *
   * Without a ceiling, "discount" is just a price override by another name:
   * a cashier could take any item to zero, which is precisely the hole that
   * removing `unit_price` from the sale schema closed. Set to 0 to require a
   * manager for every discount.
   */
  MAX_CASHIER_DISCOUNT_PERCENT: z.coerce.number().min(0).max(100).default(10),
  /**
   * Where password-reset requests are sent.
   *
   * Deliberately *not* the address that asked. Shop staff are created with
   * internal addresses (`cashier@ngpos.local`) that no mailbox answers, and
   * mailing a reset to an address an attacker controls is the whole class of
   * bug this avoids. A human administrator receives the request and passes the
   * code on to the person standing in front of them.
   *
   * Unset means the feature is off: the endpoint then says so rather than
   * silently accepting requests nobody will ever read.
   */
  PASSWORD_RESET_NOTIFY_EMAIL: z.string().email().optional(),
  /** Minutes a reset code stays valid. Short — it is read off a phone in a shop. */
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().min(5).max(1440).default(30),

  /**
   * Resend's HTTP API key, and the preferred transport when set.
   *
   * Render's free plan blocks outbound traffic to ports 25, 465 and 587, so
   * SMTP from a free web service hangs rather than fails. Resend goes out over
   * HTTPS on 443 instead. Until a sending domain is verified with them, `from`
   * must be `onboarding@resend.dev` and mail only reaches the account owner's
   * own address — which is all this feature needs, since every code goes to one
   * administrator.
   */
  RESEND_API_KEY: z.string().optional(),

  /**
   * The From address, for whichever transport is in use. Falls back to
   * SMTP_FROM so an existing SMTP-only deployment keeps working unchanged.
   */
  MAIL_FROM: z.string().optional(),

  /** SMTP, for local development and for hosts that allow outbound mail. */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  /** false for STARTTLS on 587, true for implicit TLS on 465. */
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Shown in the subject line so an admin with several shops can tell them apart. */
  APP_NAME: z.string().default('NG POS'),

  /** Set false on a second instance so the job only runs once. */
  CRON_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Close-of-business snapshot of the day that is ending. */
  DAILY_REPORT_CRON: z.string().default('5 21 * * *'),
  /** After midnight: re-run yesterday, catching late syncs, and seal it. */
  DAILY_REPORT_SEAL_CRON: z.string().default('20 0 * * *'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Fail loudly at boot rather than at the first request that needs the value.
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

export const corsOrigins =
  env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((o) => o.trim());

/** The From address, whichever transport ends up carrying the mail. */
export const mailFrom = env.MAIL_FROM ?? env.SMTP_FROM;

/** Either transport will do, but one of them must be complete. */
const resendReady = Boolean(env.RESEND_API_KEY);
const smtpReady = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD);

/** True only when a reset mail can actually be delivered to a real mailbox. */
export const passwordResetConfigured = Boolean(
  env.PASSWORD_RESET_NOTIFY_EMAIL && mailFrom && (resendReady || smtpReady)
);

// A production deployment that half-configured this would look fine until the
// first person forgot their password, so say it at boot instead.
if (env.NODE_ENV === 'production' && env.PASSWORD_RESET_NOTIFY_EMAIL && !passwordResetConfigured) {
  console.warn(
    '[startup] PASSWORD_RESET_NOTIFY_EMAIL is set, but no usable mail transport is. ' +
      'Set RESEND_API_KEY (preferred on Render — its free plan blocks SMTP ports), ' +
      'or SMTP_HOST/USER/PASSWORD, and a MAIL_FROM address. ' +
      'Password reset stays disabled until then.'
  );
}
