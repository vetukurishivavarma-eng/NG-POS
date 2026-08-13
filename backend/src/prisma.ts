import { auditExtension } from './lib/audit.js';
import { basePrisma } from './prismaBase.js';

/**
 * The client everything uses.
 *
 * It is the ordinary Prisma client with the audit extension on it, so every
 * create, update and delete made anywhere in the application leaves a history
 * entry, and the records that must not be deleted cannot be. See `lib/audit.ts`
 * for what is recorded and what is refused.
 *
 * The extension only hooks queries — it adds no methods and changes no types —
 * so this is used exactly as a plain `PrismaClient`, transactions included.
 */
export const prisma = basePrisma.$extends(auditExtension);

/**
 * The client handed to an interactive transaction callback.
 *
 * `Prisma.TransactionClient` describes the *unextended* one and no longer fits
 * — a helper typed with it stops accepting the `tx` this client hands out.
 * Derived from `prisma` itself so it can never drift from what is actually
 * passed, whatever extensions are added later.
 */
export type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
