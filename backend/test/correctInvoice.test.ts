import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { api, clientRef, seedWorld, stockOf, type World } from './fixtures.js';

/** Client request 2026-11-24: admin corrects an invoice without refunding it. */
describe('invoice correction', () => {
  let app: Express;
  let world: World;
  let saleId: string;

  beforeEach(async () => {
    app = api();
    world = await seedWorld(app);
    const [a, b] = world.products;
    const sale = await request(app)
      .post('/api/transactions')
      .set('Authorization', `Bearer ${world.tokens.cashier}`)
      .send({
        store_id: world.storeId,
        client_reference: clientRef('sale'),
        items: [
          { product_id: a!.id, quantity: 5 },
          { product_id: b!.id, quantity: 2 },
        ],
        payments: [{ method: 'cash', amount: 0 }],
      });
    expect(sale.status).toBe(201);
    saleId = sale.body.id;
  });

  const correct = (token: string, body: Record<string, unknown>) =>
    request(app).post(`/api/transactions/${saleId}/correct`).set('Authorization', `Bearer ${token}`).send(body);

  it('rewrites the sale in place and moves stock by the difference only', async () => {
    const [a, b, c] = world.products;
    // A: 5 -> 3 at a new price, B taken off, C untouched.
    const res = await correct(world.tokens.admin, {
      items: [{ product_id: a!.id, quantity: 3, unit_price: 80 }],
      payments: [{ method: 'mobile', amount: 0 }],
      customer_name: 'Banda',
      reason: 'wrong qty keyed',
    });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(saleId);
    expect(res.body.total).toBe(240);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.payments).toEqual([expect.objectContaining({ method: 'mobile', amount: 240 })]);
    expect(res.body.customer_name).toBe('Banda');
    expect(res.body.notes).toContain('wrong qty keyed');

    // Sold 5 A and 2 B from 100 each; corrected to 3 A, 0 B.
    expect(await stockOf(world.storeId, a!.id)).toBe(97);
    expect(await stockOf(world.storeId, b!.id)).toBe(100);
    expect(await stockOf(world.storeId, c!.id)).toBe(100);

    // No refund was created.
    const list = await request(app)
      .get(`/api/transactions?store_id=${world.storeId}`)
      .set('Authorization', `Bearer ${world.tokens.admin}`);
    expect(list.body).toHaveLength(1);
  });

  it('adds a new line and takes its stock', async () => {
    const [a, b, c] = world.products;
    const res = await correct(world.tokens.admin, {
      items: [
        { product_id: a!.id, quantity: 5, unit_price: 85 },
        { product_id: b!.id, quantity: 2, unit_price: 175 },
        { product_id: c!.id, quantity: 1, unit_price: 950 },
      ],
      payments: [{ method: 'cash', amount: 0 }],
      reason: 'forgot urea',
    });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(await stockOf(world.storeId, c!.id)).toBe(99);
  });

  it('is admin only, needs a reason, and is refused after a refund', async () => {
    const a = world.products[0]!;
    const body = { items: [{ product_id: a.id, quantity: 1, unit_price: 85 }], payments: [{ method: 'cash', amount: 0 }] };

    expect((await correct(world.tokens.manager, { ...body, reason: 'x' })).status).toBe(403);
    expect((await correct(world.tokens.admin, body)).status).toBe(422);

    await request(app)
      .post(`/api/transactions/${saleId}/refund`)
      .set('Authorization', `Bearer ${world.tokens.admin}`)
      .send({ items: [{ product_id: a.id, quantity: 1 }] });
    expect((await correct(world.tokens.admin, { ...body, reason: 'x' })).status).toBe(400);
  });
});
