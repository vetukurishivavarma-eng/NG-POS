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

  it('products.create accepts the ProductDraft the form builds', async () => {
    const res = await post('/api/products', world.tokens.manager, {
      name: 'Copper Oxychloride',
      description: 'Fungicide',
      sku: `COP-${Date.now()}`,
      barcode: '6001234567890',
      brand: 'Agrichem',
      category: 'Crop protection',
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
      ['product_id', 'product_name', 'brand', 'quantity', 'sales', 'profit'],
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
    expectShape(profitBranch.body[0], ['store_id', 'branch', 'sales', 'profit'], 'ProfitPerBranchRow');

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
