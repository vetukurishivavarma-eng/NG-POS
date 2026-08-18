import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { prisma } from '../src/prisma.js';
import { api, seedWorld, stockOf, type World } from './fixtures.js';

/**
 * Whose sheet each account gets, and what an empty stock column means.
 *
 * Two separate questions that arrive together in practice: an owner runs the
 * chain from one file and a shop corrects its own, and either of them can hand
 * back a sheet that lists a product and counts it nowhere.
 */
describe('one shop’s sheet', () => {
  let app: Express;
  let world: World;
  let other: { id: string; name: string };

  const as = (token: string, method: 'get' | 'post', path: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${token}`);

  beforeEach(async () => {
    app = api();
    world = await seedWorld(app);

    other = await prisma.store.create({
      data: {
        organizationId: world.organizationId,
        name: 'Katende',
        code: 'KATENDE',
        city: 'Chongwe',
      },
      select: { id: true, name: true },
    });

    // The manager runs one shop. The admin runs the chain.
    await prisma.user.updateMany({
      where: { organizationId: world.organizationId, role: 'STORE_MANAGER' },
      data: { assignedStores: [world.storeId] },
    });
  });

  const headerOf = (text: string) =>
    (text.replace(/^﻿/, '').split(/\r?\n/)[0] as string).split(',');

  /* ------------------------------------------------------------ the columns */

  it('columns an owner by every shop in the chain', async () => {
    const res = await as(world.tokens.admin, 'get', '/api/inventory/export');
    const columns = headerOf(res.text);

    expect(columns).toContain('Test Store Closing Stock');
    expect(columns).toContain('Katende Closing Stock');
    expect(columns).toContain('Katende SP Per Stock');
  });

  it('columns a shop by its own shop and no other', async () => {
    const res = await as(world.tokens.manager, 'get', '/api/inventory/export');
    const columns = headerOf(res.text);

    expect(columns).toContain('Test Store Closing Stock');
    expect(columns).toContain('Test Store SP Per Stock');
    // Not merely refused on the way back in — never handed out. A manager
    // correcting one column should not be scrolling past twenty-four.
    expect(columns.join(',')).not.toContain('Katende');
  });

  it('gives a shop a template columned the same way its list is', async () => {
    const [template, current] = await Promise.all([
      as(world.tokens.manager, 'get', '/api/inventory/bulk-upload/template'),
      as(world.tokens.manager, 'get', '/api/inventory/export'),
    ]);

    // The property the two downloads rest on, held per account rather than
    // globally: pasting rows from one into the other must land square.
    expect(headerOf(current.text)).toEqual(headerOf(template.text));
  });

  it('names a single shop’s file after that shop', async () => {
    const res = await as(world.tokens.manager, 'get', '/api/inventory/export');
    expect(res.headers['content-disposition']).toContain('ng-pos-stock-list-test-store-');

    const chain = await as(world.tokens.admin, 'get', '/api/inventory/export');
    expect(chain.headers['content-disposition']).not.toContain('test-store');
  });

  /* --------------------------------------------------------------- the rows */

  it('lists a shop only the products it carries', async () => {
    // A product only the other shop stocks. The fixture stocks every product in
    // the manager's shop, so this is the one line that separates the two files.
    const theirs = await prisma.product.create({
      data: {
        organizationId: world.organizationId,
        name: 'Katende Only Item',
        sku: 'KAT-ONLY-1',
        sellingPrice: 50,
      },
      select: { id: true },
    });
    await prisma.inventory.create({
      data: { storeId: other.id, productId: theirs.id, quantity: 4 },
    });

    const mine = await as(world.tokens.manager, 'get', '/api/inventory/export');
    expect(mine.text).not.toContain('Katende Only Item');

    const chain = await as(world.tokens.admin, 'get', '/api/inventory/export');
    expect(chain.text).toContain('Katende Only Item');
  });

  it('falls back to the catalogue for a shop that carries nothing yet', async () => {
    // Otherwise a new shop downloads an empty file and has no list to load its
    // first stock take from.
    await prisma.inventory.deleteMany({ where: { storeId: world.storeId } });
    await prisma.storePrice.deleteMany({ where: { storeId: world.storeId } });

    const res = await as(world.tokens.manager, 'get', '/api/inventory/export');
    expect(res.headers['x-product-count']).toBe(String(world.products.length));
  });
});

/*
 * A row the sheet lists and counts nowhere. Left alone unless the operator says
 * otherwise, because the two readings — "says nothing" and "sold out" — cannot
 * be told apart from the file, and one of them empties shelves.
 */
describe('products with no stock in the file', () => {
  let app: Express;
  let world: World;

  const asAdmin = (method: 'get' | 'post', path: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${world.tokens.admin}`);

  const HEADER = 'SKU,PRODUCT,Test Store Closing Stock,Test Store SP Per Stock';

  const upload = (csv: string, extra: Record<string, unknown> = {}) =>
    asAdmin('post', '/api/inventory/bulk-upload').send({ csv, ...extra });

  beforeEach(async () => {
    app = api();
    world = await seedWorld(app);
  });

  /** The fixture's first product, stocked at 100, with its stock cell empty. */
  const unstockedRow = () => `A-1,${world.products[0]?.name},,95`;

  it('counts and names them on the dry run, so the app can ask', async () => {
    const res = await upload([HEADER, unstockedRow()].join('\n'), { validate_only: true });

    expect(res.status).toBe(200);
    expect(res.body.rows_without_stock).toBe(1);
    expect(res.body.products_without_stock).toEqual([world.products[0]?.name]);
  });

  it('leaves their stock alone when the operator has not agreed', async () => {
    const res = await upload([HEADER, unstockedRow()].join('\n'));

    expect(res.status).toBe(201);
    expect(res.body.zeroed_missing_stock).toBe(false);
    await expect(stockOf(world.storeId, world.products[0]?.id as string)).resolves.toBe(100);
  });

  it('marks them out of stock once the operator has', async () => {
    const res = await upload([HEADER, unstockedRow()].join('\n'), { zero_missing_stock: true });

    expect(res.status).toBe(201);
    expect(res.body.detail).toContain('out of stock');
    // Zero is what the till reads as "Out of stock".
    await expect(stockOf(world.storeId, world.products[0]?.id as string)).resolves.toBe(0);
  });

  it('writes an absolute zero even in add mode, where an increment would do nothing', async () => {
    const res = await upload([HEADER, unstockedRow()].join('\n'), {
      mode: 'add',
      zero_missing_stock: true,
    });

    expect(res.status).toBe(201);
    await expect(stockOf(world.storeId, world.products[0]?.id as string)).resolves.toBe(0);
  });

  it('leaves a row that counts some shops alone, agreed or not', async () => {
    const katende = await prisma.store.create({
      data: { organizationId: world.organizationId, name: 'Katende', code: 'KAT' },
      select: { id: true },
    });

    const res = await upload(
      [
        'SKU,PRODUCT,Test Store Closing Stock,Katende Closing Stock',
        `A-1,${world.products[0]?.name},7,`,
      ].join('\n'),
      { zero_missing_stock: true }
    );

    expect(res.status).toBe(201);
    // The row is counted somewhere, so it is not one of the rows in question and
    // the blank cell keeps meaning "this file says nothing about that shelf".
    expect(res.body.rows_without_stock).toBe(0);
    await expect(stockOf(world.storeId, world.products[0]?.id as string)).resolves.toBe(7);
    await expect(stockOf(katende.id, world.products[0]?.id as string)).resolves.toBe(0);
  });

  /**
   * The disaster this guards against: a sheet with prices and no stock column
   * at all, read as "every shop is empty". Agreed to or not, a file that never
   * mentions stock cannot be a stock take.
   */
  it('will not empty the chain from a file that has no stock column at all', async () => {
    const res = await upload(
      ['SKU,PRODUCT,SP', `A-1,${world.products[0]?.name},99`].join('\n'),
      { zero_missing_stock: true }
    );

    expect(res.status).toBe(201);
    expect(res.body.rows_without_stock).toBe(0);
    await expect(stockOf(world.storeId, world.products[0]?.id as string)).resolves.toBe(100);
  });
});
