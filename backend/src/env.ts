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
