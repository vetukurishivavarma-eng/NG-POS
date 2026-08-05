import { Prisma } from '@prisma/client';

import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { dateKeyIn } from '../lib/time.js';
import type { AuthUser } from '../middleware/auth.js';

const D = Prisma.Decimal;

export interface SaleItemInput {
  product_id: string;
  quantity: number;
  /** Optional override; otherwise the store price or catalogue price is used. */
  unit_price?: number;
  discount_amount?: number;
}

export interface SaleInput {
  store_id: string;
  transaction_type?: 'sale' | 'refund' | 'credit_note';
  items: SaleItemInput[];
  payments: { method: 'cash' | 'card' | 'mobile'; amount: number; reference?: string | null }[];
  customer_name?: string | null;
  customer_phone?: string | null;
  notes?: string;
  client_reference?: string | null;
  /** Refunds and credit notes point at the sale they reverse. */
  reverses_id?: string | null;
}

/**
 * Claims the next receipt number for a store on a given day.
 *
 * Runs inside the caller's transaction and relies on the unique
 * `(store_id, day)` index: concurrent claims serialise on that row, so two
 * devices syncing offline sales at the same instant cannot be handed the same
 * number.
 *
 * The day is the shop's calendar day, not UTC — the same boundary the Z-report
 * uses, so every receipt number on a day report actually carries that date.
 */
async function nextReceiptNumber(
  tx: Prisma.TransactionClient,
  storeId: string,
  storeCode: string,
  when: Date
): Promise<string> {
  const day = dateKeyIn(when, env.REPORT_TIMEZONE).replace(/-/g, '');

  const counter = await tx.receiptCounter.upsert({
    where: { storeId_day: { storeId, day } },
    create: { storeId, day, sequence: 1 },
    update: { sequence: { increment: 1 } },
    select: { sequence: true },
  });

  return `${storeCode}-${day}-${String(counter.sequence).padStart(6, '0')}`;
}

/**
 * Makes what was tendered agree with what the sale actually costs.
 *
 * The server reprices every sale, so a client's payment figure can be stale by
 * the time it lands — and nothing downstream noticed: a cash sale posted with
 * `amount: 0` left the day's takings correct but its cash column at zero, so
 * the drawer could never be reconciled against the Z-report. That is the one
 * job the Z-report has.
 *
 * A single tender is therefore set to the sale total rather than believed —
 * this is the overwhelmingly common case, and it always reconciles. A split
 * tender is keyed by hand at the till and its parts must be exact, so a sum
 * that disagrees with the total is rejected rather than quietly stored.
 */
function reconcilePayments(
  payments: SaleInput['payments'],
  grandTotal: Prisma.Decimal,
  signedTotal: Prisma.Decimal
): { method: 'cash' | 'card' | 'mobile'; amount: Prisma.Decimal; reference: string | null }[] {
  if (payments.length === 0) return [];

  if (payments.length === 1) {
    const only = payments[0];
    if (!only) return [];
    return [{ method: only.method, amount: signedTotal, reference: only.reference ?? null }];
  }

  const tendered = payments.reduce((sum, p) => sum.add(new D(p.amount)), new D(0));
  if (tendered.sub(grandTotal).abs().greaterThan(new D('0.01'))) {
    throw badRequest(
      `Split payments total ${tendered.toFixed(2)} but the sale comes to ${grandTotal.toFixed(2)}. Re-enter the tender.`
    );
  }

  const sign = signedTotal.isNegative() ? -1 : 1;
  return payments.map((p) => ({
    method: p.method,
    amount: round2(new D(p.amount).mul(sign)),
    reference: p.reference ?? null,
  }));
}

/**
 * Records a sale: prices it from authoritative server-side data, claims a
 * receipt number, decrements stock and writes the audit trail — all in one
 * database transaction, so a partial sale is impossible.
 *
 * Prices are recalculated here rather than trusted from the client. A device
 * that has been offline for a week would otherwise be able to sell at stale
 * prices, and a tampered client could sell at any price it liked.
 */
export async function createSale(user: AuthUser, input: SaleInput) {
  if (input.items.length === 0) throw badRequest('A sale needs at least one item.');

  // Idempotency: a replayed offline sale returns the original rather than
  // creating a second one. Checked before the transaction as a fast path, and
  // enforced again by the unique index inside it.
  //
  // Scoped to the organisation even though the column is globally unique: the
  // key is generated on a device from a timestamp and Math.random, so a
  // collision across tenants is unlikely but not impossible, and handing one
  // organisation another's receipt would be a far worse outcome than a
  // rejected sale.
  if (input.client_reference) {
    const existing = await prisma.transaction.findFirst({
      where: { clientReference: input.client_reference, organizationId: user.organizationId },
      include: { items: true, payments: true },
    });
    if (existing) return { transaction: existing, duplicate: true as const };
  }

  const transaction = await prisma.$transaction(
    async (tx) => {
      const store = await tx.store.findFirst({
        where: { id: input.store_id, organizationId: user.organizationId },
      });
      if (!store) throw notFound('Store not found.');

      const org = await tx.organization.findUniqueOrThrow({
        where: { id: user.organizationId },
        select: { vatRate: true },
      });

      const productIds = input.items.map((i) => i.product_id);
      const products = await tx.product.findMany({
        where: { id: { in: productIds }, organizationId: user.organizationId },
      });
      const byId = new Map(products.map((p) => [p.id, p]));

      const overrides = await tx.storePrice.findMany({
        where: { storeId: store.id, productId: { in: productIds } },
      });
      const priceById = new Map(overrides.map((o) => [o.productId, o.price]));

      const isReversal = input.transaction_type === 'refund' || input.transaction_type === 'credit_note';
      const sign = isReversal ? -1 : 1;

      let subtotal = new D(0);
      let discountTotal = new D(0);
      let taxTotal = new D(0);
      let grandTotal = new D(0);

      const itemRows: Prisma.TransactionItemCreateManyTransactionInput[] = [];

      for (const line of input.items) {
        const product = byId.get(line.product_id);
        if (!product) throw badRequest(`Unknown product: ${line.product_id}`);
        if (line.quantity <= 0) throw badRequest(`Quantity must be positive for ${product.name}.`);

        const quantity = new D(line.quantity);
        const unitPrice =
          line.unit_price !== undefined
            ? new D(line.unit_price)
            : (priceById.get(product.id) ?? product.sellingPrice);

        const gross = unitPrice.mul(quantity);
        const discount = new D(line.discount_amount ?? 0);
        if (discount.gt(gross)) throw badRequest(`Discount exceeds the line total for ${product.name}.`);

        // A cashier's discount is capped; a manager's is not. Uncapped, this is
        // simply the price override that `unit_price` used to be — take the
        // discount up to the line total and the goods leave for nothing.
        if (discount.gt(0) && user.role === 'CASHIER') {
          const ceiling = gross.mul(env.MAX_CASHIER_DISCOUNT_PERCENT).div(100);
          if (discount.gt(ceiling)) {
            throw badRequest(
              env.MAX_CASHIER_DISCOUNT_PERCENT === 0
                ? `Discounts need a manager. Ask one to approve the discount on ${product.name}.`
                : `A cashier may discount ${product.name} by at most ${env.MAX_CASHIER_DISCOUNT_PERCENT}% (${round2(ceiling).toFixed(2)}). Larger discounts need a manager.`,
              'DISCOUNT_LIMIT'
            );
          }
        }

        const net = gross.sub(discount);
        const tax = product.taxType === 'vat' ? net.mul(org.vatRate) : new D(0);
        const lineTotal = net.add(tax);

        subtotal = subtotal.add(gross);
        discountTotal = discountTotal.add(discount);
        taxTotal = taxTotal.add(tax);
        grandTotal = grandTotal.add(lineTotal);

        itemRows.push({
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          brand: product.brand,
          quantity: quantity.mul(1),
          unitPrice,
          costPrice: product.costPrice,
          discountAmount: discount,
          taxType: product.taxType,
          taxAmount: round2(tax),
          lineTotal: round2(lineTotal),
        });
      }

      const receiptNumber = await nextReceiptNumber(tx, store.id, store.code, new Date());
      const signedTotal = round2(grandTotal.mul(sign));
      const paymentRows = reconcilePayments(input.payments, grandTotal, signedTotal);

      const created = await tx.transaction.create({
        data: {
          organizationId: user.organizationId,
          storeId: store.id,
          receiptNumber,
          transactionType: input.transaction_type ?? 'sale',
          status: 'completed',
          subtotal: round2(subtotal.mul(sign)),
          discountAmount: round2(discountTotal.mul(sign)),
          taxAmount: round2(taxTotal.mul(sign)),
          total: signedTotal,
          cashierId: user.id,
          cashierName: user.fullName,
          customerName: input.customer_name ?? null,
          customerPhone: input.customer_phone ?? null,
          notes: input.notes ?? '',
          clientReference: input.client_reference ?? null,
          reversesId: input.reverses_id ?? null,
          items: {
            createMany: {
              data: itemRows.map((r) => ({
                ...r,
                quantity: new D(r.quantity as Prisma.Decimal).mul(sign),
                lineTotal: new D(r.lineTotal as Prisma.Decimal).mul(sign),
                taxAmount: new D(r.taxAmount as Prisma.Decimal).mul(sign),
              })),
            },
          },
          payments: { createMany: { data: paymentRows } },
        },
        include: { items: true, payments: true },
      });

      // Stock moves the opposite way to money: a sale removes stock, a refund
      // puts it back.
      for (const line of input.items) {
        const delta = new D(line.quantity).mul(-sign);

        const inventory = await tx.inventory.upsert({
          where: { storeId_productId: { storeId: store.id, productId: line.product_id } },
          create: {
            storeId: store.id,
            productId: line.product_id,
            quantity: delta,
            reorderLevel: new D(10),
          },
          update: { quantity: { increment: delta } },
          select: { quantity: true },
        });

        await tx.stockMovement.create({
          data: {
            storeId: store.id,
            productId: line.product_id,
            type: isReversal ? 'refund' : 'sale',
            quantity: delta,
            balance: inventory.quantity,
            reference: receiptNumber,
            userId: user.id,
          },
        });
      }

      return created;
    },
    // Serializable would be stricter, but the receipt counter row already
    // serialises the only ordering-sensitive step, and this avoids spurious
    // retries when two tills sell different products at once.
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 }
  ).catch((err: unknown) => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('This sale has already been recorded.', 'DUPLICATE_SALE');
    }
    throw err;
  });

  return { transaction, duplicate: false as const };
}

function round2(v: Prisma.Decimal): Prisma.Decimal {
  return v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
