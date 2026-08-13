import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { assertStoreAccess, authenticate, currentUser, requireCapability } from '../middleware/auth.js';
import { serializeStore } from '../lib/serialize.js';
import { conflict, notFound } from '../lib/errors.js';
import { nextAuditAction } from '../lib/auditContext.js';

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
  /**
   * Mark this as the warehouse.
   *
   * Until now the only thing that ever set this was a migration with
   * `WHERE code = 'LUSAKA001'` written into it. That store is no longer active,
   * so the flag sits on nothing and there has been no way to move it — which
   * takes the whole warehouse rule down with it, including the capabilities
   * everyone assigned there is supposed to get.
   *
   * It is not a cosmetic label. Anyone assigned to a store carrying this flag
   * gets **every administrator capability**, by the rule in `lib/capabilities.ts`
   * — including changing passwords and deactivating accounts. Granted by
   * assignment, and taken away the same way.
   */
  is_warehouse: z.boolean().optional(),
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

/**
 * Every shop in the organisation, as name and code only.
 *
 * `GET /stores` deliberately narrows to the caller's own shops, which is right
 * for a store picker and wrong for the far end of a transfer: someone at
 * Katende has to be able to send stock to Chinkuli without working there, and
 * with the narrowed list the screen had nowhere to send to at all.
 *
 * So this is a directory, not a second way to read a store. It returns the
 * three fields a picker needs and nothing else — no address, phone, email or
 * sync state — because needing to know a sister shop exists is not the same as
 * being entitled to its details.
 *
 * Declared above `/:id`, or Express matches "directory" as a store id.
 */
storesRouter.get(
  '/directory',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);

    const stores = await prisma.store.findMany({
      where: { organizationId: user.organizationId, isActive: true },
      // `staffFullAccess` is the warehouse flag, and it belongs in a picker.
      // Without it a transfer screen lists six names with nothing to say which
      // one is the warehouse — and "send it back to the warehouse" is the most
      // common transfer a shop makes. It is a fact about how a place is used,
      // not a detail of the place, so it does not breach the rule above.
      select: { id: true, name: true, code: true, staffFullAccess: true },
      orderBy: { name: 'asc' },
    });

    res.json(
      stores.map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
        staff_full_access: s.staffFullAccess,
      }))
    );
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
  requireCapability('stores.write'),
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
        staffFullAccess: body.is_warehouse ?? false,
      },
    });
    res.status(201).json(serializeStore(store));
  })
);

storesRouter.put(
  '/:id',
  requireCapability('stores.write'),
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
        // `partial()` means absent stays absent, so a form that does not send
        // this cannot silently strip a shop of its warehouse standing — and
        // with it, the capabilities of everyone assigned there.
        staffFullAccess: body.is_warehouse,
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
  requireCapability('stores.write'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const existing = await prisma.store.findFirst({
      where: { id: req.params.id, organizationId: user.organizationId },
    });
    if (!existing) throw notFound('Store not found.');

    nextAuditAction('deactivate');
    await prisma.store.update({ where: { id: existing.id }, data: { isActive: false } });
    res.json({ detail: 'Store deactivated.' });
  })
);
