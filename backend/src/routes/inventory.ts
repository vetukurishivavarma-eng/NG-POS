import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import {
  assertStoreAccess,
  authenticate,
  currentUser,
  requireCapability,
  type AuthUser,
} from '../middleware/auth.js';
import { capabilityContext, mayViewCosts } from '../lib/capabilities.js';
import { recordAudit } from '../lib/audit.js';
import { num } from '../lib/serialize.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parseCsvObjects, tableToObjects, type TableObjects } from '../lib/csv.js';
import { readXlsx, XlsxError } from '../lib/xlsx.js';
import { CATEGORY_LIST_HINT, normaliseCategory } from '../lib/categories.js';
import {
  detectMisheadedSku,
  flatten,
  formatSheetDate,
  HEADER_ALIASES,
  KNOWN_FIELDS,
  parseSheetDate,
  parseShopColumn,
  productNameFrom,
  readCostPrice,
  SHEET_COLUMNS,
  shopPriceColumn,
  shopStockColumn,
  synthesiseSku,
  type ShopColumnKind,
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

    // `value` is stock at cost, so it is a buying price with a quantity applied
    // to it and is withheld from the same accounts for the same reason.
    const showCosts = await mayViewCosts(user);

    const mapped = rows.map((r) => ({
      product_id: r.productId,
      store_id: r.storeId,
      product_name: r.product.name,
      sku: r.product.sku,
      brand: r.product.brand,
      quantity: num(r.quantity),
      reorder_level: num(r.reorderLevel),
      value: showCosts ? num(r.quantity) * num(r.product.costPrice) : 0,
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
 * The one sheet the app hands out, blank but for three worked example rows.
 *
 * Every shop gets two columns — what is on its shelf at the end of the day, and
 * what it sells the line for — so the whole chain is one file and nobody has to
 * say which shop they are uploading. `shops` arrives in the order the export
 * writes them, and the two orders must stay identical: the current list and the
 * blank template are the same document, one filled in and one not, and a
 * shop that pastes rows between them would otherwise paste them askew.
 *
 * The examples price and count the first shop only. Filling all thirteen with
 * the same invented number teaches nothing the first pair does not, and buries
 * the columns the operator actually has to fill in.
 */
function sheetCsv(shopNames: string[]): string {
  const line = (cells: (string | number)[]) => cells.map(csvCell).join(',');

  const shopCells = (stock: number | string, price: number | string) =>
    shopNames.flatMap((_, index) => (index === 0 ? [stock, price] : ['', '']));

  return [
    line([...SHEET_COLUMNS, ...shopColumnHeadings(shopNames)]),
    line([
      '', 'STARKE AYRES', 'carrots', '100g', '', '', 'Veg Seed', 'packet', 'exempt', 205, 236,
      ...shopCells(15, 236),
    ]),
    line([
      '', 'Novatek', 'Dairy Meal', '50kg', '', '2027-07-31', 'Animal Feed', 'bag', 'exempt', 320, 395,
      ...shopCells(40, 395),
    ]),
    line([
      '', 'Kepro', 'Actellic Gold Dust', '250g', 'Pirimiphos-methyl 1.6%', '07/2027', 'Pesticides',
      'tin', 'vat', 48, 72.5,
      ...shopCells(12, 75),
    ]),
  ].join('\r\n');
}

/** A shop name that is safe in a filename: "Katende, East" -> "katende-east". */
function fileSafe(name: string): string {
  return flatten(name).replace(/ /g, '-') || 'shop';
}

/** Two headings per shop, in the order both downloads write them. */
function shopColumnHeadings(shopNames: string[]): string[] {
  return shopNames.flatMap((name) => [shopStockColumn(name), shopPriceColumn(name)]);
}

/** A shop called "Katende, East" would otherwise split into two columns. */
function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const bulkUploadSchema = z
  .object({
    /**
     * Optional, and normally absent. The sheet carries every shop in its own
     * columns, so there is no one shop to be uploading *into* and the app no
     * longer asks for one. It stays accepted for a file that has a single bare
     * quantity column and nothing to say about which shelf it describes.
     */
    store_id: z.string().uuid().optional(),
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
    /** The same switch for the per-shop closing stock columns. */
    apply_shop_stock: z.boolean().default(true),
    /**
     * What a row with every closing stock cell empty means.
     *
     * Off, it means "this file says nothing about that product's stock", and
     * every shelf is left where it is. On, it means "none of these shops has
     * any", and they are all written to zero so the product reads as out of
     * stock at the till.
     *
     * There is no safe default for that, which is why the app asks: the dry run
     * counts those rows and names them, and the operator agrees to the second
     * reading before it is sent. Ignored where the file has no closing stock
     * column at all — a price list is not a stock take, and reading one as a
     * chain-wide zero would empty every shelf in the organisation.
     */
    zero_missing_stock: z.boolean().default(false),
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
  /** Whether it is that shop's closing stock or that shop's selling price. */
  kind: ShopColumnKind;
  storeId: string | null;
  storeName: string | null;
  status: 'ok' | 'unknown_shop' | 'no_access' | 'no_permission';
  /** How many rows carry a value in this column. */
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
  chemicalName: string | null;
  expiryDate: Date | null;
  costPrice: number | null;
  sellingPrice: number | null;
  taxType: 'exempt' | 'vat' | null;
  quantity: number | null;
  reorderLevel: number | null;
  /** Per-shop prices from the "<shop> SP Per Stock" columns, by store id. */
  shopPrices: Map<string, number>;
  /** Per-shop closing stock from the "<shop> Closing Stock" columns. */
  shopQuantities: Map<string, number>;
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
  ['chemicalName', 'The chemical name'],
  ['expiryDate', 'The expiry date'],
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
    if (current !== null && current !== '' && !sameValue(current, next)) return label;
  }
  for (const [storeId, price] of from.shopPrices) {
    const current = into.shopPrices.get(storeId);
    if (current !== undefined && current !== price) return 'A shop price';
  }
  for (const [storeId, quantity] of from.shopQuantities) {
    const current = into.shopQuantities.get(storeId);
    if (current !== undefined && current !== quantity) return "A shop's closing stock";
  }

  for (const [field, _label] of MERGEABLE_FIELDS) {
    const next = from[field];
    if (next === null || next === '') continue;
    // Checked above: either unset, or already equal to what we are assigning.
    (into[field] as Parsed[typeof field]) = next;
  }
  for (const [storeId, price] of from.shopPrices) into.shopPrices.set(storeId, price);
  for (const [storeId, quantity] of from.shopQuantities) into.shopQuantities.set(storeId, quantity);
  into.pricesShops = into.pricesShops || from.pricesShops;

  return null;
}

/**
 * Two cell values that mean the same thing.
 *
 * Dates need saying out loud: the same expiry typed on two repeated rows parses
 * to two `Date` objects, and `!==` calls them a contradiction and rejects the
 * file over a row that agrees with itself.
 */
function sameValue(a: Parsed[keyof Parsed], b: Parsed[keyof Parsed]): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
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
 * Loads the chain's stock spreadsheet: creates or updates the products in it,
 * and sets each shop's closing stock and selling price from that shop's own
 * pair of columns, in a single transaction.
 *
 * One file for the whole chain, which is why nothing here asks which shop is
 * uploading. The sheet says so itself, twice per shop — "Lusaka Closing Stock"
 * is what is on Lusaka's shelf tonight and "Lusaka SP Per Stock" is what Lusaka
 * charges for it — and a person loading thirteen shops was previously loading
 * thirteen files and choosing the shop right thirteen times.
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
    if (body.store_id) await assertStoreAccess(user, body.store_id);

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
    let hasSku = parsed.headers.includes('sku');
    const hasName = parsed.headers.includes('name');
    const warnings: string[] = [];
    if (!hasSku && !hasName) {
      throw badRequest(
        `The file needs either an "sku" column, or a "PRODUCT" column (with "COMPANY" and "PACKSIZE") so a product code can be worked out. Found: ${
          parsed.rawHeaders.filter(Boolean).join(', ') || 'nothing'
        }.`
      );
    }

    /* ------------------------- 1b-ii. a SKU column that is really a pack size */

    /*
     * The buyer's price master labels its pack-size column SKU. Ours calls it
     * PACKSIZE, and the first version of this check told the client to rename
     * their heading — which is asking somebody to re-label a file they keep
     * every month so that our vocabulary can stay as it is. The file is theirs;
     * reading it is our job.
     *
     * So it is adopted rather than refused, but only where the reading is not a
     * guess. Three things must hold together: the values are shaped like pack
     * sizes (25g, 1ltr, 500ml), the same value is used by genuinely different
     * products, and company + product + that value identifies every row on its
     * own. A column satisfying all three cannot be a product code — a code
     * shared by thirty-six seeds is not a code — and a genuinely broken code
     * column, full of things like ABC123, matches none of them and still gets
     * the row-by-row treatment.
     *
     * What is done is always said. The response carries a warning naming the
     * column and what it was read as, because a file that imports differently
     * from how it is written should never do so quietly.
     */
    if (hasSku) {
      const misheaded = detectMisheadedSku(
        records.map((record) => ({
          sku: (record.sku ?? '').trim(),
          name: (record.name ?? '').trim(),
          company: (record.company ?? '').trim(),
        }))
      );

      const heading = parsed.rawHeaders[parsed.headers.indexOf('sku')] || 'SKU';
      const alreadyHasPackSize = parsed.headers.includes('pack_size');

      if (misheaded && misheaded.uniqueAsPackSize && !alreadyHasPackSize) {
        for (const record of records) {
          record.pack_size = (record.sku ?? '').trim();
          record.sku = '';
        }
        hasSku = false;
        warnings.push(
          `The "${heading}" column holds pack sizes (${misheaded.examples.join(', ')}), so it was read as the pack size. ` +
            `Products are identified by company, product and pack size, and a code was worked out for each of the ${misheaded.rows} rows.`
        );
      } else if (misheaded) {
        // Pack sizes, but they do not identify the rows either — two lines
        // share a company, a product and a pack size. Nothing here can be
        // reinterpreted safely, so it is said plainly.
        throw badRequest(
          `The "${heading}" column holds pack sizes, not product codes: ${misheaded.examples.join(', ')}. ` +
            (alreadyHasPackSize
              ? `The file already has a pack size column as well, so remove or rename "${heading}".`
              : `Company, product and pack size do not identify every row either, so some products cannot be told apart. ` +
                `Give the repeated rows a distinguishing pack size, or add a real product code.`) +
            ` Nothing was imported.`
        );
      }
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
      // stock, and it is checked once rather than per column.
      const canPrice = (await capabilityContext(user)).capabilities.includes('pricing.write');
      const unrestricted = user.role === 'ORG_ADMIN' || user.assignedStores.length === 0;

      for (const { raw, key } of unclaimed) {
        const named = parseShopColumn(raw);
        const store = named ? byLabel.get(named.shop) : undefined;
        if (!named || !store) {
          unrecognisedColumns.push(raw);
          continue;
        }
        shopColumns.push({
          column: raw,
          key,
          kind: named.kind,
          storeId: store.id,
          storeName: store.name,
          // A closing stock column needs no pricing permission — it is a count,
          // not a price — but both need the uploader to be allowed in the shop.
          status:
            named.kind === 'price' && !canPrice
              ? 'no_permission'
              : !unrestricted && !user.assignedStores.includes(store.id)
                ? 'no_access'
                : 'ok',
          values: records.filter((r) => (r[key] ?? '').trim() !== '').length,
        });
      }

      // Two headings for the same shop and the same thing — "Lusaka Stock"
      // beside "Lusaka Closing Stock" — would both be read, and the second
      // would quietly win. Named rather than merged: only the file knows which
      // of the two the shop actually counted.
      const seenColumn = new Set<string>();
      for (const column of shopColumns) {
        const signature = `${column.storeId}:${column.kind}`;
        if (!seenColumn.has(signature)) {
          seenColumn.add(signature);
          continue;
        }
        throw badRequest(
          `Two columns give ${column.storeName} the same thing — its ${
            column.kind === 'stock' ? 'closing stock' : 'selling price'
          } — including "${column.column}". Remove one of them. Nothing was imported.`
        );
      }
    }

    /* ------------------------------------------------------ 2. validate it */

    const errors: RowError[] = [];
    // `warnings` is declared with the header checks above: reading the sheet
    // can already have something to say before a single row is validated.
    const seenSku = new Map<string, Parsed>();

    const parsedRows: Parsed[] = [];
    const writableShopColumns = shopColumns.filter((c) => c.status === 'ok');
    const writablePriceColumns = writableShopColumns.filter((c) => c.kind === 'price');
    const writableStockColumns = writableShopColumns.filter((c) => c.kind === 'stock');
    const merged: number[] = [];
    let zeroShopPrices = 0;

    records.forEach((record, index) => {
      const line = index + 2;
      const company = (record.company ?? '').trim();
      const packSize = (record.pack_size ?? '').trim();
      const product = (record.name ?? '').trim();

      // The sheet's own code where the cell has one, and a code worked out from
      // what identifies the row where it does not — see `synthesiseSku`.
      //
      // Falling back per row rather than per file is what lets one shape serve
      // both downloads: the blank template's SKU column is empty on every line,
      // and the current list's is filled in with the codes the catalogue
      // already holds, so what comes back matches those rows instead of
      // building a second catalogue beside them under invented codes.
      const given = hasSku ? (record.sku ?? '').trim() : '';
      const name = productNameFrom(product, packSize);
      const sku = given || (product ? synthesiseSku(company, product, packSize) : '');

      const fail = (message: string) => errors.push({ row: line, sku, message });

      if (!sku) {
        fail('No product code and no product name, so this row cannot be identified.');
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
      for (const column of writablePriceColumns) {
        const raw = (record[column.key] ?? '').trim();
        if (!raw) continue;
        pricesShops = true;
        const value = numeric(raw, `"${column.column}"`);
        if (value === null) continue;
        // A shop price of zero is not a price. Written as one it means that
        // shop sells the item for nothing, and it reads as deliberate at the
        // till — where the buyer's sheet means "not priced here yet", and the
        // product's own selling price is the honest fallback. Counted and
        // reported rather than refused: a 200-line sheet with a few empty cells
        // is normal, and rejecting the file over them helps nobody.
        if (value === 0) {
          zeroShopPrices += 1;
          continue;
        }
        shopPrices.set(column.storeId as string, value);
      }

      // A shop's closing stock, where a price of zero was dropped a moment ago.
      // Zero is a fact about a shelf, not a missing answer: an item that sold
      // out today closes on nothing, and refusing to write that would leave the
      // system claiming stock the shop does not have.
      const shopQuantities = new Map<string, number>();
      for (const column of writableStockColumns) {
        const raw = (record[column.key] ?? '').trim();
        if (!raw) continue;
        const value = numeric(raw, `"${column.column}"`);
        if (value === null) continue;
        shopQuantities.set(column.storeId as string, value);
      }

      const expiryDate = parseSheetDate(record.expiry_date);
      if (expiryDate === undefined) {
        fail(
          `Expiry date "${(record.expiry_date ?? '').trim()}" could not be read. ` +
            'Write it as 2027-07-15, 15/07/2027 or 07/2027.'
        );
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
        chemicalName: (record.chemical_name ?? '').trim() || null,
        expiryDate: expiryDate ?? null,
        costPrice: numeric(readCostPrice(record), 'Cost price'),
        sellingPrice: numeric(record.selling_price, 'Selling price'),
        taxType,
        quantity: numeric(record.quantity, 'Quantity'),
        reorderLevel: numeric(record.reorder_level, 'Reorder level'),
        shopPrices,
        shopQuantities,
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

    /*
     * Which shelves this file speaks for.
     *
     * Normally every one of them: a shop with a "Closing Stock" column has
     * counted itself, and thirteen of those in one sheet is the whole point of
     * the format. `store_id` is the older, single-shop way in, kept for a file
     * that carries one bare QTY column and no shop headings at all.
     */
    const legacyStoreId = body.store_id ?? null;
    const stockStoreIds = [
      ...new Set([
        ...(body.apply_shop_stock ? writableStockColumns.map((c) => c.storeId as string) : []),
        ...(legacyStoreId ? [legacyStoreId] : []),
      ]),
    ];

    const levels =
      stockStoreIds.length > 0
        ? await prisma.inventory.findMany({
            where: { storeId: { in: stockStoreIds }, productId: { in: existing.map((p) => p.id) } },
            select: { storeId: true, productId: true, quantity: true },
          })
        : [];
    const levelAt = new Map(levels.map((l) => [`${l.storeId}:${l.productId}`, num(l.quantity)]));

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

    if (zeroShopPrices > 0) {
      warnings.push(
        `${zeroShopPrices} shop price${zeroShopPrices === 1 ? ' was' : 's were'} zero and ${
          zeroShopPrices === 1 ? 'was' : 'were'
        } left out — those shops will use the product's own selling price. Fill the cells in to price them separately.`
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
    if (!body.apply_shop_prices && writablePriceColumns.length > 0) {
      warnings.push('Per-shop prices were switched off for this import, so those columns were read and skipped.');
    }
    if (!body.apply_shop_stock && writableStockColumns.length > 0) {
      warnings.push('Per-shop closing stock was switched off for this import, so those columns were read and skipped.');
    }

    // A single QTY column and nothing saying whose shelf it is. It used to be
    // this shop's, because the screen asked which shop before it asked for the
    // file; now nothing does, so there is no shelf to put it on and saying so
    // is the only honest answer.
    if (!legacyStoreId && parsedRows.some((r) => r.quantity !== null)) {
      warnings.push(
        'The plain quantity column was skipped — it does not say which shop counted it. ' +
          'Use one "<shop> Closing Stock" column per shop, as the template does.'
      );
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

    /** One shelf this row moves: which shop, from what, to what. */
    interface ShelfPlan {
      storeId: string;
      before: number;
      after: number;
      /**
       * False for a row that only sets a reorder level. Without it the write
       * below would put the placeholder zero on the shelf, and a file adjusting
       * nothing but reorder levels would empty the shop.
       */
      counted: boolean;
      /**
       * Per shelf rather than per file, because a zeroed row is absolute
       * whatever the file's mode is. "Add on a delivery" plus "this shop has
       * none" is an increment of nothing, which would leave yesterday's count
       * on a shelf the operator has just said is empty.
       */
      mode: 'set' | 'add';
      quantity: number;
      reorderLevel: number | null;
    }

    const plan = parsedRows.map((row) => {
      const known = existingBySku.get(row.sku);
      const at = (storeId: string) => (known ? (levelAt.get(`${storeId}:${known.id}`) ?? 0) : 0);

      // The shop's own column first. The bare quantity column only fills in for
      // the named shop where that shop did not column itself, so a file that
      // carries both cannot count one shelf twice.
      const shelves = new Map<string, ShelfPlan>();
      if (body.apply_shop_stock) {
        for (const [storeId, quantity] of row.shopQuantities) {
          const before = at(storeId);
          shelves.set(storeId, {
            storeId,
            before,
            after: body.mode === 'set' ? quantity : before + quantity,
            counted: true,
            mode: body.mode,
            quantity,
            reorderLevel: null,
          });
        }
      }
      if (legacyStoreId && !shelves.has(legacyStoreId) && (row.quantity !== null || row.reorderLevel !== null)) {
        const before = at(legacyStoreId);
        const quantity = row.quantity ?? 0;
        shelves.set(legacyStoreId, {
          storeId: legacyStoreId,
          before,
          after: row.quantity === null ? before : body.mode === 'set' ? quantity : before + quantity,
          counted: row.quantity !== null,
          mode: body.mode,
          quantity,
          reorderLevel: row.reorderLevel,
        });
      }

      /*
       * A row the file lists but never counts anywhere.
       *
       * Left alone by default — a sheet that carries only prices is not saying
       * every shop is empty. Where the operator has confirmed that it is, every
       * shop in the file is written to zero, which is what puts "Out of stock"
       * against the product at the till.
       */
      const unstocked = writableStockColumns.length > 0 && shelves.size === 0;
      if (unstocked && body.zero_missing_stock) {
        for (const column of writableStockColumns) {
          const storeId = column.storeId as string;
          shelves.set(storeId, {
            storeId,
            before: at(storeId),
            after: 0,
            counted: true,
            mode: 'set',
            quantity: 0,
            reorderLevel: null,
          });
        }
      }

      const stock = [...shelves.values()];
      // Summed across the shelves this row touches. A per-shop breakdown of 500
      // rows × 13 shops is not something anybody reads on a phone before
      // pressing Import; the number that answers "is this file right?" is what
      // the chain holds now against what it would hold after.
      const before = stock.reduce((sum, shelf) => sum + shelf.before, 0);
      const after = stock.reduce((sum, shelf) => sum + shelf.after, 0);

      return {
        row: row.line,
        sku: row.sku,
        name: row.name || known?.name || row.sku,
        product_action: known ? (body.update_existing_products ? 'update' : 'unchanged') : 'create',
        /** How many shops this row counts. */
        shops: stock.length,
        /** True where the file lists the product but counts it nowhere. */
        unstocked,
        quantity_before: Math.round(before * 1000) / 1000,
        quantity_after: Math.round(after * 1000) / 1000,
        change: Math.round((after - before) * 1000) / 1000,
        stock,
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

    const shopStockWrites = plan.reduce((sum, p) => sum + p.stock.length, 0);

    // The rows the app asks about before importing. Named, not just counted:
    // "42 products have no stock" is a number to shrug at, and four product
    // names is something the person holding the phone can recognise as right
    // or wrong.
    const unstocked = plan.filter((p) => p.unstocked);

    const summary = {
      store_id: legacyStoreId,
      mode: body.mode,
      total_rows: plan.length,
      products_to_create: plan.filter((p) => p.product_action === 'create').length,
      products_to_update: plan.filter((p) => p.product_action === 'update').length,
      /** Rows that move at least one shelf. */
      stock_rows: plan.filter((p) => p.stock.length > 0).length,
      /** Shelves moved, counting each shop separately. */
      shop_stock_writes: shopStockWrites,
      shops_counted: new Set(plan.flatMap((p) => p.stock.map((s) => s.storeId))).size,
      /**
       * Rows the file lists but counts in no shop. What happens to them is the
       * operator's call — see `zero_missing_stock` — so the dry run reports
       * them and the app asks before sending the answer.
       */
      rows_without_stock: unstocked.length,
      products_without_stock: unstocked.slice(0, 20).map((p) => p.name),
      /** What this particular request did with them. */
      zeroed_missing_stock: body.zero_missing_stock,
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
        preview: plan
          .slice(0, 25)
          .map(({ parsed: _parsed, productId: _id, stock: _stock, ...rest }) => rest),
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
              chemicalName: entry.parsed.chemicalName,
              expiryDate: entry.parsed.expiryDate,
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
              ...(p.chemicalName ? { chemicalName: p.chemicalName } : {}),
              ...(p.expiryDate ? { expiryDate: p.expiryDate } : {}),
              ...(p.costPrice === null ? {} : { costPrice: new Prisma.Decimal(p.costPrice) }),
              ...(p.sellingPrice === null ? {} : { sellingPrice: new Prisma.Decimal(p.sellingPrice) }),
              ...(p.taxType === null ? {} : { taxType: p.taxType }),
            };
            if (Object.keys(data).length === 0) continue;
            await tx.product.update({ where: { id: entry.productId as string }, data });
          }
        }

        const movements: Prisma.StockMovementCreateManyInput[] = [];

        // One row now moves as many shelves as it has filled-in shop columns,
        // so this is a loop inside a loop where it used to be a single pass.
        for (const entry of plan) {
          const productId = entry.productId as string;

          for (const shelf of entry.stock) {
            const qty = new Prisma.Decimal(shelf.quantity);

            const level = await tx.inventory.upsert({
              where: { storeId_productId: { storeId: shelf.storeId, productId } },
              create: {
                storeId: shelf.storeId,
                productId,
                quantity: qty,
                ...(shelf.reorderLevel === null
                  ? {}
                  : { reorderLevel: new Prisma.Decimal(shelf.reorderLevel) }),
              },
              update: {
                ...(!shelf.counted
                  ? {}
                  : shelf.mode === 'set'
                    ? { quantity: qty }
                    : { quantity: { increment: qty } }),
                ...(shelf.reorderLevel === null
                  ? {}
                  : { reorderLevel: new Prisma.Decimal(shelf.reorderLevel) }),
              },
            });

            const change = level.quantity.minus(shelf.before);
            if (change.isZero()) continue;

            movements.push({
              storeId: shelf.storeId,
              productId,
              // A counted total is a correction to what the system believed; a
              // delivery is a purchase. The movement history has to say which.
              type: shelf.mode === 'set' ? 'adjustment' : 'purchase',
              quantity: change,
              balance: level.quantity,
              reference,
              note: body.note.trim() || 'Bulk stock upload',
              userId: user.id,
            });
          }
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
          const storeIds = writablePriceColumns.map((c) => c.storeId as string);
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
        (shopStockWrites > 0
          ? `, ${shopStockWrites} stock levels set across ${summary.shops_counted} shops`
          : '') +
        (shopPriceWrites > 0
          ? `, ${shopPriceWrites} shop prices set across ${writablePriceColumns.length} shops`
          : ''),
      organizationId: user.organizationId,
      storeId: legacyStoreId,
      details: { ...summary, reference },
    });

    return res.status(201).json({
      applied: true,
      detail: [
        `${summary.total_rows} rows imported: ${summary.products_to_create} products created, ${summary.products_to_update} updated.`,
        shopStockWrites > 0
          ? `${shopStockWrites} stock levels set across ${summary.shops_counted} shops.`
          : '',
        body.zero_missing_stock && unstocked.length > 0
          ? `${unstocked.length} product${unstocked.length === 1 ? '' : 's'} marked out of stock.`
          : '',
        shopPriceWrites > 0
          ? `${shopPriceWrites} shop prices set across ${writablePriceColumns.length} shops.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
      ...summary,
      reference,
    });
  })
);

/**
 * The shops this account's downloads are columned by, in the order both write
 * them.
 *
 * An owner gets the whole chain, which is the file the chain is run from. A
 * shop gets its own two columns and nothing else — and that is not only tidier,
 * it is the difference between a manager correcting one column and a manager
 * scrolling past twenty-four belonging to shops they cannot write to anyway.
 * The importer already refused those columns; this stops them being handed out
 * in the first place.
 */
async function shopColumnsFor(user: AuthUser): Promise<{ id: string; name: string }[]> {
  // An empty assignment means "all shops" everywhere else in this API, and it
  // has to mean the same here or an unrestricted manager would get no columns.
  const unrestricted = user.role === 'ORG_ADMIN' || user.assignedStores.length === 0;

  return prisma.store.findMany({
    where: {
      organizationId: user.organizationId,
      isActive: true,
      ...(unrestricted ? {} : { id: { in: user.assignedStores } }),
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}

/**
 * The blank spreadsheet, with worked example rows so the shape of a row is
 * obvious. Served as a file download so it can be opened straight in Excel.
 *
 * There is no format to choose any more. There were two, and the choice was
 * silent in the way that costs a week: a shop that picked the price list to
 * send its counts back sent a file with no stock column in it, and nobody found
 * out until the numbers did not move.
 */
inventoryRouter.get(
  '/bulk-upload/template',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const shops = await shopColumnsFor(user);
    const csv = sheetCsv(shops.map((s) => s.name));

    // Named after the shop when it is one shop's sheet, so a manager with four
    // downloads in their phone's Files app can tell them apart.
    const filename =
      shops.length === 1
        ? `ng-pos-stock-template-${fileSafe(shops[0]?.name ?? '')}.csv`
        : 'ng-pos-stock-template.csv';

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
    const shops = (await shopColumnsFor(user)).map((s) => s.name);

    res.json({
      columns: [...SHEET_COLUMNS, ...shopColumnHeadings(shops)],
      required: ['PRODUCT'],
      notes:
        'One file for the whole chain. No product codes needed — a stable code is worked out ' +
        'from COMPANY + PRODUCT + PACKSIZE for any row that leaves SKU blank. Each shop gets ' +
        'two columns: "<shop> Closing Stock" is what is on its shelf, "<shop> SP Per Stock" is ' +
        'what it charges.',
      sample_csv: sheetCsv(shops),
      shops: shops.map((name) => ({
        shop: name,
        stock_column: shopStockColumn(name),
        price_column: shopPriceColumn(name),
      })),
      accepted_aliases: HEADER_ALIASES,
      accepts_xlsx: true,
      max_rows: MAX_UPLOAD_ROWS,
    });
  })
);

/* ------------------------------------------------------------ export back out */

/**
 * The catalogue as it stands, written in the shape this same route reads back.
 *
 * The same document as the blank template, filled in — that is the whole design
 * of it, and the reason there are two downloads and not four. The round trip is
 * what the owner asked for: take the current list away, correct it in Excel
 * where correcting it is easy, and send the same file back.
 *
 * The properties that make the round trip safe:
 *
 *  - `SKU` carries the code the catalogue already holds, so a re-upload updates
 *    these rows rather than creating a second catalogue beside them under
 *    synthesised codes.
 *  - Every active shop gets both its columns, whether or not it prices or
 *    stocks the product. A row that prices any shop is authoritative for all
 *    the shop price columns in the file, so an export that dropped the shops
 *    with no override would blank their prices on the way back in.
 *  - A money column reading zero is written **blank**. Zero here almost always
 *    means "nobody has said yet" — the price master arrived with 106 of 215
 *    rows unpriced — and a blank leaves the stored figure alone where a zero
 *    would overwrite it. It also puts the empty cells where the eye can find
 *    them, which is the point of sending the sheet out.
 *  - A closing stock of zero is written as `0`, because an empty shelf is an
 *    answer and a blank one is not.
 *
 * `PACKSIZE` comes back empty: the catalogue holds one name per product with
 * the pack size already joined onto it, and re-splitting "Carrots 100g" would
 * be guesswork. It stays in the file so both downloads are column-for-column
 * the same document, and a row that fills it in still imports.
 */
inventoryRouter.get(
  '/export',
  requireCapability('products.import'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);

    // The buying price is withheld from the same accounts as everywhere else.
    // The column stays — dropping it would make this a different file from the
    // template for some accounts and not others — and arrives blank, which the
    // importer reads as "says nothing about cost" and leaves the figure alone.
    const showCosts = await mayViewCosts(user);

    // The same shops the template columns itself by, so the two files stay one
    // document for every account: an owner's covers the chain, a shop's covers
    // that shop.
    const stores = await shopColumnsFor(user);
    const storeIds = stores.map((s) => s.id);

    /*
     * Whose products this file lists.
     *
     * An owner gets the catalogue. A shop gets its own lines — what it has on
     * the shelf or has priced — because a shop asked for its list and handed
     * back four hundred rows belonging to twelve other shops will not correct
     * any of them.
     *
     * The exception is a shop that carries nothing yet: it gets the catalogue,
     * because the alternative is an empty file and no way to load a first
     * stock take from the list it just downloaded.
     */
    const unrestricted = user.role === 'ORG_ADMIN' || user.assignedStores.length === 0;
    const carried = unrestricted
      ? null
      : [
          ...new Set([
            ...(
              await prisma.inventory.findMany({
                where: { storeId: { in: storeIds } },
                select: { productId: true },
              })
            ).map((r) => r.productId),
            ...(
              await prisma.storePrice.findMany({
                where: { storeId: { in: storeIds } },
                select: { productId: true },
              })
            ).map((r) => r.productId),
          ]),
        ];

    const products = await prisma.product.findMany({
      where: {
        organizationId: user.organizationId,
        isActive: true,
        ...(carried && carried.length > 0 ? { id: { in: carried } } : {}),
      },
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        category: true,
        unit: true,
        chemicalName: true,
        expiryDate: true,
        costPrice: true,
        sellingPrice: true,
        taxType: true,
      },
      orderBy: { name: 'asc' },
    });

    const productIds = products.map((p) => p.id);

    // Fetched alongside rather than as nested relations: one statement each,
    // where a per-product include would be one round trip per row.
    const [overrides, levels] = await Promise.all([
      prisma.storePrice.findMany({
        where: { storeId: { in: storeIds }, productId: { in: productIds } },
        select: { productId: true, storeId: true, price: true },
      }),
      prisma.inventory.findMany({
        where: { storeId: { in: storeIds }, productId: { in: productIds } },
        select: { productId: true, storeId: true, quantity: true },
      }),
    ]);

    const priceBy = new Map(overrides.map((o) => [`${o.productId}:${o.storeId}`, num(o.price)]));
    const stockBy = new Map(levels.map((l) => [`${l.productId}:${l.storeId}`, num(l.quantity)]));

    /** Blank for nothing, so an unanswered cell stays unanswered on the way back. */
    const money = (value: number | null | undefined): string =>
      value === null || value === undefined || value === 0 ? '' : value.toFixed(2);

    const columns = [...SHEET_COLUMNS, ...shopColumnHeadings(stores.map((s) => s.name))];

    const rows = products.map((p) =>
      [
        p.sku,
        p.brand ?? '',
        p.name,
        '',
        p.chemicalName ?? '',
        formatSheetDate(p.expiryDate),
        p.category ?? '',
        p.unit ?? '',
        p.taxType,
        showCosts ? money(num(p.costPrice)) : '',
        money(num(p.sellingPrice)),
        ...stores.flatMap((s) => [
          String(stockBy.get(`${p.id}:${s.id}`) ?? 0),
          money(priceBy.get(`${p.id}:${s.id}`)),
        ]),
      ]
        .map(csvCell)
        .join(',')
    );

    const day = new Date().toISOString().slice(0, 10);
    const filename =
      stores.length === 1
        ? `ng-pos-stock-list-${fileSafe(stores[0]?.name ?? '')}-${day}.csv`
        : `ng-pos-stock-list-${day}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // How many products are in it, so a client can say "nothing to send" without
    // parsing the file. The header row is not a row.
    res.setHeader('X-Product-Count', String(products.length));
    res.send(`﻿${[columns.map(csvCell).join(','), ...rows].join('\r\n')}\r\n`);
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
