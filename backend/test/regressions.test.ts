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

  describe('the till price is locked; only an admin reprices, and only on a prompt', () => {
    it('refuses a cashier who changes the line price', async () => {
      const product = world.products[0]!;

      const res = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('cashier-reprice'),
        items: [{ product_id: product.id, quantity: 1, unit_price: product.price + 20 }],
        payments: [{ method: 'cash', amount: product.price + 20 }],
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PRICE_LOCKED');
    });

    it('lets a cashier sell at the standing price even though the app echoes unit_price', async () => {
      const product = world.products[0]!;

      const res = await sell(world.tokens.cashier, {
        store_id: world.storeId,
        client_reference: clientRef('cashier-echo'),
        items: [{ product_id: product.id, quantity: 1, unit_price: product.price }],
        payments: [{ method: 'cash', amount: product.price }],
      });

      expect(res.status).toBe(201);
      expect(res.body.items[0].unit_price).toBe(product.price);
    });

    it('rejects an admin override below cost price', async () => {
      const product = world.products[0]!;

      const res = await sell(world.tokens.admin, {
        store_id: world.storeId,
        client_reference: clientRef('cheap'),
        items: [{ product_id: product.id, quantity: 1, unit_price: 0.01 }],
        payments: [{ method: 'cash', amount: 0.01 }],
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PRICE_BELOW_COST');
    });

    it('an admin override without persist_price applies to the receipt only', async () => {
      const product = world.products[1]!;
      const newPrice = product.price - 10; // above cost (price / 2)

      const res = await sell(world.tokens.admin, {
        store_id: world.storeId,
        client_reference: clientRef('sale-only'),
        items: [{ product_id: product.id, quantity: 1, unit_price: newPrice }],
        payments: [{ method: 'cash', amount: newPrice }],
      });

      expect(res.status).toBe(201);
      expect(res.body.items[0].unit_price).toBe(newPrice);

      const catalogue = await prisma.product.findUnique({ where: { id: product.id } });
      expect(catalogue?.sellingPrice.toNumber()).toBe(product.price);
      const override = await prisma.storePrice.findFirst({
        where: { storeId: world.storeId, productId: product.id },
      });
      expect(override).toBeNull();
    });

    it('an admin override with persist_price becomes that shop’s standing price', async () => {
      const product = world.products[1]!;
      const newPrice = product.price - 10;

      const res = await sell(world.tokens.admin, {
        store_id: world.storeId,
        client_reference: clientRef('persist'),
        items: [{ product_id: product.id, quantity: 1, unit_price: newPrice, persist_price: true }],
        payments: [{ method: 'cash', amount: newPrice }],
      });

      expect(res.status).toBe(201);

      const catalogue = await prisma.product.findUnique({ where: { id: product.id } });
      expect(catalogue?.sellingPrice.toNumber()).toBe(product.price); // org base untouched
      const override = await prisma.storePrice.findFirst({
        where: { storeId: world.storeId, productId: product.id },
      });
      expect(override?.price.toNumber()).toBe(newPrice);

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

  describe('GET /api/inventory/by-product/:id — chain-wide stock, admin only', () => {
    it('returns every active store with the total, admin', async () => {
      const product = world.products[0]!;
      const other = await prisma.store.create({
        data: { organizationId: world.organizationId, name: 'Second Store', code: 'SECOND', city: 'Ndola' },
      });
      await prisma.inventory.create({
        data: { storeId: other.id, productId: product.id, quantity: 40, reorderLevel: 5 },
      });

      const res = await request(app)
        .get(`/api/inventory/by-product/${product.id}`)
        .set('Authorization', `Bearer ${world.tokens.admin}`);

      expect(res.status).toBe(200);
      expect(res.body.total_quantity).toBe(140);
      expect(res.body.stores).toHaveLength(2);
      const second = res.body.stores.find((s: { store_id: string }) => s.store_id === other.id);
      expect(second.quantity).toBe(40);
    });

    it('lists a store the product is not stocked in as zero', async () => {
      const product = world.products[0]!;
      await prisma.store.create({
        data: { organizationId: world.organizationId, name: 'Empty Store', code: 'EMPTY', city: 'Kabwe' },
      });

      const res = await request(app)
        .get(`/api/inventory/by-product/${product.id}`)
        .set('Authorization', `Bearer ${world.tokens.admin}`);

      expect(res.status).toBe(200);
      const empty = res.body.stores.find((s: { store_name: string }) => s.store_name === 'Empty Store');
      expect(empty.quantity).toBe(0);
    });

    it('is refused to a store manager', async () => {
      const product = world.products[0]!;
      const res = await request(app)
        .get(`/api/inventory/by-product/${product.id}`)
        .set('Authorization', `Bearer ${world.tokens.manager}`);
      expect(res.status).toBe(403);
    });

    it('is refused to a cashier', async () => {
      const product = world.products[0]!;
      const res = await request(app)
        .get(`/api/inventory/by-product/${product.id}`)
        .set('Authorization', `Bearer ${world.tokens.cashier}`);
      expect(res.status).toBe(403);
    });

    it('404s an unknown product', async () => {
      const res = await request(app)
        .get('/api/inventory/by-product/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${world.tokens.admin}`);
      expect(res.status).toBe(404);
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

  describe('a shop login editing a product only touches its own store', () => {
    it('scopes selling_price and expiry_date to store_id, and requires it', async () => {
      const product = world.products[0]!;
      const otherStore = await prisma.store.create({
        data: { organizationId: world.organizationId, name: 'Other Store', code: 'OTHER', city: 'Ndola' },
      });

      // No store_id at all: refused outright, not silently applied anywhere.
      const noStore = await request(app)
        .put(`/api/products/${product.id}`)
        .set('Authorization', `Bearer ${world.tokens.manager}`)
        .send({ selling_price: product.price + 1 });
      expect(noStore.status).toBe(400);

      const edited = await request(app)
        .put(`/api/products/${product.id}`)
        .set('Authorization', `Bearer ${world.tokens.manager}`)
        .send({
          selling_price: product.price + 15,
          expiry_date: '2027-01-01',
          store_id: world.storeId,
        });
      expect(edited.status).toBe(200);

      const here = await request(app)
        .get(`/api/products/${product.id}`)
        .query({ store_id: world.storeId })
        .set('Authorization', `Bearer ${world.tokens.manager}`);
      expect(here.body.selling_price).toBe(product.price + 15);
      expect(here.body.expiry_date).toBe('2027-01-01');

      // The other store never carried this product (no Inventory row), so
      // there's nothing to have been touched — the master default still
      // stands there.
      const elsewhere = await request(app)
        .get(`/api/products/${product.id}`)
        .query({ store_id: otherStore.id })
        .set('Authorization', `Bearer ${world.tokens.manager}`);
      expect(elsewhere.body.selling_price).toBe(product.price);
      expect(elsewhere.body.expiry_date).toBeNull();

      // The org-wide master record is untouched by a store-scoped edit.
      const master = await request(app)
        .get(`/api/products/${product.id}`)
        .set('Authorization', `Bearer ${world.tokens.admin}`);
      expect(master.body.selling_price).toBe(product.price);
      expect(master.body.expiry_date).toBeNull();
    });

    it('always writes chemical_name and category to the shared master record', async () => {
      const product = world.products[0]!;

      const res = await request(app)
        .put(`/api/products/${product.id}`)
        .set('Authorization', `Bearer ${world.tokens.cashier}`)
        .send({ chemical_name: 'Cypermethrin 10%', category: 'Pesticides', store_id: world.storeId });
      expect(res.status).toBe(200);

      const master = await request(app)
        .get(`/api/products/${product.id}`)
        .set('Authorization', `Bearer ${world.tokens.admin}`);
      expect(master.body.chemical_name).toBe('Cypermethrin 10%');
      expect(master.body.category).toBe('Pesticides');
    });

    it('lists a diverged store on the master record, so admin can see it without checking every shop', async () => {
      const product = world.products[0]!;
      const otherStore = await prisma.store.create({
        data: { organizationId: world.organizationId, name: 'Second Store', code: 'SECOND', city: 'Kitwe' },
      });

      await request(app)
        .put(`/api/products/${product.id}`)
        .set('Authorization', `Bearer ${world.tokens.admin}`)
        .send({ selling_price: product.price + 3, store_id: otherStore.id });

      const master = await request(app)
        .get(`/api/products/${product.id}`)
        .set('Authorization', `Bearer ${world.tokens.admin}`);

      expect(master.body.selling_price).toBe(product.price);
      expect(master.body.store_overrides).toEqual([
        { store_id: otherStore.id, store_name: 'Second Store', price: product.price + 3, expiry_date: null },
      ]);
    });
  });

  describe('the product list excludes inactive by default', () => {
    it('leaves an inactive product out unless include_inactive is asked for', async () => {
      const product = world.products[0]!;
      await request(app)
        .delete(`/api/products/${product.id}`)
        .set('Authorization', `Bearer ${world.tokens.admin}`);

      const defaultList = await request(app)
        .get('/api/products')
        .set('Authorization', `Bearer ${world.tokens.admin}`);
      expect(defaultList.body.some((p: { id: string }) => p.id === product.id)).toBe(false);

      const withInactive = await request(app)
        .get('/api/products')
        .query({ include_inactive: 'true' })
        .set('Authorization', `Bearer ${world.tokens.admin}`);
      expect(withInactive.body.some((p: { id: string }) => p.id === product.id)).toBe(true);
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
