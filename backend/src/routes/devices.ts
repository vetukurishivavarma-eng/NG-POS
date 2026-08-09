import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { authenticate, currentUser, requireRole } from '../middleware/auth.js';
import { serializeDevice } from '../lib/serialize.js';
import { badRequest, notFound } from '../lib/errors.js';

/**
 * Which device is holding which account.
 *
 * One account may only be signed in on one device at a time, so this is where
 * an administrator sees what is claimed and releases it — a phone that was
 * lost, sold, or is simply somebody else's.
 */
export const devicesRouter = Router();

devicesRouter.use(authenticate);

const listQuery = z.object({
  user_id: z.string().uuid().optional(),
  /** Revoked rows are the audit trail; they are off unless asked for. */
  include_revoked: z.enum(['true', 'false']).optional(),
});

/**
 * Everything currently signed in across the organisation.
 *
 * Managers can look — they are the ones standing in the shop when a till will
 * not sign in — but only an admin may remove, because removing is what lets one
 * account move to a different phone.
 */
devicesRouter.get(
  '/',
  requireRole('ORG_ADMIN', 'STORE_MANAGER'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const { user_id, include_revoked } = listQuery.parse(req.query);

    const devices = await prisma.deviceSession.findMany({
      // Scoped to the caller's organisation on the query itself, not filtered
      // afterwards: a user id from another tenant then returns nothing rather
      // than somebody else's tills.
      where: {
        organizationId: user.organizationId,
        ...(user_id ? { userId: user_id } : {}),
        ...(include_revoked === 'true' ? {} : { revokedAt: null }),
      },
      include: { user: { select: { id: true, fullName: true, email: true, role: true } } },
      orderBy: [{ revokedAt: 'asc' }, { lastSeenAt: 'desc' }],
      take: 500,
    });

    res.json(devices.map(serializeDevice));
  })
);

/** The caller's own device, so the app can show "this phone" in settings. */
devicesRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const session = req.session;
    if (!session) throw notFound('No device session on this token.');

    const device = await prisma.deviceSession.findUnique({
      where: { id: session.id },
      include: { user: { select: { id: true, fullName: true, email: true, role: true } } },
    });
    if (!device) throw notFound('Device not found.');

    res.json(serializeDevice(device));
  })
);

const revokeBody = z.object({ reason: z.string().max(200).optional() });

/**
 * Release a device, so the account can be signed into somewhere else.
 *
 * Takes effect on the phone itself within one request — `authenticate` checks
 * the session every time rather than trusting the token, which is what makes
 * this useful for a handset that has walked out of the shop.
 */
devicesRouter.delete(
  '/:id',
  requireRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    const admin = currentUser(req);
    const { reason } = revokeBody.parse(req.body ?? {});

    const device = await prisma.deviceSession.findFirst({
      where: { id: req.params.id, organizationId: admin.organizationId },
    });
    if (!device) throw notFound('Device not found.');
    if (device.revokedAt) throw badRequest('That device has already been removed.');

    const updated = await prisma.deviceSession.update({
      where: { id: device.id },
      data: {
        revokedAt: new Date(),
        revokedById: admin.id,
        revokedReason: reason?.trim() || null,
      },
      include: { user: { select: { id: true, fullName: true, email: true, role: true } } },
    });

    res.json(serializeDevice(updated));
  })
);

/**
 * Sign this device out and free the account for another one.
 *
 * Deliberately available to everyone, not just admins: a cashier finishing a
 * shift on a shared handset can release it themselves, which is the ordinary
 * case the admin screen should not have to handle.
 */
export async function revokeOwnSession(sessionId: string): Promise<void> {
  await prisma.deviceSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'Signed out' },
  });
}

/**
 * Release every device an account holds.
 *
 * Called when a password changes or is reset. Without it, losing the only phone
 * an administrator owns would be unrecoverable — there is nobody above them to
 * press the remove button, and the one-device rule would lock them out of their
 * own organisation permanently.
 */
export async function revokeAllSessions(userId: string, reason: string): Promise<void> {
  await prisma.deviceSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}
