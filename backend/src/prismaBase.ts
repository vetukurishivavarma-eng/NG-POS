import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

/**
 * The client with no extensions on it.
 *
 * Everything in the application uses the extended client from `prisma.ts`,
 * which records an audit entry for every write. This one exists for the audit
 * machinery itself: it reads the row about to change and writes the log entry,
 * and doing either through the extended client would audit the audit and never
 * come back.
 *
 * Nothing else should import this. If a route needs to write without leaving a
 * trace, the answer is that it does not.
 */
export const basePrisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
