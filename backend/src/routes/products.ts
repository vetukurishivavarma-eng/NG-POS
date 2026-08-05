import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { assertStoreAccess, authenticate, currentUser, requireRole } from '../middleware/auth.js';
import { serializeProduct, serializeProductWithStock } from '../lib/serialize.js';
import { notFound } from '../lib/errors.js';

export const productsRouter = Router();
productsRouter.use(authenticate);

const productSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  sku: z.string().min(1),
  barcode: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
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
  limit: z.coerce.number().min(1).max(1000).default(200),
  offset: z.coerce.number().min(0).default(0),
});

productsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const organizationId = currentUser(req).organizationId;

    const products = await prisma.product.findMany({
      where: {
        organizationId,
        ...(q.brand ? { brand: q.brand } : {}),
        ...(q.category ? { category: q.category } : {}),
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

    res.json(products.map(serializeProduct));
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
 * The catalogue the till actually uses: every active product joined with this
 * store's stock level and its store-specific price, in one round trip.
 */
productsRouter.get(
  '/with-stock/:storeId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const storeId = req.params.storeId as string;
    assertStoreAccess(user, storeId);

    const store = await prisma.store.findFirst({
      where: { id: storeId, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!store) throw notFound('Store not found.');

    const products = await prisma.product.findMany({
      where: { organizationId: user.organizationId, isActive: true },
      orderBy: { name: 'asc' },
      include: {
        inventory: { where: { storeId }, select: { quantity: true, reorderLevel: true } },
        prices: { where: { storeId }, select: { price: true } },
      },
    });

    res.json(
      products.map((p) =>
        serializeProductWithStock(
          p,
          p.inventory[0]?.quantity ?? 0,
          p.inventory[0]?.reorderLevel ?? 10,
          p.prices[0]?.price ?? null
        )
      )
    );
  })
);

productsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, organizationId: currentUser(req).organizationId },
    });
    if (!product) throw notFound('Product not found.');
    res.json(serializeProduct(product));
  })
);

productsRouter.post(
  '/',
  requireRole('ORG_ADMIN', 'STORE_MANAGER'),
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
        costPrice: body.cost_price,
        sellingPrice: body.selling_price,
        taxType: body.tax_type,
        unit: body.unit ?? null,
        isActive: body.is_active,
        imageBase64: body.image_base64 ?? null,
      },
    });
    res.status(201).json(serializeProduct(product));
  })
);

productsRouter.put(
  '/:id',
  requireRole('ORG_ADMIN', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const body = productSchema.partial().parse(req.body);
    const organizationId = currentUser(req).organizationId;

    const existing = await prisma.product.findFirst({
      where: { id: req.params.id, organizationId },
    });
    if (!existing) throw notFound('Product not found.');

    const product = await prisma.product.update({
      where: { id: existing.id },
      data: {
        name: body.name,
        description: body.description,
        sku: body.sku,
        barcode: body.barcode,
        brand: body.brand,
        category: body.category,
        costPrice: body.cost_price,
        sellingPrice: body.selling_price,
        taxType: body.tax_type,
        unit: body.unit,
        isActive: body.is_active,
        imageBase64: body.image_base64,
      },
    });

    res.json(serializeProduct(product));
  })
);

/** Soft delete: past receipts still reference the product. */
productsRouter.delete(
  '/:id',
  requireRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    const organizationId = currentUser(req).organizationId;
    const existing = await prisma.product.findFirst({
      where: { id: req.params.id, organizationId },
    });
    if (!existing) throw notFound('Product not found.');

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
  requireRole('ORG_ADMIN', 'STORE_MANAGER'),
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
