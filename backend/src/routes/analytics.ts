import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { assertStoreAccess, authenticate, currentUser } from '../middleware/auth.js';

export const analyticsRouter = Router();
analyticsRouter.use(authenticate);

const periodSchema = z.enum(['daily', 'weekly', 'monthly']);

/** Inclusive start of the requested window, in server local time. */
function periodStart(period: z.infer<typeof periodSchema>): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (period === 'weekly') d.setDate(d.getDate() - 7);
  if (period === 'monthly') d.setMonth(d.getMonth() - 1);
  return d;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const storeQuery = z.object({ store_id: z.string().uuid().optional() });

/** Scopes a query to one store, or to every store the caller may see. */
function scope(req: Parameters<typeof currentUser>[0], storeId?: string) {
  const user = currentUser(req);
  if (storeId) {
    assertStoreAccess(user, storeId);
    return { organizationId: user.organizationId, storeId };
  }
  if (user.role !== 'ORG_ADMIN' && user.assignedStores.length > 0) {
    return { organizationId: user.organizationId, storeId: { in: user.assignedStores } };
  }
  return { organizationId: user.organizationId };
}

analyticsRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const { store_id } = storeQuery.parse(req.query);
    const user = currentUser(req);
    const where = { ...scope(req, store_id), status: { not: 'voided' as const } };

    const now = new Date();
    const weekStart = new Date(startOfToday());
    weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(startOfToday());
    monthStart.setMonth(monthStart.getMonth() - 1);

    const [today, week, month, storeCount, productCount, lowStock] = await Promise.all([
      prisma.transaction.aggregate({
        where: { ...where, createdAt: { gte: startOfToday(), lte: now } },
        _sum: { total: true, taxAmount: true },
        _count: true,
      }),
      prisma.transaction.aggregate({
        where: { ...where, createdAt: { gte: weekStart, lte: now } },
        _sum: { total: true },
        _count: true,
      }),
      prisma.transaction.aggregate({
        where: { ...where, createdAt: { gte: monthStart, lte: now } },
        _sum: { total: true },
        _count: true,
      }),
      prisma.store.count({ where: { organizationId: user.organizationId, isActive: true } }),
      prisma.product.count({ where: { organizationId: user.organizationId, isActive: true } }),
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM inventory i
        JOIN stores s ON s.id = i.store_id
        WHERE s.organization_id = ${user.organizationId}::uuid
          AND i.quantity <= i.reorder_level
      `,
    ]);

    res.json({
      today_sales: Number(today._sum.total ?? 0),
      today_transactions: today._count,
      tax_collected_today: Number(today._sum.taxAmount ?? 0),
      week_sales: Number(week._sum.total ?? 0),
      week_transactions: week._count,
      month_sales: Number(month._sum.total ?? 0),
      month_transactions: month._count,
      active_stores: storeCount,
      total_products: productCount,
      low_stock_count: Number(lowStock[0]?.count ?? 0),
    });
  })
);

analyticsRouter.get(
  '/sales-trend',
  asyncHandler(async (req, res) => {
    const q = z
      .object({ store_id: z.string().uuid().optional(), days: z.coerce.number().min(1).max(365).default(14) })
      .parse(req.query);

    const user = currentUser(req);
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (q.days - 1));

    // Generated series so days with no sales still appear as zero, which is
    // what a chart needs.
    const rows = await prisma.$queryRaw<{ date: Date; total: number; count: bigint }[]>`
      SELECT d.day::date AS date,
             COALESCE(SUM(t.total), 0)::float8 AS total,
             COUNT(t.id)::bigint AS count
      FROM generate_series(${since}::timestamp, NOW()::timestamp, '1 day') AS d(day)
      LEFT JOIN transactions t
        ON date_trunc('day', t.created_at) = date_trunc('day', d.day)
       AND t.organization_id = ${user.organizationId}::uuid
       AND t.status <> 'voided'
       ${q.store_id ? prismaStoreFilter(q.store_id) : prismaEmpty()}
      GROUP BY d.day
      ORDER BY d.day
    `;

    res.json(
      rows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        total: Number(r.total),
        count: Number(r.count),
      }))
    );
  })
);

analyticsRouter.get(
  '/top-products',
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        store_id: z.string().uuid().optional(),
        limit: z.coerce.number().min(1).max(50).default(5),
        period: periodSchema.default('monthly'),
      })
      .parse(req.query);

    const rows = await prisma.transactionItem.groupBy({
      by: ['productId', 'productName'],
      where: {
        transaction: {
          ...scope(req, q.store_id),
          status: { not: 'voided' },
          transactionType: 'sale',
          createdAt: { gte: periodStart(q.period) },
        },
      },
      _sum: { quantity: true, lineTotal: true },
      orderBy: { _sum: { lineTotal: 'desc' } },
      take: q.limit,
    });

    res.json(
      rows.map((r) => ({
        product_id: r.productId,
        product_name: r.productName,
        quantity: Number(r._sum.quantity ?? 0),
        total: Number(r._sum.lineTotal ?? 0),
      }))
    );
  })
);

analyticsRouter.get(
  '/sales-per-product',
  asyncHandler(async (req, res) => {
    const q = z
      .object({ store_id: z.string().uuid().optional(), period: periodSchema.default('monthly') })
      .parse(req.query);

    const rows = await prisma.transactionItem.groupBy({
      by: ['productId', 'productName', 'brand'],
      where: {
        transaction: {
          ...scope(req, q.store_id),
          status: { not: 'voided' },
          createdAt: { gte: periodStart(q.period) },
        },
      },
      _sum: { quantity: true, lineTotal: true },
      orderBy: { _sum: { lineTotal: 'desc' } },
    });

    res.json(
      rows.map((r) => ({
        product_id: r.productId,
        product_name: r.productName,
        brand: r.brand,
        quantity: Number(r._sum.quantity ?? 0),
        sales: Number(r._sum.lineTotal ?? 0),
      }))
    );
  })
);

/**
 * Profit uses the cost price captured on the line at the time of sale, not the
 * product's current cost — otherwise a supplier price change would silently
 * rewrite last month's margins.
 */
analyticsRouter.get(
  '/profit-per-product',
  asyncHandler(async (req, res) => {
    const q = z
      .object({ store_id: z.string().uuid().optional(), period: periodSchema.default('monthly') })
      .parse(req.query);

    const user = currentUser(req);
    const since = periodStart(q.period);

    const rows = await prisma.$queryRaw<
      { product_id: string | null; product_name: string; brand: string | null; qty: number; sales: number; profit: number }[]
    >`
      SELECT ti.product_id,
             ti.product_name,
             ti.brand,
             SUM(ti.quantity)::float8 AS qty,
             SUM(ti.line_total)::float8 AS sales,
             SUM(ti.line_total - ti.tax_amount - (ti.cost_price * ti.quantity))::float8 AS profit
      FROM transaction_items ti
      JOIN transactions t ON t.id = ti.transaction_id
      WHERE t.organization_id = ${user.organizationId}::uuid
        AND t.status <> 'voided'
        AND t.created_at >= ${since}
        ${q.store_id ? prismaStoreFilter(q.store_id) : prismaEmpty()}
      GROUP BY ti.product_id, ti.product_name, ti.brand
      ORDER BY profit DESC
    `;

    res.json(
      rows.map((r) => ({
        product_id: r.product_id,
        product_name: r.product_name,
        brand: r.brand,
        quantity: Number(r.qty),
        sales: Number(r.sales),
        profit: Number(r.profit),
      }))
    );
  })
);

analyticsRouter.get(
  '/sales-per-branch',
  asyncHandler(async (req, res) => {
    const q = z.object({ period: periodSchema.default('monthly') }).parse(req.query);
    const user = currentUser(req);

    const rows = await prisma.transaction.groupBy({
      by: ['storeId'],
      where: {
        organizationId: user.organizationId,
        status: { not: 'voided' },
        createdAt: { gte: periodStart(q.period) },
      },
      _sum: { total: true },
      _count: true,
    });

    const stores = await prisma.store.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true },
    });
    const nameById = new Map(stores.map((s) => [s.id, s.name]));

    res.json(
      rows.map((r) => ({
        store_id: r.storeId,
        branch: nameById.get(r.storeId) ?? 'Unknown',
        transactions: r._count,
        sales: Number(r._sum.total ?? 0),
      }))
    );
  })
);

analyticsRouter.get(
  '/profit-per-branch',
  asyncHandler(async (req, res) => {
    const q = z.object({ period: periodSchema.default('monthly') }).parse(req.query);
    const user = currentUser(req);
    const since = periodStart(q.period);

    const rows = await prisma.$queryRaw<
      { store_id: string; branch: string; sales: number; profit: number }[]
    >`
      SELECT s.id AS store_id,
             s.name AS branch,
             COALESCE(SUM(ti.line_total), 0)::float8 AS sales,
             COALESCE(SUM(ti.line_total - ti.tax_amount - (ti.cost_price * ti.quantity)), 0)::float8 AS profit
      FROM stores s
      LEFT JOIN transactions t
        ON t.store_id = s.id AND t.status <> 'voided' AND t.created_at >= ${since}
      LEFT JOIN transaction_items ti ON ti.transaction_id = t.id
      WHERE s.organization_id = ${user.organizationId}::uuid
      GROUP BY s.id, s.name
      ORDER BY profit DESC
    `;

    res.json(
      rows.map((r) => ({
        store_id: r.store_id,
        branch: r.branch,
        sales: Number(r.sales),
        profit: Number(r.profit),
      }))
    );
  })
);

analyticsRouter.get(
  '/sales-summary',
  asyncHandler(async (req, res) => {
    const q = z
      .object({ store_id: z.string().uuid().optional(), period: periodSchema.default('monthly') })
      .parse(req.query);

    const agg = await prisma.transaction.aggregate({
      where: {
        ...scope(req, q.store_id),
        status: { not: 'voided' },
        createdAt: { gte: periodStart(q.period) },
      },
      _sum: { total: true, taxAmount: true, discountAmount: true },
      _count: true,
      _avg: { total: true },
    });

    res.json({
      total_sales: Number(agg._sum.total ?? 0),
      tax_collected: Number(agg._sum.taxAmount ?? 0),
      discounts: Number(agg._sum.discountAmount ?? 0),
      transactions: agg._count,
      average_transaction: Number(agg._avg.total ?? 0),
    });
  })
);

analyticsRouter.get(
  '/stores-map',
  asyncHandler(async (req, res) => {
    const stores = await prisma.store.findMany({
      where: { organizationId: currentUser(req).organizationId, isActive: true },
      select: { id: true, name: true, code: true, latitude: true, longitude: true, city: true },
    });

    res.json(
      stores
        .filter((s) => s.latitude !== null && s.longitude !== null)
        .map((s) => ({
          store_id: s.id,
          name: s.name,
          code: s.code,
          city: s.city,
          latitude: s.latitude,
          longitude: s.longitude,
        }))
    );
  })
);

/* Raw-SQL fragment helpers. Kept at the bottom because they exist only to make
   the optional store filter readable inside tagged templates. */
import { Prisma } from '@prisma/client';

function prismaStoreFilter(storeId: string) {
  return Prisma.sql`AND t.store_id = ${storeId}::uuid`;
}

function prismaEmpty() {
  return Prisma.empty;
}
