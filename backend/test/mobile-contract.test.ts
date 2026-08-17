import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { api, clientRef, seedWorld, type World } from './fixtures.js';

/**
 * The mobile app and this server are separate codebases with no shared types.
 * `mobile/src/api/endpoints.ts` declares a URL, a set of params and a response
 * type for every call; nothing checks that any of it is true. A renamed field
 * or a dropped key typechecks perfectly on both sides and fails on a till.
 *
 * So: one case per function in `endpoints.ts`, calling the exact path and
 * params the app calls, asserting the keys `mobile/src/api/types.ts` promises.
 * When a route changes shape, this is what fails instead of a cashier.
 */

/** Asserts every declared key is present — extra server keys are fine. */
function expectShape(value: unknown, keys: string[], label: string) {
  expect(value, `${label} should be an object`).toBeTypeOf('object');
  expect(value, `${label} should not be null`).not.toBeNull();
  const missing = keys.filter((k) => !(k in (value as Record<string, unknown>)));
  expect(missing, `${label} is missing ${missing.join(', ')}`).toEqual([]);
}

describe('mobile API contract', () => {
  let app: Express;
  let world: World;

  beforeEach(async () => {
    app = api();
    world = await seedWorld(app);
  });

  const get = (path: string, token: string, query: Record<string, unknown> = {}) =>
    request(app).get(path).set('Authorization', `Bearer ${token}`).query(query);

  const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
    request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);

  const put = (path: string, token: string, body: Record<string, unknown> = {}) =>
    request(app).put(path).set('Authorization', `Bearer ${token}`).send(body);

  const del = (path: string, token: string) =>
    request(app).delete(path).set('Authorization', `Bearer ${token}`);

  /* ------------------------------------------------------------------ auth */

  it('auth.login returns the token and user the app stores', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: world.emails.admin, password: 'TestPassw0rd!' });

    expect(res.status).toBe(200);
    expectShape(res.body, ['access_token', 'user'], 'LoginResponse');
    expectShape(
      res.body.user,
      ['id', 'organization_id', 'email', 'full_name', 'role', 'assigned_stores', 'is_active'],
      'User'
    );
  });

  /* --------------------------------------------------------- organizations */

  it('organizations.current exposes vat_rate and currency_symbol', async () => {
    const res = await get('/api/organizations/current', world.tokens.admin);

    expect(res.status).toBe(200);
    expectShape(
      res.body,
      ['id', 'name', 'slug', 'logo_base64', 'invoice_logo_base64', 'vat_rate', 'currency_symbol'],
      'Organization'
    );
    // The settings screen renders this as a percentage; a fraction is what it
    // divides. If this ever became 16 instead of 0.16 the app would show 1600%.
    expect(res.body.vat_rate).toBeLessThanOrEqual(1);
  });

  it('organizations.update accepts a partial patch', async () => {
    const res = await put('/api/organizations/current', world.tokens.admin, {
      name: 'Renamed Agrovet',
      vat_rate: 0.16,
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Agrovet');
    expect(res.body.vat_rate).toBe(0.16);
  });

  /* ---------------------------------------------------------------- stores */

  it('stores.list and stores.get return the Store shape', async () => {
    const list = await get('/api/stores', world.tokens.admin);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);

    const keys = [
      'id',
      'organization_id',
      'name',
      'code',
      'address',
      'location',
      'phone',
      'email',
      'is_active',
      'last_sync_at',
    ];
    expectShape(list.body[0], keys, 'Store');
    expectShape(list.body[0].address, ['street', 'city', 'province', 'postal_code', 'country'], 'Store.address');
    expectShape(list.body[0].location, ['latitude', 'longitude'], 'Store.location');

    const one = await get(`/api/stores/${world.storeId}`, world.tokens.admin);
    expect(one.status).toBe(200);
    expectShape(one.body, keys, 'Store (single)');
  });

  it('stores.create, update and deactivate work the way the Shops screen sends them', async () => {
    const created = await post('/api/stores', world.tokens.admin, {
      name: 'Katende',
      // The screen shows the code already uppercased and stripped, because this
      // is what the server stores whatever it is sent.
      code: 'KATENDE',
      address: { street: 'Main road', city: 'Katende', province: 'Central', country: 'Zambia' },
      phone: '0977000000',
      email: '',
    });

    expect(created.status).toBe(201);
    expect(created.body.code).toBe('KATENDE');
    expect(created.body.address.city).toBe('Katende');

    const updated = await put(`/api/stores/${created.body.id}`, world.tokens.admin, {
      phone: '0955111222',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.phone).toBe('0955111222');

    const closed = await del(`/api/stores/${created.body.id}`, world.tokens.admin);
    expect(closed.status).toBe(200);
    expectShape(closed.body, ['detail'], 'deactivate response');
  });

  /* -------------------------------------------------------------- products */

  const productKeys = [
    'id',
    'organization_id',
    'name',
    'description',
    'sku',
    'barcode',
    'brand',
    'category',
    'cost_price',
    'selling_price',
    'tax_type',
    'unit',
    'is_active',
    'created_at',
    'updated_at',
  ];

  it('products.list honours the search and brand params the app sends', async () => {
    const res = await get('/api/products', world.tokens.admin, {
      search: 'Actellic',
      limit: 200,
      offset: 0,
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expectShape(res.body[0], productKeys, 'Product');

    const byBrand = await get('/api/products', world.tokens.admin, { brand: 'Nonexistent' });
    expect(byBrand.status).toBe(200);
    expect(byBrand.body).toEqual([]);
  });

  it('products.get returns one product', async () => {
    const res = await get(`/api/products/${world.products[0]!.id}`, world.tokens.admin);
    expect(res.status).toBe(200);
    expectShape(res.body, productKeys, 'Product');
  });

  it('products.withStock adds quantity and reorder_level', async () => {
    const res = await get(`/api/products/with-stock/${world.storeId}`, world.tokens.cashier);

    expect(res.status).toBe(200);
    expectShape(res.body[0], [...productKeys, 'quantity', 'reorder_level'], 'ProductWithStock');
  });

  it('products.brands returns a flat string array', async () => {
    await put(`/api/products/${world.products[0]!.id}`, world.tokens.admin, { brand: 'Syngenta' });

    const res = await get('/api/products/brands', world.tokens.admin);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Syngenta');
    expect(res.body.every((b: unknown) => typeof b === 'string')).toBe(true);
  });

  it('products.categories returns every head, counted, plus the backlog', async () => {
    const res = await get('/api/products/categories', world.tokens.admin);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('uncategorized');
    expect(typeof res.body.uncategorized).toBe('number');

    // The app renders its own copy of this list before the request comes back,
    // so the two have to stay identical — order included.
    expect(res.body.categories.map((c: { name: string }) => c.name)).toEqual([
      'Herbicides',
      'Pesticides',
      'Fungicides',
      'Insecticides',
      'Fertilizer',
      'Maize Seed',
      'Veg Seed',
      'Other Seed',
      'Equipment',
      'Animal Feed',
      'Veterinary',
      'Other',
    ]);
    expect(res.body.categories.every((c: { count: unknown }) => typeof c.count === 'number')).toBe(
      true
    );
  });

  it('products.list filters by category and by the unfiled backlog', async () => {
    const sku = `CAT-${Date.now()}`;
    await post('/api/products', world.tokens.admin, {
      name: 'Roundup 1L',
      sku,
      // Deliberately a legacy spelling: the server stores the canonical head.
      category: 'herbicide',
      cost_price: 100,
      selling_price: 150,
    });

    const filtered = await get('/api/products?category=Herbicides', world.tokens.admin);
    expect(filtered.status).toBe(200);
    expect(filtered.body.find((p: { sku: string }) => p.sku === sku)?.category).toBe('Herbicides');

    const unfiled = await get('/api/products?uncategorized=true', world.tokens.admin);
    expect(unfiled.status).toBe(200);
    expect(unfiled.body.every((p: { category: string | null }) => !p.category)).toBe(true);
  });

  it('products.create rejects a category outside the list', async () => {
    const res = await post('/api/products', world.tokens.admin, {
      name: 'Mystery Tonic',
      sku: `BAD-${Date.now()}`,
      category: 'Chemicals',
      cost_price: 10,
      selling_price: 20,
    });

    expect(res.status).toBe(422);
  });

  it('products.create accepts the ProductDraft the form builds', async () => {
    const res = await post('/api/products', world.tokens.manager, {
      name: 'Copper Oxychloride',
      description: 'Fungicide',
      sku: `COP-${Date.now()}`,
      barcode: '6001234567890',
      brand: 'Agrichem',
      // A head from the fixed taxonomy, not a description of one. This said
      // "Crop protection" when categories were free text; `normaliseCategory`
      // now refuses anything it cannot place, on purpose — an unrecognised head
      // is a mis-typed column rather than a new category.
      category: 'Fungicides',
      cost_price: 120,
      selling_price: 185.5,
      tax_type: 'vat',
      unit: 'kg',
      is_active: true,
    });

    expect(res.status).toBe(201);
    expectShape(res.body, productKeys, 'Product (created)');
    expect(res.body.selling_price).toBe(185.5);
    expect(res.body.tax_type).toBe('vat');
  });

  it('products.update takes a partial draft and remove soft-deletes', async () => {
    const id = world.products[1]!.id;

    const updated = await put(`/api/products/${id}`, world.tokens.manager, { selling_price: 199 });
    expect(updated.status).toBe(200);
    expect(updated.body.selling_price).toBe(199);

    const removed = await del(`/api/products/${id}`, world.tokens.admin);
    expect(removed.status).toBe(200);
    expectShape(removed.body, ['detail'], 'delete response');

    // Soft delete: the row survives so old receipts still resolve.
    const still = await get(`/api/products/${id}`, world.tokens.admin);
    expect(still.status).toBe(200);
    expect(still.body.is_active).toBe(false);
  });

  /* ------------------------------------------------------------- inventory */

  it('inventory.list returns the InventoryRow shape, and low_only filters', async () => {
    const res = await get('/api/inventory', world.tokens.cashier, { store_id: world.storeId });

    expect(res.status).toBe(200);
    expectShape(
      res.body[0],
      ['product_id', 'store_id', 'product_name', 'sku', 'quantity', 'reorder_level', 'value'],
      'InventoryRow'
    );

    const low = await get('/api/inventory', world.tokens.cashier, {
      store_id: world.storeId,
      low_only: true,
    });
    expect(low.status).toBe(200);
    // Seed stock is 100 against a reorder level of 10, so nothing is low yet.
    expect(low.body).toEqual([]);
  });

  it('inventory.adjust applies a signed delta and returns the new level', async () => {
    const product = world.products[0]!;

    const received = await post('/api/inventory/movements', world.tokens.manager, {
      store_id: world.storeId,
      product_id: product.id,
      type: 'purchase',
      quantity: 25,
      note: 'Delivery 4471',
    });

    expect(received.status).toBe(201);
    expectShape(received.body, ['product_id', 'store_id', 'quantity', 'reorder_level'], 'StockLevel');
    // 100 seeded + 25 received. A delta, never a replacement — the adjust screen
    // computes it from a counted total, so this is the assumption it rests on.
    expect(received.body.quantity).toBe(125);

    const corrected = await post('/api/inventory/movements', world.tokens.manager, {
      store_id: world.storeId,
      product_id: product.id,
      type: 'adjustment',
      quantity: -5,
      note: 'Recount',
    });
    expect(corrected.body.quantity).toBe(120);
  });

  it('inventory.adjust is refused to a cashier', async () => {
    const res = await post('/api/inventory/movements', world.tokens.cashier, {
      store_id: world.storeId,
      product_id: world.products[0]!.id,
      type: 'adjustment',
      quantity: 500,
    });

    expect(res.status).toBe(403);
  });

  it('inventory.movements returns the audit rows the history screen renders', async () => {
    await post('/api/inventory/movements', world.tokens.manager, {
      store_id: world.storeId,
      product_id: world.products[0]!.id,
      type: 'purchase',
      quantity: 10,
      note: 'Delivery',
    });

    const res = await get('/api/inventory/movements', world.tokens.manager, {
      store_id: world.storeId,
      limit: 100,
    });

    expect(res.status).toBe(200);
    expectShape(
      res.body[0],
      [
        'id',
        'product_id',
        'product_name',
        'sku',
        'type',
        'quantity',
        'balance',
        'reference',
        'note',
        'created_at',
      ],
      'StockMovement'
    );
  });

  /* ---------------------------------------------------------- transactions */

  async function makeSale(): Promise<string> {
    const res = await post('/api/transactions', world.tokens.cashier, {
      store_id: world.storeId,
      client_reference: clientRef('contract'),
      items: [{ product_id: world.products[0]!.id, quantity: 2 }],
      payments: [{ method: 'cash', amount: world.products[0]!.price * 2 }],
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('transactions.list and .get return the Transaction shape', async () => {
    await makeSale();

    const list = await get('/api/transactions', world.tokens.cashier, {
      store_id: world.storeId,
      limit: 40,
      offset: 0,
      type: 'sale',
    });

    expect(list.status).toBe(200);
    const keys = [
      'id',
      'organization_id',
      'store_id',
      'receipt_number',
      'transaction_type',
      'status',
      'items',
      'subtotal',
      'discount_amount',
      'tax_amount',
      'total',
      'payments',
      'cashier_id',
      'cashier_name',
      'created_at',
    ];
    expectShape(list.body[0], keys, 'Transaction');
    expectShape(
      list.body[0].items[0],
      ['product_id', 'product_name', 'sku', 'quantity', 'unit_price', 'line_total', 'tax_amount'],
      'TransactionItem'
    );
    expectShape(list.body[0].payments[0], ['method', 'amount'], 'Payment');

    const one = await get(`/api/transactions/${list.body[0].id}`, world.tokens.cashier);
    expect(one.status).toBe(200);
    expectShape(one.body, keys, 'Transaction (single)');
  });

  it('transactions.refund returns the reversing transaction', async () => {
    const saleId = await makeSale();

    const res = await post(`/api/transactions/${saleId}/refund`, world.tokens.manager, {
      reason: 'Damaged',
      items: [{ product_id: world.products[0]!.id, quantity: 1 }],
      client_reference: clientRef('refund'),
    });

    expect(res.status).toBe(201);
    expect(res.body.transaction_type).toBe('refund');
    expect(res.body.total).toBeLessThan(0);
  });

  it('transactions.dailyReport returns the Z-report figures', async () => {
    await makeSale();

    const res = await get('/api/transactions/reports/daily', world.tokens.manager, {
      store_id: world.storeId,
    });

    expect(res.status).toBe(200);
    expectShape(
      res.body,
      [
        'store_id',
        'date',
        'transaction_count',
        'gross_total',
        'tax_total',
        'refund_total',
        'by_payment_method',
      ],
      'DailyReport'
    );
    expectShape(res.body.by_payment_method, ['cash', 'card', 'mobile'], 'by_payment_method');
    expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /* ----------------------------------------------------------------- users */

  it('users.list, create, update and deactivate round-trip', async () => {
    const list = await get('/api/users', world.tokens.admin);
    expect(list.status).toBe(200);
    expectShape(
      list.body[0],
      ['id', 'organization_id', 'email', 'full_name', 'role', 'assigned_stores', 'is_active'],
      'User'
    );

    const email = `new-${Date.now().toString(36)}@test.local`;
    const created = await post('/api/users', world.tokens.admin, {
      email,
      full_name: 'Grace Banda',
      password: 'Str0ngPassword!',
      role: 'CASHIER',
      assigned_stores: [world.storeId],
      is_active: true,
    });

    expect(created.status).toBe(201);
    expect(created.body.assigned_stores).toEqual([world.storeId]);
    expect(created.body).not.toHaveProperty('password_hash');

    // The edit form omits `password` entirely when left blank.
    const updated = await put(`/api/users/${created.body.id}`, world.tokens.admin, {
      full_name: 'Grace M. Banda',
      role: 'STORE_MANAGER',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.full_name).toBe('Grace M. Banda');

    const removed = await del(`/api/users/${created.body.id}`, world.tokens.admin);
    expect(removed.status).toBe(200);
    expectShape(removed.body, ['detail'], 'deactivate response');
  });

  it('users.list is readable by a manager but not a cashier', async () => {
    expect((await get('/api/users', world.tokens.manager)).status).toBe(200);
    expect((await get('/api/users', world.tokens.cashier)).status).toBe(403);
  });

  /* --------------------------------------------------------- store pricing */

  it('storePricing set, list and remove round-trip', async () => {
    const product = world.products[0]!;

    const set = await post('/api/store-pricing', world.tokens.manager, {
      store_id: world.storeId,
      product_id: product.id,
      price: 79.5,
    });
    expect(set.status).toBe(201);
    expectShape(set.body, ['id', 'store_price'], 'store-pricing upsert');

    const list = await get('/api/store-pricing', world.tokens.manager, { store_id: world.storeId });
    expect(list.status).toBe(200);
    expectShape(
      list.body[0],
      [
        'id',
        'store_id',
        'product_id',
        'product_name',
        'sku',
        'brand',
        'default_price',
        'store_price',
        'difference',
      ],
      'StorePriceRow'
    );
    expect(list.body[0].store_price).toBe(79.5);
    expect(list.body[0].difference).toBeCloseTo(79.5 - product.price, 5);

    // Upsert, not insert — the screen reuses the same call to edit a row.
    const again = await post('/api/store-pricing', world.tokens.manager, {
      store_id: world.storeId,
      product_id: product.id,
      price: 82,
    });
    expect(again.status).toBe(201);
    expect((await get('/api/store-pricing', world.tokens.manager, { store_id: world.storeId })).body)
      .toHaveLength(1);

    const removed = await del(`/api/store-pricing/${set.body.id}`, world.tokens.manager);
    expect(removed.status).toBe(200);
  });

  it('a store price overrides the catalogue price in the till catalogue', async () => {
    const product = world.products[0]!;
    await post('/api/store-pricing', world.tokens.manager, {
      store_id: world.storeId,
      product_id: product.id,
      price: 60,
    });

    const res = await get(`/api/products/with-stock/${world.storeId}`, world.tokens.cashier);
    const row = res.body.find((p: { id: string }) => p.id === product.id);
    expect(row.selling_price).toBe(60);
  });

  /* ------------------------------------------------------------ warehouses */

  it('warehouses list, create, stock and deactivate', async () => {
    const created = await post('/api/warehouses', world.tokens.admin, {
      name: 'Central Depot',
      code: 'cd1',
    });
    expect(created.status).toBe(201);
    expectShape(created.body, ['id', 'name', 'code', 'is_active'], 'Warehouse (created)');
    expect(created.body.code).toBe('CD1');

    const list = await get('/api/warehouses', world.tokens.admin);
    expect(list.status).toBe(200);
    expectShape(
      list.body[0],
      ['id', 'organization_id', 'name', 'code', 'is_active', 'stock_items', 'created_at'],
      'Warehouse'
    );

    const stock = await get(`/api/warehouses/${created.body.id}/stock`, world.tokens.admin);
    expect(stock.status).toBe(200);
    expect(Array.isArray(stock.body)).toBe(true);

    expect((await del(`/api/warehouses/${created.body.id}`, world.tokens.admin)).status).toBe(200);
  });

  /* ------------------------------------------------------------- transfers */

  it('transfers.create moves stock and transfers.list returns the shape', async () => {
    const destination = await post('/api/stores', world.tokens.admin, {
      name: 'Kabwe Road',
      code: 'KBW',
    });
    expect(destination.status).toBe(201);

    const product = world.products[0]!;
    const created = await post('/api/transfers', world.tokens.manager, {
      from_store_id: world.storeId,
      to_store_id: destination.body.id,
      items: [{ product_id: product.id, quantity: 15 }],
      notes: 'Weekly top-up',
    });

    expect(created.status).toBe(201);
    expectShape(created.body, ['id', 'reference', 'status'], 'transfer create response');

    const list = await get('/api/transfers', world.tokens.manager);
    expect(list.status).toBe(200);
    expectShape(
      list.body[0],
      [
        'id',
        'reference',
        'from_store_id',
        'from_store',
        'to_store_id',
        'to_store',
        'status',
        'items',
        'created_at',
      ],
      'Transfer'
    );
    expectShape(list.body[0].items[0], ['product_id', 'product_name', 'sku', 'quantity'], 'TransferItem');

    // Source drops, destination gains — the screen's "all or nothing" promise.
    const source = await get('/api/inventory', world.tokens.manager, { store_id: world.storeId });
    expect(source.body.find((r: { product_id: string }) => r.product_id === product.id).quantity).toBe(85);
  });

  it('transfers.create refuses more stock than the source holds', async () => {
    const destination = await post('/api/stores', world.tokens.admin, {
      name: 'Chingola',
      code: 'CHG',
    });

    const res = await post('/api/transfers', world.tokens.manager, {
      from_store_id: world.storeId,
      to_store_id: destination.body.id,
      items: [{ product_id: world.products[0]!.id, quantity: 5000 }],
    });

    // The new-transfer screen blocks this client-side; this is the backstop.
    expect(res.status).toBe(400);
  });

  /* ------------------------------------------------------------- analytics */

  it('analytics.dashboard returns every tile the reports tab reads', async () => {
    await makeSale();

    const res = await get('/api/analytics/dashboard', world.tokens.manager, {
      store_id: world.storeId,
    });

    expect(res.status).toBe(200);
    expectShape(
      res.body,
      [
        'today_sales',
        'today_transactions',
        'week_sales',
        'week_transactions',
        'month_sales',
        'month_transactions',
        'tax_collected_today',
        'active_stores',
        'total_products',
        'low_stock_count',
      ],
      'DashboardAnalytics'
    );
  });

  it('analytics.salesTrend fills empty days so the chart has a baseline', async () => {
    const res = await get('/api/analytics/sales-trend', world.tokens.manager, {
      store_id: world.storeId,
      days: 7,
    });

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(7);
    expectShape(res.body[0], ['date', 'total', 'count'], 'SalesTrendPoint');
    expect(res.body[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('analytics product and branch breakdowns return their declared shapes', async () => {
    await makeSale();

    const top = await get('/api/analytics/top-products', world.tokens.manager, {
      store_id: world.storeId,
      limit: 10,
      period: 'monthly',
    });
    expect(top.status).toBe(200);
    expectShape(top.body[0], ['product_id', 'product_name', 'quantity', 'total'], 'TopProduct');

    const perProduct = await get('/api/analytics/sales-per-product', world.tokens.manager, {
      store_id: world.storeId,
      period: 'monthly',
    });
    expect(perProduct.status).toBe(200);
    expectShape(
      perProduct.body[0],
      ['product_id', 'product_name', 'brand', 'quantity', 'sales'],
      'SalesPerProductRow'
    );

    const profitProduct = await get('/api/analytics/profit-per-product', world.tokens.manager, {
      store_id: world.storeId,
      period: 'monthly',
    });
    expect(profitProduct.status).toBe(200);
    expectShape(
      profitProduct.body[0],
      ['product_id', 'product_name', 'brand', 'quantity', 'sales', 'cost', 'tax', 'profit'],
      'ProfitPerProductRow'
    );

    const perBranch = await get('/api/analytics/sales-per-branch', world.tokens.manager, {
      period: 'monthly',
    });
    expect(perBranch.status).toBe(200);
    expectShape(perBranch.body[0], ['store_id', 'branch', 'transactions', 'sales'], 'SalesPerBranchRow');

    const profitBranch = await get('/api/analytics/profit-per-branch', world.tokens.manager, {
      period: 'monthly',
    });
    expect(profitBranch.status).toBe(200);
    expectShape(
      profitBranch.body[0],
      ['store_id', 'branch', 'sales', 'cost', 'tax', 'profit'],
      'ProfitPerBranchRow'
    );

    const summary = await get('/api/analytics/sales-summary', world.tokens.manager, {
      store_id: world.storeId,
      period: 'monthly',
    });
    expect(summary.status).toBe(200);
    expectShape(
      summary.body,
      ['total_sales', 'tax_collected', 'discounts', 'transactions', 'average_transaction'],
      'SalesSummary'
    );
  });

  it('analytics accepts an org-wide call with no store_id', async () => {
    // The analytics screen's "All stores" scope omits the param entirely.
    const res = await get('/api/analytics/sales-summary', world.tokens.admin, { period: 'monthly' });
    expect(res.status).toBe(200);
  });

  it('analytics.marginSummary returns three parts that add up to the selling price', async () => {
    await makeSale();

    const res = await get('/api/analytics/margin-summary', world.tokens.manager, {
      store_id: world.storeId,
      period: 'monthly',
    });

    expect(res.status).toBe(200);
    expectShape(
      res.body,
      [
        'period',
        'period_start',
        'timezone',
        'selling_price',
        'cost_price',
        'tax',
        'gross_profit',
        'margin_percent',
        'units',
        'transactions',
      ],
      'MarginSummary'
    );

    // The whole point of the donut: the slices are parts of the takings, so
    // they must reconstitute them exactly. If this drifts, the chart is a lie.
    const { selling_price, cost_price, tax, gross_profit } = res.body;
    expect(cost_price + tax + gross_profit).toBeCloseTo(selling_price, 2);
    expect(selling_price).toBeGreaterThan(0);
    expect(res.body.period_start).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('analytics accepts every period the app can ask for', async () => {
    // PERIOD_LABELS in the app is the list; a period it offers and the server
    // rejects is a 422 the user cannot do anything about.
    for (const period of ['daily', 'weekly', 'monthly', 'quarterly', 'yearly']) {
      const res = await get('/api/analytics/margin-summary', world.tokens.admin, { period });
      expect(res.status, `period ${period}`).toBe(200);
      expect(res.body.period).toBe(period);
    }
  });

  /* -------------------------------------------------------------- suppliers */

  it('suppliers.list, create and update return the Supplier shape', async () => {
    const created = await post('/api/suppliers', world.tokens.admin, {
      name: 'Contract Wholesale',
      contact_name: 'Mrs Phiri',
      phone: '0966000111',
    });

    expect(created.status).toBe(201);
    expectShape(
      created.body,
      [
        'id',
        'organization_id',
        'name',
        'contact_name',
        'phone',
        'email',
        'address',
        'notes',
        'is_active',
        'created_at',
      ],
      'Supplier'
    );

    const list = await get('/api/suppliers', world.tokens.admin);
    expect(list.status).toBe(200);
    // The list screen leads with the balance, so these two only exist here.
    expectShape(list.body[0], ['id', 'name', 'outstanding_balance', 'invoice_count'], 'Supplier row');

    const updated = await put(`/api/suppliers/${created.body.id}`, world.tokens.admin, {
      phone: '0955222333',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.phone).toBe('0955222333');

    const removed = await del(`/api/suppliers/${created.body.id}`, world.tokens.admin);
    expect(removed.status).toBe(200);
    expectShape(removed.body, ['detail'], 'deactivate response');
  });

  /* ------------------------------------------------------ supplier invoices */

  it('purchases.create returns the SupplierInvoice shape the app reads', async () => {
    const supplier = await post('/api/suppliers', world.tokens.admin, { name: 'Invoice Supplier' });

    const res = await post('/api/supplier-invoices', world.tokens.admin, {
      supplier_id: supplier.body.id,
      store_id: world.storeId,
      invoice_number: 'CT-1',
      items: [{ product_id: world.products[0]!.id, quantity: 4, unit_cost: 25 }],
      payment: { amount: 40, method: 'cash' },
    });

    expect(res.status).toBe(201);
    expectShape(
      res.body,
      [
        'id',
        'supplier_id',
        'supplier_name',
        'store_id',
        'store_name',
        'store_code',
        'invoice_number',
        'invoice_date',
        'due_date',
        'subtotal',
        'tax_amount',
        'other_charges',
        'discount_amount',
        'total',
        'amount_paid',
        'balance',
        'status',
        'notes',
        'created_by_name',
        'items',
        'payments',
      ],
      'SupplierInvoice'
    );
    expectShape(
      res.body.items[0],
      ['id', 'product_id', 'product_name', 'sku', 'quantity', 'unit_cost', 'line_total'],
      'SupplierInvoiceItem'
    );
    expectShape(
      res.body.payments[0],
      ['id', 'amount', 'method', 'reference', 'note', 'paid_at', 'user_name'],
      'SupplierPaymentRow'
    );

    const one = await get(`/api/supplier-invoices/${res.body.id}`, world.tokens.admin);
    expect(one.status).toBe(200);
    expect(one.body.balance).toBe(60);

    // The list screen's filter chips send exactly these values.
    for (const status of ['outstanding', 'unpaid', 'partial', 'paid']) {
      const listed = await get('/api/supplier-invoices', world.tokens.admin, {
        store_id: world.storeId,
        status,
        limit: 100,
      });
      expect(listed.status, `status=${status}`).toBe(200);
    }

    const paid = await post(
      `/api/supplier-invoices/${res.body.id}/payments`,
      world.tokens.admin,
      { amount: 60, method: 'bank_transfer', reference: 'FT-1' }
    );
    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe('paid');
  });

  it('purchases.summary returns the shape the invoice list header renders', async () => {
    const res = await get('/api/supplier-invoices/summary', world.tokens.admin, {
      store_id: world.storeId,
    });

    expect(res.status).toBe(200);
    expectShape(
      res.body,
      ['outstanding_total', 'open_invoice_count', 'overdue_total', 'overdue_count', 'by_supplier'],
      'SupplierOutstandingSummary'
    );
  });

  /* ------------------------------------------------------------ bulk upload */

  it('inventory.bulkUpload returns the result shape, dry run and applied', async () => {
    const csv = ['sku,name,cost_price,selling_price,quantity', 'CT-BULK-1,Contract Feed,10,20,5'].join(
      '\n'
    );

    const dry = await post('/api/inventory/bulk-upload', world.tokens.admin, {
      store_id: world.storeId,
      csv,
      validate_only: true,
    });

    expect(dry.status).toBe(200);
    expectShape(
      dry.body,
      [
        'applied',
        'detail',
        'store_id',
        'mode',
        'total_rows',
        'products_to_create',
        'products_to_update',
        'stock_rows',
        'warnings',
        'preview',
      ],
      'BulkUploadResult (dry run)'
    );
    expectShape(
      dry.body.preview[0],
      ['row', 'sku', 'name', 'product_action', 'quantity_before', 'quantity_after', 'change'],
      'BulkUploadRowPreview'
    );

    const applied = await post('/api/inventory/bulk-upload', world.tokens.admin, {
      store_id: world.storeId,
      csv,
    });
    expect(applied.status).toBe(201);
    expect(applied.body.applied).toBe(true);
    expectShape(applied.body, ['reference'], 'BulkUploadResult (applied)');

    // The import screen renders this body directly, so its shape is contract.
    const rejected = await post('/api/inventory/bulk-upload', world.tokens.admin, {
      store_id: world.storeId,
      csv: 'sku,name,quantity\nCT-BULK-2,Bad,lots\n',
    });
    expect(rejected.status).toBe(422);
    expectShape(
      rejected.body,
      ['applied', 'detail', 'total_rows', 'errors', 'error_count', 'warnings'],
      'BulkUploadRejection'
    );
    expectShape(rejected.body.errors[0], ['row', 'sku', 'message'], 'bulk upload row error');
  });

  it('inventory.bulkUploadTemplate defaults to the price list, columned by shop', async () => {
    const res = await get('/api/inventory/bulk-upload/template', world.tokens.admin);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');

    const header = res.text.split(/\r?\n/)[0] as string;
    expect(header).toContain('PRODUCT');
    expect(header).toContain('PACKSIZE');
    // One column per shop, taken from the organisation's own shops.
    expect(header).toContain('Test Store');
  });

  it('inventory.bulkUploadTemplate still serves the coded sheet on request', async () => {
    const res = await get('/api/inventory/bulk-upload/template?format=sku', world.tokens.admin);

    expect(res.status).toBe(200);
    expect(res.text.split(/\r?\n/)[0]).toContain('sku');
  });

  it('inventory.exportCatalogue writes the catalogue in the shape the importer reads', async () => {
    const res = await get('/api/inventory/export', world.tokens.admin);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');

    const header = res.text.split(/\r?\n/)[0] as string;
    // `sku` is what makes a re-upload an update rather than a second catalogue.
    expect(header).toContain('sku');
    expect(header).toContain('selling_price');
    expect(header).toContain('cost_price');
    // One column per shop, so a row that prices one shop does not blank the rest.
    expect(header).toContain('Test Store');
    // No quantity unless it was asked for: the importer reads one as the
    // counted total, and returning this file must not move any stock.
    expect(header).not.toContain('quantity');
  });

  it('inventory.exportCatalogue adds stock counts only for a named shop', async () => {
    const res = await get('/api/inventory/export', world.tokens.admin, {
      store_id: world.storeId,
      include_stock: 'true',
    });

    expect(res.status).toBe(200);
    expect(res.text.split(/\r?\n/)[0]).toContain('quantity');

    // Stock is per shop, so asking for it without naming one is a 400 rather
    // than a file that quietly counts nothing.
    const noShop = await get('/api/inventory/export', world.tokens.admin, {
      include_stock: 'true',
    });
    expect(noShop.status).toBe(400);
  });

  it('inventory.exportCatalogue leaves the buying price out for a store manager', async () => {
    const res = await get('/api/inventory/export', world.tokens.manager);

    expect(res.status).toBe(200);
    const header = res.text.split(/\r?\n/)[0] as string;
    expect(header).not.toContain('cost_price');
    expect(header).toContain('selling_price');
  });

  /* ----------------------------------------------- buying prices are withheld */

  it('products carry no cost price for a store manager', async () => {
    const admin = await get('/api/products', world.tokens.admin);
    const manager = await get('/api/products', world.tokens.manager);

    expect(admin.status).toBe(200);
    expect(manager.status).toBe(200);
    // Sent as 0 rather than dropped: the field is declared on the app's own
    // Product type and the stock screen multiplies it, so a missing key would
    // read "K NaN" on a handset that had not been updated yet.
    expect(manager.body[0]).toHaveProperty('cost_price', 0);
    expect(admin.body[0].cost_price).toBeGreaterThan(0);
  });

  it('a store manager saving a product cannot blank its cost price', async () => {
    const before = await get('/api/products', world.tokens.admin);
    const product = before.body[0];

    // Exactly what the app would post back after an edit if it echoed the 0 it
    // was given — the case that would destroy the figure for the whole chain.
    const saved = await put(`/api/products/${product.id}`, world.tokens.manager, {
      name: product.name,
      sku: product.sku,
      cost_price: 0,
      selling_price: product.selling_price,
      tax_type: product.tax_type,
    });
    expect(saved.status).toBe(200);

    const after = await get('/api/products', world.tokens.admin);
    const same = after.body.find((p: { id: string }) => p.id === product.id);
    expect(same.cost_price).toBe(product.cost_price);
  });

  it('profit and margin reports are closed to a store manager', async () => {
    for (const path of ['/api/analytics/margin-summary', '/api/analytics/profit-per-product', '/api/analytics/profit-per-branch']) {
      const res = await get(path, world.tokens.manager);
      expect(res.status).toBe(403);
    }

    const allowed = await get('/api/analytics/margin-summary', world.tokens.admin);
    expect(allowed.status).toBe(200);

    // Takings are not costs: the Reports tab every till opens must still work.
    const dashboard = await get('/api/analytics/dashboard', world.tokens.manager);
    expect(dashboard.status).toBe(200);
  });

  /* ------------------------------------------------------------------ sync */

  it('sync.pull returns products, inventory and the server clock', async () => {
    const res = await get('/api/sync/pull', world.tokens.cashier, { store_id: world.storeId });

    expect(res.status).toBe(200);
    expectShape(res.body, ['server_time', 'products', 'inventory'], 'sync pull');
    expectShape(res.body.products[0], ['id', 'name', 'selling_price', 'quantity', 'reorder_level'], 'synced product');

    // The client stores `server_time` and sends it back; a device clock that
    // runs fast would otherwise skip records on the next delta.
    const delta = await get('/api/sync/pull', world.tokens.cashier, {
      store_id: world.storeId,
      last_sync: res.body.server_time,
    });
    expect(delta.status).toBe(200);
    expect(delta.body.products).toEqual([]);
  });
});
