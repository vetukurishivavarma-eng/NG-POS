import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { assertStoreAccess, authenticate, currentUser, requireCapability } from '../middleware/auth.js';
import { num } from '../lib/serialize.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

/* ---------------------------------------------------------------- suppliers */

export const suppliersRouter = Router();
suppliersRouter.use(authenticate);

const supplierSchema = z.object({
  name: z.string().min(1).transform((v) => v.trim()),
  contact_name: z.string().default(''),
  phone: z.string().default(''),
  email: z.string().email().or(z.literal('')).default(''),
  address: z.string().default(''),
  notes: z.string().default(''),
  is_active: z.boolean().default(true),
});

type SupplierRow = {
  id: string;
  organizationId: string;
  name: string;
  contactName: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  isActive: boolean;
  createdAt: Date;
};

function serializeSupplier(s: SupplierRow, outstanding?: number, invoiceCount?: number) {
  return {
    id: s.id,
    organization_id: s.organizationId,
    name: s.name,
    contact_name: s.contactName,
    phone: s.phone,
    email: s.email,
    address: s.address,
    notes: s.notes,
    is_active: s.isActive,
    ...(outstanding === undefined ? {} : { outstanding_balance: outstanding }),
    ...(invoiceCount === undefined ? {} : { invoice_count: invoiceCount }),
    created_at: s.createdAt,
  };
}

suppliersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const organizationId = currentUser(req).organizationId;

    const suppliers = await prisma.supplier.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
      include: {
        // The list screen leads with what is still owed, so the balance is
        // gathered here rather than left to one request per supplier.
        invoices: { select: { total: true, amountPaid: true } },
      },
    });

    res.json(
      suppliers.map((s) => {
        const outstanding = s.invoices.reduce(
          (sum, i) => sum.plus(i.total.minus(i.amountPaid)),
          new Prisma.Decimal(0)
        );
        return serializeSupplier(s, num(outstanding), s.invoices.length);
      })
    );
  })
);

suppliersRouter.post(
  '/',
  requireCapability('suppliers.write'),
  asyncHandler(async (req, res) => {
    const body = supplierSchema.parse(req.body);
    const organizationId = currentUser(req).organizationId;

    const clash = await prisma.supplier.findFirst({
      where: { organizationId, name: { equals: body.name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash) throw conflict('A supplier with that name already exists.');

    const supplier = await prisma.supplier.create({
      data: {
        organizationId,
        name: body.name,
        contactName: body.contact_name,
        phone: body.phone,
        email: body.email,
        address: body.address,
        notes: body.notes,
        isActive: body.is_active,
      },
    });

    res.status(201).json(serializeSupplier(supplier, 0, 0));
  })
);

suppliersRouter.put(
  '/:id',
  requireCapability('suppliers.write'),
  asyncHandler(async (req, res) => {
    const body = supplierSchema.partial().parse(req.body);
    const organizationId = currentUser(req).organizationId;

    const existing = await prisma.supplier.findFirst({
      where: { id: req.params.id as string, organizationId },
      select: { id: true },
    });
    if (!existing) throw notFound('Supplier not found.');

    const supplier = await prisma.supplier.update({
      where: { id: existing.id },
      data: {
        name: body.name,
        contactName: body.contact_name,
        phone: body.phone,
        email: body.email,
        address: body.address,
        notes: body.notes,
        isActive: body.is_active,
      },
    });

    res.json(serializeSupplier(supplier));
  })
);

/** Soft delete: past invoices still point at the supplier. */
suppliersRouter.delete(
  '/:id',
  requireCapability('suppliers.delete'),
  asyncHandler(async (req, res) => {
    const organizationId = currentUser(req).organizationId;
    const existing = await prisma.supplier.findFirst({
      where: { id: req.params.id as string, organizationId },
      select: { id: true },
    });
    if (!existing) throw notFound('Supplier not found.');

    await prisma.supplier.update({ where: { id: existing.id }, data: { isActive: false } });
    res.json({ detail: 'Supplier deactivated.' });
  })
);

/* -------------------------------------------------------- supplier invoices */

export const supplierInvoicesRouter = Router();
supplierInvoicesRouter.use(authenticate);

const paymentMethods = ['cash', 'bank_transfer', 'mobile', 'cheque', 'card', 'other'] as const;

const paymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(paymentMethods).default('cash'),
  reference: z.string().default(''),
  note: z.string().default(''),
  paid_at: z.coerce.date().optional(),
});

const invoiceSchema = z.object({
  supplier_id: z.string().uuid(),
  /** Where the goods physically landed. Stock is added here. */
  store_id: z.string().uuid(),
  invoice_number: z.string().min(1).transform((v) => v.trim()),
  invoice_date: z.coerce.date().optional(),
  due_date: z.coerce.date().nullable().optional(),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        quantity: z.number().positive(),
        unit_cost: z.number().min(0),
      })
    )
    .min(1),
  tax_amount: z.number().min(0).default(0),
  other_charges: z.number().min(0).default(0),
  discount_amount: z.number().min(0).default(0),
  notes: z.string().default(''),
  /**
   * A delivery is the moment the true cost of an item is known, so by default
   * the catalogue's cost price follows the invoice. Turned off when a line is a
   * one-off price that should not become the basis of every margin figure.
   */
  update_cost_price: z.boolean().default(true),
  /** Omit entirely for goods taken on credit. */
  payment: paymentSchema.optional(),
});

const money = (v: Prisma.Decimal | number) => new Prisma.Decimal(v).toDecimalPlaces(2);

function statusFor(total: Prisma.Decimal, paid: Prisma.Decimal) {
  if (paid.lte(0)) return 'unpaid' as const;
  return paid.gte(total) ? ('paid' as const) : ('partial' as const);
}

type InvoiceWithRelations = Prisma.SupplierInvoiceGetPayload<{
  include: {
    supplier: { select: { name: true; phone: true } };
    store: { select: { name: true; code: true } };
    items: true;
    payments: true;
  };
}>;

function serializeInvoice(i: InvoiceWithRelations) {
  const balance = i.total.minus(i.amountPaid);
  return {
    id: i.id,
    organization_id: i.organizationId,
    supplier_id: i.supplierId,
    supplier_name: i.supplier.name,
    supplier_phone: i.supplier.phone,
    store_id: i.storeId,
    store_name: i.store.name,
    store_code: i.store.code,
    invoice_number: i.invoiceNumber,
    invoice_date: i.invoiceDate,
    due_date: i.dueDate,
    subtotal: num(i.subtotal),
    tax_amount: num(i.taxAmount),
    other_charges: num(i.otherCharges),
    discount_amount: num(i.discountAmount),
    total: num(i.total),
    amount_paid: num(i.amountPaid),
    /** What is still owed. The whole reason this record exists. */
    balance: num(balance),
    status: i.status,
    notes: i.notes,
    created_by_name: i.createdByName,
    items: i.items.map((it) => ({
      id: it.id,
      product_id: it.productId,
      product_name: it.productName,
      sku: it.sku,
      quantity: num(it.quantity),
      unit_cost: num(it.unitCost),
      line_total: num(it.lineTotal),
    })),
    payments: i.payments
      .slice()
      .sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime())
      .map((p) => ({
        id: p.id,
        amount: num(p.amount),
        method: p.method,
        reference: p.reference,
        note: p.note,
        paid_at: p.paidAt,
        user_name: p.userName,
      })),
    created_at: i.createdAt,
    updated_at: i.updatedAt,
  };
}

const invoiceInclude = {
  supplier: { select: { name: true, phone: true } },
  store: { select: { name: true, code: true } },
  items: true,
  payments: true,
} as const;

/**
 * What the organisation still owes, and to whom. Registered before `/:id` so
 * "summary" is never read as an invoice id.
 */
supplierInvoicesRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const q = z.object({ store_id: z.string().uuid().optional() }).parse(req.query);
    const user = currentUser(req);
    if (q.store_id) await assertStoreAccess(user, q.store_id);

    const invoices = await prisma.supplierInvoice.findMany({
      where: {
        organizationId: user.organizationId,
        ...(q.store_id ? { storeId: q.store_id } : {}),
        status: { in: ['unpaid', 'partial'] },
      },
      include: { supplier: { select: { id: true, name: true } } },
    });

    const now = new Date();
    let outstanding = new Prisma.Decimal(0);
    let overdue = new Prisma.Decimal(0);
    let overdueCount = 0;
    const bySupplier = new Map<string, { supplier_id: string; supplier_name: string; balance: Prisma.Decimal; invoices: number }>();

    for (const invoice of invoices) {
      const balance = invoice.total.minus(invoice.amountPaid);
      if (balance.lte(0)) continue;

      outstanding = outstanding.plus(balance);
      if (invoice.dueDate && invoice.dueDate < now) {
        overdue = overdue.plus(balance);
        overdueCount += 1;
      }

      const entry = bySupplier.get(invoice.supplierId) ?? {
        supplier_id: invoice.supplierId,
        supplier_name: invoice.supplier.name,
        balance: new Prisma.Decimal(0),
        invoices: 0,
      };
      entry.balance = entry.balance.plus(balance);
      entry.invoices += 1;
      bySupplier.set(invoice.supplierId, entry);
    }

    res.json({
      outstanding_total: num(outstanding),
      open_invoice_count: invoices.length,
      overdue_total: num(overdue),
      overdue_count: overdueCount,
      by_supplier: [...bySupplier.values()]
        .map((e) => ({ ...e, balance: num(e.balance) }))
        .sort((a, b) => b.balance - a.balance),
    });
  })
);

supplierInvoicesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        store_id: z.string().uuid().optional(),
        supplier_id: z.string().uuid().optional(),
        status: z.enum(['unpaid', 'partial', 'paid', 'outstanding']).optional(),
        search: z.string().optional(),
        limit: z.coerce.number().min(1).max(200).default(50),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(req.query);

    const user = currentUser(req);
    if (q.store_id) await assertStoreAccess(user, q.store_id);

    const invoices = await prisma.supplierInvoice.findMany({
      where: {
        organizationId: user.organizationId,
        ...(q.store_id ? { storeId: q.store_id } : {}),
        ...(q.supplier_id ? { supplierId: q.supplier_id } : {}),
        ...(q.status === 'outstanding'
          ? { status: { in: ['unpaid', 'partial'] } }
          : q.status
            ? { status: q.status }
            : {}),
        ...(q.search
          ? {
              OR: [
                { invoiceNumber: { contains: q.search, mode: 'insensitive' } },
                { supplier: { name: { contains: q.search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: invoiceInclude,
      orderBy: { invoiceDate: 'desc' },
      take: q.limit,
      skip: q.offset,
    });

    res.json(invoices.map(serializeInvoice));
  })
);

supplierInvoicesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const invoice = await prisma.supplierInvoice.findFirst({
      where: { id: req.params.id as string, organizationId: currentUser(req).organizationId },
      include: invoiceInclude,
    });
    if (!invoice) throw notFound('Invoice not found.');
    res.json(serializeInvoice(invoice));
  })
);

/**
 * Records a delivery: the paperwork, the stock and the money owed, in one
 * transaction.
 *
 * This is the only way stock should arrive from a supplier. Adding it through
 * a plain stock adjustment leaves no invoice to pay, no cost to reconcile and
 * nothing to check the delivery note against a month later.
 */
supplierInvoicesRouter.post(
  '/',
  requireCapability('purchases.write'),
  asyncHandler(async (req, res) => {
    const body = invoiceSchema.parse(req.body);
    const user = currentUser(req);
    await assertStoreAccess(user, body.store_id);

    const supplier = await prisma.supplier.findFirst({
      where: { id: body.supplier_id, organizationId: user.organizationId },
      select: { id: true, name: true, isActive: true },
    });
    if (!supplier) throw notFound('Supplier not found.');

    // Every product has to be ours. Without this a line could pin an invoice to
    // another organisation's product and move its cost price.
    const productIds = [...new Set(body.items.map((i) => i.product_id))];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, organizationId: user.organizationId },
      select: { id: true, name: true, sku: true },
    });
    if (products.length !== productIds.length) throw notFound('One of the products is not in this catalogue.');
    const productById = new Map(products.map((p) => [p.id, p]));

    const lines = body.items.map((item) => {
      const product = productById.get(item.product_id) as { id: string; name: string; sku: string };
      return {
        item,
        product,
        lineTotal: money(new Prisma.Decimal(item.quantity).times(item.unit_cost)),
      };
    });

    const subtotal = money(lines.reduce((sum, l) => sum.plus(l.lineTotal), new Prisma.Decimal(0)));
    const total = money(
      subtotal.plus(body.tax_amount).plus(body.other_charges).minus(body.discount_amount)
    );
    if (total.lt(0)) throw badRequest('The discount is larger than the invoice.');

    const paid = money(body.payment?.amount ?? 0);
    // A payment bigger than the invoice is a typo every time. Refusing it here
    // is what keeps the stored balance trustworthy.
    if (paid.gt(total)) {
      throw badRequest('The payment is more than the invoice total. Enter the amount actually paid.');
    }

    const duplicate = await prisma.supplierInvoice.findFirst({
      where: {
        organizationId: user.organizationId,
        supplierId: supplier.id,
        invoiceNumber: body.invoice_number,
      },
      select: { id: true },
    });
    if (duplicate) {
      throw conflict(
        `Invoice ${body.invoice_number} from ${supplier.name} has already been entered. Entering it twice would double the stock and the debt.`
      );
    }

    const invoiceDate = body.invoice_date ?? new Date();

    const created = await prisma.$transaction(async (tx) => {
      const invoice = await tx.supplierInvoice.create({
        data: {
          organizationId: user.organizationId,
          supplierId: supplier.id,
          storeId: body.store_id,
          invoiceNumber: body.invoice_number,
          invoiceDate,
          dueDate: body.due_date ?? null,
          subtotal,
          taxAmount: money(body.tax_amount),
          otherCharges: money(body.other_charges),
          discountAmount: money(body.discount_amount),
          total,
          amountPaid: paid,
          status: statusFor(total, paid),
          notes: body.notes,
          createdById: user.id,
          createdByName: user.fullName,
          items: {
            createMany: {
              data: lines.map((l) => ({
                productId: l.product.id,
                productName: l.product.name,
                sku: l.product.sku,
                quantity: new Prisma.Decimal(l.item.quantity),
                unitCost: money(l.item.unit_cost),
                lineTotal: l.lineTotal,
              })),
            },
          },
        },
      });

      if (body.payment) {
        await tx.supplierPayment.create({
          data: {
            invoiceId: invoice.id,
            amount: paid,
            method: body.payment.method,
            reference: body.payment.reference,
            note: body.payment.note,
            paidAt: body.payment.paid_at ?? new Date(),
            userId: user.id,
            userName: user.fullName,
          },
        });
      }

      // The stock. Sequential on purpose: an invoice may list the same product
      // on two lines, and each movement has to record the balance *after* its
      // own increment or the audit trail stops adding up.
      for (const line of lines) {
        const qty = new Prisma.Decimal(line.item.quantity);

        const level = await tx.inventory.upsert({
          where: {
            storeId_productId: { storeId: body.store_id, productId: line.product.id },
          },
          create: { storeId: body.store_id, productId: line.product.id, quantity: qty },
          update: { quantity: { increment: qty } },
        });

        await tx.stockMovement.create({
          data: {
            storeId: body.store_id,
            productId: line.product.id,
            type: 'purchase',
            quantity: qty,
            balance: level.quantity,
            reference: `INV ${body.invoice_number}`,
            note: `Received from ${supplier.name}`,
            userId: user.id,
          },
        });

        if (body.update_cost_price) {
          await tx.product.update({
            where: { id: line.product.id },
            data: { costPrice: money(line.item.unit_cost) },
          });
        }
      }

      return tx.supplierInvoice.findUniqueOrThrow({
        where: { id: invoice.id },
        include: invoiceInclude,
      });
    });

    res.status(201).json(serializeInvoice(created));
  })
);

/**
 * A part payment. Each instalment is its own row, and the invoice's running
 * total is moved in the same transaction so the balance shown on a list can
 * never disagree with the payments behind it.
 */
supplierInvoicesRouter.post(
  '/:id/payments',
  requireCapability('purchases.write'),
  asyncHandler(async (req, res) => {
    const body = paymentSchema.parse(req.body);
    const user = currentUser(req);

    const invoice = await prisma.supplierInvoice.findFirst({
      where: { id: req.params.id as string, organizationId: user.organizationId },
      select: { id: true, storeId: true },
    });
    if (!invoice) throw notFound('Invoice not found.');
    await assertStoreAccess(user, invoice.storeId);

    const amount = money(body.amount);

    const updated = await prisma.$transaction(async (tx) => {
      // Re-read inside the transaction: two people settling the same invoice
      // from two tills would otherwise both pass a check made on stale figures
      // and overpay it between them.
      const current = await tx.supplierInvoice.findUniqueOrThrow({
        where: { id: invoice.id },
        select: { total: true, amountPaid: true },
      });

      const balance = current.total.minus(current.amountPaid);
      if (balance.lte(0)) throw badRequest('This invoice is already settled in full.');
      if (amount.gt(balance)) {
        throw badRequest(
          `That is more than the outstanding balance of ${balance.toFixed(2)}. Enter the amount actually paid.`
        );
      }

      await tx.supplierPayment.create({
        data: {
          invoiceId: invoice.id,
          amount,
          method: body.method,
          reference: body.reference,
          note: body.note,
          paidAt: body.paid_at ?? new Date(),
          userId: user.id,
          userName: user.fullName,
        },
      });

      const nextPaid = current.amountPaid.plus(amount);
      await tx.supplierInvoice.update({
        where: { id: invoice.id },
        data: { amountPaid: nextPaid, status: statusFor(current.total, nextPaid) },
      });

      return tx.supplierInvoice.findUniqueOrThrow({
        where: { id: invoice.id },
        include: invoiceInclude,
      });
    });

    res.status(201).json(serializeInvoice(updated));
  })
);

/** Only the paperwork fields; the money and the stock are settled events. */
supplierInvoicesRouter.put(
  '/:id',
  requireCapability('purchases.write'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        notes: z.string().optional(),
        due_date: z.coerce.date().nullable().optional(),
      })
      .parse(req.body);

    const user = currentUser(req);
    const existing = await prisma.supplierInvoice.findFirst({
      where: { id: req.params.id as string, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!existing) throw notFound('Invoice not found.');

    const invoice = await prisma.supplierInvoice.update({
      where: { id: existing.id },
      data: {
        ...(body.notes === undefined ? {} : { notes: body.notes }),
        ...(body.due_date === undefined ? {} : { dueDate: body.due_date }),
      },
      include: invoiceInclude,
    });

    res.json(serializeInvoice(invoice));
  })
);

/**
 * Reverses a mis-keyed invoice: the stock it added is taken back off the shelf
 * and the record is removed.
 *
 * Refused once any money has been paid against it — at that point the invoice
 * is part of the accounts, and the right correction is a credit note from the
 * supplier, not a deletion here.
 */
supplierInvoicesRouter.delete(
  '/:id',
  requireCapability('purchases.delete'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);

    const invoice = await prisma.supplierInvoice.findFirst({
      where: { id: req.params.id as string, organizationId: user.organizationId },
      include: { items: true, supplier: { select: { name: true } } },
    });
    if (!invoice) throw notFound('Invoice not found.');
    await assertStoreAccess(user, invoice.storeId);

    if (invoice.amountPaid.gt(0)) {
      throw badRequest(
        'Money has already been paid against this invoice, so it cannot be deleted. Record a credit note from the supplier instead.'
      );
    }

    await prisma.$transaction(async (tx) => {
      for (const item of invoice.items) {
        if (!item.productId) continue;
        const level = await tx.inventory.update({
          where: { storeId_productId: { storeId: invoice.storeId, productId: item.productId } },
          data: { quantity: { decrement: item.quantity } },
        });

        await tx.stockMovement.create({
          data: {
            storeId: invoice.storeId,
            productId: item.productId,
            type: 'adjustment',
            quantity: item.quantity.neg(),
            balance: level.quantity,
            reference: `INV ${invoice.invoiceNumber} reversed`,
            note: `Invoice from ${invoice.supplier.name} deleted`,
            userId: user.id,
          },
        });
      }

      await tx.supplierInvoice.delete({ where: { id: invoice.id } });
    });

    res.json({ detail: 'Invoice deleted and the stock it added has been reversed.' });
  })
);
