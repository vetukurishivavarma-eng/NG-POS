import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { prisma } from '../src/prisma.js';
import { api, seedWorld, stockOf, type World } from './fixtures.js';

/**
 * A supplier invoice is three things happening at once: goods arriving, a
 * paper reference being filed, and money being owed. These tests exist because
 * any one of them landing without the others is a shop that cannot reconcile.
 */
describe('supplier invoices', () => {
  let app: Express;
  let world: World;
  let supplierId: string;

  const asAdmin = (method: 'get' | 'post' | 'put' | 'delete', path: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${world.tokens.admin}`);

  beforeEach(async () => {
    app = api();
    world = await seedWorld(app);

    const res = await asAdmin('post', '/api/suppliers').send({
      name: 'Novatek Wholesale',
      phone: '0977000111',
    });
    expect(res.status).toBe(201);
    supplierId = res.body.id as string;
  });

  const invoiceBody = (overrides: Record<string, unknown> = {}) => ({
    supplier_id: supplierId,
    store_id: world.storeId,
    invoice_number: 'NV-1001',
    items: [
      { product_id: world.products[0]!.id, quantity: 10, unit_cost: 40 },
      { product_id: world.products[1]!.id, quantity: 5, unit_cost: 100 },
    ],
    ...overrides,
  });

  it('puts the stock on the shelf and records what it cost', async () => {
    const before = await stockOf(world.storeId, world.products[0]!.id);

    const res = await asAdmin('post', '/api/supplier-invoices').send(invoiceBody());

    expect(res.status).toBe(201);
    expect(res.body.subtotal).toBe(900);
    expect(res.body.total).toBe(900);
    expect(res.body.balance).toBe(900);
    expect(res.body.status).toBe('unpaid');

    await expect(stockOf(world.storeId, world.products[0]!.id)).resolves.toBe(before + 10);

    // The movement history has to name the paperwork, or a delivery cannot be
    // traced back to the invoice that brought it in.
    const movements = await prisma.stockMovement.findMany({
      where: { storeId: world.storeId, type: 'purchase' },
    });
    expect(movements).toHaveLength(2);
    expect(movements[0]?.reference).toBe('INV NV-1001');
  });

  it('moves the catalogue cost price to what was actually paid', async () => {
    await asAdmin('post', '/api/supplier-invoices').send(invoiceBody());

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: world.products[0]!.id },
    });
    expect(product.costPrice.toNumber()).toBe(40);
  });

  it('leaves the cost price alone when told to', async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: world.products[0]!.id } });

    await asAdmin('post', '/api/supplier-invoices').send(
      invoiceBody({ update_cost_price: false })
    );

    const after = await prisma.product.findUniqueOrThrow({ where: { id: world.products[0]!.id } });
    expect(after.costPrice.toNumber()).toBe(before.costPrice.toNumber());
  });

  it('adds tax and delivery, and takes off a discount', async () => {
    const res = await asAdmin('post', '/api/supplier-invoices').send(
      invoiceBody({ tax_amount: 144, other_charges: 50, discount_amount: 94 })
    );

    expect(res.status).toBe(201);
    expect(res.body.total).toBe(1000);
  });

  it('records a part payment and shows the balance still owed', async () => {
    const res = await asAdmin('post', '/api/supplier-invoices').send(
      invoiceBody({ payment: { amount: 300, method: 'cash' } })
    );

    expect(res.status).toBe(201);
    expect(res.body.amount_paid).toBe(300);
    expect(res.body.balance).toBe(600);
    expect(res.body.status).toBe('partial');
    expect(res.body.payments).toHaveLength(1);
  });

  it('marks an invoice paid when the full amount is tendered', async () => {
    const res = await asAdmin('post', '/api/supplier-invoices').send(
      invoiceBody({ payment: { amount: 900, method: 'bank_transfer', reference: 'FT2233' } })
    );

    expect(res.body.status).toBe('paid');
    expect(res.body.balance).toBe(0);
  });

  it('refuses a payment larger than the invoice', async () => {
    const res = await asAdmin('post', '/api/supplier-invoices').send(
      invoiceBody({ payment: { amount: 1200 } })
    );

    expect(res.status).toBe(400);
    // Nothing at all should have been written — not the invoice, not the stock.
    await expect(prisma.supplierInvoice.count()).resolves.toBe(0);
  });

  it('settles an invoice over several instalments', async () => {
    const created = await asAdmin('post', '/api/supplier-invoices').send(invoiceBody());
    const id = created.body.id as string;

    const first = await asAdmin('post', `/api/supplier-invoices/${id}/payments`).send({
      amount: 400,
      method: 'mobile',
      reference: 'MM-9911',
    });
    expect(first.body.balance).toBe(500);
    expect(first.body.status).toBe('partial');

    const second = await asAdmin('post', `/api/supplier-invoices/${id}/payments`).send({
      amount: 500,
      method: 'cash',
    });
    expect(second.body.balance).toBe(0);
    expect(second.body.status).toBe('paid');
    expect(second.body.payments).toHaveLength(2);
  });

  it('refuses an instalment bigger than what is left', async () => {
    const created = await asAdmin('post', '/api/supplier-invoices').send(
      invoiceBody({ payment: { amount: 800 } })
    );
    const id = created.body.id as string;

    const res = await asAdmin('post', `/api/supplier-invoices/${id}/payments`).send({ amount: 200 });

    expect(res.status).toBe(400);
    const invoice = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id } });
    expect(invoice.amountPaid.toNumber()).toBe(800);
  });

  it('refuses the same paper invoice twice', async () => {
    await asAdmin('post', '/api/supplier-invoices').send(invoiceBody());
    const again = await asAdmin('post', '/api/supplier-invoices').send(invoiceBody());

    expect(again.status).toBe(409);
    // The stock must not have moved a second time either.
    const movements = await prisma.stockMovement.count({ where: { type: 'purchase' } });
    expect(movements).toBe(2);
  });

  it('adds the same product twice when it is on two lines', async () => {
    const before = await stockOf(world.storeId, world.products[0]!.id);

    await asAdmin('post', '/api/supplier-invoices').send(
      invoiceBody({
        items: [
          { product_id: world.products[0]!.id, quantity: 3, unit_cost: 40 },
          { product_id: world.products[0]!.id, quantity: 7, unit_cost: 40 },
        ],
      })
    );

    await expect(stockOf(world.storeId, world.products[0]!.id)).resolves.toBe(before + 10);
  });

  it("will not receive another organisation's product", async () => {
    const theirs = await seedWorld(app);

    const res = await asAdmin('post', '/api/supplier-invoices').send(
      invoiceBody({ items: [{ product_id: theirs.products[0]!.id, quantity: 1, unit_cost: 5 }] })
    );

    expect(res.status).toBe(404);
  });

  it("will not receive into another organisation's store", async () => {
    const theirs = await seedWorld(app);

    const res = await asAdmin('post', '/api/supplier-invoices').send(
      invoiceBody({ store_id: theirs.storeId })
    );

    expect(res.status).toBe(404);
  });

  it('is closed to cashiers', async () => {
    const res = await request(app)
      .post('/api/supplier-invoices')
      .set('Authorization', `Bearer ${world.tokens.cashier}`)
      .send(invoiceBody());

    expect(res.status).toBe(403);
  });

  it('reports what is outstanding across suppliers', async () => {
    await asAdmin('post', '/api/supplier-invoices').send(
      invoiceBody({ payment: { amount: 300 } })
    );
    await asAdmin('post', '/api/supplier-invoices').send(
      invoiceBody({
        invoice_number: 'NV-1002',
        items: [{ product_id: world.products[2]!.id, quantity: 1, unit_cost: 250 }],
      })
    );

    const res = await asAdmin('get', '/api/supplier-invoices/summary');

    expect(res.status).toBe(200);
    expect(res.body.outstanding_total).toBe(850);
    expect(res.body.open_invoice_count).toBe(2);
    expect(res.body.by_supplier[0].balance).toBe(850);
  });

  it('takes the stock back off the shelf when an unpaid invoice is deleted', async () => {
    const before = await stockOf(world.storeId, world.products[0]!.id);
    const created = await asAdmin('post', '/api/supplier-invoices').send(invoiceBody());

    const res = await asAdmin('delete', `/api/supplier-invoices/${created.body.id}`);

    expect(res.status).toBe(200);
    await expect(stockOf(world.storeId, world.products[0]!.id)).resolves.toBe(before);
    await expect(prisma.supplierInvoice.count()).resolves.toBe(0);
  });

  it('refuses to delete an invoice that has been paid against', async () => {
    const created = await asAdmin('post', '/api/supplier-invoices').send(
      invoiceBody({ payment: { amount: 100 } })
    );

    const res = await asAdmin('delete', `/api/supplier-invoices/${created.body.id}`);

    expect(res.status).toBe(400);
    await expect(prisma.supplierInvoice.count()).resolves.toBe(1);
  });

  it('lists a supplier with what is still owed to them', async () => {
    await asAdmin('post', '/api/supplier-invoices').send(invoiceBody({ payment: { amount: 100 } }));

    const res = await asAdmin('get', '/api/suppliers');

    expect(res.status).toBe(200);
    expect(res.body[0].outstanding_balance).toBe(800);
    expect(res.body[0].invoice_count).toBe(1);
  });

  it('refuses a second supplier with the same name', async () => {
    const res = await asAdmin('post', '/api/suppliers').send({ name: 'novatek wholesale' });
    expect(res.status).toBe(409);
  });
});
