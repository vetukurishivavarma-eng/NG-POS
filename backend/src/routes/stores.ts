import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { assertStoreAccess, authenticate, currentUser, requireRole } from '../middleware/auth.js';
import { serializeStore } from '../lib/serialize.js';
import { conflict, notFound } from '../lib/errors.js';

export const storesRouter = Router();
storesRouter.use(authenticate);

const addressSchema = z
  .object({
    street: z.string().default(''),
    city: z.string().default(''),
    province: z.string().default(''),
    postal_code: z.string().default(''),
    country: z.string().default('Zambia'),
  })
  .partial()
  .optional();

const storeSchema = z.object({
  name: z.string().min(1),
  /**
   * Optional: opening a shop should only ask for its name. Left out, the code
   * is derived from the name — it is plumbing (the front of every receipt
   * number here), not something an owner should have to invent.
   */
  code: z
    .string()
    .min(1)
    .transform((c) => c.toUpperCase().replace(/[^A-Z0-9-]/g, ''))
    .optional(),
  address: addressSchema,
  location: z
    .object({ latitude: z.number().nullable(), longitude: z.number().nullable() })
    .partial()
    .optional(),
  phone: z.string().default(''),
  email: z.string().email().or(z.literal('')).default(''),
  is_active: z.boolean().default(true),
});

storesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);

    const stores = await prisma.store.findMany({
      where: {
        organizationId: user.organizationId,
        // Non-admins with explicit assignments only see their own stores.
        ...(user.role !== 'ORG_ADMIN' && user.assignedStores.length > 0
          ? { id: { in: user.assignedStores } }
          : {}),
      },
      orderBy: { name: 'asc' },
    });

    res.json(stores.map(serializeStore));
  })
);

storesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const store = await prisma.store.findFirst({
      where: { id: req.params.id, organizationId: user.organizationId },
    });
    if (!store) throw notFound('Store not found.');
    await assertStoreAccess(user, store.id);
    res.json(serializeStore(store));
  })
);

/**
 * A shop code that is unique within the organisation.
 *
 * Receipt numbers are `CODE-YYYYMMDD-NNNNNN` and their counters are keyed on the
 * store, so two shops sharing a code would print receipts that look identical
 * on paper. Hence the suffix rather than a rejection: two shops may legitimately
 * be named after the same place.
 */
async function uniqueCode(organizationId: string, name: string): Promise<string> {
  const base = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'SHOP';

  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const taken = await prisma.store.findFirst({
      where: { organizationId, code: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }

  throw conflict('Could not derive a shop code from that name. Enter one yourself.');
}

storesRouter.post(
  '/',
  requireRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    const body = storeSchema.parse(req.body);
    const organizationId = currentUser(req).organizationId;

    const code = body.code || (await uniqueCode(organizationId, body.name));
    if (body.code) {
      const clash = await prisma.store.findFirst({
        where: { organizationId, code },
        select: { name: true },
      });
      if (clash) throw conflict(`${clash.name} already uses the code ${code}.`, 'STORE_CODE_TAKEN');
    }

    const store = await prisma.store.create({
      data: {
        organizationId,
        name: body.name,
        code,
        street: body.address?.street ?? '',
        city: body.address?.city ?? '',
        province: body.address?.province ?? '',
        postalCode: body.address?.postal_code ?? '',
        country: body.address?.country ?? 'Zambia',
        latitude: body.location?.latitude ?? null,
        longitude: body.location?.longitude ?? null,
        phone: body.phone,
        email: body.email,
        isActive: body.is_active,
      },
    });
    res.status(201).json(serializeStore(store));
  })
);

storesRouter.put(
  '/:id',
  requireRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    const body = storeSchema.partial().parse(req.body);
    const user = currentUser(req);

    const existing = await prisma.store.findFirst({
      where: { id: req.params.id, organizationId: user.organizationId },
    });
    if (!existing) throw notFound('Store not found.');

    if (body.code && body.code !== existing.code) {
      const clash = await prisma.store.findFirst({
        where: { organizationId: user.organizationId, code: body.code, id: { not: existing.id } },
        select: { name: true },
      });
      if (clash)
        throw conflict(`${clash.name} already uses the code ${body.code}.`, 'STORE_CODE_TAKEN');
    }

    const store = await prisma.store.update({
      where: { id: existing.id },
      data: {
        name: body.name,
        code: body.code,
        street: body.address?.street,
        city: body.address?.city,
        province: body.address?.province,
        postalCode: body.address?.postal_code,
        country: body.address?.country,
        latitude: body.location?.latitude,
        longitude: body.location?.longitude,
        phone: body.phone,
        email: body.email,
        isActive: body.is_active,
      },
    });

    res.json(serializeStore(store));
  })
);

/**
 * Soft delete. Transactions reference stores for their history, so a store is
 * deactivated rather than removed.
 */
storesRouter.delete(
  '/:id',
  requireRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const existing = await prisma.store.findFirst({
      where: { id: req.params.id, organizationId: user.organizationId },
    });
    if (!existing) throw notFound('Store not found.');

    await prisma.store.update({ where: { id: existing.id }, data: { isActive: false } });
    res.json({ detail: 'Store deactivated.' });
  })
);
