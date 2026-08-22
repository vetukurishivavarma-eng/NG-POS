import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import {
  assertStoreAccess,
  authenticate,
  currentUser,
  requireAnyCapability,
  requireCapability,
} from '../middleware/auth.js';
import { num, serializeProduct, serializeProductWithStock } from '../lib/serialize.js';
import { mayViewCosts } from '../lib/capabilities.js';
import { badRequest, notFound } from '../lib/errors.js';
import { nextAuditAction } from '../lib/auditContext.js';
import {
  CATEGORY_LIST_HINT,
  PRODUCT_CATEGORIES,
  normaliseCategory,
} from '../lib/categories.js';

export const productsRouter = Router();
productsRouter.use(authenticate);

/**
 * Accepts any spelling of a known head and stores the canonical one; refuses a
 * value that isn't one of them, so the taxonomy can't be widened by a typo.
 */
const categoryField = z
  .string()
  .nullable()
  .optional()
  .transform((value) => normaliseCategory(value))
  .refine((value) => value !== undefined, { message: `Unknown category. ${CATEGORY_LIST_HINT}` });

const productSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  sku: z.string().min(1),
  barcode: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  category: categoryField,
  /** The active ingredient — several brands share one, so it is its own field. */
  chemical_name: z.string().nullable().optional(),
  /**
   * `YYYY-MM-DD`, and stored as midnight UTC so a phone in another time zone
   * cannot shift the date it shows by a day.
   */
  expiry_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Write the expiry date as YYYY-MM-DD.')
    .nullable()
    .optional()
    .transform((value) => (value ? new Date(`${value}T00:00:00.000Z`) : value)),
  transport_cost: z.number().min(0).default(0),
  cost_price: z.number().min(0).default(0),
  selling_price: z.number().min(0).default(0),
  tax_type: z.enum(['exempt', 'vat']).default('exempt'),
  unit: z.string().nullable().optional(),
  is_active: z.boolean().default(true),
  image_base64: z.string().nullable().optional(),
});

const listQuery = z.object({
  search: z.string().optional(),
  brand: z.string().optional(),
  category: z.string().optional(),
  /**
   * The "still needs filing" view — products no one has put under a head yet.
   *
   * Not `z.coerce.boolean()`: that is `Boolean("false")`, which is `true`, so
   * `?uncategorized=false` would switch the filter *on*.
   */
  uncategorized: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((value) => value === 'true' || value === '1'),
  /**
   * Default excludes a deactivated product — matching what the till already
   * shows (`with-stock` filters `isActive: true`) so the same catalogue reads
   * the same count everywhere. Same non-coerce trick as `uncategorized`:
   * `z.coerce.boolean()` would read `?include_inactive=false` as true.
   */
  include_inactive: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((value) => value === 'true' || value === '1'),
  limit: z.coerce.number().min(1).max(1000).default(200),
  offset: z.coerce.number().min(0).default(0),
});

/**
 * Which stored spellings belong to a head, read from the catalogue itself.
 *
 * Filtering can't just compare against the canonical string: a product saved
 * before the list existed still reads "Fertilizers", and `/categories` counts
 * it under **Fertilizer**. Matching the raw values the same way the counter
 * does is what keeps the chip's number and the list it opens in agreement.
 */
async function storedCategories(organizationId: string) {
  const rows = await prisma.product.findMany({
    where: { organizationId },
    distinct: ['category'],
    select: { category: true },
  });
  return rows.map((r) => r.category).filter((c): c is string => Boolean(c));
}

productsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const organizationId = currentUser(req).organizationId;

    // One extra query, and only when a category filter is actually on.
    const stored = q.category || q.uncategorized ? await storedCategories(organizationId) : [];
    const head = q.category ? normaliseCategory(q.category) : null;

    const products = await prisma.product.findMany({
      where: {
        organizationId,
        ...(q.include_inactive ? {} : { isActive: true }),
        ...(q.brand ? { brand: q.brand } : {}),
        ...(q.category
          ? { category: { in: stored.filter((c) => normaliseCategory(c) === head) } }
          : {}),
        // "Unfiled" means the same here as it does in the counts: never set, or
        // set to something the list no longer recognises.
        ...(q.uncategorized
          ? {
              AND: [
                {
                  OR: [
                    { category: null },
                    { category: '' },
                    { category: { in: stored.filter((c) => !normaliseCategory(c)) } },
                  ],
                },
              ],
            }
          : {}),
        ...(q.search
          ? {
              OR: [
                { name: { contains: q.search, mode: 'insensitive' } },
                { sku: { contains: q.search, mode: 'insensitive' } },
                { barcode: { contains: q.search, mode: 'insensitive' } },
                { brand: { contains: q.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: q.limit,
      skip: q.offset,
    });

    const showCosts = await mayViewCosts(currentUser(req));
    res.json(products.map((p) => serializeProduct(p, showCosts)));
  })
);

productsRouter.get(
  '/brands',
  asyncHandler(async (req, res) => {
    const rows = await prisma.product.findMany({
      where: { organizationId: currentUser(req).organizationId, brand: { not: null } },
      distinct: ['brand'],
      select: { brand: true },
      orderBy: { brand: 'asc' },
    });
    res.json(rows.map((r) => r.brand).filter((b): b is string => Boolean(b)));
  })
);

/**
 * The category picker and filter chips.
 *
 * Every head is returned whether or not anything is filed under it — the list
 * is fixed, so a category with no products is information ("nothing is filed
 * under Equipment yet"), not an empty result to hide. `uncategorized` is what
 * tells the shop how much of the catalogue still needs doing.
 */
productsRouter.get(
  '/categories',
  asyncHandler(async (req, res) => {
    const organizationId = currentUser(req).organizationId;

    const grouped = await prisma.product.groupBy({
      by: ['category'],
      where: { organizationId, isActive: true },
      _count: { _all: true },
    });

    const counts = new Map<string, number>();
    let uncategorized = 0;
    for (const row of grouped) {
      const canonical = normaliseCategory(row.category);
      if (!canonical) {
        // Both "never set" and "set to something we no longer recognise" need
        // filing, so they count as the same job.
        uncategorized += row._count._all;
        continue;
      }
      counts.set(canonical, (counts.get(canonical) ?? 0) + row._count._all);
    }

    res.json({
      categories: PRODUCT_CATEGORIES.map((name) => ({ name, count: counts.get(name) ?? 0 })),
      uncategorized,
    });
  })
);

/**
 * The catalogue the till actually uses: every active product joined with this
 * store's stock level and its store-specific price, in one round trip.
 */
productsRouter.get(
  '/with-stock/:storeId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const storeId = req.params.storeId as string;
    await assertStoreAccess(user, storeId);

    const store = await prisma.store.findFirst({
      where: { id: storeId, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!store) throw notFound('Store not found.');

    const products = await prisma.product.findMany({
      where: { organizationId: user.organizationId, isActive: true },
      orderBy: { name: 'asc' },
      include: {
        inventory: { where: { storeId }, select: { quantity: true, reorderLevel: true, expiryDate: true } },
        prices: { where: { storeId }, select: { price: true } },
      },
    });

    const showCosts = await mayViewCosts(user);
    res.json(
      products.map((p) =>
        serializeProductWithStock(
          p,
          p.inventory[0]?.quantity ?? 0,
          p.inventory[0]?.reorderLevel ?? 10,
          p.prices[0]?.price ?? null,
          showCosts,
          p.inventory[0]?.expiryDate ?? null
        )
      )
    );
  })
);

const productDetailQuery = z.object({ store_id: z.string().uuid().optional() });

productsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { store_id } = productDetailQuery.parse(req.query);
    const user = currentUser(req);
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, organizationId: user.organizationId },
    });
    if (!product) throw notFound('Product not found.');
    const showCosts = await mayViewCosts(user);

    // Without a store, this is the master record. A shop's own price or
    // expiry silently outranks this on the till (see with-stock), and admin
    // had no way to know one existed short of checking every shop by hand —
    // this is genuinely confusing on a product like "master price K272, but
    // Chilyabale quietly charges K271." So the master view also lists every
    // shop that has diverged, price and/or expiry, right beside the base
    // value it's overriding.
    if (!store_id) {
      const [overridePrices, overrideExpiries] = await Promise.all([
        prisma.storePrice.findMany({
          where: { productId: product.id },
          select: { price: true, store: { select: { id: true, name: true } } },
        }),
        prisma.inventory.findMany({
          where: { productId: product.id, expiryDate: { not: null } },
          select: { expiryDate: true, store: { select: { id: true, name: true } } },
        }),
      ]);

      const byStore = new Map<
        string,
        { store_id: string; store_name: string; price: number | null; expiry_date: string | null }
      >();
      for (const row of overridePrices) {
        byStore.set(row.store.id, {
          store_id: row.store.id,
          store_name: row.store.name,
          price: num(row.price),
          expiry_date: null,
        });
      }
      for (const row of overrideExpiries) {
        const existing = byStore.get(row.store.id);
        const expiry_date = row.expiryDate!.toISOString().slice(0, 10);
        if (existing) existing.expiry_date = expiry_date;
        else byStore.set(row.store.id, { store_id: row.store.id, store_name: row.store.name, price: null, expiry_date });
      }

      res.json({
        ...serializeProduct(product, showCosts),
        store_overrides: [...byStore.values()].sort((a, b) => a.store_name.localeCompare(b.store_name)),
      });
      return;
    }
    await assertStoreAccess(user, store_id);

    const [price, inventory] = await Promise.all([
      prisma.storePrice.findUnique({
        where: { storeId_productId: { storeId: store_id, productId: product.id } },
        select: { price: true },
      }),
      prisma.inventory.findUnique({
        where: { storeId_productId: { storeId: store_id, productId: product.id } },
        select: { quantity: true, reorderLevel: true, expiryDate: true },
      }),
    ]);

    res.json(
      serializeProductWithStock(
        product,
        inventory?.quantity ?? 0,
        inventory?.reorderLevel ?? 10,
        price?.price ?? null,
        showCosts,
        inventory?.expiryDate ?? null
      )
    );
  })
);

productsRouter.post(
  '/',
  requireCapability('products.write'),
  asyncHandler(async (req, res) => {
    const body = productSchema.parse(req.body);
    const product = await prisma.product.create({
      data: {
        organizationId: currentUser(req).organizationId,
        name: body.name,
        description: body.description ?? null,
        sku: body.sku,
        barcode: body.barcode ?? null,
        brand: body.brand ?? null,
        category: body.category ?? null,
        chemicalName: body.chemical_name ?? null,
        expiryDate: body.expiry_date ?? null,
        transportCost: body.transport_cost,
        costPrice: body.cost_price,
        sellingPrice: body.selling_price,
        taxType: body.tax_type,
        unit: body.unit ?? null,
        isActive: body.is_active,
        imageBase64: body.image_base64 ?? null,
      },
    });
    res.status(201).json(serializeProduct(product, await mayViewCosts(currentUser(req))));
  })
);

productsRouter.put(
  '/:id',
  // Two doors: `products.write` (full edit — an admin, or a shop's own
  // permanent grant while the entry window is open) or `pricing.write`
  // (permanent for shop staff, and only ever enough for the selling price —
  // see the fullWrite/showCosts split below). Either is enough to reach the
  // handler; which one applies decides how much of the body gets honoured.
  requireAnyCapability('products.write', 'pricing.write'),
  asyncHandler(async (req, res) => {
    const body = productSchema
      .partial()
      .extend({ store_id: z.string().uuid().optional() })
      .parse(req.body);
    const user = currentUser(req);
    const organizationId = user.organizationId;

    const existing = await prisma.product.findFirst({
      where: { id: req.params.id, organizationId },
    });
    if (!existing) throw notFound('Product not found.');

    // An account that cannot see the buying price cannot write it either, and
    // this is not a nicety. Such an account is *sent* a cost price of zero, so
    // saving any edit at all — a corrected spelling, a new category — would post
    // that zero back and destroy the real figure for the whole organisation.
    // The field is dropped from the update rather than rejected, because the
    // shop did nothing wrong by sending back what it was given.
    const showCosts = await mayViewCosts(user);

    // The same trust tier that may see the buying price is the only one that
    // may rewrite the identity/commerce fields of the product record itself
    // (name, SKU, barcode, tax type, cost, ...). A shop login reaches this
    // route with `pricing.write` and a narrower set: selling price and expiry
    // (both store-scoped, below), plus chemical name and category, which the
    // client asked to always update the shared master list regardless of who
    // edits them — a product with a different name/chemical/category per shop
    // reads as a different product, which is worse than one shop's edit
    // reaching everyone.
    const fullWrite = showCosts;

    // Where a `selling_price` or `expiry_date` edit lands, so it never spills
    // onto a shop that did not ask for it:
    //  - A shop login always writes just their own store's row (StorePrice /
    //    Inventory.expiryDate) — the app sends the store it is currently
    //    signed into as `store_id`, never the org-wide Product fields. Batches
    //    (and hence expiry) genuinely differ by shop, and the client was
    //    explicit that a price or expiry change must not touch another shop.
    //  - An admin/warehouse account picks a store from a list in the app;
    //    that edit is scoped the same way. Only when they leave the picker on
    //    "All Shops" (no `store_id`) does it become the org-wide base/master
    //    value — and, same as before, that clears every store's own
    //    override, since a new base value with a stale override still
    //    outranking it would be worse than no base value at all.
    const wantsStoreScopedField = body.selling_price !== undefined || body.expiry_date !== undefined;
    let storeScopeId: string | null = null;
    if (wantsStoreScopedField) {
      if (!fullWrite && !body.store_id) {
        throw badRequest('store_id is required to change the selling price or expiry date.');
      }
      storeScopeId = body.store_id ?? null;
      if (storeScopeId) await assertStoreAccess(user, storeScopeId);
    }

    const product = await prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id: existing.id },
        data: fullWrite
          ? {
              name: body.name,
              description: body.description,
              sku: body.sku,
              barcode: body.barcode,
              brand: body.brand,
              category: body.category,
              chemicalName: body.chemical_name,
              expiryDate: storeScopeId ? undefined : body.expiry_date,
              costPrice: body.cost_price,
              transportCost: body.transport_cost,
              sellingPrice: storeScopeId ? undefined : body.selling_price,
              taxType: body.tax_type,
              unit: body.unit,
              isActive: body.is_active,
              imageBase64: body.image_base64,
            }
          : {
              // Always the master list — never store-scoped.
              category: body.category,
              chemicalName: body.chemical_name,
            },
      });

      if (body.selling_price !== undefined) {
        if (storeScopeId) {
          await tx.storePrice.upsert({
            where: { storeId_productId: { storeId: storeScopeId, productId: existing.id } },
            create: { storeId: storeScopeId, productId: existing.id, price: body.selling_price },
            update: { price: body.selling_price },
          });
        } else {
          await tx.storePrice.deleteMany({ where: { productId: existing.id } });
        }
      }

      if (body.expiry_date !== undefined) {
        if (storeScopeId) {
          await tx.inventory.upsert({
            where: { storeId_productId: { storeId: storeScopeId, productId: existing.id } },
            create: { storeId: storeScopeId, productId: existing.id, expiryDate: body.expiry_date },
            update: { expiryDate: body.expiry_date },
          });
        } else {
          await tx.inventory.updateMany({ where: { productId: existing.id }, data: { expiryDate: null } });
        }
      }

      return updated;
    });

    res.json(serializeProduct(product, showCosts));
  })
);

/** Soft delete: past receipts still reference the product. */
productsRouter.delete(
  '/:id',
  requireCapability('products.delete'),
  asyncHandler(async (req, res) => {
    const organizationId = currentUser(req).organizationId;
    const existing = await prisma.product.findFirst({
      where: { id: req.params.id, organizationId },
    });
    if (!existing) throw notFound('Product not found.');

    nextAuditAction('deactivate');
    await prisma.product.update({ where: { id: existing.id }, data: { isActive: false } });
    res.json({ detail: 'Product deactivated.' });
  })
);

const importSchema = z.object({
  products: z.array(productSchema).min(1),
});

/**
 * Bulk upsert keyed on SKU, so re-importing a corrected spreadsheet updates
 * rows instead of failing on duplicates.
 */
productsRouter.post(
  '/import',
  requireCapability('products.import'),
  asyncHandler(async (req, res) => {
    const { products } = importSchema.parse(req.body);
    const organizationId = currentUser(req).organizationId;

    let created = 0;
    let updated = 0;

    for (const p of products) {
      const existing = await prisma.product.findUnique({
        where: { organizationId_sku: { organizationId, sku: p.sku } },
        select: { id: true },
      });

      const data = {
        name: p.name,
        description: p.description ?? null,
        barcode: p.barcode ?? null,
        brand: p.brand ?? null,
        category: p.category ?? null,
        chemicalName: p.chemical_name ?? null,
        expiryDate: p.expiry_date ?? null,
        transportCost: p.transport_cost,
        costPrice: p.cost_price,
        sellingPrice: p.selling_price,
        taxType: p.tax_type,
        unit: p.unit ?? null,
        isActive: p.is_active,
      };

      if (existing) {
        await prisma.product.update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await prisma.product.create({ data: { ...data, organizationId, sku: p.sku } });
        created += 1;
      }
    }

    res.json({ created, updated, total: products.length });
  })
);
