import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { assertStoreAccess, authenticate, currentUser, requireRole } from '../middleware/auth.js';
import { num } from '../lib/serialize.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parseCsvObjects } from '../lib/csv.js';
import { CATEGORY_LIST_HINT, normaliseCategory } from '../lib/categories.js';

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
  requireRole('ORG_ADMIN', 'STORE_MANAGER'),
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
 * The columns of the stock spreadsheet, in the order the template writes them.
 * `sku` is the key everything else hangs off: it is what makes a re-upload an
 * update rather than a second copy of the catalogue.
 */
const TEMPLATE_COLUMNS = [
  'sku',
  'name',
  'barcode',
  'brand',
  'category',
  'unit',
  'cost_price',
  'selling_price',
  'tax_type',
  'quantity',
  'reorder_level',
] as const;

/**
 * Headings a shop's own spreadsheet is likely to already use. Accepting them
 * means the file can be handed over as it is kept, rather than retyped into our
 * shape — which is where transcription errors come from.
 */
const HEADER_ALIASES: Record<string, string> = {
  code: 'sku',
  item_code: 'sku',
  product_code: 'sku',
  stock_code: 'sku',
  product: 'name',
  product_name: 'name',
  item: 'name',
  item_name: 'name',
  bar_code: 'barcode',
  ean: 'barcode',
  make: 'brand',
  manufacturer: 'brand',
  group: 'category',
  uom: 'unit',
  units: 'unit',
  cost: 'cost_price',
  buying_price: 'cost_price',
  purchase_price: 'cost_price',
  price: 'selling_price',
  sale_price: 'selling_price',
  retail_price: 'selling_price',
  unit_price: 'selling_price',
  tax: 'tax_type',
  vat: 'tax_type',
  qty: 'quantity',
  stock: 'quantity',
  opening_stock: 'quantity',
  quantity_in_stock: 'quantity',
  reorder: 'reorder_level',
  re_order_level: 'reorder_level',
  reorder_point: 'reorder_level',
  min_stock: 'reorder_level',
  minimum_stock: 'reorder_level',
};

const TEMPLATE_CSV = [
  TEMPLATE_COLUMNS.join(','),
  // The category column teaches the fixed list — see lib/categories.ts.
  'AGV-0001,Dairy Meal 50kg,6009123456789,Novatek,Animal Feed,bag,320.00,395.00,exempt,40,10',
  'AGV-0002,Layers Mash 50kg,6009123456796,Novatek,Animal Feed,bag,305.50,375.00,exempt,25,10',
  'AGV-0003,Newcastle Vaccine 100ml,,Kepro,Veterinary,bottle,48.00,72.50,vat,12,6',
  'AGV-0004,Knapsack Sprayer 16L,6009123456819,Jembe,Equipment,piece,410.00,540.00,vat,6,2',
  'AGV-0005,Maize Seed SC627 10kg,,Seedco,Maize Seed,bag,255.00,320.00,exempt,18,5',
].join('\r\n');

const bulkUploadSchema = z
  .object({
    store_id: z.string().uuid(),
    /** The spreadsheet, saved as CSV and sent as text. */
    csv: z.string().optional(),
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
    /** Checks the file and reports what would happen, changing nothing. */
    validate_only: z.boolean().default(false),
    reference: z.string().default(''),
    note: z.string().default(''),
  })
  .refine((b) => Boolean(b.csv) !== Boolean(b.rows), {
    message: 'Send either csv text or rows, not both.',
  });

const MAX_UPLOAD_ROWS = 1000;

type RowError = { row: number; sku: string; message: string };

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
  requireRole('ORG_ADMIN', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = bulkUploadSchema.parse(req.body);
    const user = currentUser(req);
    await assertStoreAccess(user, body.store_id);

    /* ---------------------------------------------------------- 1. read it */

    let records: Record<string, string>[];
    if (body.csv !== undefined) {
      const parsed = parseCsvObjects(body.csv, HEADER_ALIASES);
      if (parsed.rows.length === 0) throw badRequest('The file has a header row but no data rows.');
      if (!parsed.headers.includes('sku')) {
        throw badRequest(
          `The file needs an "sku" column. Found: ${parsed.headers.filter(Boolean).join(', ') || 'nothing'}.`
        );
      }
      records = parsed.rows;
    } else {
      records = (body.rows ?? []).map((r) => {
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(r)) {
          const canonical = HEADER_ALIASES[key.toLowerCase()] ?? key.toLowerCase();
          out[canonical] = value === null || value === undefined ? '' : String(value).trim();
        }
        return out;
      });
      if (records.length === 0) throw badRequest('No rows were sent.');
    }

    if (records.length > MAX_UPLOAD_ROWS) {
      throw badRequest(
        `${records.length} rows is more than the ${MAX_UPLOAD_ROWS} allowed in one upload. Split the file.`
      );
    }

    /* ------------------------------------------------------ 2. validate it */

    const errors: RowError[] = [];
    const warnings: string[] = [];
    const seenSku = new Map<string, number>();

    type Parsed = {
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
    };

    const parsedRows: Parsed[] = [];

    records.forEach((record, index) => {
      const line = index + 2;
      const sku = (record.sku ?? '').trim();
      const fail = (message: string) => errors.push({ row: line, sku, message });

      if (!sku) {
        fail('No SKU. Every row needs a product code.');
        return;
      }
      const duplicateOf = seenSku.get(sku.toLowerCase());
      if (duplicateOf) {
        fail(`SKU ${sku} also appears on line ${duplicateOf}. Combine them into one row.`);
        return;
      }
      seenSku.set(sku.toLowerCase(), line);

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

      parsedRows.push({
        line,
        sku,
        name: (record.name ?? '').trim(),
        barcode: (record.barcode ?? '').trim() || null,
        brand: (record.brand ?? '').trim() || null,
        category: category ?? null,
        unit: (record.unit ?? '').trim() || null,
        costPrice: numeric(record.cost_price, 'Cost price'),
        sellingPrice: numeric(record.selling_price, 'Selling price'),
        taxType,
        quantity: numeric(record.quantity, 'Quantity'),
        reorderLevel: numeric(record.reorder_level, 'Reorder level'),
      });
    });

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
          warnings.push(`Line ${row.line}: ${row.sku} is new and has no selling price — it will be created at 0.`);
        }
      }
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

    const summary = {
      store_id: body.store_id,
      mode: body.mode,
      total_rows: plan.length,
      products_to_create: plan.filter((p) => p.product_action === 'create').length,
      products_to_update: plan.filter((p) => p.product_action === 'update').length,
      stock_rows: plan.filter((p) => p.parsed.quantity !== null).length,
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
      },
      // A thousand rows over a pooled connection to a serverless database takes
      // longer than the five-second default, and a timeout here rolls the whole
      // import back for no reason other than impatience.
      { timeout: 120_000, maxWait: 20_000 }
    );

    return res.status(201).json({
      applied: true,
      detail: `${summary.total_rows} rows imported: ${summary.products_to_create} products created, ${summary.products_to_update} updated.`,
      ...summary,
      reference,
    });
  })
);

/**
 * The blank spreadsheet, with five filled-in example rows so the shape of a row
 * is obvious. Served as a file download so it can be opened straight in Excel.
 */
inventoryRouter.get(
  '/bulk-upload/template',
  asyncHandler(async (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ng-pos-stock-template.csv"');
    // The BOM is what makes Excel open a UTF-8 CSV without mangling accented
    // characters; our own parser strips it back off on the way in.
    res.send(`﻿${TEMPLATE_CSV}\r\n`);
  })
);

/** The same columns as JSON, for a client that wants to build the form itself. */
inventoryRouter.get(
  '/bulk-upload/columns',
  asyncHandler(async (_req, res) => {
    res.json({
      columns: TEMPLATE_COLUMNS,
      required: ['sku'],
      required_for_new_products: ['sku', 'name'],
      accepted_aliases: HEADER_ALIASES,
      max_rows: MAX_UPLOAD_ROWS,
      sample_csv: TEMPLATE_CSV,
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
