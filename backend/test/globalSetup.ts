// The app loads this via src/env.ts, but global setup runs before any of that.
import 'dotenv/config';
import { execSync } from 'node:child_process';

/**
 * Builds a throwaway database for the suite.
 *
 * A separate database rather than the dev one: these tests deliberately create
 * bad sales, exhaust rate limits and drive stock negative, and none of that
 * should land in data someone is looking at.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? deriveTestUrl();
  process.env.DATABASE_URL = url;

  const name = new URL(url).pathname.slice(1);
  psql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  psql(`CREATE DATABASE "${name}"`);

  // `db push` rather than `migrate deploy`: the schema is the contract under
  // test, and this keeps the suite runnable before a migration exists for it.
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}

function deriveTestUrl(): string {
  const dev = process.env.DATABASE_URL;
  if (!dev) throw new Error('DATABASE_URL is not set; cannot derive a test database URL.');
  const url = new URL(dev);
  url.pathname = `${url.pathname.replace(/\/$/, '')}_test`;
  return url.toString();
}

/** Runs against the compose container, which is where the dev database lives. */
function psql(sql: string) {
  execSync(`docker exec ngpos-db psql -U ngpos -d postgres -c "${sql}"`, { stdio: 'pipe' });
}
