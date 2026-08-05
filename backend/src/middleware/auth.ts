import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  organizationId: string;
  email: string;
  fullName: string;
  role: 'ORG_ADMIN' | 'STORE_MANAGER' | 'CASHIER';
  assignedStores: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export interface TokenPayload {
  sub: string;
  org: string;
}

export function signToken(userId: string, organizationId: string): string {
  return jwt.sign({ sub: userId, org: organizationId } satisfies TokenPayload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

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
      payload = jwt.verify(token, env.JWT_SECRET) as TokenPayload;
    } catch {
      throw unauthorized('Session expired. Please sign in again.');
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) throw unauthorized('This account is no longer active.');

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
 */
export function assertStoreAccess(user: AuthUser, storeId: string): void {
  if (user.role === 'ORG_ADMIN') return;
  if (user.assignedStores.length === 0) return;
  if (!user.assignedStores.includes(storeId)) {
    throw forbidden('You are not assigned to this store.');
  }
}
