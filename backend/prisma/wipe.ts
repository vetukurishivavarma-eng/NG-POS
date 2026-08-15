import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'node:fs';

/**
 * Empties a production database of trading data, keeping the schema, the
 * organisation, the administrator, and the app-release ledger.
 *
 * This is the "we tested with it, now the client trades with it" script. It is
 * not a migration and not a reset: the structure is left exactly as
 * `migrate deploy` built it, and four tables survive on purpose.
 *
 *   _prisma_migrations  Render runs `prisma migrate deploy` in its start
 *                       command. With the history gone every migration re-runs
 *                       against a schema that already exists, fails, and the
 *                       API never boots. Losing this table costs the service,
 *                       not the data.
 *   app_releases        The release ledger the fleet checks on every launch.
 *                       Not trading data and not scoped to an organisation —
 *                       emptying it silently switches off forced updates for
 *                       every till already in the field.
 *   organizations       The VAT rate, currency and product-entry window.
 *   users               Administrators only. Shop staff are trading data.
 *
 * Run it from `backend/`, against the external URL, with the target named:
 *
 *   DATABASE_URL=<external url> DIRECT_URL=<external url> \
 *   CONFIRM_DATABASE=ngpos npx tsx prisma/wipe.ts
 *
 * A JSON dump of every table is written before anything is deleted. It is not
 * a substitute for a real backup — a JSON file cannot be restored by a tool
 * that understands foreign keys — but it means the rows can still be read
 * afterwards, which is the thing actually wanted when somebody says "what was
 * that supplier called again".
 */

const prisma = new PrismaClient();

/**
 * Every table, in an order that would satisfy the foreign keys if these were
 * DELETEs. TRUNCATE does not care, but the order is what a person reads when
 * checking nothing was missed, and it doubles as the dump order.
 */
const WIPE = [
  'audit_logs',
  'password_reset_requests',
  'device_sessions',
  'daily_reports',
  'payments',
  'transaction_items',
  'transactions',
  'receipt_counters',
  'transfer_items',
  'transfers',
  'supplier_payments',
  'supplier_invoice_items',
  'supplier_invoices',
  'suppliers',
  'stock_movements',
  'warehouse_stock',
  'warehouses',
  'store_prices',
  'inventory',
  'products',
  'stores',
] as const;

const KEEP = ['_prisma_migrations', 'app_releases', 'organizations', 'users'] as const;

/**
 * Decimal and BigInt do not survive `JSON.stringify` unaided — BigInt throws
 * outright, which would lose the dump at the last step, after the read work is
 * already done.
 */
function serialise(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Buffer) return v.toString('base64');
      return v;
    },
    2
  );
}

async function counts(tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of tables) {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "${table}"`
    );
    const row = rows[0];
    if (!row) throw new Error(`No count returned for ${table}.`);
    out[table] = Number(row.n);
  }
  return out;
}

async function main() {
  /*
   * Name the database you mean to empty. The connection string is pasted in by
   * hand and the one for the dev box differs from production by a few
   * characters; this is the check that a paste into the wrong terminal cannot
   * pass.
   */
  const expected = process.env.CONFIRM_DATABASE?.trim();
  if (!expected) {
    throw new Error(
      'CONFIRM_DATABASE is not set. Set it to the database name you intend to ' +
        'empty, so that a connection string pasted from the wrong place fails ' +
        'here rather than halfway through.'
    );
  }

  const targets = await prisma.$queryRawUnsafe<
    { db: string; host: string | null; version: string }[]
  >(`SELECT current_database() AS db, inet_server_addr()::text AS host, version() AS version`);
  const target = targets[0];
  if (!target) throw new Error('The server did not answer an identity query. Nothing was changed.');

  if (target.db !== expected) {
    throw new Error(
      `Connected to "${target.db}" but CONFIRM_DATABASE says "${expected}". Nothing was changed.`
    );
  }

  console.log(`Target   ${target.db} at ${target.host}`);
  console.log(`Server   ${target.version.split(' ').slice(0, 2).join(' ')}\n`);

  const before = await counts([...WIPE, ...KEEP]);

  // Dump before touching anything, and fail the whole run if the dump fails —
  // an unreadable table is a reason to stop, not to carry on deleting.
  const dump: Record<string, unknown[]> = {};
  for (const table of [...WIPE, ...KEEP]) {
    dump[table] = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${table}"`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = process.env.DUMP_PATH ?? `ngpos-before-wipe-${stamp}.json`;
  writeFileSync(path, serialise({ takenAt: new Date().toISOString(), database: target.db, tables: dump }));
  console.log(`Dumped ${Object.values(dump).reduce((n, rows) => n + rows.length, 0)} rows to ${path}\n`);

  /*
   * One statement, one transaction. A half-emptied database is worse than
   * either end of the operation: the shops would be gone while the sales that
   * reference them stayed, and no screen in the app expects that.
   *
   * No CASCADE. Every table being emptied is named, so CASCADE could only ever
   * reach something deliberately being kept.
   */
  const list = WIPE.map((t) => `"${t}"`).join(', ');
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY`),
    // Shop staff are trading data. Administrators are how you get back in.
    prisma.$executeRawUnsafe(`DELETE FROM "users" WHERE role <> 'ORG_ADMIN'`),
    /*
     * assigned_stores is a plain text[] with no foreign key, so nothing above
     * cleans it up: the surviving admin would keep pointing at shops that no
     * longer exist. Empty means "all stores", which is what an administrator
     * should have anyway.
     */
    prisma.$executeRawUnsafe(`UPDATE "users" SET assigned_stores = '{}' WHERE assigned_stores <> '{}'`),
  ]);

  const after = await counts([...WIPE, ...KEEP]);

  const width = Math.max(...[...WIPE, ...KEEP].map((t) => t.length));
  console.log('Table'.padEnd(width) + '   before    after');
  for (const table of WIPE) {
    console.log(table.padEnd(width) + String(before[table]).padStart(9) + String(after[table]).padStart(9));
  }
  console.log('-- kept --');
  for (const table of KEEP) {
    console.log(table.padEnd(width) + String(before[table]).padStart(9) + String(after[table]).padStart(9));
  }

  const leftover = WIPE.filter((t) => after[t] !== 0);
  if (leftover.length) throw new Error(`Not empty after truncate: ${leftover.join(', ')}`);

  console.log('\nEmpty and ready. Sign in as the administrator, create the shops on the');
  console.log('Shops screen, then load the catalogue through Stock Import (CSV).');
}

main()
  .catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
