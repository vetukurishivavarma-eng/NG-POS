import { afterAll, beforeEach } from 'vitest';

import { prisma } from '../src/prisma.js';

/**
 * Every test starts from an empty database and builds only the rows it needs.
 * Shared fixtures across tests are how a suite ends up passing because of
 * something an unrelated test happened to leave behind.
 */
beforeEach(async () => {
  // Order matters: children before parents, since some relations are Restrict.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      payments, transaction_items, transactions, stock_movements,
      receipt_counters, daily_reports, inventory, store_prices,
      warehouse_stock, transfer_items, transfers, warehouses,
      supplier_payments, supplier_invoice_items, supplier_invoices, suppliers,
      password_reset_requests,
      products, stores, users, organizations
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await prisma.$disconnect();
});
