import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { prisma } from '../src/prisma.js';
import { api, clientRef, seedWorld, stockOf, type World } from './fixtures.js';

/**
 * Revoking a transfer that was sent to the wrong shop.
 *
 * The whole value of the feature is the refusal, not the reversal: putting
 * stock back is arithmetic, but putting it back *after somebody has already
 * sold it* quietly corrupts two shops' figures at once. So the cases that
 * matter here are the ones where the destination has touched the stock.
 */
describe('revoking a transfer', () => {
  let app: Express;
  let world: World;
  let sister: { id: string };

  beforeEach(async () => {
    app = api();
    world = await seedWorld(app);
    sister = await prisma.store.create({
      data: {
        organizationId: world.organizationId,
        name: 'Chinkuli',
        code: `CHINKULI-${Date.now().toString(36)}`,
        city: 'Chongwe',
      },
      select: { id: true },
    });
  });

  const asAdmin = (method: 'get' | 'post', path: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${world.tokens.admin}`);

  /** Stocks the source shop and sends `quantity` of it to the sister shop. */
  async function send(quantity: number): Promise<{ id: string; productId: string }> {
    const product = world.products[0]!;
    await prisma.inventory.upsert({
      where: { storeId_productId: { storeId: world.storeId, productId: product.id } },
      create: { storeId: world.storeId, productId: product.id, quantity: 100 },
      update: { quantity: 100 },
    });

    const res = await asAdmin('post', '/api/transfers').send({
      from_store_id: world.storeId,
      to_store_id: sister.id,
      items: [{ product_id: product.id, quantity }],
    });
    expect(res.status).toBe(201);
    return { id: res.body.id as string, productId: product.id };
  }

  it('puts every line back and marks the transfer cancelled', async () => {
    const { id, productId } = await send(30);
    expect(await stockOf(world.storeId, productId)).toBe(70);
    expect(await stockOf(sister.id, productId)).toBe(30);

    const res = await asAdmin('post', `/api/transfers/${id}/revoke`);

    expect(res.status).toBe(200);
    expect(await stockOf(world.storeId, productId)).toBe(100);
    expect(await stockOf(sister.id, productId)).toBe(0);

    const after = await prisma.transfer.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe('cancelled');
    expect(after.notes).toContain('Revoked');
  });

  it('refuses once the destination has sold any of it, and moves no stock', async () => {
    const { id, productId } = await send(30);

    const sale = await asAdmin('post', '/api/transactions').send({
      store_id: sister.id,
      client_reference: clientRef('revoke-sale'),
      items: [{ product_id: productId, quantity: 1 }],
      payments: [{ method: 'cash', amount: world.products[0]!.price }],
    });
    expect(sale.status).toBe(201);

    const res = await asAdmin('post', `/api/transfers/${id}/revoke`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TRANSFER_ALREADY_USED');
    expect(res.body.detail).toMatch(/a sale/);
    // Nothing moved, and the transfer still stands.
    expect(await stockOf(world.storeId, productId)).toBe(70);
    expect(await stockOf(sister.id, productId)).toBe(29);
    const after = await prisma.transfer.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe('completed');
  });

  it('refuses once the destination has passed the stock on again', async () => {
    const { id, productId } = await send(30);

    const onward = await asAdmin('post', '/api/transfers').send({
      from_store_id: sister.id,
      to_store_id: world.storeId,
      items: [{ product_id: productId, quantity: 5 }],
      source_transfer_id: id,
    });
    expect(onward.status).toBe(201);

    const res = await asAdmin('post', `/api/transfers/${id}/revoke`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TRANSFER_ALREADY_USED');
  });

  it('refuses a hand correction at the destination — the stale-upload case', async () => {
    const { id, productId } = await send(30);

    const adjust = await asAdmin('post', '/api/inventory/movements').send({
      store_id: sister.id,
      product_id: productId,
      type: 'adjustment',
      quantity: -4,
      note: 'recount',
    });
    expect(adjust.status).toBeLessThan(300);

    const res = await asAdmin('post', `/api/transfers/${id}/revoke`);
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/a stock correction/);
  });

  it('cannot be revoked twice', async () => {
    const { id } = await send(30);

    expect((await asAdmin('post', `/api/transfers/${id}/revoke`)).status).toBe(200);

    const again = await asAdmin('post', `/api/transfers/${id}/revoke`);
    expect(again.status).toBe(400);
    expect(again.body.detail).toMatch(/already been revoked/);
  });

  it("will not revoke another organisation's transfer", async () => {
    const { id } = await send(30);
    const theirs = await seedWorld(app);

    const res = await request(app)
      .post(`/api/transfers/${id}/revoke`)
      .set('Authorization', `Bearer ${theirs.tokens.admin}`);

    expect(res.status).toBe(404);
  });
});
