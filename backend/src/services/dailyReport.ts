import { Prisma } from '@prisma/client';

import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { num } from '../lib/serialize.js';
import { dateKeyIn, dayRangeIn, previousDateKey } from '../lib/time.js';

export interface DailyReportFigures {
  store_id: string;
  date: string;
  transaction_count: number;
  /** Net of refunds. */
  gross_total: number;
  tax_total: number;
  refund_total: number;
  by_payment_method: { cash: number; card: number; mobile: number };
  top_items: { name: string; quantity: number; total: number }[];
  /** True when read from a sealed snapshot rather than computed live. */
  finalized: boolean;
  generated_at: string;
}

const TOP_ITEM_LIMIT = 5;

/** Today's date key in the reporting timezone. */
export function todayKey(): string {
  return dateKeyIn(new Date(), env.REPORT_TIMEZONE);
}

export function yesterdayKey(): string {
  return previousDateKey(todayKey());
}

/**
 * Totals one store-day straight from the transaction table.
 *
 * Voided rows are excluded, refunds carry negative totals (so `gross_total` is
 * already net), and only real tenders count towards the payment split — a
 * refund's payment rows are recorded at zero.
 */
export async function computeDailyFigures(
  storeId: string,
  date: string
): Promise<Omit<DailyReportFigures, 'finalized' | 'generated_at'>> {
  const { start, end } = dayRangeIn(date, env.REPORT_TIMEZONE);

  const rows = await prisma.transaction.findMany({
    where: {
      storeId,
      status: { not: 'voided' },
      createdAt: { gte: start, lt: end },
    },
    include: { items: true, payments: true },
  });

  const byMethod = { cash: 0, card: 0, mobile: 0 };
  const tally = new Map<string, { name: string; quantity: number; total: number }>();
  let gross = 0;
  let tax = 0;
  let refunds = 0;

  for (const t of rows) {
    gross += num(t.total);
    tax += num(t.taxAmount);
    if (t.transactionType !== 'sale') refunds += Math.abs(num(t.total));

    for (const p of t.payments) {
      if (p.method in byMethod) byMethod[p.method as keyof typeof byMethod] += num(p.amount);
    }

    if (t.transactionType !== 'sale') continue;
    for (const item of t.items) {
      const entry = tally.get(item.productName) ?? { name: item.productName, quantity: 0, total: 0 };
      entry.quantity += num(item.quantity);
      entry.total += num(item.lineTotal);
      tally.set(item.productName, entry);
    }
  }

  return {
    store_id: storeId,
    date,
    transaction_count: rows.length,
    gross_total: round(gross),
    tax_total: round(tax),
    refund_total: round(refunds),
    by_payment_method: {
      cash: round(byMethod.cash),
      card: round(byMethod.card),
      mobile: round(byMethod.mobile),
    },
    top_items: [...tally.values()]
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, TOP_ITEM_LIMIT)
      .map((i) => ({ ...i, quantity: round(i.quantity), total: round(i.total) })),
  };
}

/**
 * Writes (or refreshes) the snapshot for one store-day.
 *
 * `finalize` seals the row: once the day is over the figures should never move
 * again, so a sealed row is not recomputed on a later run. That is what makes
 * the printed Z-report and the stored one agree months later.
 */
export async function snapshotStoreDay(
  storeId: string,
  date: string,
  options: { finalize?: boolean } = {}
): Promise<DailyReportFigures> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { organizationId: true },
  });
  if (!store) throw new Error(`Unknown store ${storeId}`);

  const existing = await prisma.dailyReport.findUnique({
    where: { storeId_date: { storeId, date } },
  });
  if (existing?.finalized) return fromRow(existing);

  const figures = await computeDailyFigures(storeId, date);
  const data = {
    organizationId: store.organizationId,
    storeId,
    date,
    transactionCount: figures.transaction_count,
    grossTotal: new Prisma.Decimal(figures.gross_total),
    taxTotal: new Prisma.Decimal(figures.tax_total),
    refundTotal: new Prisma.Decimal(figures.refund_total),
    cashTotal: new Prisma.Decimal(figures.by_payment_method.cash),
    cardTotal: new Prisma.Decimal(figures.by_payment_method.card),
    mobileTotal: new Prisma.Decimal(figures.by_payment_method.mobile),
    topItems: figures.top_items as unknown as Prisma.InputJsonValue,
    finalized: options.finalize ?? false,
  };

  const row = await prisma.dailyReport.upsert({
    where: { storeId_date: { storeId, date } },
    create: data,
    update: data,
  });

  return fromRow(row);
}

/** Snapshots every active store for one date. Never throws for one bad store. */
export async function snapshotAllStores(
  date: string,
  options: { finalize?: boolean } = {}
): Promise<{ date: string; stores: number; failed: number }> {
  const stores = await prisma.store.findMany({ where: { isActive: true }, select: { id: true } });

  let failed = 0;
  for (const store of stores) {
    try {
      await snapshotStoreDay(store.id, date, options);
    } catch (err) {
      // One store's failure must not cost the other twelve their reports.
      failed += 1;
      console.error(`[daily-report] ${store.id} ${date} failed:`, err);
    }
  }

  return { date, stores: stores.length - failed, failed };
}

/**
 * What the API serves: the sealed snapshot when there is one, live figures
 * otherwise. Today's report is always live — the day isn't over yet.
 */
export async function readDailyReport(
  storeId: string,
  date: string
): Promise<DailyReportFigures> {
  if (date !== todayKey()) {
    const row = await prisma.dailyReport.findUnique({
      where: { storeId_date: { storeId, date } },
    });
    if (row?.finalized) return fromRow(row);
  }

  const figures = await computeDailyFigures(storeId, date);
  return { ...figures, finalized: false, generated_at: new Date().toISOString() };
}

function fromRow(row: {
  storeId: string;
  date: string;
  transactionCount: number;
  grossTotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  refundTotal: Prisma.Decimal;
  cashTotal: Prisma.Decimal;
  cardTotal: Prisma.Decimal;
  mobileTotal: Prisma.Decimal;
  topItems: Prisma.JsonValue;
  finalized: boolean;
  generatedAt: Date;
}): DailyReportFigures {
  return {
    store_id: row.storeId,
    date: row.date,
    transaction_count: row.transactionCount,
    gross_total: num(row.grossTotal),
    tax_total: num(row.taxTotal),
    refund_total: num(row.refundTotal),
    by_payment_method: {
      cash: num(row.cashTotal),
      card: num(row.cardTotal),
      mobile: num(row.mobileTotal),
    },
    top_items: Array.isArray(row.topItems)
      ? (row.topItems as unknown as DailyReportFigures['top_items'])
      : [],
    finalized: row.finalized,
    generated_at: row.generatedAt.toISOString(),
  };
}

function round(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
