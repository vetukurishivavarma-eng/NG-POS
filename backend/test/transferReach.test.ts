import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { prisma } from '../src/prisma.js';
import { api, seedWorld, stockOf, type World } from './fixtures.js';

/**
 * Who a shop may send stock to.
 *
 * A transfer reaches between two shops, and the person keying it in works at
 * one of them. Requiring an assignment at *both* ends meant a shop could only
 * send stock to itself — which the app surfaced as "Nowhere to transfer to",
 * on the screen whose entire purpose is sending stock elsewhere.
 *
 * So the destination is checked for tenancy and not for assignment. These
 * tests hold that line in both directions: a sister shop is reachable, another
 * organisation's shop is not.
 */
describe('transfer reach', () => {
  let app: Express;
  let world: World;
  let sister: { id: string; name: string };

  beforeEach(async () => {
    app = api();
    world = await seedWorld(app);

    sister = await prisma.store.create({
      data: {
        organizationId: world.organizationId,
        name: 'Chinkuli',
        code: 'CHINKULI',
        city: 'Chongwe',
      },
      select: { id: true, name: true },
    });

    // The manager works at one shop and one shop only — the case that was broken.
    await prisma.user.updateMany({
      where: { organizationId: world.organizationId, role: 'STORE_MANAGER' },
      data: { assignedStores: [world.storeId] },
    });
  });

  const asManager = (method: 'get' | 'post', path: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${world.tokens.manager}`);

  it('sends stock to a sister shop the sender is not assigned to', async () => {
    const product = world.products[0]!;
    await prisma.inventory.upsert({
      where: { storeId_productId: { storeId: world.storeId, productId: product.id } },
      create: { storeId: world.storeId, productId: product.id, quantity: 40 },
      update: { quantity: 40 },
    });

    const res = await asManager('post', '/api/transfers').send({
      from_store_id: world.storeId,
      to_store_id: sister.id,
      items: [{ product_id: product.id, quantity: 15 }],
    });

    expect(res.status).toBe(201);
    await expect(stockOf(world.storeId, product.id)).resolves.toBe(25);
    await expect(stockOf(sister.id, product.id)).resolves.toBe(15);
  });

  it('still refuses to send stock out of the organisation', async () => {
    const theirs = await seedWorld(app);
    const product = world.products[0]!;

    const res = await asManager('post', '/api/transfers').send({
      from_store_id: world.storeId,
      to_store_id: theirs.storeId,
      items: [{ product_id: product.id, quantity: 1 }],
    });

    expect(res.status).toBe(404);
    await expect(
      prisma.transfer.count({ where: { toStoreId: theirs.storeId } })
    ).resolves.toBe(0);
  });

  it('still refuses to send stock out of a shop the sender does not work at', async () => {
    const product = world.products[0]!;

    const res = await asManager('post', '/api/transfers').send({
      from_store_id: sister.id,
      to_store_id: world.storeId,
      items: [{ product_id: product.id, quantity: 1 }],
    });

    expect(res.status).toBe(403);
  });

  /* ------------------------------------------------------------- directory */

  it('lists every shop in the organisation, however narrow the assignment', async () => {
    const res = await asManager('get', '/api/stores/directory');

    expect(res.status).toBe(200);
    expect(res.body.map((s: { name: string }) => s.name).sort()).toEqual(['Chinkuli', 'Test Store']);
  });

  it('gives the directory nothing but a name and a code', async () => {
    const res = await asManager('get', '/api/stores/directory');

    // Knowing a sister shop exists is not the same as being entitled to its
    // address, phone number or sync state.
    expect(Object.keys(res.body[0]).sort()).toEqual(['code', 'id', 'name']);
  });

  it('keeps another organisation out of the directory', async () => {
    const theirs = await seedWorld(app);
    const res = await asManager('get', '/api/stores/directory');

    expect(res.body.map((s: { id: string }) => s.id)).not.toContain(theirs.storeId);
  });

  it('narrows /stores to the sender\'s own shops, as the store picker needs', async () => {
    const res = await asManager('get', '/api/stores');

    // The two lists are deliberately different; this is what makes the
    // directory necessary rather than redundant.
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(world.storeId);
  });
});
