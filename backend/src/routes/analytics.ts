import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { asyncHandler } from '../middleware/error.js';
import { assertStoreAccess, authenticate, currentUser } from '../middleware/auth.js';
import { dateKeyIn, periodStartIn, periodStartKey, REPORT_PERIODS, shiftDateKey } from '../lib/time.js';

export const analyticsRouter = Router();
analyticsRouter.use(authenticate);

const periodSchema = z.enum(REPORT_PERIODS);

/**
 * Inclusive start of the requested period, in the shop's timezone.
 *
 * Periods are calendar-aligned — "this month" starts on the 1st — and the
 * boundary is `REPORT_TIMEZONE`, not the server clock. Render runs UTC and the
 * shops are UTC+2, so a server-clock "today" would drop every sale made after
 * 22:00 into tomorrow's figures.
 */
function periodStart(period: z.infer<typeof periodSchema>): Date {
  return periodStartIn(period, env.REPORT_TIMEZONE);
}

function startOfToday(): Date {
  return periodStartIn('daily', env.REPORT_TIMEZONE);
}

const storeQuery = z.object({ store_id: z.string().uuid().optional() });

/** Scopes a query to one store, or to every store the caller may see. */
async function scope(req: Parameters<typeof currentUser>[0], storeId?: string) {
  const user = currentUser(req);
  if (storeId) {
    await assertStoreAccess(user, storeId);
    return { organizationId: user.organizationId, storeId };
  }
  if (user.role !== 'ORG_ADMIN' && user.assignedStores.length > 0) {
    return { organizationId: user.organizationId, storeId: { in: user.assignedStores } };
  }
  return { organizationId: user.organizationId };
}

/**
 * The same scoping as `scope()`, as a SQL fragment for the raw queries.
 *
 * Without the assigned-store arm, a cashier who left `store_id` off the request
 * would be answered with figures for the whole organisation — which is exactly
 * what the Prisma-side `scope()` exists to prevent.
 */
async function rawScope(req: Parameters<typeof currentUser>[0], storeId?: string) {
  const user = currentUser(req);
  if (storeId) {
    await assertStoreAccess(user, storeId);
    return Prisma.sql`AND t.store_id = ${storeId}`;
  }
  if (user.role !== 'ORG_ADMIN' && user.assignedStores.length > 0) {
    return Prisma.sql`AND t.store_id IN (${Prisma.join(user.assignedStores)})`;
  }
  return Prisma.empty;
}

analyticsRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const { store_id } = storeQuery.parse(req.query);
    const user = currentUser(req);
    const where = { ...(await scope(req, store_id)), status: { not: 'voided' as const } };

    const now = new Date();
    // Calendar week (from Monday) and calendar month, matching what the app
    // labels them — "This Week" and "This Month".
    const weekStart = periodStart('weekly');
    const monthStart = periodStart('monthly');

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
        WHERE s.organization_id = ${user.organizationId}
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
    const tz = env.REPORT_TIMEZONE;
    const lastKey = dateKeyIn(new Date(), tz);
    const firstKey = shiftDateKey(lastKey, -(q.days - 1));

    // Generated series so days with no sales still appear as zero, which is
    // what a chart needs. Both the series and the bucketing are in the shop's
    // timezone — bucketing on the stored UTC timestamp would file an evening
    // sale under the next day.
    const rows = await prisma.$queryRaw<{ date: string; total: number; count: bigint }[]>`
      SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
             COALESCE(SUM(t.total), 0)::float8 AS total,
             COUNT(t.id)::bigint AS count
      FROM generate_series(${firstKey}::date, ${lastKey}::date, '1 day') AS d(day)
      LEFT JOIN transactions t
        ON ((t.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date = d.day::date
       AND t.organization_id = ${user.organizationId}
       AND t.status <> 'voided'
       ${await rawScope(req, q.store_id)}
      GROUP BY d.day
      ORDER BY d.day
    `;

    res.json(
      rows.map((r) => ({
        date: r.date,
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
          ...(await scope(req, q.store_id)),
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
          ...(await scope(req, q.store_id)),
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
      {
        product_id: string | null;
        product_name: string;
        brand: string | null;
        qty: number;
        sales: number;
        cost: number;
        tax: number;
        profit: number;
      }[]
    >`
      SELECT ti.product_id,
             ti.product_name,
             ti.brand,
             SUM(ti.quantity)::float8 AS qty,
             SUM(ti.line_total)::float8 AS sales,
             SUM(ti.cost_price * ti.quantity)::float8 AS cost,
             SUM(ti.tax_amount)::float8 AS tax,
             SUM(ti.line_total - ti.tax_amount - (ti.cost_price * ti.quantity))::float8 AS profit
      FROM transaction_items ti
      JOIN transactions t ON t.id = ti.transaction_id
      WHERE t.organization_id = ${user.organizationId}
        AND t.status <> 'voided'
        AND t.created_at >= ${since}
        ${await rawScope(req, q.store_id)}
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
        cost: Number(r.cost),
        tax: Number(r.tax),
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
        ...(await scope(req)),
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

    const visible =
      user.role !== 'ORG_ADMIN' && user.assignedStores.length > 0
        ? Prisma.sql`AND s.id IN (${Prisma.join(user.assignedStores)})`
        : Prisma.empty;

    const rows = await prisma.$queryRaw<
      { store_id: string; branch: string; sales: number; cost: number; tax: number; profit: number }[]
    >`
      SELECT s.id AS store_id,
             s.name AS branch,
             COALESCE(SUM(ti.line_total), 0)::float8 AS sales,
             COALESCE(SUM(ti.cost_price * ti.quantity), 0)::float8 AS cost,
             COALESCE(SUM(ti.tax_amount), 0)::float8 AS tax,
             COALESCE(SUM(ti.line_total - ti.tax_amount - (ti.cost_price * ti.quantity)), 0)::float8 AS profit
      FROM stores s
      LEFT JOIN transactions t
        ON t.store_id = s.id AND t.status <> 'voided' AND t.created_at >= ${since}
      LEFT JOIN transaction_items ti ON ti.transaction_id = t.id
      WHERE s.organization_id = ${user.organizationId}
      ${visible}
      GROUP BY s.id, s.name
      ORDER BY profit DESC
    `;

    res.json(
      rows.map((r) => ({
        store_id: r.store_id,
        branch: r.branch,
        sales: Number(r.sales),
        cost: Number(r.cost),
        tax: Number(r.tax),
        profit: Number(r.profit),
      }))
    );
  })
);

/**
 * What a period's takings were actually made of: the cost of the goods, the VAT
 * that belongs to ZRA, and the gross profit left over.
 *
 * The three add up to the selling price exactly, which is the point — it is the
 * one breakdown a shopkeeper can check against the till. Profit uses the cost
 * captured on each line at the time of sale, so a later supplier price rise
 * cannot rewrite a month that has already closed.
 */
analyticsRouter.get(
  '/margin-summary',
  asyncHandler(async (req, res) => {
    const q = z
      .object({ store_id: z.string().uuid().optional(), period: periodSchema.default('monthly') })
      .parse(req.query);

    const user = currentUser(req);
    const filter = await rawScope(req, q.store_id);
    const since = periodStart(q.period);

    const rows = await prisma.$queryRaw<
      { selling: number; cost: number; tax: number; units: number; transactions: bigint }[]
    >`
      SELECT COALESCE(SUM(ti.line_total), 0)::float8 AS selling,
             COALESCE(SUM(ti.cost_price * ti.quantity), 0)::float8 AS cost,
             COALESCE(SUM(ti.tax_amount), 0)::float8 AS tax,
             COALESCE(SUM(ti.quantity), 0)::float8 AS units,
             COUNT(DISTINCT t.id)::bigint AS transactions
      FROM transaction_items ti
      JOIN transactions t ON t.id = ti.transaction_id
      WHERE t.organization_id = ${user.organizationId}
        AND t.status <> 'voided'
        AND t.created_at >= ${since}
        ${filter}
    `;

    const row = rows[0];
    const selling = Number(row?.selling ?? 0);
    const cost = Number(row?.cost ?? 0);
    const tax = Number(row?.tax ?? 0);
    const grossProfit = selling - tax - cost;

    res.json({
      period: q.period,
      period_start: periodStartKey(q.period, env.REPORT_TIMEZONE),
      timezone: env.REPORT_TIMEZONE,
      selling_price: round2(selling),
      cost_price: round2(cost),
      tax: round2(tax),
      gross_profit: round2(grossProfit),
      /** Gross profit as a share of the selling price, or null with no sales. */
      margin_percent: selling !== 0 ? round2((grossProfit / selling) * 100) : null,
      units: Number(row?.units ?? 0),
      transactions: Number(row?.transactions ?? 0),
    });
  })
);

/** Money is summed as NUMERIC in Postgres; float8 out is only for transport. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

analyticsRouter.get(
  '/sales-summary',
  asyncHandler(async (req, res) => {
    const q = z
      .object({ store_id: z.string().uuid().optional(), period: periodSchema.default('monthly') })
      .parse(req.query);

    const agg = await prisma.transaction.aggregate({
      where: {
        ...(await scope(req, q.store_id)),
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

/* Imported last because `Prisma` is only needed to build the SQL fragments that
   `rawScope` returns; the declaration is hoisted, so the callers above see it.

   Do not add a `::uuid` cast to any bound id in this file. Prisma's default
   `String @id` maps to a `text` column, not `uuid`, so casting the parameter
   produces `text = uuid` and Postgres rejects the whole query with a 500. That
   is what it did on every raw query here until 2026-08-06. */
import { Prisma } from '@prisma/client';
