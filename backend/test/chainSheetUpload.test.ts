import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { prisma } from '../src/prisma.js';
import { api, seedWorld, stockOf, type World } from './fixtures.js';
import { synthesiseSku } from '../src/lib/productSheet.js';

/**
 * The whole chain in one sheet.
 *
 * Every shop gets two columns — "<shop> Closing Stock" is what is left on its
 * shelf at the end of the day, "<shop> SP Per Stock" is what it charges — and
 * nothing in the request says which shop is uploading, because the file does.
 * Before this, loading thirteen shops meant thirteen uploads and thirteen
 * chances to pick the wrong shop from a dropdown.
 */
describe('the chain sheet', () => {
  let app: Express;
  let world: World;
  /** Two more shops, so the paired columns have somewhere to land. */
  let shops: { id: string; name: string }[];

  const asAdmin = (method: 'get' | 'post', path: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${world.tokens.admin}`);

  const HEADER = [
    'SKU',
    'COMPANY',
    'PRODUCT',
    'PACKSIZE',
    'CHEMICAL NAME',
    'EXPIRY DATE',
    'CATEGORY',
    'UNIT',
    'TAX',
    'COST',
    'SP',
    'Katende Closing Stock',
    'Katende SP Per Stock',
    'Chinkuli Closing Stock',
    'Chinkuli SP Per Stock',
  ].join(',');

  /** One line: a chemical, dated, counted and priced in both shops. */
  const ACTELLIC = [
    '',
    'Kepro',
    'Actellic Gold Dust',
    '250g',
    'Pirimiphos-methyl 1.6%',
    '15/07/2027',
    'Pesticides',
    'tin',
    'vat',
    '48',
    '72.50',
    '12',
    '75',
    '9',
    '78',
  ].join(',');

  const upload = (csv: string, extra: Record<string, unknown> = {}) =>
    asAdmin('post', '/api/inventory/bulk-upload').send({ csv, ...extra });

  beforeEach(async () => {
    app = api();
    world = await seedWorld(app);
    shops = [];
    for (const name of ['Katende', 'Chinkuli']) {
      shops.push(
        await prisma.store.create({
          data: {
            organizationId: world.organizationId,
            name,
            code: name.toUpperCase(),
            city: 'Chongwe',
          },
          select: { id: true, name: true },
        })
      );
    }
  });

  const shopByName = (name: string) => shops.find((s) => s.name === name) as { id: string };

  /* ------------------------------------------------------- one file, no shop */

  it('sets each shop from its own pair of columns, with no shop chosen', async () => {
    const res = await upload([HEADER, ACTELLIC].join('\n'));

    expect(res.status).toBe(201);
    expect(res.body.store_id).toBeNull();
    expect(res.body.shops_counted).toBe(2);
    expect(res.body.shop_stock_writes).toBe(2);
    expect(res.body.shop_prices_to_write).toBe(2);

    const sku = synthesiseSku('Kepro', 'Actellic Gold Dust', '250g');
    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, sku },
    });

    await expect(stockOf(shopByName('Katende').id, product.id)).resolves.toBe(12);
    await expect(stockOf(shopByName('Chinkuli').id, product.id)).resolves.toBe(9);

    const prices = await prisma.storePrice.findMany({
      where: { productId: product.id },
      include: { store: { select: { name: true } } },
    });
    expect(Object.fromEntries(prices.map((p) => [p.store.name, p.price.toNumber()]))).toEqual({
      Katende: 75,
      Chinkuli: 78,
    });
  });

  it('reads the chemical name and the expiry date onto the product', async () => {
    await upload([HEADER, ACTELLIC].join('\n'));

    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, brand: 'Kepro' },
    });
    expect(product.chemicalName).toBe('Pirimiphos-methyl 1.6%');
    expect(product.expiryDate?.toISOString().slice(0, 10)).toBe('2027-07-15');
  });

  it('refuses an expiry date it cannot read rather than guessing one', async () => {
    const res = await upload(
      [HEADER, ACTELLIC.replace('15/07/2027', 'sometime next year')].join('\n')
    );

    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain('Expiry date');
  });

  it('names each column and says which of the two it is', async () => {
    const res = await upload([HEADER, ACTELLIC].join('\n'), { validate_only: true });

    expect(res.body.shop_columns).toEqual([
      expect.objectContaining({ column: 'Katende Closing Stock', kind: 'stock', status: 'ok' }),
      expect.objectContaining({ column: 'Katende SP Per Stock', kind: 'price', status: 'ok' }),
      expect.objectContaining({ column: 'Chinkuli Closing Stock', kind: 'stock', status: 'ok' }),
      expect.objectContaining({ column: 'Chinkuli SP Per Stock', kind: 'price', status: 'ok' }),
    ]);
    expect(res.body.ignored_columns).toEqual([]);
  });

  /* -------------------------------------------------------------- the counts */

  it('counts a shelf that closed on nothing, rather than leaving stock it does not have', async () => {
    await upload([HEADER, ACTELLIC].join('\n'));
    const soldOut = ACTELLIC.replace(',12,75,', ',0,75,');

    await upload([HEADER, soldOut].join('\n'));

    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, brand: 'Kepro' },
    });
    await expect(stockOf(shopByName('Katende').id, product.id)).resolves.toBe(0);
    // The other shop's column was untouched by that edit and stays where it was.
    await expect(stockOf(shopByName('Chinkuli').id, product.id)).resolves.toBe(9);
  });

  it('leaves a shop alone where its closing stock cell is blank', async () => {
    await upload([HEADER, ACTELLIC].join('\n'));
    const katendeOnly = ACTELLIC.replace(',9,78', ',,78');

    await upload([HEADER, katendeOnly].join('\n'));

    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, brand: 'Kepro' },
    });
    await expect(stockOf(shopByName('Chinkuli').id, product.id)).resolves.toBe(9);
  });

  it('adds to each shelf in add mode, and records it per shop', async () => {
    await upload([HEADER, ACTELLIC].join('\n'));
    await upload([HEADER, ACTELLIC].join('\n'), { mode: 'add' });

    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, brand: 'Kepro' },
    });
    await expect(stockOf(shopByName('Katende').id, product.id)).resolves.toBe(24);
    await expect(stockOf(shopByName('Chinkuli').id, product.id)).resolves.toBe(18);

    const purchases = await prisma.stockMovement.findMany({
      where: { productId: product.id, type: 'purchase' },
      select: { storeId: true, quantity: true },
    });
    expect(purchases).toHaveLength(2);
  });

  it('totals the preview across the shops a row counts', async () => {
    const res = await upload([HEADER, ACTELLIC].join('\n'), { validate_only: true });

    expect(res.body.preview[0]).toMatchObject({
      shops: 2,
      quantity_before: 0,
      quantity_after: 21,
      change: 21,
    });
  });

  /* ------------------------------------------------------------ the round trip */

  it('exports the same columns the template hands out', async () => {
    await upload([HEADER, ACTELLIC].join('\n'));

    const [template, current] = await Promise.all([
      asAdmin('get', '/api/inventory/bulk-upload/template'),
      asAdmin('get', '/api/inventory/export'),
    ]);

    const headerOf = (text: string) =>
      (text.split(/\r?\n/)[0] as string).replace(/^﻿/, '');

    expect(headerOf(current.text)).toBe(headerOf(template.text));
    expect(headerOf(current.text)).toContain('Katende Closing Stock');
    expect(headerOf(current.text)).toContain('Katende SP Per Stock');
  });

  /**
   * The property the whole round trip rests on. The current list carries the
   * codes the catalogue already holds, so sending it straight back updates
   * those rows — where an export without them would build a second catalogue
   * beside the first under freshly synthesised codes.
   */
  it('re-imports its own export without duplicating anything or moving a shelf', async () => {
    await upload([HEADER, ACTELLIC].join('\n'));
    const before = await prisma.product.count({ where: { organizationId: world.organizationId } });

    const current = await asAdmin('get', '/api/inventory/export');
    const res = await upload(current.text);

    expect(res.status).toBe(201);
    expect(res.body.products_to_create).toBe(0);
    await expect(
      prisma.product.count({ where: { organizationId: world.organizationId } })
    ).resolves.toBe(before);

    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, brand: 'Kepro' },
    });
    await expect(stockOf(shopByName('Katende').id, product.id)).resolves.toBe(12);
    await expect(stockOf(shopByName('Chinkuli').id, product.id)).resolves.toBe(9);
    expect(product.chemicalName).toBe('Pirimiphos-methyl 1.6%');
    expect(product.expiryDate?.toISOString().slice(0, 10)).toBe('2027-07-15');
  });

  /* ------------------------------------------------------------- what it will not do */

  it('says so when a plain quantity column has no shop to belong to', async () => {
    const res = await upload(['SKU,PRODUCT,QTY', ',Loose Thing,5'].join('\n'), {
      validate_only: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.shop_stock_writes).toBe(0);
    expect(res.body.warnings.join(' ')).toContain('does not say which shop');
  });

  it('refuses two columns that give one shop the same thing twice', async () => {
    const res = await upload(
      ['PRODUCT,Katende Closing Stock,Katende Stock', 'Thing,5,7'].join('\n')
    );

    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('Katende');
  });

  it('will not count a shop the uploader is not assigned to', async () => {
    await prisma.user.updateMany({
      where: { organizationId: world.organizationId, role: 'STORE_MANAGER' },
      data: { assignedStores: [world.storeId] },
    });

    const res = await request(app)
      .post('/api/inventory/bulk-upload')
      .set('Authorization', `Bearer ${world.tokens.manager}`)
      .send({ csv: [HEADER, ACTELLIC].join('\n') });

    expect(res.status).toBe(201);
    expect(res.body.shop_stock_writes).toBe(0);
    // Loudly, not silently: the shop must not believe it counted the chain.
    expect(res.body.warnings.join(' ')).toContain('not assigned');

    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, brand: 'Kepro' },
    });
    await expect(stockOf(shopByName('Katende').id, product.id)).resolves.toBe(0);
  });
  /* --------------------------------------------------- the price a shop falls back to */

  /*
   * There is no chain-wide SP column any more. It sat two columns from
   * "<shop> SP Per Stock" looking like the same thing written twice, and the
   * obvious mistake — leaving it blank as redundant — created the product at
   * zero and handed it to every unpriced shop for nothing.
   */
  it('takes the product fallback from the first shop priced on the row', async () => {
    const header = 'PRODUCT,Katende SP Per Stock,Chinkuli SP Per Stock';
    const res = await upload([header, 'Loose Thing,80,90'].join('\n'));

    expect(res.status).toBe(201);
    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, name: 'Loose Thing' },
    });
    // Katende is the leftmost priced column, so its price is what a shop with
    // no price of its own charges. Never zero, which is the point.
    expect(product.sellingPrice.toNumber()).toBe(80);
    expect(res.body.warnings.join(' ')).toContain('fallback price');
  });

  it('skips a blank column when working the fallback out', async () => {
    const header = 'PRODUCT,Katende SP Per Stock,Chinkuli SP Per Stock';
    const res = await upload([header, 'Loose Thing,,90'].join('\n'));

    expect(res.status).toBe(201);
    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, name: 'Loose Thing' },
    });
    expect(product.sellingPrice.toNumber()).toBe(90);
  });

  /** The buyer's own price master carries SP, and it still wins where it does. */
  it('lets a file that states a selling price keep it', async () => {
    const res = await upload([HEADER, ACTELLIC].join('\n'));

    expect(res.status).toBe(201);
    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, brand: 'Kepro' },
    });
    // The row says SP 72.50 and prices Katende at 75; the stated figure stands.
    expect(product.sellingPrice.toNumber()).toBe(72.5);
  });

  it('says plainly when a new product is priced in no shop at all', async () => {
    const res = await upload(['PRODUCT,Katende Closing Stock', 'Unpriced Thing,4'].join('\n'), {
      validate_only: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.warnings.join(' ')).toContain('no price in any shop');
  });

  /* ---------------------------------------------------------- transport cost */

  /*
   * Transport used to be one of the price master's working columns, read and
   * thrown away. Now it is kept, because a figure that vanishes from the next
   * download is a figure somebody has to type again.
   */
  it('adds transport onto the buying price to get what the item lands at', async () => {
    const res = await upload(
      ['PRODUCT,COST,TRANSPORT COST,Katende SP Per Stock', 'Landed Thing,180,20,300'].join('\n')
    );

    expect(res.status).toBe(201);
    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, name: 'Landed Thing' },
    });
    // The margins are measured against the landed figure, so that is what is
    // stored; the transport is kept beside it rather than inside it only.
    expect(product.costPrice.toNumber()).toBe(200);
    expect(product.transportCost.toNumber()).toBe(20);
  });

  it("keeps the buyer's own Landing column as final rather than redoing his sum", async () => {
    // His sheet works Landing out itself, and COST + Transport there is 204.6
    // against a Landing of 205 — his rounding, and not ours to correct.
    const res = await upload(
      [
        'COMPANY,PRODUCT,PACKSIZE,COST,Transport & Others,Landing,SP',
        'STARKE AYRES,carrots,100g,201.6,3,205,236',
      ].join('\n')
    );

    expect(res.status).toBe(201);
    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, brand: 'STARKE AYRES' },
    });
    expect(product.costPrice.toNumber()).toBe(205);
    expect(product.transportCost.toNumber()).toBe(3);
  });

  it('leaves the landed cost unstated where only transport was filled in', async () => {
    const res = await upload(
      ['PRODUCT,TRANSPORT COST,Katende SP Per Stock', 'Half Filled,15,300'].join('\n')
    );

    expect(res.status).toBe(201);
    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, name: 'Half Filled' },
    });
    // Transport alone is not what the thing costs.
    expect(product.costPrice.toNumber()).toBe(0);
    expect(product.transportCost.toNumber()).toBe(15);
  });

  it('splits the two cost columns back out on the way down, and re-imports level', async () => {
    await upload(
      ['PRODUCT,COST,TRANSPORT COST,Katende SP Per Stock', 'Landed Thing,180,20,300'].join('\n')
    );

    const current = await asAdmin('get', '/api/inventory/export');
    const lines = current.text.replace(/^﻿/, '').split(/\r?\n/);
    const columns = (lines[0] as string).split(',');
    // The download carries the whole catalogue, so the row has to be found
    // by name rather than assumed to be the first one under the header.
    const row = (lines.find(
      (l) => l.split(',')[columns.indexOf('PRODUCT')] === 'Landed Thing'
    ) as string).split(',');

    // Written back as the base and the transport, so the two still add up to
    // the landed figure and a straight re-upload moves nothing.
    expect(row[columns.indexOf('COST')]).toBe('180.00');
    expect(row[columns.indexOf('TRANSPORT COST')]).toBe('20.00');

    await upload(current.text);
    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, name: 'Landed Thing' },
    });
    expect(product.costPrice.toNumber()).toBe(200);
    expect(product.transportCost.toNumber()).toBe(20);
  });

});
