import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { assertStoreAccess, authenticate, currentUser, requireCapability } from '../middleware/auth.js';
import { serializeTransaction } from '../lib/serialize.js';
import { badRequest, notFound } from '../lib/errors.js';
import { nextAuditAction } from '../lib/auditContext.js';
import { createSale } from '../services/sales.js';
import { readDailyReport, snapshotStoreDay, todayKey } from '../services/dailyReport.js';

export const transactionsRouter = Router();
transactionsRouter.use(authenticate);

const include = { items: true, payments: true } as const;

const listQuery = z.object({
  store_id: z.string().uuid().optional(),
  type: z.enum(['sale', 'refund', 'credit_note']).optional(),
  status: z.enum(['pending', 'completed', 'refunded', 'voided']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

transactionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const user = currentUser(req);
    if (q.store_id) await assertStoreAccess(user, q.store_id);

    const rows = await prisma.transaction.findMany({
      where: {
        organizationId: user.organizationId,
        ...(q.store_id ? { storeId: q.store_id } : {}),
        ...(q.type ? { transactionType: q.type } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.from || q.to
          ? {
              createdAt: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to ? { lte: new Date(q.to) } : {}),
              },
            }
          : {}),
      },
      include,
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      skip: q.offset,
    });

    res.json(rows.map(serializeTransaction));
  })
);

transactionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const tx = await prisma.transaction.findFirst({
      where: { id: req.params.id, organizationId: currentUser(req).organizationId },
      include,
    });
    if (!tx) throw notFound('Transaction not found.');
    res.json(serializeTransaction(tx));
  })
);

/**
 * What a till may post.
 *
 * Deliberately narrower than `SaleInput`:
 *
 *  - **No `unit_price`.** The service accepts one so a refund can be priced at
 *    what the customer originally paid, but exposing it here let any cashier
 *    sell a K85 item for one ngwee. Prices come from the catalogue.
 *  - **`sale` only.** A client posting `transaction_type: "refund"` walked
 *    straight past the manager approval on `POST /:id/refund`, minting negative
 *    money and stock out of nothing. Reversals go through that route.
 *  - **No `reverses_id`.** Only the refund route may link a reversal.
 */
const saleSchema = z.object({
  store_id: z.string().uuid(),
  transaction_type: z.literal('sale').optional(),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        quantity: z.number().positive(),
        discount_amount: z.number().min(0).optional(),
      })
    )
    .min(1),
  payments: z
    .array(
      z.object({
        method: z.enum(['cash', 'card', 'mobile']),
        amount: z.number(),
        reference: z.string().nullable().optional(),
      })
    )
    .min(1),
  customer_name: z.string().nullable().optional(),
  customer_phone: z.string().nullable().optional(),
  notes: z.string().optional(),
  /**
   * Idempotency key generated on the device. Replaying a queued offline sale
   * with the same key returns the original transaction instead of duplicating it.
   */
  client_reference: z.string().min(8).max(64).nullable().optional(),
});

transactionsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = saleSchema.parse(req.body);
    const user = currentUser(req);
    await assertStoreAccess(user, body.store_id);

    const { transaction, duplicate } = await createSale(user, body);

    // 200 rather than 201 on a replay, so a client can tell the difference.
    res.status(duplicate ? 200 : 201).json(serializeTransaction(transaction));
  })
);

const refundSchema = z.object({
  reason: z.string().optional(),
  /** Omit to refund the whole sale. */
  items: z
    .array(z.object({ product_id: z.string().uuid(), quantity: z.number().positive() }))
    .optional(),
  client_reference: z.string().min(8).max(64).nullable().optional(),
});

/**
 * Reverses a sale, in full or in part. Creates a linked refund transaction and
 * returns the stock — the original is preserved for the audit trail rather than
 * being edited.
 */
transactionsRouter.post(
  '/:id/refund',
  requireCapability('refunds.issue'),
  asyncHandler(async (req, res) => {
    const body = refundSchema.parse(req.body);
    const user = currentUser(req);

    const original = await prisma.transaction.findFirst({
      where: { id: req.params.id, organizationId: user.organizationId },
      include,
    });
    if (!original) throw notFound('Transaction not found.');
    if (original.transactionType !== 'sale') throw badRequest('Only a sale can be refunded.');
    if (original.voidedAt) throw badRequest('This sale has been voided.');

    await assertStoreAccess(user, original.storeId);

    // What the sale actually contained, one entry per product: the same product
    // can appear on two lines, and matching per line would refund the requested
    // quantity once for each of them.
    const sold = new Map<string, { quantity: number; unitPrice: number }>();
    for (const line of original.items) {
      if (!line.productId) continue;
      const entry = sold.get(line.productId) ?? { quantity: 0, unitPrice: line.unitPrice.toNumber() };
      entry.quantity += Math.abs(line.quantity.toNumber());
      sold.set(line.productId, entry);
    }

    // Earlier partial refunds of this same sale. Without this, a sale of 3 could
    // be refunded one unit at a time indefinitely.
    const priorRefunds = await prisma.transaction.findMany({
      where: { reversesId: original.id, voidedAt: null },
      include: { items: true },
    });
    const alreadyRefunded = new Map<string, number>();
    for (const refund of priorRefunds) {
      for (const line of refund.items) {
        if (!line.productId) continue;
        alreadyRefunded.set(
          line.productId,
          (alreadyRefunded.get(line.productId) ?? 0) + Math.abs(line.quantity.toNumber())
        );
      }
    }

    const remaining = new Map<string, number>();
    for (const [productId, entry] of sold) {
      remaining.set(productId, entry.quantity - (alreadyRefunded.get(productId) ?? 0));
    }

    // Aggregate the request too: a caller may send the same product twice.
    const asked = new Map<string, number>();
    if (body.items) {
      for (const r of body.items) {
        asked.set(r.product_id, (asked.get(r.product_id) ?? 0) + r.quantity);
      }
    } else {
      // No list means everything still outstanding.
      for (const [productId, quantity] of remaining) {
        if (quantity > 0) asked.set(productId, quantity);
      }
    }

    for (const [productId, quantity] of asked) {
      if (!sold.has(productId)) throw badRequest('That product was not on this sale.');

      const left = remaining.get(productId) ?? 0;
      if (quantity > left) {
        const name =
          original.items.find((i) => i.productId === productId)?.productName ?? 'that product';
        throw badRequest(
          left <= 0
            ? `${name} has already been refunded in full.`
            : `Cannot refund ${quantity} of ${name} — only ${left} left on this sale.`
        );
      }
      remaining.set(productId, left - quantity);
    }

    const items = [...asked]
      .filter(([, quantity]) => quantity > 0)
      .map(([product_id, quantity]) => ({
        product_id,
        quantity,
        unit_price: sold.get(product_id)?.unitPrice ?? 0,
      }));

    if (items.length === 0) throw badRequest('This sale has already been refunded in full.');

    const { transaction } = await createSale(user, {
      store_id: original.storeId,
      transaction_type: 'refund',
      items,
      // Money goes back on the tender it came in on. A single row, because
      // `createSale` sets its amount to the refund total — negative, so the
      // day's payment split shows the drawer actually being paid out of.
      // A sale split across tenders is refunded to whichever came first.
      payments: [
        { method: original.payments[0]?.method ?? 'cash', amount: 0, reference: body.reason ?? null },
      ],
      customer_name: original.customerName,
      customer_phone: original.customerPhone,
      notes: body.reason ?? `Refund of ${original.receiptNumber}`,
      client_reference: body.client_reference ?? null,
      reverses_id: original.id,
    });

    // Only call the sale refunded once nothing is left on it. Flagging it after
    // the first partial refund made the other units unreturnable.
    const fullyRefunded = [...remaining.values()].every((quantity) => quantity <= 0);
    if (fullyRefunded) {
      await prisma.transaction.update({
        where: { id: original.id },
        data: { status: 'refunded' },
      });
    }

    res.status(201).json(serializeTransaction(transaction));
  })
);

transactionsRouter.post(
  '/:id/void',
  requireCapability('transactions.void'),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
    const user = currentUser(req);

    const original = await prisma.transaction.findFirst({
      where: { id: req.params.id, organizationId: user.organizationId },
      include,
    });
    if (!original) throw notFound('Transaction not found.');
    if (original.voidedAt) throw badRequest('Already voided.');

    // A void is a status column moving, and to the shop it is the cancellation
    // of a sale. Name it, or the history reads as somebody editing a field.
    nextAuditAction('void');
    const updated = await prisma.transaction.update({
      where: { id: original.id },
      data: { status: 'voided', voidedAt: new Date(), voidReason: reason },
      include,
    });

    res.json(serializeTransaction(updated));
  })
);

const dateKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

/**
 * Z-report: the day's takings for a store, broken down by payment method.
 * Mirrors the web app's "Daily Report" / "End Session".
 *
 * Serves the sealed snapshot written by the nightly job when there is one, and
 * live figures otherwise — so a report printed months ago still prints the same.
 */
transactionsRouter.get(
  '/reports/daily',
  asyncHandler(async (req, res) => {
    const q = z
      .object({ store_id: z.string().uuid(), date: dateKey.optional() })
      .parse(req.query);

    const user = currentUser(req);
    await assertStoreAccess(user, q.store_id);

    res.json(await readDailyReport(q.store_id, q.date ?? todayKey()));
  })
);

/** The last N sealed days for a store — the month-end view for a manager. */
transactionsRouter.get(
  '/reports/daily/history',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        store_id: z.string().uuid(),
        limit: z.coerce.number().min(1).max(120).default(30),
      })
      .parse(req.query);

    const user = currentUser(req);
    await assertStoreAccess(user, q.store_id);

    const rows = await prisma.dailyReport.findMany({
      where: { storeId: q.store_id, organizationId: user.organizationId },
      orderBy: { date: 'desc' },
      take: q.limit,
    });

    res.json(
      rows.map((r) => ({
        store_id: r.storeId,
        date: r.date,
        transaction_count: r.transactionCount,
        gross_total: r.grossTotal.toNumber(),
        tax_total: r.taxTotal.toNumber(),
        refund_total: r.refundTotal.toNumber(),
        by_payment_method: {
          cash: r.cashTotal.toNumber(),
          card: r.cardTotal.toNumber(),
          mobile: r.mobileTotal.toNumber(),
        },
        top_items: Array.isArray(r.topItems) ? r.topItems : [],
        finalized: r.finalized,
        generated_at: r.generatedAt.toISOString(),
      }))
    );
  })
);

/**
 * Re-runs the snapshot for one store-day by hand — for when the cron was down.
 * Sealed days stay sealed unless `force` is set, so this can't quietly rewrite
 * a report that has already been signed off.
 */
transactionsRouter.post(
  '/reports/daily/rebuild',
  requireCapability('reports.rebuild'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        store_id: z.string().uuid(),
        date: dateKey,
        finalize: z.boolean().default(true),
        force: z.boolean().default(false),
      })
      .parse(req.body);

    await assertStoreAccess(currentUser(req), body.store_id);

    if (body.force) {
      await prisma.dailyReport.updateMany({
        where: { storeId: body.store_id, date: body.date },
        data: { finalized: false },
      });
    }

    res.json(
      await snapshotStoreDay(body.store_id, body.date, { finalize: body.finalize })
    );
  })
);
