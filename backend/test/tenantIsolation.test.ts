import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { prisma } from '../src/prisma.js';
import { api, seedWorld, type World } from './fixtures.js';

/**
 * Two organisations that must not be able to see or touch each other.
 *
 * Every one of these probes an id belonging to the *other* tenant. The rule is
 * that a foreign id looks exactly like one that does not exist — a 403 would
 * itself confirm the row is real.
 */
describe('tenant isolation', () => {
  let app: Express;
  let mine: World;
  let theirs: World;

  beforeEach(async () => {
    app = api();
    mine = await seedWorld(app);
    theirs = await seedWorld(app);
  });

  const asAdmin = (method: 'get' | 'post' | 'delete', path: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${mine.tokens.admin}`);

  it("refuses to read another organisation's store pricing", async () => {
    const res = await asAdmin('get', `/api/store-pricing?store_id=${theirs.storeId}`);
    expect(res.status).toBe(404);
  });

  it("refuses to price another organisation's store", async () => {
    const res = await asAdmin('post', '/api/store-pricing').send({
      store_id: theirs.storeId,
      product_id: theirs.products[0]!.id,
      price: 1,
    });

    expect(res.status).toBe(404);
    const rows = await prisma.storePrice.findMany({ where: { storeId: theirs.storeId } });
    expect(rows).toHaveLength(0);
  });

  it("refuses to price another organisation's product in our own store", async () => {
    const res = await asAdmin('post', '/api/store-pricing').send({
      store_id: mine.storeId,
      product_id: theirs.products[0]!.id,
      price: 1,
    });
    expect(res.status).toBe(404);
  });

  it("refuses to delete another organisation's custom price", async () => {
    const row = await prisma.storePrice.create({
      data: { storeId: theirs.storeId, productId: theirs.products[0]!.id, price: 42 },
    });

    const res = await asAdmin('delete', `/api/store-pricing/${row.id}`);

    expect(res.status).toBe(404);
    await expect(
      prisma.storePrice.findUnique({ where: { id: row.id } })
    ).resolves.not.toBeNull();
  });

  it("refuses to read another organisation's stock", async () => {
    const res = await asAdmin('get', `/api/inventory?store_id=${theirs.storeId}`);
    expect(res.status).toBe(404);
  });

  it("refuses to read another organisation's stock movements", async () => {
    const res = await asAdmin('get', `/api/inventory/movements?store_id=${theirs.storeId}`);
    expect(res.status).toBe(404);
  });

  it("refuses to read another organisation's catalogue and stock levels", async () => {
    const res = await asAdmin('get', `/api/products/with-stock/${theirs.storeId}`);
    expect(res.status).toBe(404);
  });

  it("refuses to sell through another organisation's store", async () => {
    const res = await asAdmin('post', '/api/transactions').send({
      store_id: theirs.storeId,
      client_reference: `cross-${Date.now()}`,
      items: [{ product_id: mine.products[0]!.id, quantity: 1 }],
      payments: [{ method: 'cash', amount: 85 }],
    });
    expect(res.status).toBe(404);
  });

  it("refuses to transfer stock out to another organisation's store", async () => {
    const res = await asAdmin('post', '/api/transfers').send({
      from_store_id: mine.storeId,
      to_store_id: theirs.storeId,
      items: [{ product_id: mine.products[0]!.id, quantity: 1 }],
    });

    expect(res.status).toBe(404);
    const transfers = await prisma.transfer.findMany({ where: { toStoreId: theirs.storeId } });
    expect(transfers).toHaveLength(0);
  });

  it("refuses to read another organisation's analytics", async () => {
    const res = await asAdmin('get', `/api/analytics/dashboard?store_id=${theirs.storeId}`);
    expect(res.status).toBe(404);
  });

  it('still allows everything against our own store', async () => {
    expect((await asAdmin('get', `/api/inventory?store_id=${mine.storeId}`)).status).toBe(200);
    expect((await asAdmin('get', `/api/products/with-stock/${mine.storeId}`)).status).toBe(200);
    expect((await asAdmin('get', `/api/analytics/dashboard?store_id=${mine.storeId}`)).status).toBe(
      200
    );
    expect((await asAdmin('get', `/api/store-pricing?store_id=${mine.storeId}`)).status).toBe(200);
  });
});
