import * as SQLite from 'expo-sqlite';
import type { ProductWithStock, TransactionDraft } from '../api/types';

const DB_NAME = 'ngpos.db';
const SCHEMA_VERSION = 1;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DB_NAME).then(async (db) => {
      await migrate(db);
      return db;
    });
  }
  return dbPromise;
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  if (current >= SCHEMA_VERSION) return;

  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS products (
      id             TEXT NOT NULL,
      store_id       TEXT NOT NULL,
      name           TEXT NOT NULL,
      sku            TEXT,
      barcode        TEXT,
      brand          TEXT,
      category       TEXT,
      cost_price     REAL NOT NULL DEFAULT 0,
      selling_price  REAL NOT NULL DEFAULT 0,
      tax_type       TEXT NOT NULL DEFAULT 'exempt',
      unit           TEXT,
      quantity       REAL NOT NULL DEFAULT 0,
      reorder_level  REAL NOT NULL DEFAULT 0,
      is_active      INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (id, store_id)
    );

    CREATE INDEX IF NOT EXISTS idx_products_store   ON products (store_id);
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products (barcode);
    CREATE INDEX IF NOT EXISTS idx_products_name    ON products (name);

    -- Sales made while offline. No receipt_number: the server assigns it on
    -- sync, which is what keeps per-store daily numbering collision-free.
    CREATE TABLE IF NOT EXISTS pending_transactions (
      local_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id    TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      store_id      TEXT PRIMARY KEY,
      last_sync_at  TEXT
    );

    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

/* ---------------------------------------------------------------- products */

export async function cacheProducts(storeId: string, items: ProductWithStock[]): Promise<void> {
  if (items.length === 0) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const p of items) {
      await db.runAsync(
        `INSERT INTO products
           (id, store_id, name, sku, barcode, brand, category, cost_price,
            selling_price, tax_type, unit, quantity, reorder_level, is_active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id, store_id) DO UPDATE SET
           name=excluded.name, sku=excluded.sku, barcode=excluded.barcode,
           brand=excluded.brand, category=excluded.category,
           cost_price=excluded.cost_price, selling_price=excluded.selling_price,
           tax_type=excluded.tax_type, unit=excluded.unit,
           quantity=excluded.quantity, reorder_level=excluded.reorder_level,
           is_active=excluded.is_active`,
        [
          p.id,
          storeId,
          p.name,
          p.sku ?? null,
          p.barcode ?? null,
          p.brand ?? null,
          p.category ?? null,
          p.cost_price ?? 0,
          p.selling_price ?? 0,
          p.tax_type ?? 'exempt',
          p.unit ?? null,
          p.quantity ?? 0,
          p.reorder_level ?? 0,
          p.is_active === false ? 0 : 1,
        ]
      );
    }
  });
}

/**
 * Wipes every buying price out of the offline catalogue.
 *
 * The server now sends 0 in place of the cost price to an account that may not
 * see it, but this cache was filled before that was true and it is only topped
 * up with what has *changed* since the last sync — so a product nobody has
 * edited would keep the price it was cached with for ever. One statement on a
 * few hundred rows, run after each sync for those accounts, and the device is
 * carrying nothing it should not be carrying.
 */
export async function forgetCachedCosts(): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE products SET cost_price = 0 WHERE cost_price <> 0`);
}

export async function readCachedProducts(storeId: string): Promise<ProductWithStock[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM products WHERE store_id = ? AND is_active = 1 ORDER BY name`,
    [storeId]
  );
  return rows.map(rowToProduct);
}

export async function findCachedByBarcode(
  storeId: string,
  barcode: string
): Promise<ProductWithStock | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT * FROM products WHERE store_id = ? AND barcode = ? LIMIT 1`,
    [storeId, barcode]
  );
  return row ? rowToProduct(row) : null;
}

export async function countCachedProducts(storeId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM products WHERE store_id = ?`,
    [storeId]
  );
  return row?.n ?? 0;
}

/** Optimistic local stock decrement so an offline cart can't oversell twice. */
export async function decrementCachedStock(
  storeId: string,
  changes: { product_id: string; quantity: number }[]
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const c of changes) {
      await db.runAsync(
        `UPDATE products SET quantity = MAX(0, quantity - ?) WHERE id = ? AND store_id = ?`,
        [c.quantity, c.product_id, storeId]
      );
    }
  });
}

function rowToProduct(r: Record<string, unknown>): ProductWithStock {
  return {
    id: String(r.id),
    organization_id: '',
    name: String(r.name),
    description: null,
    sku: (r.sku as string) ?? '',
    barcode: (r.barcode as string) ?? null,
    brand: (r.brand as string) ?? null,
    category: (r.category as string) ?? null,
    // Not cached: this table is what the till needs to ring a sale offline, and
    // neither the chemical nor the expiry date is part of that. The product
    // screen reads them from the API, which is where they are shown.
    chemical_name: null,
    expiry_date: null,
    transport_cost: 0,
    cost_price: Number(r.cost_price ?? 0),
    selling_price: Number(r.selling_price ?? 0),
    tax_type: (r.tax_type as ProductWithStock['tax_type']) ?? 'exempt',
    unit: (r.unit as string) ?? null,
    variants: [],
    is_active: Number(r.is_active) === 1,
    image_base64: null,
    created_at: '',
    updated_at: '',
    quantity: Number(r.quantity ?? 0),
    reorder_level: Number(r.reorder_level ?? 0),
  };
}

/* ------------------------------------------------------------ sale queueing */

export interface PendingTransaction {
  local_id: number;
  store_id: string;
  payload: TransactionDraft;
  created_at: string;
  attempts: number;
  last_error: string | null;
}

export async function queueTransaction(draft: TransactionDraft): Promise<number> {
  const db = await getDb();
  const res = await db.runAsync(
    `INSERT INTO pending_transactions (store_id, payload, created_at) VALUES (?,?,?)`,
    [draft.store_id, JSON.stringify(draft), new Date().toISOString()]
  );
  return res.lastInsertRowId;
}

export async function readPending(storeId?: string): Promise<PendingTransaction[]> {
  const db = await getDb();
  const rows = storeId
    ? await db.getAllAsync<Record<string, unknown>>(
        `SELECT * FROM pending_transactions WHERE store_id = ? ORDER BY local_id`,
        [storeId]
      )
    : await db.getAllAsync<Record<string, unknown>>(
        `SELECT * FROM pending_transactions ORDER BY local_id`
      );
  return rows.map((r) => ({
    local_id: Number(r.local_id),
    store_id: String(r.store_id),
    payload: JSON.parse(String(r.payload)) as TransactionDraft,
    created_at: String(r.created_at),
    attempts: Number(r.attempts ?? 0),
    last_error: (r.last_error as string) ?? null,
  }));
}

export async function countPending(storeId?: string): Promise<number> {
  const db = await getDb();
  const row = storeId
    ? await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM pending_transactions WHERE store_id = ?`,
        [storeId]
      )
    : await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM pending_transactions`);
  return row?.n ?? 0;
}

export async function removePending(localId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM pending_transactions WHERE local_id = ?`, [localId]);
}

export async function markPendingFailed(localId: number, error: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE pending_transactions SET attempts = attempts + 1, last_error = ? WHERE local_id = ?`,
    [error, localId]
  );
}

/* --------------------------------------------------------------- sync state */

export async function getLastSync(storeId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ last_sync_at: string | null }>(
    `SELECT last_sync_at FROM sync_state WHERE store_id = ?`,
    [storeId]
  );
  return row?.last_sync_at ?? null;
}

export async function setLastSync(storeId: string, iso: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO sync_state (store_id, last_sync_at) VALUES (?,?)
     ON CONFLICT(store_id) DO UPDATE SET last_sync_at = excluded.last_sync_at`,
    [storeId, iso]
  );
}
