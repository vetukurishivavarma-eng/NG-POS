import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { prisma } from '../src/prisma.js';
import { api, seedWorld, stockOf, type World } from './fixtures.js';
import { synthesiseSku } from '../src/lib/productSheet.js';
import { buildXlsx } from './helpers/xlsx.js';

/**
 * The buyer's price master, which is the file the shop actually keeps.
 *
 * It carries no product codes at all — identity is COMPANY + PRODUCT +
 * PACKSIZE — a landed-cost build-up whose working columns are not ours to
 * import, and one price column per shop in the chain.
 */
describe('price master upload', () => {
  let app: Express;
  let world: World;
  /** The other five shops, so the branch columns have somewhere to land. */
  let shops: { id: string; name: string }[];

  const asAdmin = (method: 'get' | 'post', path: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${world.tokens.admin}`);

  const HEADER =
    'COMPANY,PRODUCT,PACKSIZE,MATCH STATUS,MATCHED AP NAME,MATCH SCORE,COST (USD),COST,Transport & Others,Landing,MARK UP,GP,SP,QTY,Katende,Chinkuli';

  const CARROTS = 'STARKE AYRES,carrots,100g,Review - check pack size,Carrot nantes (100g),70,,201.6,3,205,0.15,31,236,15,235,245';

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

  const upload = (csv: string, extra: Record<string, unknown> = {}) =>
    asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      csv,
      ...extra,
    });

  /* ------------------------------------------------------------- the columns */

  it('creates a product from company, product and pack size alone', async () => {
    const res = await upload([HEADER, CARROTS].join('\n'));
    expect(res.status).toBe(201);
    expect(res.body.products_to_create).toBe(1);

    const sku = synthesiseSku('STARKE AYRES', 'carrots', '100g');
    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, sku },
    });

    // The pack size is joined onto the name because it is what tells two
    // otherwise identical rows apart at the till.
    expect(product.name).toBe('Carrots 100g');
    expect(product.brand).toBe('STARKE AYRES');
    // Landing (205), not COST (201.6): the margin is measured against what the
    // item costs us delivered.
    expect(product.costPrice.toNumber()).toBe(205);
    expect(product.sellingPrice.toNumber()).toBe(236);
    await expect(stockOf(world.storeId, product.id)).resolves.toBe(15);
  });

  it('does not mistake COST (USD) for COST', async () => {
    // Both headings strip to `cost`. Read in the wrong order, the blank USD
    // column silently wipes the kwacha cost off every row in the file.
    const res = await upload([HEADER, CARROTS].join('\n'), { validate_only: true });
    expect(res.status).toBe(200);

    const applied = await upload([HEADER, CARROTS].join('\n'));
    expect(applied.status).toBe(201);

    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, brand: 'STARKE AYRES' },
    });
    expect(product.costPrice.toNumber()).toBe(205);
  });

  it('falls back to COST where the sheet worked out no landed cost', async () => {
    const row = 'OSHO,Kolopa,1ltr,Exact,,100,,180,,,,,240,4,,';
    const res = await upload([HEADER, row].join('\n'));
    expect(res.status).toBe(201);

    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, brand: 'OSHO' },
    });
    expect(product.costPrice.toNumber()).toBe(180);
  });

  it('reports the working columns as read-and-ignored, not as unknown', async () => {
    const res = await upload([HEADER, CARROTS].join('\n'), { validate_only: true });
    expect(res.body.ignored_columns).toEqual([]);
  });

  it('names a column that matches neither a field nor a shop', async () => {
    const res = await upload(
      [`${HEADER},Mumbwa Depot`, `${CARROTS},199`].join('\n'),
      { validate_only: true }
    );
    expect(res.body.ignored_columns).toEqual(['Mumbwa Depot']);
    expect(res.body.warnings.join(' ')).toContain('Mumbwa Depot');
  });

  /* --------------------------------------------------------- the shop prices */

  it('writes one price per shop from the branch columns', async () => {
    const res = await upload([HEADER, CARROTS].join('\n'));
    expect(res.status).toBe(201);
    expect(res.body.shop_prices_to_write).toBe(2);

    const prices = await prisma.storePrice.findMany({
      where: { storeId: { in: shops.map((s) => s.id) } },
      include: { store: { select: { name: true } } },
    });

    expect(
      Object.fromEntries(prices.map((p) => [p.store.name, p.price.toNumber()]))
    ).toEqual({ Katende: 235, Chinkuli: 245 });
  });

  it('reports each shop column it found and matched', async () => {
    const res = await upload([HEADER, CARROTS].join('\n'), { validate_only: true });
    expect(res.body.shop_columns).toEqual([
      expect.objectContaining({ column: 'Katende', status: 'ok', values: 1 }),
      expect.objectContaining({ column: 'Chinkuli', status: 'ok', values: 1 }),
    ]);
  });

  it('leaves the shop prices alone when they are switched off', async () => {
    const res = await upload([HEADER, CARROTS].join('\n'), { apply_shop_prices: false });
    expect(res.status).toBe(201);
    await expect(prisma.storePrice.count({ where: { storeId: { in: shops.map((s) => s.id) } } }))
      .resolves.toBe(0);
    expect(res.body.warnings.join(' ')).toContain('switched off');
  });

  it('replaces a shop price a re-upload changed', async () => {
    await upload([HEADER, CARROTS].join('\n'));
    const cheaper = CARROTS.replace(/,235,245$/, ',215,225');
    const res = await upload([HEADER, cheaper].join('\n'));
    expect(res.status).toBe(201);

    const prices = await prisma.storePrice.findMany({
      where: { storeId: { in: shops.map((s) => s.id) } },
      include: { store: { select: { name: true } } },
    });
    expect(
      Object.fromEntries(prices.map((p) => [p.store.name, p.price.toNumber()]))
    ).toEqual({ Katende: 215, Chinkuli: 225 });
  });

  it('drops an override the file now leaves blank for a row it does price', async () => {
    await upload([HEADER, CARROTS].join('\n'));
    const katendeOnly = CARROTS.replace(/,235,245$/, ',235,');
    await upload([HEADER, katendeOnly].join('\n'));

    const prices = await prisma.storePrice.findMany({
      where: { storeId: { in: shops.map((s) => s.id) } },
      include: { store: { select: { name: true } } },
    });
    // Katende kept, Chinkuli removed so the product's default price applies.
    expect(prices.map((p) => p.store.name)).toEqual(['Katende']);
  });

  it('leaves every override alone for a row that prices no shop at all', async () => {
    await upload([HEADER, CARROTS].join('\n'));
    const noShopPrices = CARROTS.replace(/,235,245$/, ',,');
    await upload([HEADER, noShopPrices].join('\n'));

    // The row said nothing about shop prices, so it changed none of them.
    await expect(
      prisma.storePrice.count({ where: { storeId: { in: shops.map((s) => s.id) } } })
    ).resolves.toBe(2);
  });

  it('will not price a shop the uploader is not assigned to', async () => {
    // The manager is scoped to the main store only.
    await prisma.user.updateMany({
      where: { organizationId: world.organizationId, role: 'STORE_MANAGER' },
      data: { assignedStores: [world.storeId] },
    });

    const res = await request(app)
      .post('/api/inventory/bulk-upload')
      .set('Authorization', `Bearer ${world.tokens.manager}`)
      .send({ store_id: world.storeId, csv: [HEADER, CARROTS].join('\n') });

    expect(res.status).toBe(201);
    expect(res.body.shop_columns).toEqual([
      expect.objectContaining({ column: 'Katende', status: 'no_access' }),
      expect.objectContaining({ column: 'Chinkuli', status: 'no_access' }),
    ]);
    // Loudly, not silently: the shop must not believe it repriced the chain.
    expect(res.body.warnings.join(' ')).toContain('not assigned');
    await expect(
      prisma.storePrice.count({ where: { storeId: { in: shops.map((s) => s.id) } } })
    ).resolves.toBe(0);
  });

  /* --------------------------------------------------------- repeated rows */

  it('folds a repeated row in rather than refusing the file', async () => {
    // The real file carries `okra` and `Okra`, and `Repacked Urea` beside
    // `Repacked  Urea`, both with everything else blank.
    const csv = [
      HEADER,
      'HYGROTECH,okra,100g,No price data found,,,,,,,,,,,,',
      'HYGROTECH,Okra,100g,No price data found,,,,,,,,,,,,',
    ].join('\n');

    const res = await upload(csv);
    expect(res.status).toBe(201);
    expect(res.body.total_rows).toBe(1);
    expect(res.body.warnings.join(' ')).toContain('line 3');

    await expect(
      prisma.product.count({ where: { organizationId: world.organizationId, brand: 'HYGROTECH' } })
    ).resolves.toBe(1);
  });

  it('takes the filled-in half of a repeat that only one row completed', async () => {
    const csv = [
      HEADER,
      'OSHO,Kolopa,1ltr,No price data found,,,,,,,,,,,,',
      'OSHO,Kolopa,1ltr,Exact,,100,,180,5,185,0.3,55,240,4,,',
    ].join('\n');

    const res = await upload(csv);
    expect(res.status).toBe(201);

    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, brand: 'OSHO' },
    });
    expect(product.costPrice.toNumber()).toBe(185);
    expect(product.sellingPrice.toNumber()).toBe(240);
  });

  it('still refuses a repeat that contradicts the first row', async () => {
    const csv = [
      HEADER,
      'OSHO,Kolopa,1ltr,Exact,,100,,180,5,185,0.3,55,240,4,,',
      'OSHO,Kolopa,1ltr,Exact,,100,,180,5,185,0.3,55,999,4,,',
    ].join('\n');

    const res = await upload(csv);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toContain('selling price');
    expect(res.body.errors[0].message).toContain('line 2');
  });

  /* ---------------------------------------------------------------- re-upload */

  it('updates the same products on a second upload instead of duplicating them', async () => {
    await upload([HEADER, CARROTS].join('\n'));
    const dearer = CARROTS.replace(',236,15,', ',249,20,');

    const res = await upload([HEADER, dearer].join('\n'));
    expect(res.status).toBe(201);
    expect(res.body.products_to_create).toBe(0);
    expect(res.body.products_to_update).toBe(1);

    await expect(
      prisma.product.count({ where: { organizationId: world.organizationId } })
    ).resolves.toBe(world.products.length + 1);
  });

  /* --------------------------------------------------------------- as .xlsx */

  it('reads the workbook itself, with no save-as-CSV step', async () => {
    const xlsx = buildXlsx([HEADER.split(','), CARROTS.split(',')]);

    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      xlsx_base64: xlsx.toString('base64'),
    });

    expect(res.status).toBe(201);
    expect(res.body.total_rows).toBe(1);

    const product = await prisma.product.findFirstOrThrow({
      where: { organizationId: world.organizationId, brand: 'STARKE AYRES' },
    });
    expect(product.name).toBe('Carrots 100g');
    expect(product.costPrice.toNumber()).toBe(205);
  });

  it('says so plainly when the file is not a workbook at all', async () => {
    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      xlsx_base64: Buffer.from('sku,name\nA-1,Feed\n').toString('base64'),
    });

    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('.xlsx');
  });

  it('will not take a file two ways at once', async () => {
    const res = await asAdmin('post', '/api/inventory/bulk-upload').send({
      store_id: world.storeId,
      csv: [HEADER, CARROTS].join('\n'),
      xlsx_base64: buildXlsx([HEADER.split(',')]).toString('base64'),
    });

    // 422 is this API's code for a body that does not fit its schema.
    expect(res.status).toBe(422);
  });
});
