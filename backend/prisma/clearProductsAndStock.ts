import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'node:fs';

/**
 * Empties the catalogue and stock across every shop, for a client asking to
 * start the product list over from a clean slate — without touching anything
 * else the wipe script would (shops, staff, suppliers, sales history, settings).
 *
 * This is narrower than `wipe.ts` on purpose: two `DELETE`s, relying on the
 * real Postgres foreign keys already in every migration to do the rest —
 * `TRUNCATE` was not used here because it would demand every table that
 * merely *references* a product be emptied too (`transaction_items`), which
 * would take receipt history down with it. A plain `DELETE` lets the
 * constraints' own `ON DELETE` actions apply, which is exactly the
 * distinction that matters:
 *
 *   DELETE FROM supplier_invoices   Cascades to supplier_invoice_items and
 *                                   supplier_payments (both ON DELETE CASCADE
 *                                   on invoice_id). Suppliers themselves and
 *                                   their contact details are untouched — only
 *                                   the paperwork and what it says is owed.
 *   DELETE FROM products            Cascades to inventory, store_prices,
 *                                   stock_movements and warehouse_stock (all
 *                                   ON DELETE CASCADE on product_id) — this is
 *                                   the actual stock-level and movement data.
 *                                   Also cascades to transfer_items, so any
 *                                   transfer that moved one of these products
 *                                   is left with zero items; the transfer
 *                                   header (from/to store, date, notes)
 *                                   survives, now empty. transaction_items
 *                                   only has its product_id set to null (ON
 *                                   DELETE SET NULL) — every past receipt is
 *                                   denormalised with its own product_name,
 *                                   sku, brand and prices, so old sales read
 *                                   exactly as they did before.
 *
 * What is deliberately NOT touched: organizations, stores, users,
 * device_sessions, suppliers (the contacts), transactions/transaction_items/
 * payments (sales history), daily_reports, audit_logs, app_releases,
 * receipt_counters, warehouses, transfers (headers).
 *
 * Run it from `backend/`, against the external URL, with the target named:
 *
 *   DATABASE_URL=<external url> DIRECT_URL=<external url> \
 *   CONFIRM_DATABASE=ngpos npx tsx prisma/clearProductsAndStock.ts
 *
 * A JSON dump of every row this touches is written before anything is
 * deleted, same reasoning as `wipe.ts`: not a real backup, but enough to
 * answer "what was that product called again" afterwards.
 */

const prisma = new PrismaClient();

/** Deleted directly, in this order. */
const DELETE_DIRECT = ['supplier_invoices', 'products'] as const;

/**
 * Not deleted directly — emptied as a side effect of the deletes above, via
 * the real `ON DELETE CASCADE` constraint on their product_id/invoice_id.
 * Dumped and counted for the same reason the direct deletes are: so the
 * before/after table below shows the whole blast radius, not just the two
 * statements that were actually run.
 */
const CASCADE_AFFECTED = [
  'supplier_invoice_items',
  'supplier_payments',
  'inventory',
  'store_prices',
  'stock_movements',
  'warehouse_stock',
  'transfer_items',
] as const;

const ALL_DUMPED = [...DELETE_DIRECT, ...CASCADE_AFFECTED] as const;

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

  // transaction_items is not emptied — only its product_id is nulled — so it
  // is reported separately rather than folded into the dump/delete tables.
  const productLinkedItems = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM "transaction_items" WHERE product_id IS NOT NULL`
  );
  const linkedBefore = Number(productLinkedItems[0]?.n ?? 0);

  const before = await counts(ALL_DUMPED);

  const dump: Record<string, unknown[]> = {};
  for (const table of ALL_DUMPED) {
    dump[table] = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${table}"`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = process.env.DUMP_PATH ?? `ngpos-before-clear-products-${stamp}.json`;
  writeFileSync(
    path,
    serialise({ takenAt: new Date().toISOString(), database: target.db, tables: dump })
  );
  console.log(`Dumped ${Object.values(dump).reduce((n, rows) => n + rows.length, 0)} rows to ${path}\n`);

  /*
   * One transaction, two DELETEs, in an order that does not matter to the
   * constraints (supplier_invoices and products share no direct FK) but
   * reads naturally as "purchase history, then the catalogue itself".
   */
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`DELETE FROM "supplier_invoices"`),
    prisma.$executeRawUnsafe(`DELETE FROM "products"`),
  ]);

  const after = await counts(ALL_DUMPED);
  const linkedAfterRows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM "transaction_items" WHERE product_id IS NOT NULL`
  );
  const linkedAfter = Number(linkedAfterRows[0]?.n ?? 0);

  const width = Math.max(...ALL_DUMPED.map((t) => t.length));
  console.log('Table'.padEnd(width) + '   before    after');
  for (const table of DELETE_DIRECT) {
    console.log(table.padEnd(width) + String(before[table]).padStart(9) + String(after[table]).padStart(9));
  }
  console.log('-- emptied by cascade, not deleted directly --');
  for (const table of CASCADE_AFFECTED) {
    console.log(table.padEnd(width) + String(before[table]).padStart(9) + String(after[table]).padStart(9));
  }
  console.log(
    'transaction_items.product_id set null'.padEnd(width) +
      String(linkedBefore).padStart(9) +
      String(linkedAfter).padStart(9) +
      '   (rows themselves are kept)'
  );

  const leftover = ALL_DUMPED.filter((t) => after[t] !== 0);
  if (leftover.length) throw new Error(`Not empty after delete: ${leftover.join(', ')}`);
  if (linkedAfter !== 0) throw new Error('transaction_items still references a product after delete.');

  console.log('\nCatalogue and stock cleared for every shop. Shops, staff, suppliers,');
  console.log('settings and sales history are untouched. Load the new catalogue through');
  console.log('Stock Import (CSV) or Products.');
}

main()
  .catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
