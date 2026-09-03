import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import {
  assertStoreAccess,
  assertStoreInOrganization,
  authenticate,
  currentUser,
  requireCapability,
} from '../middleware/auth.js';
import { num, serializeProduct, serializeUser } from '../lib/serialize.js';
import { mayViewCosts } from '../lib/capabilities.js';
import { badRequest, notFound } from '../lib/errors.js';
import { nextAuditAction } from '../lib/auditContext.js';
import { revokeAllSessions } from './devices.js';

/* ------------------------------------------------------------------- users */

export const usersRouter = Router();
usersRouter.use(authenticate);

usersRouter.get(
  '/',
  requireCapability('users.view'),
  asyncHandler(async (req, res) => {
    const users = await prisma.user.findMany({
      where: { organizationId: currentUser(req).organizationId },
      orderBy: { fullName: 'asc' },
    });
    res.json(users.map(serializeUser));
  })
);

const userSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(2),
  password: z.string().min(8),
  role: z.enum(['ORG_ADMIN', 'STORE_MANAGER', 'CASHIER']).default('CASHIER'),
  assigned_stores: z.array(z.string().uuid()).default([]),
  is_active: z.boolean().default(true),
});

usersRouter.post(
  '/',
  requireCapability('users.write'),
  asyncHandler(async (req, res) => {
    const body = userSchema.parse(req.body);
    const user = await prisma.user.create({
      data: {
        organizationId: currentUser(req).organizationId,
        email: body.email.toLowerCase(),
        passwordHash: await bcrypt.hash(body.password, 10),
        fullName: body.full_name,
        role: body.role,
        assignedStores: body.assigned_stores,
        isActive: body.is_active,
      },
    });
    res.status(201).json(serializeUser(user));
  })
);

usersRouter.put(
  '/:id',
  requireCapability('users.write'),
  asyncHandler(async (req, res) => {
    const body = userSchema.partial().parse(req.body);
    const organizationId = currentUser(req).organizationId;

    const existing = await prisma.user.findFirst({ where: { id: req.params.id, organizationId } });
    if (!existing) throw notFound('User not found.');

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        email: body.email?.toLowerCase(),
        fullName: body.full_name,
        role: body.role,
        assignedStores: body.assigned_stores,
        isActive: body.is_active,
        // Setting a password from here is how an admin takes an account back —
        // usually because it is compromised. That has to end the sessions the
        // old password opened, or the tokens keep working for another 30 days.
        ...(body.password
          ? { passwordHash: await bcrypt.hash(body.password, 10), passwordChangedAt: new Date() }
          : {}),
      },
    });

    // Taking an account back has to free the handset too. Otherwise the new
    // password is useless: the one-device rule would refuse the sign-in because
    // the device being taken away is still holding the claim.
    if (body.password) await revokeAllSessions(user.id, 'Password reset by administrator');
    // Deactivating is the same act by another name — the device keeps its claim
    // and blocks nobody, but leaving it listed as active misreports the estate.
    if (body.is_active === false) await revokeAllSessions(user.id, 'Account deactivated');

    res.json(serializeUser(user));
  })
);

usersRouter.delete(
  '/:id',
  requireCapability('users.write'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    if (me.id === req.params.id) throw badRequest('You cannot deactivate your own account.');

    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, organizationId: me.organizationId },
    });
    if (!existing) throw notFound('User not found.');

    nextAuditAction('deactivate');
    await prisma.user.update({ where: { id: existing.id }, data: { isActive: false } });
    res.json({ detail: 'User deactivated.' });
  })
);

/* ----------------------------------------------------------- store pricing */

export const storePricingRouter = Router();
storePricingRouter.use(authenticate);

storePricingRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { store_id } = z.object({ store_id: z.string().uuid() }).parse(req.query);
    await assertStoreAccess(currentUser(req), store_id);

    const rows = await prisma.storePrice.findMany({
      where: { storeId: store_id },
      include: { product: true },
      orderBy: { product: { name: 'asc' } },
    });

    res.json(
      rows.map((r) => ({
        id: r.id,
        store_id: r.storeId,
        product_id: r.productId,
        product_name: r.product.name,
        sku: r.product.sku,
        brand: r.product.brand,
        default_price: num(r.product.sellingPrice),
        store_price: num(r.price),
        difference: num(r.price) - num(r.product.sellingPrice),
      }))
    );
  })
);

storePricingRouter.post(
  '/',
  requireCapability('pricing.write'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        store_id: z.string().uuid(),
        product_id: z.string().uuid(),
        price: z.number().min(0),
      })
      .parse(req.body);

    const user = currentUser(req);
    await assertStoreAccess(user, body.store_id);

    // The store is now known to be ours; the product has to be checked too, or
    // a price row could be pinned to another organisation's product.
    const product = await prisma.product.findFirst({
      where: { id: body.product_id, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!product) throw notFound('Product not found.');

    const row = await prisma.storePrice.upsert({
      where: { storeId_productId: { storeId: body.store_id, productId: body.product_id } },
      create: { storeId: body.store_id, productId: body.product_id, price: body.price },
      update: { price: body.price },
    });

    res.status(201).json({ id: row.id, store_price: num(row.price) });
  })
);

storePricingRouter.delete(
  '/:id',
  requireCapability('pricing.write'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);

    // Deleting straight by id trusted whatever the caller sent: any manager
    // could remove any organisation's custom price by guessing a uuid. Resolve
    // it inside the tenant first, and a foreign id is simply not found.
    const existing = await prisma.storePrice.findFirst({
      where: {
        id: req.params.id as string,
        store: { organizationId: user.organizationId },
      },
      select: { id: true, storeId: true },
    });
    if (!existing) throw notFound('Custom price not found.');

    await assertStoreAccess(user, existing.storeId);
    await prisma.storePrice.delete({ where: { id: existing.id } });
    res.json({ detail: 'Custom price removed; the catalogue price now applies.' });
  })
);

/* --------------------------------------------------------------- transfers */

export const transfersRouter = Router();
transfersRouter.use(authenticate);

transfersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await prisma.transfer.findMany({
      where: { organizationId: currentUser(req).organizationId },
      include: {
        items: { include: { product: { select: { name: true, sku: true } } } },
        fromStore: { select: { name: true } },
        toStore: { select: { name: true } },
        sourceTransfer: { select: { reference: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    res.json(
      rows.map((t) => ({
        id: t.id,
        reference: t.reference,
        from_store_id: t.fromStoreId,
        from_store: t.fromStore?.name ?? null,
        to_store_id: t.toStoreId,
        to_store: t.toStore?.name ?? null,
        status: t.status,
        source_transfer_id: t.sourceTransferId,
        source_reference: t.sourceTransfer?.reference ?? null,
        // Printed on the transfer note, so it has to come back out of the API.
        notes: t.notes,
        items: t.items.map((i) => ({
          product_id: i.productId,
          product_name: i.product.name,
          sku: i.product.sku,
          quantity: num(i.quantity),
        })),
        created_at: t.createdAt,
      }))
    );
  })
);

const transferSchema = z.object({
  from_store_id: z.string().uuid(),
  to_store_id: z.string().uuid(),
  items: z
    .array(z.object({ product_id: z.string().uuid(), quantity: z.number().positive() }))
    .min(1),
  notes: z.string().optional(),
  /** The transfer this stock arrived on, when this one is "passing it on". */
  source_transfer_id: z.string().uuid().optional(),
});

/**
 * Moves stock between stores. Both sides move in one transaction, so stock can
 * never be counted twice or vanish partway through.
 */
transfersRouter.post(
  '/',
  requireCapability('transfers.create'),
  asyncHandler(async (req, res) => {
    const body = transferSchema.parse(req.body);
    const user = currentUser(req);

    if (body.from_store_id === body.to_store_id) {
      throw badRequest('Source and destination must be different stores.');
    }
    // Stock only leaves a shop the sender works at.
    await assertStoreAccess(user, body.from_store_id);
    // The destination is checked for tenancy but not for assignment. Sending to
    // a sister shop is what a transfer *is* — nobody at Katende is assigned to
    // Chinkuli — and requiring one there left every single-shop user with
    // nowhere to send to. Crossing organisations is still refused.
    await assertStoreInOrganization(user, body.to_store_id);

    // A pass-on link, if given, has to be a real transfer in this organisation.
    if (body.source_transfer_id) {
      const parent = await prisma.transfer.findFirst({
        where: { id: body.source_transfer_id, organizationId: user.organizationId },
        select: { id: true },
      });
      if (!parent) throw badRequest('The transfer this stock came from could not be found.');
    }

    const transfer = await prisma.$transaction(async (tx) => {
      const reference = `TRF-${Date.now().toString(36).toUpperCase()}`;

      const created = await tx.transfer.create({
        data: {
          organizationId: user.organizationId,
          reference,
          fromStoreId: body.from_store_id,
          toStoreId: body.to_store_id,
          status: 'completed',
          notes: body.notes ?? '',
          sourceTransferId: body.source_transfer_id ?? null,
          items: {
            createMany: {
              data: body.items.map((i) => ({
                productId: i.product_id,
                quantity: new Prisma.Decimal(i.quantity),
              })),
            },
          },
        },
        include: { items: true },
      });

      for (const item of body.items) {
        const qty = new Prisma.Decimal(item.quantity);

        const source = await tx.inventory.findUnique({
          where: { storeId_productId: { storeId: body.from_store_id, productId: item.product_id } },
        });
        if (!source || source.quantity.lt(qty)) {
          throw badRequest('Not enough stock at the source store to transfer.');
        }

        const out = await tx.inventory.update({
          where: { storeId_productId: { storeId: body.from_store_id, productId: item.product_id } },
          data: { quantity: { decrement: qty } },
        });
        const into = await tx.inventory.upsert({
          where: { storeId_productId: { storeId: body.to_store_id, productId: item.product_id } },
          create: { storeId: body.to_store_id, productId: item.product_id, quantity: qty },
          update: { quantity: { increment: qty } },
        });

        await tx.stockMovement.createMany({
          data: [
            {
              storeId: body.from_store_id,
              productId: item.product_id,
              type: 'transfer_out',
              quantity: qty.neg(),
              balance: out.quantity,
              reference,
              userId: user.id,
            },
            {
              storeId: body.to_store_id,
              productId: item.product_id,
              type: 'transfer_in',
              quantity: qty,
              balance: into.quantity,
              reference,
              userId: user.id,
            },
          ],
        });
      }

      return created;
    });

    res.status(201).json({ id: transfer.id, reference: transfer.reference, status: transfer.status });
  })
);

/* -------------------------------------------------------------------- sync */

export const syncRouter = Router();
syncRouter.use(authenticate);

/**
 * Delta pull for offline clients: everything in this store's catalogue that
 * changed since `last_sync`. Omit it for a full download.
 *
 * `server_time` is echoed back so the client stores the server's clock, not its
 * own — device clocks on cheap Android hardware drift badly, and a fast clock
 * would silently skip records.
 */
syncRouter.get(
  '/pull',
  asyncHandler(async (req, res) => {
    const q = z
      .object({ store_id: z.string().uuid(), last_sync: z.string().optional() })
      .parse(req.query);

    const user = currentUser(req);
    await assertStoreAccess(user, q.store_id);

    const since = q.last_sync ? new Date(q.last_sync) : null;
    if (since && Number.isNaN(since.getTime())) throw badRequest('last_sync is not a valid date.');

    const serverTime = new Date();

    const products = await prisma.product.findMany({
      where: {
        organizationId: user.organizationId,
        ...(since ? { updatedAt: { gt: since } } : {}),
      },
      include: {
        inventory: { where: { storeId: q.store_id } },
        prices: { where: { storeId: q.store_id } },
      },
      orderBy: { updatedAt: 'asc' },
      take: 2000,
    });

    const inventory = await prisma.inventory.findMany({
      where: { storeId: q.store_id, ...(since ? { updatedAt: { gt: since } } : {}) },
      take: 5000,
    });

    // The offline catalogue lands in SQLite on the handset, so a cost price sent
    // here does not just appear on a screen — it stays on the device.
    const showCosts = await mayViewCosts(user);

    res.json({
      server_time: serverTime.toISOString(),
      products: products.map((p) => ({
        ...serializeProduct(p, showCosts),
        selling_price: p.prices[0] ? num(p.prices[0].price) : num(p.sellingPrice),
        quantity: num(p.inventory[0]?.quantity ?? 0),
        reorder_level: num(p.inventory[0]?.reorderLevel ?? 10),
      })),
      inventory: inventory.map((i) => ({
        product_id: i.productId,
        store_id: i.storeId,
        quantity: num(i.quantity),
        reorder_level: num(i.reorderLevel),
      })),
    });
  })
);
