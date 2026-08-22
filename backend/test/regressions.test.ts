import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { api, clientRef, PASSWORD, seedWorld, stockOf, type World } from './fixtures.js';
import { prisma } from '../src/prisma.js';

/**
 * One test per hole found by probing the running server on 2026-08-04.
 *
 * Every one of these passed a typecheck, which is exactly why they are here:
 * types cannot tell you that a cashier may set their own prices.
 */
describe('regressions', () => {
  let app: Express;
  let world: World;

  beforeEach(async () => {
    app = api();
    world = await seedWorld(app);
  });

  const sell = (token: string, body: Record<string, unknown>) =>
    request(app).post('/api/transactions').set('Authorization', `Bearer ${token}`).send(body);

  describe('a till may reprice a line, but never below cost', () => {
    it('rejects a price below cost price, for a cashier same as anyone', async () => {
      const product = world.products[0]!;

      const res = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('cheap'),
        items: [{ product_id: product.id, quantity: 1, unit_price: 0.01 }],
        payments: [{ method: 'cash', amount: 0.01 }],
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PRICE_BELOW_COST');
    });

    it('honours an override at or above cost, and it becomes the new catalogue price', async () => {
      const { prisma } = await import('../src/prisma.js');
      const product = world.products[1]!;
      const newPrice = product.price - 10; // still comfortably above cost (price / 2)

      const res = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('reprice'),
        items: [{ product_id: product.id, quantity: 1, unit_price: newPrice }],
        payments: [{ method: 'cash', amount: newPrice }],
      });

      expect(res.status).toBe(201);
      expect(res.body.items[0].unit_price).toBe(newPrice);

      const catalogue = await prisma.product.findUnique({ where: { id: product.id } });
      expect(catalogue?.sellingPrice.toNumber()).toBe(newPrice);

      const withStock = await request(app)
        .get(`/api/products/with-stock/${world.storeId}`)
        .set('Authorization', `Bearer ${world.tokens.cashier}`);
      const item = withStock.body.find((p: { id: string }) => p.id === product.id);
      expect(item.selling_price).toBe(newPrice);
    });

    it('still accepts the extra fields the mobile app sends', async () => {
      const product = world.products[0]!;

      const res = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        transaction_type: 'sale',
        client_reference: clientRef('mobile'),
        items: [
          {
            product_id: product.id,
            product_name: product.name,
            sku: 'whatever',
            brand: null,
            quantity: 2,
            unit_price: product.price,
            discount_amount: 0,
            tax_type: 'exempt',
            tax_amount: 0,
            line_total: product.price * 2,
          },
        ],
        subtotal: product.price * 2,
        total: product.price * 2,
        payments: [{ method: 'cash', amount: product.price * 2, reference: null }],
        customer_name: 'Someone',
        notes: '',
      });

      expect(res.status).toBe(201);
      expect(res.body.total).toBe(product.price * 2);
    });
  });

  describe('reversals only come from the refund route', () => {
    it('rejects transaction_type: refund on the sale endpoint', async () => {
      const product = world.products[0]!;
      const before = await stockOf(world.storeId, product.id);

      const res = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('sneaky'),
        transaction_type: 'refund',
        items: [{ product_id: product.id, quantity: 5 }],
        payments: [{ method: 'cash', amount: 0 }],
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      // The point of the bug: it minted stock out of nothing.
      expect(await stockOf(world.storeId, product.id)).toBe(before);
    });

    it('ignores a client-supplied reverses_id', async () => {
      const product = world.products[0]!;

      const res = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('link'),
        items: [{ product_id: product.id, quantity: 1 }],
        payments: [{ method: 'cash', amount: 0 }],
        reverses_id: '11111111-1111-1111-1111-111111111111',
      });

      expect(res.status).toBe(201);
      expect(res.body.reverses_id ?? null).toBeNull();
    });

    it('refuses a refund to a cashier', async () => {
      const product = world.products[0]!;
      const sale = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('sale'),
        items: [{ product_id: product.id, quantity: 1 }],
        payments: [{ method: 'cash', amount: 0 }],
      });

      const res = await request(app)
        .post(`/api/transactions/${sale.body.id}/refund`)
        .set('Authorization', `Bearer ${world.tokens.cashier}`)
        .send({ reason: 'nope' });

      expect(res.status).toBe(403);
    });
  });

  describe('a refund cannot exceed the sale', () => {
    let saleId: string;
    let productId: string;
    let stockAfterSale: number;

    beforeEach(async () => {
      const product = world.products[0]!;
      productId = product.id;
      const sale = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('sale'),
        items: [{ product_id: product.id, quantity: 3 }],
        payments: [{ method: 'cash', amount: 0 }],
      });
      saleId = sale.body.id;
      stockAfterSale = await stockOf(world.storeId, productId);
    });

    const refund = (body: Record<string, unknown>) =>
      request(app)
        .post(`/api/transactions/${saleId}/refund`)
        .set('Authorization', `Bearer ${world.tokens.manager}`)
        .send({ client_reference: clientRef('rf'), ...body });

    it('rejects more units than were sold, and moves no stock', async () => {
      const res = await refund({ items: [{ product_id: productId, quantity: 999 }] });

      expect(res.status).toBe(400);
      expect(res.body.detail).toMatch(/only 3 left/i);
      expect(await stockOf(world.storeId, productId)).toBe(stockAfterSale);
    });

    it('aggregates the same product sent twice instead of refunding it twice', async () => {
      const res = await refund({
        items: [
          { product_id: productId, quantity: 2 },
          { product_id: productId, quantity: 2 },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.detail).toMatch(/only 3 left/i);
    });

    it('rejects a product that was not on the sale', async () => {
      const other = world.products[1]!;
      const res = await refund({ items: [{ product_id: other.id, quantity: 1 }] });

      expect(res.status).toBe(400);
      expect(res.body.detail).toMatch(/not on this sale/i);
    });
  });

  describe('partial refunds run until the sale is exhausted', () => {
    it('keeps the sale open until every unit is back, then closes it', async () => {
      const product = world.products[0]!;
      const sale = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('sale'),
        items: [{ product_id: product.id, quantity: 3 }],
        payments: [{ method: 'cash', amount: 0 }],
      });
      const stockAfterSale = await stockOf(world.storeId, product.id);

      const refund = (quantity: number) =>
        request(app)
          .post(`/api/transactions/${sale.body.id}/refund`)
          .set('Authorization', `Bearer ${world.tokens.manager}`)
          .send({
            client_reference: clientRef('rf'),
            items: [{ product_id: product.id, quantity }],
          });

      const read = async () =>
        (
          await request(app)
            .get(`/api/transactions/${sale.body.id}`)
            .set('Authorization', `Bearer ${world.tokens.manager}`)
        ).body.status;

      expect((await refund(1)).status).toBe(201);
      // The bug: this said "refunded" and stranded the other two units.
      expect(await read()).toBe('completed');

      expect((await refund(2)).status).toBe(201);
      expect(await read()).toBe('refunded');

      const tooMany = await refund(1);
      expect(tooMany.status).toBe(400);

      expect(await stockOf(world.storeId, product.id)).toBe(stockAfterSale + 3);
    });

    it('refunds everything outstanding when no items are given', async () => {
      const product = world.products[0]!;
      const sale = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('sale'),
        items: [{ product_id: product.id, quantity: 2 }],
        payments: [{ method: 'cash', amount: 0 }],
      });

      const res = await request(app)
        .post(`/api/transactions/${sale.body.id}/refund`)
        .set('Authorization', `Bearer ${world.tokens.manager}`)
        .send({ client_reference: clientRef('rf') });

      expect(res.status).toBe(201);
      expect(res.body.total).toBe(-(product.price * 2));
    });
  });

  describe('tender is reconciled against the server price', () => {
    it('sets a single tender to the sale total', async () => {
      const product = world.products[0]!;

      const res = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('zero'),
        items: [{ product_id: product.id, quantity: 2 }],
        // The bug: this was stored verbatim, so the cash column read zero.
        payments: [{ method: 'cash', amount: 0 }],
      });

      expect(res.status).toBe(201);
      expect(res.body.payments[0].amount).toBe(res.body.total);
    });

    it('accepts a split tender that adds up', async () => {
      const product = world.products[1]!;

      const res = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('split'),
        items: [{ product_id: product.id, quantity: 1 }],
        payments: [
          { method: 'cash', amount: 25 },
          { method: 'mobile', amount: product.price - 25 },
        ],
      });

      expect(res.status).toBe(201);
      expect(res.body.payments).toHaveLength(2);
    });

    it('rejects a split tender that does not', async () => {
      const product = world.products[1]!;

      const res = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('bad-split'),
        items: [{ product_id: product.id, quantity: 1 }],
        payments: [
          { method: 'cash', amount: 10 },
          { method: 'mobile', amount: 10 },
        ],
      });

      expect(res.status).toBe(400);
      expect(res.body.detail).toMatch(/Re-enter the tender/i);
    });

    it('records a refund as money leaving the drawer', async () => {
      const product = world.products[0]!;
      const sale = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('sale'),
        items: [{ product_id: product.id, quantity: 1 }],
        payments: [{ method: 'cash', amount: 0 }],
      });

      const res = await request(app)
        .post(`/api/transactions/${sale.body.id}/refund`)
        .set('Authorization', `Bearer ${world.tokens.manager}`)
        .send({ client_reference: clientRef('rf') });

      expect(res.status).toBe(201);
      expect(res.body.payments[0].amount).toBe(-product.price);
      expect(res.body.payments[0].method).toBe('cash');
    });
  });

  describe('discounts are capped for cashiers', () => {
    // Matches MAX_CASHIER_DISCOUNT_PERCENT's default.
    const CAP = 10;

    it('allows a cashier a small discount', async () => {
      const product = world.products[0]!;
      const within = (product.price * CAP) / 100;

      const res = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('disc-ok'),
        items: [{ product_id: product.id, quantity: 1, discount_amount: within }],
        payments: [{ method: 'cash', amount: 0 }],
      });

      expect(res.status).toBe(201);
      expect(res.body.total).toBeCloseTo(product.price - within, 2);
    });

    it('refuses to let a cashier discount a line to nothing', async () => {
      const product = world.products[0]!;

      const res = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('disc-free'),
        items: [{ product_id: product.id, quantity: 1, discount_amount: product.price }],
        payments: [{ method: 'cash', amount: 0 }],
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DISCOUNT_LIMIT');
    });

    it('caps against the whole line, not the unit price', async () => {
      const product = world.products[0]!;
      // 10% of one unit, but only 5% of the three actually being bought — the
      // limit has to follow the line or a big basket smuggles a big discount.
      const res = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('disc-line'),
        items: [{ product_id: product.id, quantity: 3, discount_amount: product.price * 0.15 }],
        payments: [{ method: 'cash', amount: 0 }],
      });

      expect(res.status).toBe(201);
    });

    it('lets a manager discount without limit', async () => {
      const product = world.products[0]!;

      const res = await sell(world.tokens.manager, {
        store_id: world.storeId,
        client_reference: clientRef('disc-mgr'),
        items: [{ product_id: product.id, quantity: 1, discount_amount: product.price }],
        payments: [{ method: 'cash', amount: 0 }],
      });

      expect(res.status).toBe(201);
      expect(res.body.total).toBe(0);
    });

    it('still refuses a discount larger than the line, whoever asks', async () => {
      const product = world.products[0]!;

      const res = await sell(world.tokens.admin, {
        store_id: world.storeId,
        client_reference: clientRef('disc-over'),
        items: [{ product_id: product.id, quantity: 1, discount_amount: product.price * 2 }],
        payments: [{ method: 'cash', amount: 0 }],
      });

      expect(res.status).toBe(400);
      expect(res.body.detail).toMatch(/exceeds the line total/i);
    });
  });

  describe('editing a product price clears any stale store override', () => {
    it('with-stock reflects the new price even when a StorePrice override existed', async () => {
      const product = world.products[0]!;

      // Simulate a shop-specific override the way a bulk price-sheet upload
      // would create one.
      await prisma.storePrice.create({
        data: { storeId: world.storeId, productId: product.id, price: product.price + 5 },
      });

      const before = await request(app)
        .get(`/api/products/with-stock/${world.storeId}`)
        .set('Authorization', `Bearer ${world.tokens.admin}`);
      const beforeItem = before.body.find((p: { id: string }) => p.id === product.id);
      expect(beforeItem.selling_price).toBe(product.price + 5);

      const newPrice = product.price + 20;
      const edit = await request(app)
        .put(`/api/products/${product.id}`)
        .set('Authorization', `Bearer ${world.tokens.admin}`)
        .send({ selling_price: newPrice });
      expect(edit.status).toBe(200);

      const after = await request(app)
        .get(`/api/products/with-stock/${world.storeId}`)
        .set('Authorization', `Bearer ${world.tokens.admin}`);
      const afterItem = after.body.find((p: { id: string }) => p.id === product.id);

      // The bug: this stayed at product.price + 5 because the override was
      // never cleared, so the till kept charging the old price forever.
      expect(afterItem.selling_price).toBe(newPrice);
    });
  });

  describe('login is throttled', () => {
    it('stops guessing after a handful of attempts', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ email: world.emails.admin, password: `wrong-${i}` });
        codes.push(res.status);
      }

      expect(codes).toContain(429);
      expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(8);
    });

    it('does not lock out a different account on the same connection', async () => {
      for (let i = 0; i < 12; i += 1) {
        await request(app)
          .post('/api/auth/login')
          .send({ email: world.emails.admin, password: `wrong-${i}` });
      }

      // A shop's tills share one connection; one fumbled password must not
      // take the branch offline.
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: world.emails.cashier, password: PASSWORD });

      expect(res.status).toBe(200);
    });
  });
});
