import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { assertStoreAccess, authenticate, currentUser, requireRole } from '../middleware/auth.js';
import { num } from '../lib/serialize.js';
import { badRequest, notFound } from '../lib/errors.js';

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
    assertStoreAccess(user, q.store_id);

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
    assertStoreAccess(user, body.store_id);

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

    assertStoreAccess(currentUser(req), q.store_id);

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
