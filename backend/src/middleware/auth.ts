import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  organizationId: string;
  email: string;
  fullName: string;
  role: 'ORG_ADMIN' | 'STORE_MANAGER' | 'CASHIER';
  assignedStores: string[];
}

/** The device session the request arrived on, for routes that report or end it. */
export interface AuthSession {
  id: string;
  deviceId: string;
  deviceName: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      session?: AuthSession;
    }
  }
}

export interface TokenPayload {
  sub: string;
  org: string;
  /**
   * The device session this token belongs to.
   *
   * Optional only in the type: a token without one predates device binding and
   * is refused, because accepting it would be a way to hold a session no
   * administrator can see in the Devices list or release.
   */
  sid?: string;
  /** Seconds since epoch, set by jsonwebtoken when the token is signed. */
  iat?: number;
}

// Pinned so signing and verification can never disagree on the algorithm. With
// a symmetric secret this is belt-and-braces, but it removes the whole class of
// algorithm-confusion tricks for free, and documents the intent.
const JWT_ALG: jwt.Algorithm = 'HS256';

export function signToken(userId: string, organizationId: string, sessionId: string): string {
  return jwt.sign(
    { sub: userId, org: organizationId, sid: sessionId } satisfies TokenPayload,
    env.JWT_SECRET,
    {
      algorithm: JWT_ALG,
      expiresIn: env.JWT_EXPIRES_IN,
    } as jwt.SignOptions
  );
}

/**
 * How stale `lastSeenAt` is allowed to get.
 *
 * Every authenticated request could refresh it, but a till polling the
 * catalogue would then write to this row hundreds of times an hour for a column
 * an administrator glances at. Five minutes is far finer than the judgement it
 * supports — "is this device still in use?" — at a fraction of the writes.
 */
const LAST_SEEN_REFRESH_MS = 5 * 60_000;

/**
 * The user is re-read on each request rather than trusted from the token, so
 * deactivating a member or changing their store assignments takes effect
 * immediately instead of whenever their token happens to expire.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();

    const token = header.slice(7);
    let payload: TokenPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET, { algorithms: [JWT_ALG] }) as TokenPayload;
    } catch {
      throw unauthorized('Session expired. Please sign in again.');
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) throw unauthorized('This account is no longer active.');

    // A password change or reset must actually end the other sessions, or an
    // account recovered *because* it was compromised stays compromised for the
    // 30 days the stolen token still has to run. `iat` is whole seconds, so
    // compare on the same scale to avoid logging out the token just issued.
    const issuedAt = payload.iat ?? 0;
    if (issuedAt < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      throw unauthorized('Your password was changed. Please sign in again.');
    }

    // The device this token was issued to must still be the one holding the
    // account. Checked on every request, not just at sign-in: releasing a
    // device from the Devices screen has to take effect on the phone in
    // somebody's pocket within seconds, not in thirty days when the token runs
    // out — which is the entire point of being able to remove it.
    if (!payload.sid) {
      throw unauthorized('Please sign in again to register this device.');
    }
    const session = await prisma.deviceSession.findUnique({ where: { id: payload.sid } });
    if (!session || session.userId !== user.id) {
      throw unauthorized('Please sign in again to register this device.');
    }
    if (session.revokedAt) {
      throw unauthorized(
        session.revokedReason
          ? `This device was removed by an administrator (${session.revokedReason}).`
          : 'This device was removed by an administrator. Please sign in again.'
      );
    }

    if (Date.now() - session.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
      // Not awaited and not fatal: a failed heartbeat must never turn a working
      // request into a 500. Worst case the admin sees a slightly older time.
      void prisma.deviceSession
        .update({
          where: { id: session.id },
          data: { lastSeenAt: new Date(), lastIp: req.ip ?? null },
        })
        .catch(() => {});
    }

    req.session = { id: session.id, deviceId: session.deviceId, deviceName: session.deviceName };
    req.user = {
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      assignedStores: user.assignedStores,
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: AuthUser['role'][]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden('Your role does not allow this action.'));
    }
    next();
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/**
 * A user with no explicit assignment can use every store in their organisation;
 * otherwise the store must be on their list. Org admins always pass.
 *
 * The tenant check comes first and is not optional. Both shortcuts below — org
 * admin, and "no assignment means all stores" — used to return before anything
 * confirmed the store was even in the caller's organisation, so a store id from
 * another tenant sailed through on any route that did not separately re-scope
 * its own query. Doing it here means a caller cannot reach another
 * organisation's data by guessing an id, on this route or a future one.
 */
export async function assertStoreAccess(user: AuthUser, storeId: string): Promise<void> {
  const store = await prisma.store.findFirst({
    where: { id: storeId, organizationId: user.organizationId },
    select: { id: true },
  });
  // Not 403: another tenant's id must be indistinguishable from one that does
  // not exist, or the difference between the two answers maps their stores.
  if (!store) throw notFound('Store not found.');

  if (user.role === 'ORG_ADMIN') return;
  if (user.assignedStores.length === 0) return;
  if (!user.assignedStores.includes(storeId)) {
    throw forbidden('You are not assigned to this store.');
  }
}
