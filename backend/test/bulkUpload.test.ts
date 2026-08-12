import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { prisma } from '../src/prisma.js';
import { api, seedWorld, stockOf, type World } from './fixtures.js';
import { normaliseHeader, parseCsv, parseCsvObjects } from '../src/lib/csv.js';

/**
 * The reader, on its own. Everything here is a real shape a spreadsheet arrives
 * in — a BOM from Excel, CRLF endings, a quoted field with a comma in it.
 */
describe('csv reader', () => {
  it('strips the byte order mark Excel writes', () => {
    const rows = parseCsv('﻿sku,name\nA-1,Feed\n');
    expect(rows[0]).toEqual(['sku', 'name']);
  });

  it('keeps commas and quotes that are inside a quoted field', () => {
    const rows = parseCsv('sku,name\nA-1,"Dairy Meal, 50kg"\nA-2,"He said ""hi"""\n');
    expect(rows[1]).toEqual(['A-1', 'Dairy Meal, 50kg']);
    expect(rows[2]).toEqual(['A-2', 'He said "hi"']);
  });

  it('handles CRLF and drops blank lines', () => {
    const rows = parseCsv('sku\r\nA-1\r\n\r\nA-2\r\n');
    expect(rows).toHaveLength(3);
  });

  it('folds headings to a canonical key', () => {
    expect(normaliseHeader('  Selling Price (K) ')).toBe('selling_price');
    expect(normaliseHeader('Re-order Level')).toBe('re_order_level');
  });

  it('applies aliases so a shop can use its own headings', () => {
    const { rows } = parseCsvObjects('Item Code,Qty\nA-1,40\n', {
      item_code: 'sku',
      qty: 'quantity',
    });
    expect(rows[0]).toEqual({ sku: 'A-1', quantity: '40' });
  });
});

describe('stock bulk upload', () => {
  let app: Express;
  let world: World;

  const asAdmin = (method: 'get' | 'post', path: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${world.tokens.admin}`);

  beforeEach(async () => {
    app = api();
    world = await seedWorld(app);
  });

  const header = 'sku,name,brand,category,unit,cost_price,selling_price,tax_type,quantity,reorder_level';

  it('creates products and sets their opening stock', async () => {
    const csv = [
      header,
      'NEW-1,Dairy Meal 50kg,Novatek,Feed,bag,320,395,exempt,40,10',
      'NEW-2,Layers Mash 50kg,Novatek,Feed,bag,305.50,375,vat,25,8',
    ].join('\n');

    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      csv,
    });

    expect(res.status).toBe(201);
    expect(res.body.applied).toBe(true);
    expect(res.body.products_to_create).toBe(2);

    const created = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, sku: 'NEW-1' },
    });
    expect(created.name).toBe('Dairy Meal 50kg');
    expect(created.sellingPrice.toNumber()).toBe(395);
    await expect(stockOf(world.storeId, created.id)).resolves.toBe(40);
  });

  it('treats an existing SKU as an update, not a second product', async () => {
    const csv = [header, 'A-1,Actellic Gold Dust,,,,50,120,exempt,7,3'].join('\n');

    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      csv,
    });

    expect(res.status).toBe(201);
    expect(res.body.products_to_create).toBe(0);
    expect(res.body.products_to_update).toBe(1);
    await expect(
      prisma.product.count({ where: { organizationId: world.organizationId, sku: 'A-1' } })
    ).resolves.toBe(1);
  });

  it('reads a counted total as a correction to the level, not an addition', async () => {
    // The fixture stocks 100 of each product.
    const csv = [header, 'A-1,Actellic Gold Dust,,,,,,,7,'].join('\n');

    await asAdmin('post', '/api/inventory/bulk-upload').send({ store_id: world.storeId, csv });

    await expect(stockOf(world.storeId, world.products[0]!.id)).resolves.toBe(7);
    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { storeId: world.storeId, type: 'adjustment' },
    });
    expect(movement.quantity.toNumber()).toBe(-93);
  });

  it('adds to the level in add mode, and calls it a purchase', async () => {
    const csv = [header, 'A-1,Actellic Gold Dust,,,,,,,7,'].join('\n');

    await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      csv,
      mode: 'add',
    });

    await expect(stockOf(world.storeId, world.products[0]!.id)).resolves.toBe(107);
    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { storeId: world.storeId, type: 'purchase' },
    });
    expect(movement.quantity.toNumber()).toBe(7);
  });

  it('leaves the stock level alone when the quantity column is blank', async () => {
    const csv = [header, 'A-1,Actellic Gold Dust,,,,60,130,,,'].join('\n');

    await asAdmin('post', '/api/inventory/bulk-upload').send({ store_id: world.storeId, csv });

    await expect(stockOf(world.storeId, world.products[0]!.id)).resolves.toBe(100);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: world.products[0]!.id } });
    expect(product.sellingPrice.toNumber()).toBe(130);
  });

  it('does not blank prices a stock-only file left empty', async () => {
    const csv = ['sku,quantity', 'A-1,12'].join('\n');

    await asAdmin('post', '/api/inventory/bulk-upload').send({ store_id: world.storeId, csv });

    const product = await prisma.product.findUniqueOrThrow({ where: { id: world.products[0]!.id } });
    expect(product.sellingPrice.toNumber()).toBe(85);
    expect(product.name).toBe('Actellic Gold Dust');
  });

  it('reads money the way people type it', async () => {
    const csv = [header, 'NEW-3,Compound D,,,bag,"1,250.00","K1 480",exempt,5,2'].join('\n');

    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      csv,
    });

    expect(res.status).toBe(201);
    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, sku: 'NEW-3' },
    });
    expect(product.costPrice.toNumber()).toBe(1250);
    expect(product.sellingPrice.toNumber()).toBe(1480);
  });

  it('imports nothing at all when one line is unreadable', async () => {
    const csv = [
      header,
      'NEW-4,Good Row,,,,10,20,exempt,5,1',
      'NEW-5,Bad Row,,,,10,twenty,exempt,5,1',
    ].join('\n');

    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      csv,
    });

    expect(res.status).toBe(422);
    expect(res.body.applied).toBe(false);
    // The line number is the one the operator sees in the spreadsheet.
    expect(res.body.errors[0].row).toBe(3);
    await expect(
      prisma.product.count({ where: { organizationId: world.organizationId, sku: 'NEW-4' } })
    ).resolves.toBe(0);
  });

  it('rejects a new product with no name', async () => {
    const csv = [header, 'NEW-6,,,,,,10,exempt,5,1'].join('\n');

    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      csv,
    });

    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain('name');
  });

  it('rejects the same SKU twice in one file', async () => {
    const csv = [
      header,
      'NEW-7,One,,,,1,2,exempt,5,1',
      'NEW-7,Two,,,,1,2,exempt,6,1',
    ].join('\n');

    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      csv,
    });

    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain('line 2');
  });

  it('rejects a row with no SKU', async () => {
    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      csv: [header, ',Nameless,,,,1,2,exempt,5,1'].join('\n'),
    });

    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain('SKU');
  });

  it('changes nothing on a dry run, but says what would happen', async () => {
    const csv = [header, 'A-1,Actellic Gold Dust,,,,,,,7,', 'NEW-8,Brand New,,,,1,2,exempt,3,1'].join('\n');

    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      csv,
      validate_only: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.products_to_create).toBe(1);
    expect(res.body.preview[0]).toMatchObject({ quantity_before: 100, quantity_after: 7 });

    await expect(stockOf(world.storeId, world.products[0]!.id)).resolves.toBe(100);
    await expect(
      prisma.product.count({ where: { organizationId: world.organizationId, sku: 'NEW-8' } })
    ).resolves.toBe(0);
  });

  it('accepts the headings a shop already uses', async () => {
    const csv = ['Item Code,Product Name,Buying Price,Retail Price,Qty', 'NEW-9,Knapsack,410,540,6'].join(
      '\n'
    );

    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      csv,
    });

    expect(res.status).toBe(201);
    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, sku: 'NEW-9' },
    });
    expect(product.costPrice.toNumber()).toBe(410);
    await expect(stockOf(world.storeId, product.id)).resolves.toBe(6);
  });

  it('refuses a file that neither codes nor names its products', async () => {
    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      csv: 'quantity,cost_price\n5,10\n',
    });

    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('sku');
  });

  it("will not load into another organisation's store", async () => {
    const theirs = await seedWorld(app);

    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: theirs.storeId,
      csv: [header, 'NEW-10,Thing,,,,1,2,exempt,5,1'].join('\n'),
    });

    expect(res.status).toBe(404);
  });

  /**
   * Deliberately open to shop staff, where it used to be manager-and-above.
   *
   * What the shops upload is the buyer's price master, reissued every time
   * prices move, and at an agrovet this size the person on the till is the
   * person who loads it. The blast radius is real — an import can rewrite the
   * catalogue and reset stock levels — so it is mitigated by the import itself
   * rather than by the role: the dry run reports every row before anything is
   * written, and one unreadable line rejects the whole file.
   */
  it('is open to shop staff, not just managers', async () => {
    const res = await request(app)
      .post('/api/inventory/bulk-upload')
      .set('Authorization', `Bearer ${world.tokens.cashier}`)
      .send({ store_id: world.storeId, csv: [header, 'NEW-11,Thing,,,,1,2,exempt,5,1'].join('\n') });

    expect(res.status).toBe(201);
  });

  it("still will not import into another organisation's store, whoever asks", async () => {
    const theirs = await seedWorld(app);

    const res = await request(app)
      .post('/api/inventory/bulk-upload')
      .set('Authorization', `Bearer ${world.tokens.cashier}`)
      .send({ store_id: theirs.storeId, csv: [header, 'NEW-12,Thing,,,,1,2,exempt,5,1'].join('\n') });

    expect(res.status).toBe(404);
  });

  // The template is the instructions. If it cannot be imported as it stands,
  // everyone who follows it gets an error on their first attempt.
  it.each([
    ['price-master', 3],
    ['sku', 5],
  ])('serves a %s template whose own columns import cleanly', async (format, rows) => {
    const template = await asAdmin('get', `/api/inventory/bulk-upload/template?format=${format}`);
    expect(template.status).toBe(200);

    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      csv: template.text,
      validate_only: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.total_rows).toBe(rows);
  });
});
