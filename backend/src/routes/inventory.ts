import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { assertStoreAccess, authenticate, currentUser, requireCapability } from '../middleware/auth.js';
import { capabilityContext } from '../lib/capabilities.js';
import { recordAudit } from '../lib/audit.js';
import { num } from '../lib/serialize.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parseCsvObjects, tableToObjects, type TableObjects } from '../lib/csv.js';
import { readXlsx, XlsxError } from '../lib/xlsx.js';
import { CATEGORY_LIST_HINT, normaliseCategory } from '../lib/categories.js';
import {
  flatten,
  HEADER_ALIASES,
  KNOWN_FIELDS,
  PRICE_MASTER_COLUMNS,
  productNameFrom,
  readCostPrice,
  SKU_TEMPLATE_COLUMNS,
  synthesiseSku,
} from '../lib/productSheet.js';

export const inventoryRouter = Router();
inventoryRouter.use(authenticate);

const listQuery = z.object({
  store_id: z.string().uuid(),
  low_only: z.coerce.boolean().default(false),
});

inventoryRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const user = currentUser(req);
    await assertStoreAccess(user, q.store_id);

    const rows = await prisma.inventory.findMany({
      where: { storeId: q.store_id, product: { organizationId: user.organizationId, isActive: true } },
      include: { product: { select: { name: true, sku: true, costPrice: true, brand: true } } },
      orderBy: { product: { name: 'asc' } },
    });

    const mapped = rows.map((r) => ({
      product_id: r.productId,
      store_id: r.storeId,
      product_name: r.product.name,
      sku: r.product.sku,
      brand: r.product.brand,
      quantity: num(r.quantity),
      reorder_level: num(r.reorderLevel),
      value: num(r.quantity) * num(r.product.costPrice),
      updated_at: r.updatedAt,
    }));

    res.json(q.low_only ? mapped.filter((m) => m.quantity <= m.reorder_level) : mapped);
  })
);

const movementSchema = z.object({
  store_id: z.string().uuid(),
  product_id: z.string().uuid(),
  type: z.enum(['purchase', 'adjustment', 'transfer_in', 'transfer_out']),
  /** Signed for adjustments; positive for purchases. */
  quantity: z.number(),
  note: z.string().optional(),
  reorder_level: z.number().min(0).optional(),
});

/**
 * Applies a stock change and records why. Inventory is never edited directly —
 * every change leaves a movement row, so a discrepancy can be traced.
 */
inventoryRouter.post(
  '/movements',
  requireCapability('stock.adjust'),
  asyncHandler(async (req, res) => {
    const body = movementSchema.parse(req.body);
    const user = currentUser(req);
    await assertStoreAccess(user, body.store_id);

    if (body.quantity === 0 && body.reorder_level === undefined) {
      throw badRequest('Nothing to change.');
    }

    const product = await prisma.product.findFirst({
      where: { id: body.product_id, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!product) throw notFound('Product not found.');

    const result = await prisma.$transaction(async (tx) => {
      const inventory = await tx.inventory.upsert({
        where: { storeId_productId: { storeId: body.store_id, productId: body.product_id } },
        create: {
          storeId: body.store_id,
          productId: body.product_id,
          quantity: new Prisma.Decimal(body.quantity),
          reorderLevel: new Prisma.Decimal(body.reorder_level ?? 10),
        },
        update: {
          quantity: { increment: new Prisma.Decimal(body.quantity) },
          ...(body.reorder_level !== undefined
            ? { reorderLevel: new Prisma.Decimal(body.reorder_level) }
            : {}),
        },
      });

      if (body.quantity !== 0) {
        await tx.stockMovement.create({
          data: {
            storeId: body.store_id,
            productId: body.product_id,
            type: body.type,
            quantity: new Prisma.Decimal(body.quantity),
            balance: inventory.quantity,
            note: body.note,
            userId: user.id,
          },
        });
      }

      return inventory;
    });

    res.status(201).json({
      product_id: result.productId,
      store_id: result.storeId,
      quantity: num(result.quantity),
      reorder_level: num(result.reorderLevel),
    });
  })
);

/* ------------------------------------------------------------- bulk upload */

/**
 * Our own template, with five filled-in rows so the shape of a row is obvious.
 * `sku` is the key everything else hangs off: it is what makes a re-upload an
 * update rather than a second copy of the catalogue.
 */
const SKU_TEMPLATE_CSV = [
  SKU_TEMPLATE_COLUMNS.join(','),
  // The category column teaches the fixed list — see lib/categories.ts.
  'AGV-0001,Dairy Meal 50kg,6009123456789,Novatek,Animal Feed,bag,320.00,395.00,exempt,40,10',
  'AGV-0002,Layers Mash 50kg,6009123456796,Novatek,Animal Feed,bag,305.50,375.00,exempt,25,10',
  'AGV-0003,Newcastle Vaccine 100ml,,Kepro,Veterinary,bottle,48.00,72.50,vat,12,6',
  'AGV-0004,Knapsack Sprayer 16L,6009123456819,Jembe,Equipment,piece,410.00,540.00,vat,6,2',
  'AGV-0005,Maize Seed SC627 10kg,,Seedco,Maize Seed,bag,255.00,320.00,exempt,18,5',
].join('\r\n');

/**
 * The price master, with the shop columns filled in from the organisation's own
 * shops so the operator gets back the sheet they actually keep rather than an
 * example of one. Built per request; see the template route.
 */
function priceMasterCsv(shopNames: string[]): string {
  const blanks = shopNames.map(() => '');
  const line = (cells: (string | number)[]) => cells.map(csvCell).join(',');

  return [
    line([...PRICE_MASTER_COLUMNS, ...shopNames]),
    line(['STARKE AYRES', 'carrots', '100g', 201.6, 3, 205, 0.15, 31, 236, 15, ...blanks]),
    line(['SEED-CO', 'Maize Seed SC627', '10kg', 255, 8, 263, 0.22, 57, 320, 18, ...blanks]),
    line(['Novatek', 'Dairy Meal', '50kg', 312, 8, 320, 0.23, 75, 395, 40, ...blanks]),
  ].join('\r\n');
}

/** A shop called "Katende, East" would otherwise split into two columns. */
function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const bulkUploadSchema = z
  .object({
    store_id: z.string().uuid(),
    /** The spreadsheet, saved as CSV and sent as text. */
    csv: z.string().optional(),
    /** The .xlsx itself, base64 encoded — no "save as CSV" step to forget. */
    xlsx_base64: z.string().optional(),
    /** Which sheet of the workbook to read. Defaults to the first visible one. */
    sheet: z.string().optional(),
    /** Already-parsed rows, for a client that would rather not ship the file. */
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).optional(),
    /**
     * `set` treats the quantity column as the counted total on the shelf — the
     * right reading for an opening stock take. `add` treats it as a delivery to
     * be added to what is already there.
     */
    mode: z.enum(['set', 'add']).default('set'),
    create_missing_products: z.boolean().default(true),
    update_existing_products: z.boolean().default(true),
    /**
     * Whether the per-shop price columns are written. On by default: a file
     * carrying them is a chain price list, and importing it without the prices
     * is almost never what was meant.
     */
    apply_shop_prices: z.boolean().default(true),
    /** Checks the file and reports what would happen, changing nothing. */
    validate_only: z.boolean().default(false),
    reference: z.string().default(''),
    note: z.string().default(''),
  })
  .refine(
    (b) => [b.csv, b.xlsx_base64, b.rows].filter((v) => v !== undefined).length === 1,
    { message: 'Send exactly one of: csv text, xlsx_base64, or rows.' }
  );

const MAX_UPLOAD_ROWS = 1000;

type RowError = { row: number; sku: string; message: string };

/**
 * A spreadsheet column that turned out to name one of the organisation's shops,
 * and whether its prices can actually be written.
 *
 * Anything other than `ok` is reported rather than silently dropped. A price
 * column that quietly did nothing is the worst failure this import has: the
 * shop believes the chain was repriced, and finds out at the till.
 */
interface ShopColumn {
  /** The heading as written in the file. */
  column: string;
  /** The key its values are filed under on each parsed row. */
  key: string;
  storeId: string | null;
  storeName: string | null;
  status: 'ok' | 'unknown_shop' | 'no_access' | 'no_permission';
  /** How many rows carry a price in this column. */
  values: number;
}

/** One spreadsheet line, read into the fields it will be written from. */
interface Parsed {
  /** Line number in the file as the operator sees it: header is line 1. */
  line: number;
  sku: string;
  name: string;
  barcode: string | null;
  brand: string | null;
  category: string | null;
  unit: string | null;
  costPrice: number | null;
  sellingPrice: number | null;
  taxType: 'exempt' | 'vat' | null;
  quantity: number | null;
  reorderLevel: number | null;
  /** Per-shop prices from the branch columns, by store id. */
  shopPrices: Map<string, number>;
  /** True when the row carried at least one shop price cell. */
  pricesShops: boolean;
}

/** The fields a repeated row may fill in, named as the operator would read them. */
const MERGEABLE_FIELDS = [
  ['name', 'The product name'],
  ['barcode', 'The barcode'],
  ['brand', 'The company'],
  ['category', 'The category'],
  ['unit', 'The unit'],
  ['costPrice', 'The cost price'],
  ['sellingPrice', 'The selling price'],
  ['taxType', 'The tax type'],
  ['quantity', 'The quantity'],
  ['reorderLevel', 'The reorder level'],
] as const satisfies readonly (readonly [keyof Parsed, string])[];

/**
 * Folds a repeated row into the first one that claimed its product code.
 *
 * A blank never overwrites a value, and a value never overwrites a different
 * one — that second case is returned as the name of the field that disagreed,
 * for the caller to turn into an error. Nothing is written until it comes back
 * clean, so a conflict cannot leave the first row half-merged.
 */
function mergeDuplicateRow(into: Parsed, from: Parsed): string | null {
  for (const [field, label] of MERGEABLE_FIELDS) {
    const next = from[field];
    if (next === null || next === '') continue;
    const current = into[field];
    if (current !== null && current !== '' && current !== next) return label;
  }
  for (const [storeId, price] of from.shopPrices) {
    const current = into.shopPrices.get(storeId);
    if (current !== undefined && current !== price) return 'A shop price';
  }

  for (const [field, _label] of MERGEABLE_FIELDS) {
    const next = from[field];
    if (next === null || next === '') continue;
    // Checked above: either unset, or already equal to what we are assigning.
    (into[field] as Parsed[typeof field]) = next;
  }
  for (const [storeId, price] of from.shopPrices) into.shopPrices.set(storeId, price);
  into.pricesShops = into.pricesShops || from.pricesShops;

  return null;
}

/** A JSON cell as the text the rest of the importer works in. */
function stringify(value: string | number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** Money and quantities as typed by a person: "K1,250.00", "1 250", "12.5". */
function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[Kk]\s?(?=[\d.,])/, '').replace(/[\s,]/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Loads a shop's stock spreadsheet: creates or updates the products in it and
 * sets this store's stock level for each one, in a single transaction.
 *
 * All or nothing. A partly-applied import is the worst outcome available — the
 * operator cannot tell which half landed, and re-running it would double the
 * rows that did. So every row is validated first, and one bad row rejects the
 * file with the line number to fix.
 */
inventoryRouter.post(
  '/bulk-upload',
  requireCapability('products.import'),
  asyncHandler(async (req, res) => {
    const body = bulkUploadSchema.parse(req.body);
    const user = currentUser(req);
    await assertStoreAccess(user, body.store_id);

    /* ---------------------------------------------------------- 1. read it */

    let parsed: TableObjects;

    if (body.xlsx_base64 !== undefined) {
      let table: string[][];
      try {
        table = readXlsx(Buffer.from(body.xlsx_base64, 'base64'), {
          ...(body.sheet ? { sheet: body.sheet } : {}),
          // One over the cap, so a file that is too long is reported as such
          // rather than being silently truncated to the limit.
          maxRows: MAX_UPLOAD_ROWS + 2,
        }).rows;
      } catch (err) {
        throw badRequest(
          err instanceof XlsxError ? err.message : 'That spreadsheet could not be read.'
        );
      }
      parsed = tableToObjects(table, HEADER_ALIASES);
    } else if (body.csv !== undefined) {
      parsed = parseCsvObjects(body.csv, HEADER_ALIASES);
    } else {
      // Rows sent as JSON: same header vocabulary, applied to the object keys.
      const supplied = body.rows ?? [];
      const rawHeaders = [...new Set(supplied.flatMap((r) => Object.keys(r)))];
      parsed = tableToObjects(
        [rawHeaders, ...supplied.map((r) => rawHeaders.map((h) => stringify(r[h])))],
        HEADER_ALIASES
      );
    }

    const records = parsed.rows;
    if (records.length === 0) {
      throw badRequest(
        parsed.rawHeaders.length > 0
          ? 'The file has a header row but no data rows.'
          : 'That file has no rows in it.'
      );
    }
    if (records.length > MAX_UPLOAD_ROWS) {
      throw badRequest(
        `${records.length} rows is more than the ${MAX_UPLOAD_ROWS} allowed in one upload. Split the file.`
      );
    }

    /* ------------------------------------------- 1b. what shape of sheet is it */

    // Either the file names its products, or it describes them well enough for
    // a code to be worked out. Without one of the two there is nothing stable
    // to match a re-upload against, and every import would duplicate the last.
    const hasSku = parsed.headers.includes('sku');
    const hasName = parsed.headers.includes('name');
    if (!hasSku && !hasName) {
      throw badRequest(
        `The file needs either an "sku" column, or a "PRODUCT" column (with "COMPANY" and "PACKSIZE") so a product code can be worked out. Found: ${
          parsed.rawHeaders.filter(Boolean).join(', ') || 'nothing'
        }.`
      );
    }

    /* --------------------------------------- 1c. columns named after a shop */

    // Anything the vocabulary does not claim is a candidate. Matching is done
    // against the organisation's real shops rather than a hard-coded list, so
    // renaming a shop or opening a new one needs no change here.
    const unclaimed = parsed.rawHeaders
      .map((raw, index) => ({ raw, key: parsed.headers[index] ?? '' }))
      .filter(({ raw, key }) => raw !== '' && key !== '' && !KNOWN_FIELDS.has(key));

    const shopColumns: ShopColumn[] = [];
    const unrecognisedColumns: string[] = [];

    if (unclaimed.length > 0) {
      const stores = await prisma.store.findMany({
        where: { organizationId: user.organizationId },
        select: { id: true, name: true, code: true, isActive: true },
      });
      const byLabel = new Map<string, (typeof stores)[number]>();
      for (const store of stores) {
        byLabel.set(flatten(store.name), store);
        if (store.code) byLabel.set(flatten(store.code), store);
      }

      // Writing prices into other shops is a separate permission from loading
      // stock into this one, and it is checked once rather than per column.
      const canPrice = (await capabilityContext(user)).capabilities.includes('pricing.write');
      const unrestricted = user.role === 'ORG_ADMIN' || user.assignedStores.length === 0;

      for (const { raw, key } of unclaimed) {
        const store = byLabel.get(flatten(raw));
        if (!store) {
          unrecognisedColumns.push(raw);
          continue;
        }
        shopColumns.push({
          column: raw,
          key,
          storeId: store.id,
          storeName: store.name,
          status: !canPrice
            ? 'no_permission'
            : !unrestricted && !user.assignedStores.includes(store.id)
              ? 'no_access'
              : 'ok',
          values: records.filter((r) => (r[key] ?? '').trim() !== '').length,
        });
      }
    }

    /* ------------------------------------------------------ 2. validate it */

    const errors: RowError[] = [];
    const warnings: string[] = [];
    const seenSku = new Map<string, Parsed>();

    const parsedRows: Parsed[] = [];
    const writableShopColumns = shopColumns.filter((c) => c.status === 'ok');
    const merged: number[] = [];

    records.forEach((record, index) => {
      const line = index + 2;
      const company = (record.company ?? '').trim();
      const packSize = (record.pack_size ?? '').trim();
      const product = (record.name ?? '').trim();

      // A file with product codes uses them. One without gets a code derived
      // from what identifies the row instead — see `synthesiseSku`.
      const name = hasSku ? product : productNameFrom(product, packSize);
      const sku = hasSku
        ? (record.sku ?? '').trim()
        : product
          ? synthesiseSku(company, product, packSize)
          : '';

      const fail = (message: string) => errors.push({ row: line, sku, message });

      if (!sku) {
        fail(
          hasSku
            ? 'No SKU. Every row needs a product code.'
            : 'No product name, so this row cannot be identified.'
        );
        return;
      }

      const numeric = (raw: string | undefined, label: string) => {
        const value = parseNumber(raw);
        if (value === null) return null;
        if (Number.isNaN(value)) {
          fail(`${label} is not a number: "${raw}".`);
          return null;
        }
        if (value < 0) {
          fail(`${label} cannot be negative.`);
          return null;
        }
        return value;
      };

      const taxRaw = (record.tax_type ?? '').trim().toLowerCase();
      let taxType: 'exempt' | 'vat' | null = null;
      if (taxRaw) {
        if (['vat', 'vatable', 'standard', 'taxable', 'yes', 'y'].includes(taxRaw)) taxType = 'vat';
        else if (['exempt', 'zero', 'none', 'no', 'n', '0'].includes(taxRaw)) taxType = 'exempt';
        else fail(`Tax type must be "vat" or "exempt", not "${record.tax_type}".`);
      }

      // Same fixed list the app's picker offers. A spreadsheet is exactly where
      // a stray head like "Chemicals" would get in, so an unknown value fails
      // the row rather than being filed under "Other".
      const category = normaliseCategory(record.category);
      if (category === undefined) {
        fail(`Unknown category "${(record.category ?? '').trim()}". ${CATEGORY_LIST_HINT}`);
      }

      const shopPrices = new Map<string, number>();
      let pricesShops = false;
      for (const column of writableShopColumns) {
        const raw = (record[column.key] ?? '').trim();
        if (!raw) continue;
        pricesShops = true;
        const value = numeric(raw, `${column.column} price`);
        if (value !== null) shopPrices.set(column.storeId as string, value);
      }

      const parsedRow: Parsed = {
        line,
        sku,
        name,
        barcode: (record.barcode ?? '').trim() || null,
        // The price master calls it COMPANY; it is the same field.
        brand: company || null,
        category: category ?? null,
        unit: (record.unit ?? '').trim() || null,
        costPrice: numeric(readCostPrice(record), 'Cost price'),
        sellingPrice: numeric(record.selling_price, 'Selling price'),
        taxType,
        quantity: numeric(record.quantity, 'Quantity'),
        reorderLevel: numeric(record.reorder_level, 'Reorder level'),
        shopPrices,
        pricesShops,
      };

      /* --- the same product, listed twice --- */

      // A hand-maintained sheet repeats itself: the real price master carries
      // `okra` and `Okra`, and `Repacked Urea` beside `Repacked  Urea`. Where
      // the repeat adds nothing that contradicts the first, folding the two
      // together is obviously what was meant, and refusing a 500-line file over
      // a duplicated blank row would just send someone hunting for it.
      //
      // Where they genuinely disagree — two different prices for one product —
      // there is no safe guess, so that still fails with both line numbers.
      const first = seenSku.get(sku.toLowerCase());
      if (!first) {
        seenSku.set(sku.toLowerCase(), parsedRow);
        parsedRows.push(parsedRow);
        return;
      }

      const conflict = mergeDuplicateRow(first, parsedRow);
      if (conflict) {
        fail(
          `${conflict} does not match line ${first.line}, which is the same ${
            hasSku ? `product code (${sku})` : 'company, product and pack size'
          }. Combine them into one row.`
        );
        return;
      }
      merged.push(line);
    });

    if (merged.length > 0) {
      warnings.push(
        `${merged.length} row${merged.length === 1 ? ' was a repeat of an earlier one and was' : 's were repeats of earlier ones and were'} folded in: line${merged.length === 1 ? '' : 's'} ${merged.slice(0, 10).join(', ')}${merged.length > 10 ? `, and ${merged.length - 10} more` : ''}.`
      );
    }

    /* ------------------------------------- 3. match against what we already have */

    const skus = parsedRows.map((r) => r.sku);
    const existing = await prisma.product.findMany({
      where: { organizationId: user.organizationId, sku: { in: skus } },
      select: { id: true, sku: true, name: true, costPrice: true, sellingPrice: true },
    });
    const existingBySku = new Map(existing.map((p) => [p.sku, p]));

    const levels = await prisma.inventory.findMany({
      where: { storeId: body.store_id, productId: { in: existing.map((p) => p.id) } },
      select: { productId: true, quantity: true },
    });
    const levelByProduct = new Map(levels.map((l) => [l.productId, l.quantity]));

    let unpricedNewProducts = 0;

    for (const row of parsedRows) {
      const known = existingBySku.get(row.sku);
      if (!known) {
        if (!body.create_missing_products) {
          errors.push({
            row: row.line,
            sku: row.sku,
            message: `${row.sku} is not in the catalogue, and creating new products is switched off.`,
          });
        } else if (!row.name) {
          errors.push({
            row: row.line,
            sku: row.sku,
            message: `${row.sku} is new, so it needs a name.`,
          });
        } else if (row.sellingPrice === null) {
          // Counted rather than listed: the price master routinely carries
          // hundreds of catalogue-only rows, and a warning per line buries the
          // handful that actually need reading.
          unpricedNewProducts += 1;
        }
      }
    }

    if (unpricedNewProducts > 0) {
      warnings.push(
        `${unpricedNewProducts} new product${unpricedNewProducts === 1 ? ' has' : 's have'} no selling price and will be created at 0.`
      );
    }

    /* --- what the shop columns will and will not do --- */

    for (const column of shopColumns) {
      if (column.status === 'ok') continue;
      const why =
        column.status === 'no_access'
          ? 'you are not assigned to that shop'
          : column.status === 'no_permission'
            ? 'your role cannot change prices'
            : 'it is not one of your shops';
      warnings.push(`Column "${column.column}" was not applied — ${why}.`);
    }
    if (unrecognisedColumns.length > 0) {
      warnings.push(
        `Ignored ${unrecognisedColumns.length} column${unrecognisedColumns.length === 1 ? '' : 's'} that matched no field or shop: ${unrecognisedColumns.join(', ')}.`
      );
    }
    if (!body.apply_shop_prices && writableShopColumns.length > 0) {
      warnings.push('Per-shop prices were switched off for this import, so those columns were read and skipped.');
    }

    if (errors.length > 0) {
      return res.status(422).json({
        applied: false,
        detail:
          errors.length === 1
            ? `Line ${errors[0]?.row} could not be read, so nothing was imported.`
            : `${errors.length} lines could not be read, so nothing was imported.`,
        total_rows: records.length,
        errors: errors.slice(0, 100),
        error_count: errors.length,
        warnings,
      });
    }

    /* ------------------------------------------------------ 4. what will happen */

    const plan = parsedRows.map((row) => {
      const known = existingBySku.get(row.sku);
      const before = known ? num(levelByProduct.get(known.id) ?? 0) : 0;
      const after =
        row.quantity === null ? before : body.mode === 'set' ? row.quantity : before + row.quantity;

      return {
        row: row.line,
        sku: row.sku,
        name: row.name || known?.name || row.sku,
        product_action: known ? (body.update_existing_products ? 'update' : 'unchanged') : 'create',
        quantity_before: before,
        quantity_after: after,
        change: Math.round((after - before) * 1000) / 1000,
        parsed: row,
        productId: known?.id ?? null,
      };
    });

    // Only rows that price at least one shop take part in the price write. A
    // row that says nothing about shop prices leaves the existing overrides
    // alone; see the delete-then-insert in step 5 for why that distinction
    // matters.
    const repricing = body.apply_shop_prices ? plan.filter((p) => p.parsed.pricesShops) : [];
    const shopPriceWrites = repricing.reduce((sum, p) => sum + p.parsed.shopPrices.size, 0);

    const summary = {
      store_id: body.store_id,
      mode: body.mode,
      total_rows: plan.length,
      products_to_create: plan.filter((p) => p.product_action === 'create').length,
      products_to_update: plan.filter((p) => p.product_action === 'update').length,
      stock_rows: plan.filter((p) => p.parsed.quantity !== null).length,
      /** Every shop-named column found, applied or not, with the reason. */
      shop_columns: shopColumns.map(({ key: _key, ...rest }) => rest),
      shop_price_rows: repricing.length,
      shop_prices_to_write: shopPriceWrites,
      ignored_columns: unrecognisedColumns,
      warnings,
    };

    if (body.validate_only) {
      return res.json({
        applied: false,
        detail: 'The file reads cleanly. Nothing has been changed yet.',
        ...summary,
        preview: plan.slice(0, 25).map(({ parsed: _parsed, productId: _id, ...rest }) => rest),
      });
    }

    /* --------------------------------------------------------- 5. apply it */

    const now = new Date();
    const reference = body.reference.trim() || `BULK-${now.toISOString().slice(0, 10)}`;

    await prisma.$transaction(
      async (tx) => {
        // New products are inserted in one statement with ids generated here,
        // because `createMany` does not hand any back and a 500-row catalogue
        // load should not be 500 round trips.
        const toCreate = plan.filter((p) => p.product_action === 'create');
        for (const entry of toCreate) entry.productId = randomUUID();

        if (toCreate.length > 0) {
          await tx.product.createMany({
            data: toCreate.map((entry) => ({
              id: entry.productId as string,
              organizationId: user.organizationId,
              name: entry.parsed.name,
              sku: entry.parsed.sku,
              barcode: entry.parsed.barcode,
              brand: entry.parsed.brand,
              category: entry.parsed.category,
              unit: entry.parsed.unit,
              costPrice: new Prisma.Decimal(entry.parsed.costPrice ?? 0),
              sellingPrice: new Prisma.Decimal(entry.parsed.sellingPrice ?? 0),
              taxType: entry.parsed.taxType ?? 'exempt',
            })),
          });
        }

        if (body.update_existing_products) {
          for (const entry of plan) {
            if (entry.product_action !== 'update') continue;
            const p = entry.parsed;
            // Only the columns the file actually filled in. A spreadsheet that
            // carries stock counts and nothing else must not blank the prices.
            const data: Prisma.ProductUpdateInput = {
              ...(p.name ? { name: p.name } : {}),
              ...(p.barcode ? { barcode: p.barcode } : {}),
              ...(p.brand ? { brand: p.brand } : {}),
              ...(p.category ? { category: p.category } : {}),
              ...(p.unit ? { unit: p.unit } : {}),
              ...(p.costPrice === null ? {} : { costPrice: new Prisma.Decimal(p.costPrice) }),
              ...(p.sellingPrice === null ? {} : { sellingPrice: new Prisma.Decimal(p.sellingPrice) }),
              ...(p.taxType === null ? {} : { taxType: p.taxType }),
            };
            if (Object.keys(data).length === 0) continue;
            await tx.product.update({ where: { id: entry.productId as string }, data });
          }
        }

        const movements: Prisma.StockMovementCreateManyInput[] = [];

        for (const entry of plan) {
          const { quantity, reorderLevel } = entry.parsed;
          if (quantity === null && reorderLevel === null) continue;

          const productId = entry.productId as string;
          const qty = new Prisma.Decimal(quantity ?? 0);

          const level = await tx.inventory.upsert({
            where: { storeId_productId: { storeId: body.store_id, productId } },
            create: {
              storeId: body.store_id,
              productId,
              quantity: qty,
              ...(reorderLevel === null ? {} : { reorderLevel: new Prisma.Decimal(reorderLevel) }),
            },
            update: {
              ...(quantity === null
                ? {}
                : body.mode === 'set'
                  ? { quantity: qty }
                  : { quantity: { increment: qty } }),
              ...(reorderLevel === null ? {} : { reorderLevel: new Prisma.Decimal(reorderLevel) }),
            },
          });

          if (quantity === null) continue;

          const change = level.quantity.minus(entry.quantity_before);
          if (change.isZero()) continue;

          movements.push({
            storeId: body.store_id,
            productId,
            // A counted total is a correction to what the system believed; a
            // delivery is a purchase. The movement history has to say which.
            type: body.mode === 'set' ? 'adjustment' : 'purchase',
            quantity: change,
            balance: level.quantity,
            reference,
            note: body.note.trim() || 'Bulk stock upload',
            userId: user.id,
          });
        }

        if (movements.length > 0) await tx.stockMovement.createMany({ data: movements });

        /* --- per-shop prices --- */

        // Delete-then-insert rather than several thousand upserts: six shops
        // across five hundred products is 3,000 round trips one at a time, and
        // this is two statements. `StorePrice` carries nothing but the price,
        // so there is no history to lose by replacing the row.
        //
        // Scoped to the products that the file actually prices. A row that
        // leaves every shop column blank is saying nothing about shop prices,
        // and its existing overrides survive untouched — only a row that prices
        // some shops is treated as authoritative for all the shops in the file,
        // which is what makes a blanked cell mean "no override here".
        if (repricing.length > 0) {
          const storeIds = writableShopColumns.map((c) => c.storeId as string);
          const productIds = repricing.map((entry) => entry.productId as string);

          await tx.storePrice.deleteMany({
            where: { storeId: { in: storeIds }, productId: { in: productIds } },
          });

          const prices: Prisma.StorePriceCreateManyInput[] = [];
          for (const entry of repricing) {
            for (const [storeId, price] of entry.parsed.shopPrices) {
              prices.push({
                storeId,
                productId: entry.productId as string,
                price: new Prisma.Decimal(price),
              });
            }
          }
          if (prices.length > 0) await tx.storePrice.createMany({ data: prices });
        }
      },
      // A thousand rows over a pooled connection to a serverless database takes
      // longer than the five-second default, and a timeout here rolls the whole
      // import back for no reason other than impatience.
      { timeout: 120_000, maxWait: 20_000 }
    );

    // The one place the data layer's trail is genuinely thin: shop prices are
    // written with `createMany`, which hands back a count and no rows, so there
    // is nothing to snapshot per price. Three thousand entries would be the
    // wrong answer anyway — what somebody looking into "who repriced the whole
    // catalogue on Tuesday" needs is this one line, and the file's reference.
    recordAudit({
      entity: 'import',
      entityId: reference,
      action: 'import',
      label: reference,
      summary:
        `Imported ${summary.total_rows} rows, reference ${reference}: ` +
        `${summary.products_to_create} products created, ${summary.products_to_update} updated` +
        (shopPriceWrites > 0
          ? `, ${shopPriceWrites} shop prices set across ${writableShopColumns.length} shops`
          : ''),
      organizationId: user.organizationId,
      storeId: body.store_id,
      details: { ...summary, reference },
    });

    return res.status(201).json({
      applied: true,
      detail: [
        `${summary.total_rows} rows imported: ${summary.products_to_create} products created, ${summary.products_to_update} updated.`,
        shopPriceWrites > 0
          ? `${shopPriceWrites} shop prices set across ${writableShopColumns.length} shops.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
      ...summary,
      reference,
    });
  })
);

/** The organisation's shops, in the order a price sheet should column them. */
async function shopColumnNames(organizationId: string): Promise<string[]> {
  const stores = await prisma.store.findMany({
    where: { organizationId, isActive: true },
    select: { name: true },
    orderBy: { name: 'asc' },
  });
  return stores.map((s) => s.name);
}

const templateQuery = z.object({
  /**
   * `price-master` is the default because it is the sheet the buyer already
   * keeps. `sku` is our own shape, still read on the way in and still the
   * better file when the shop has real product codes.
   */
  format: z.enum(['price-master', 'sku']).default('price-master'),
});

/**
 * The blank spreadsheet, with filled-in example rows so the shape of a row is
 * obvious. Served as a file download so it can be opened straight in Excel.
 */
inventoryRouter.get(
  '/bulk-upload/template',
  asyncHandler(async (req, res) => {
    const { format } = templateQuery.parse(req.query);
    const user = currentUser(req);

    const csv =
      format === 'sku' ? SKU_TEMPLATE_CSV : priceMasterCsv(await shopColumnNames(user.organizationId));
    const filename = format === 'sku' ? 'ng-pos-stock-template.csv' : 'ng-pos-price-master.csv';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // The BOM is what makes Excel open a UTF-8 CSV without mangling accented
    // characters; our own parser strips it back off on the way in.
    res.send(`﻿${csv}\r\n`);
  })
);

/** The same columns as JSON, for a client that wants to build the form itself. */
inventoryRouter.get(
  '/bulk-upload/columns',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const shops = await shopColumnNames(user.organizationId);

    res.json({
      formats: {
        price_master: {
          columns: [...PRICE_MASTER_COLUMNS, ...shops],
          required: ['PRODUCT'],
          notes:
            'No product codes needed — a stable code is worked out from COMPANY + PRODUCT + PACKSIZE. One extra column per shop sets that shop\'s price.',
          sample_csv: priceMasterCsv(shops),
        },
        sku: {
          columns: SKU_TEMPLATE_COLUMNS,
          required: ['sku'],
          required_for_new_products: ['sku', 'name'],
          sample_csv: SKU_TEMPLATE_CSV,
        },
      },
      shop_price_columns: shops,
      accepted_aliases: HEADER_ALIASES,
      accepts_xlsx: true,
      max_rows: MAX_UPLOAD_ROWS,
    });
  })
);

inventoryRouter.get(
  '/movements',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        store_id: z.string().uuid(),
        product_id: z.string().uuid().optional(),
        limit: z.coerce.number().min(1).max(500).default(100),
      })
      .parse(req.query);

    await assertStoreAccess(currentUser(req), q.store_id);

    const rows = await prisma.stockMovement.findMany({
      where: { storeId: q.store_id, ...(q.product_id ? { productId: q.product_id } : {}) },
      include: { product: { select: { name: true, sku: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });

    res.json(
      rows.map((m) => ({
        id: m.id,
        product_id: m.productId,
        product_name: m.product.name,
        sku: m.product.sku,
        type: m.type,
        quantity: num(m.quantity),
        balance: num(m.balance),
        reference: m.reference,
        note: m.note,
        created_at: m.createdAt,
      }))
    );
  })
);
