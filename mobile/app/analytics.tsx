import React, { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { analytics } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { PERIOD_LABELS } from '../src/api/types';
import { useStoreSelection } from '../src/store/storeSelection';
import { useLayout } from '../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing, splitAmount } from '../src/theme';
import {
  Badge,
  Card,
  EmptyState,
  Icon,
  Loading,
  SectionLabel,
  Select,
  type IconName,
} from '../src/ui/components';
import type {
  AnalyticsPeriod,
  ProfitPerBranchRow,
  ProfitPerProductRow,
  SalesPerBranchRow,
  SalesSummary,
  SalesTrendPoint,
  TopProduct,
} from '../src/api/types';

type Scope = 'store' | 'all';

const PERIOD_OPTIONS = (Object.keys(PERIOD_LABELS) as AnalyticsPeriod[]).map((value) => ({
  value,
  label: PERIOD_LABELS[value],
}));

/**
 * How much history the trend chart shows for each period. The window is wider
 * than the period itself on purpose — a "today" figure means nothing without
 * the week around it — while staying short enough that 1px bars don't happen.
 */
const TREND_DAYS: Record<AnalyticsPeriod, number> = { daily: 7, weekly: 30, monthly: 90 };

const CHART_HEIGHT = 132;
/** Zero days still get a visible baseline rather than disappearing entirely. */
const BAR_FLOOR = 2;

export default function AnalyticsScreen() {
  const store = useStoreSelection((s) => s.selected);
  const layout = useLayout();

  const [period, setPeriod] = useState<AnalyticsPeriod>('monthly');
  const [scope, setScope] = useState<Scope>('store');

  // Without a selected store there is nothing to scope to, so the org-wide view
  // is the only honest one.
  const effectiveScope: Scope = store ? scope : 'all';
  const storeId = effectiveScope === 'store' && store ? store.id : null;

  const summary = useQuery({
    queryKey: ['analytics', 'sales-summary', storeId, period],
    queryFn: () => analytics.salesSummary(storeId, period),
  });

  const trend = useQuery({
    queryKey: ['analytics', 'sales-trend', storeId, period],
    queryFn: () => analytics.salesTrend(storeId, TREND_DAYS[period]),
  });

  const top = useQuery({
    queryKey: ['analytics', 'top-products', storeId, period],
    queryFn: () => analytics.topProducts(storeId, 10, period),
  });

  const profit = useQuery({
    queryKey: ['analytics', 'profit-per-product', storeId, period],
    queryFn: () => analytics.profitPerProduct(storeId, period),
  });

  // Branch endpoints are org-wide by design; keying them on a store id would
  // fragment the cache for identical responses.
  const branchSales = useQuery({
    queryKey: ['analytics', 'sales-per-branch', null, period],
    queryFn: () => analytics.salesPerBranch(period),
  });

  const branchProfit = useQuery({
    queryKey: ['analytics', 'profit-per-branch', null, period],
    queryFn: () => analytics.profitPerBranch(period),
  });

  const branches = useMemo(
    () => mergeBranches(branchSales.data ?? [], branchProfit.data ?? []),
    [branchSales.data, branchProfit.data]
  );

  const refreshing =
    summary.isRefetching ||
    trend.isRefetching ||
    top.isRefetching ||
    profit.isRefetching ||
    branchSales.isRefetching ||
    branchProfit.isRefetching;

  function refreshAll() {
    void summary.refetch();
    void trend.refetch();
    void top.refetch();
    void profit.refetch();
    void branchSales.refetch();
    void branchProfit.refetch();
  }

  const scopeLabel = effectiveScope === 'store' ? (store?.name ?? 'This store') : 'All stores';

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.gutter,
          paddingBottom: spacing.xxl,
          gap: spacing.lg,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refreshAll} tintColor={colors.primary} />
        }
      >
        <Card style={{ gap: spacing.md }}>
          <Select label="Period" value={period} options={PERIOD_OPTIONS} onChange={setPeriod} />
          <Select
            label="Scope"
            value={effectiveScope}
            options={[
              { value: 'store', label: store ? store.name : 'This store' },
              { value: 'all', label: 'All stores' },
            ]}
            onChange={setScope}
            hint={
              store
                ? undefined
                : 'No store is selected on this device, so every figure is organisation-wide.'
            }
          />
        </Card>

        {/* ------------------------------------------------------------ summary */}
        <View>
          <SectionLabel>Summary · {scopeLabel}</SectionLabel>
          <Panel
            query={summary}
            loadingLabel="Adding up the period"
            isEmpty={(s: SalesSummary) => s.transactions === 0 && s.total_sales === 0}
            emptyIcon="inbox"
            emptyTitle="Nothing sold yet"
            emptyHint={`No sales recorded for ${PERIOD_LABELS[period].toLowerCase()}.`}
          >
            {(s) => <SummaryBlock summary={s} period={period} />}
          </Panel>
        </View>

        {/* -------------------------------------------------------------- trend */}
        <View>
          <SectionLabel>Sales trend · last {TREND_DAYS[period]} days</SectionLabel>
          <Panel
            query={trend}
            loadingLabel="Plotting the trend"
            isEmpty={(points: SalesTrendPoint[]) => points.length === 0}
            emptyIcon="activity"
            emptyTitle="No trend to draw"
            emptyHint="The server returned no days for this window."
          >
            {(points) => <TrendChart points={points} />}
          </Panel>
        </View>

        {/* ------------------------------------------------------- top products */}
        <View>
          <SectionLabel>Top products by revenue</SectionLabel>
          <Panel
            query={top}
            loadingLabel="Ranking products"
            isEmpty={(rows: TopProduct[]) => rows.length === 0}
            emptyIcon="package"
            emptyTitle="No products sold"
            emptyHint={`Nothing was sold ${PERIOD_LABELS[period].toLowerCase()}.`}
          >
            {(rows) => <TopProducts rows={rows} />}
          </Panel>
        </View>

        {/* ---------------------------------------------------- profit by product */}
        <View>
          <SectionLabel>Profit by product</SectionLabel>
          <Panel
            query={profit}
            loadingLabel="Working out margins"
            isEmpty={(rows: ProfitPerProductRow[]) => rows.length === 0}
            emptyIcon="trending-up"
            emptyTitle="No margin data"
            emptyHint="Profit is worked out from the cost price captured at the time of sale."
          >
            {(rows) => <ProfitByProduct rows={rows} />}
          </Panel>
        </View>

        {/* ----------------------------------------------------------- branches */}
        <View>
          <SectionLabel>Branches · across all branches</SectionLabel>
          {branchSales.isPending || branchProfit.isPending ? (
            <Card>
              <Loading label="Comparing branches" />
            </Card>
          ) : branchSales.isError || branchProfit.isError ? (
            <Card>
              <EmptyState
                icon="cloud-off"
                title="Couldn't load branches"
                hint={errorMessage(branchSales.error ?? branchProfit.error)}
              />
            </Card>
          ) : branches.length === 0 ? (
            <Card>
              <EmptyState
                icon="home"
                title="No branch activity"
                hint={`No branch recorded a sale ${PERIOD_LABELS[period].toLowerCase()}.`}
              />
            </Card>
          ) : (
            <BranchTable rows={branches} currentStoreId={store?.id ?? null} />
          )}
          <Text style={styles.footnote}>
            Branch figures always cover the whole organisation — the scope switch above does not
            apply to them.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/* ------------------------------------------------------------------- summary */

function SummaryBlock({ summary, period }: { summary: SalesSummary; period: AnalyticsPeriod }) {
  const total = splitAmount(summary.total_sales);

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={styles.hero}>
        <View style={styles.heroGlow} />
        <Text style={styles.heroLabel}>Total sales · {PERIOD_LABELS[period]}</Text>
        <Text style={styles.heroAmount}>
          {total.whole}
          <Text style={styles.heroDecimals}>{total.decimals}</Text>
        </Text>
        <View style={styles.heroMetaRow}>
          <View style={styles.heroChip}>
            <Icon name="shopping-bag" size={12} color={colors.onDark} />
            <Text style={styles.heroChipText}>
              {summary.transactions} transaction{summary.transactions === 1 ? '' : 's'}
            </Text>
          </View>
          <View style={styles.heroChip}>
            <Icon name="divide" size={12} color={colors.onDark} />
            <Text style={styles.heroChipText}>
              {formatKwacha(summary.average_transaction)} average
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.grid}>
        <Metric icon="hash" label="Transactions" value={String(summary.transactions)} />
        <Metric
          icon="divide"
          label="Average sale"
          value={formatKwacha(summary.average_transaction)}
        />
        <Metric icon="percent" label="Tax collected" value={formatKwacha(summary.tax_collected)} />
        <Metric
          icon="tag"
          label="Discounts given"
          value={formatKwacha(summary.discounts)}
          tone={summary.discounts > 0 ? colors.accentDeep : undefined}
        />
      </View>
    </View>
  );
}

function Metric({
  icon,
  label,
  value,
  tone,
}: {
  icon: IconName;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <Card style={styles.metric}>
      <View style={styles.metricIcon}>
        <Icon name={icon} size={14} color={colors.primary} />
      </View>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, tone ? { color: tone } : null]} numberOfLines={1}>
        {value}
      </Text>
    </Card>
  );
}

/* --------------------------------------------------------------------- trend */

function TrendChart({ points }: { points: SalesTrendPoint[] }) {
  const max = points.reduce((m, p) => Math.max(m, p.total), 0);
  const peakIndex = max > 0 ? points.findIndex((p) => p.total === max) : -1;
  const peak = peakIndex >= 0 ? points[peakIndex] : null;
  const total = points.reduce((sum, p) => sum + p.total, 0);

  // 90 bars on a phone leaves no room for a gap; drop to a hairline instead of
  // letting the bars themselves shrink below a pixel.
  const gap = points.length > 45 ? 1 : 2;

  // Only three labels — a date under every bar is unreadable on a phone.
  const labelIndexes = [0, Math.floor((points.length - 1) / 2), points.length - 1];

  return (
    <Card>
      <View style={[styles.plot, { gap }]}>
        {points.map((p, index) => {
          const height = max > 0 ? Math.max(BAR_FLOOR, (p.total / max) * CHART_HEIGHT) : BAR_FLOOR;
          const isPeak = index === peakIndex;
          return (
            <View
              key={p.date}
              style={[
                styles.bar,
                { height, backgroundColor: isPeak ? colors.accent : colors.primary },
              ]}
            />
          );
        })}
      </View>

      <View style={styles.axis}>
        {labelIndexes.map((index, slot) => (
          <Text
            key={`${index}-${slot}`}
            style={[
              styles.axisLabel,
              slot === 1 && { textAlign: 'center' },
              slot === 2 && { textAlign: 'right' },
            ]}
          >
            {points[index] ? shortDate(points[index].date) : ''}
          </Text>
        ))}
      </View>

      <View style={styles.trendFoot}>
        {peak ? (
          <View style={styles.peakRow}>
            <View style={styles.peakSwatch} />
            <Text style={styles.peakText}>
              Peak {shortDate(peak.date)} · {formatKwacha(peak.total)}
            </Text>
          </View>
        ) : (
          <Text style={styles.peakText}>No sales in this window.</Text>
        )}
        <Text style={styles.trendTotal}>{formatKwacha(total)} total</Text>
      </View>
    </Card>
  );
}

/* -------------------------------------------------------------- top products */

function TopProducts({ rows }: { rows: TopProduct[] }) {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  const max = sorted.reduce((m, r) => Math.max(m, r.total), 0);

  return (
    <Card>
      {sorted.map((row, index) => (
        <RankedRow
          key={row.product_id ?? `${row.product_name}-${index}`}
          rank={index + 1}
          name={row.product_name}
          meta={`${row.quantity} sold`}
          value={formatKwacha(row.total)}
          fill={max > 0 ? (row.total / max) * 100 : 0}
          highlight={index === 0}
        />
      ))}
    </Card>
  );
}

/* ---------------------------------------------------------- profit by product */

function ProfitByProduct({ rows }: { rows: ProfitPerProductRow[] }) {
  const sorted = [...rows].sort((a, b) => b.profit - a.profit);
  const losses = sorted.filter((r) => r.profit < 0);
  // Best ten by profit, then every loss-making line regardless of where it fell
  // in that ranking — a product sold below cost must never be cut off by a
  // top-N slice, because it is the whole reason to look at this section.
  const earners = sorted.filter((r) => r.profit >= 0).slice(0, 10);
  const max = earners.reduce((m, r) => Math.max(m, r.profit), 0);
  const worst = losses.reduce((m, r) => Math.max(m, Math.abs(r.profit)), 0);

  return (
    <View style={{ gap: spacing.sm }}>
      {losses.length > 0 ? (
        <View style={styles.alert}>
          <Icon name="alert-triangle" size={16} color={colors.danger} />
          <Text style={styles.alertText}>
            {losses.length} product{losses.length === 1 ? ' is' : 's are'} selling below cost.
          </Text>
        </View>
      ) : null}

      <Card>
        {earners.length === 0 ? (
          <Text style={styles.subtle}>No product turned a profit in this period.</Text>
        ) : (
          earners.map((row, index) => (
            <RankedRow
              key={row.product_id ?? `${row.product_name}-${index}`}
              rank={index + 1}
              name={row.product_name}
              meta={`${row.quantity} sold · ${formatKwacha(row.sales)} sales`}
              value={formatKwacha(row.profit)}
              fill={max > 0 ? (row.profit / max) * 100 : 0}
              highlight={index === 0}
            />
          ))
        )}

        {losses.length > 0 ? (
          <>
            <View style={styles.lossHead}>
              <Text style={styles.lossHeadText}>Sold below cost</Text>
              <Badge label="LOSS" tone="danger" dot />
            </View>
            {losses.map((row, index) => (
              <RankedRow
                key={row.product_id ?? `loss-${row.product_name}-${index}`}
                name={row.product_name}
                meta={`${row.quantity} sold · ${formatKwacha(row.sales)} sales`}
                value={formatKwacha(row.profit)}
                fill={worst > 0 ? (Math.abs(row.profit) / worst) * 100 : 0}
                negative
              />
            ))}
          </>
        ) : null}
      </Card>
    </View>
  );
}

/**
 * One row of a ranked list, with the proportional bar drawn behind the text
 * rather than beside it — on a phone there is no width to spare for a separate
 * chart column.
 */
function RankedRow({
  rank,
  name,
  meta,
  value,
  fill,
  highlight,
  negative,
}: {
  rank?: number;
  name: string;
  meta: string;
  value: string;
  fill: number;
  highlight?: boolean;
  negative?: boolean;
}) {
  const barColor = negative
    ? colors.dangerSoft
    : highlight
      ? colors.accentSoft
      : colors.primarySoft;

  return (
    <View style={styles.ranked}>
      <View style={[styles.rankedFill, { width: pct(fill), backgroundColor: barColor }]} />
      {rank !== undefined ? <Text style={styles.rankedNum}>{rank}</Text> : null}
      <View style={{ flex: 1 }}>
        <Text style={styles.rankedName} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.rankedMeta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <Text style={[styles.rankedValue, negative && { color: colors.danger }]}>{value}</Text>
    </View>
  );
}

/* ------------------------------------------------------------------ branches */

interface BranchRow {
  store_id: string;
  branch: string;
  transactions: number;
  sales: number;
  profit: number;
}

function BranchTable({
  rows,
  currentStoreId,
}: {
  rows: BranchRow[];
  currentStoreId: string | null;
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.sales), 0);

  return (
    <Card padded={false} style={{ overflow: 'hidden' }}>
      <View style={styles.tableHead}>
        <Text style={[styles.tableHeadCell, { flex: 1 }]}>Branch</Text>
        <Text style={[styles.tableHeadCell, styles.cellNum]}>Sales</Text>
        <Text style={[styles.tableHeadCell, styles.cellNum]}>Profit</Text>
        <Text style={[styles.tableHeadCell, styles.cellPct]}>Margin</Text>
      </View>

      {rows.map((row, index) => {
        const mine = row.store_id === currentStoreId;
        const margin = row.sales !== 0 ? (row.profit / row.sales) * 100 : null;
        return (
          <View key={row.store_id} style={[styles.tableRow, mine && styles.tableRowMine]}>
            <View
              style={[
                styles.tableFill,
                {
                  width: pct(max > 0 ? (row.sales / max) * 100 : 0),
                  backgroundColor: index === 0 ? colors.accentSoft : colors.primarySoft,
                },
              ]}
            />
            <View style={{ flex: 1, paddingRight: spacing.sm }}>
              <Text style={styles.branchName} numberOfLines={1}>
                {row.branch}
              </Text>
              <Text style={styles.branchMeta}>
                {row.transactions} transaction{row.transactions === 1 ? '' : 's'}
                {mine ? ' · your store' : ''}
              </Text>
            </View>
            <Text style={[styles.cellValue, styles.cellNum]} numberOfLines={1}>
              {formatKwacha(row.sales)}
            </Text>
            <Text
              style={[styles.cellValue, styles.cellNum, row.profit < 0 && { color: colors.danger }]}
              numberOfLines={1}
            >
              {formatKwacha(row.profit)}
            </Text>
            <Text
              style={[
                styles.cellValue,
                styles.cellPct,
                margin !== null && margin < 0 && { color: colors.danger },
              ]}
            >
              {margin === null ? '—' : `${margin.toFixed(1)}%`}
            </Text>
          </View>
        );
      })}
    </Card>
  );
}

/** Sales and profit arrive from two endpoints; a branch present in either shows. */
function mergeBranches(sales: SalesPerBranchRow[], profit: ProfitPerBranchRow[]): BranchRow[] {
  const merged = new Map<string, BranchRow>();

  for (const row of sales) {
    merged.set(row.store_id, {
      store_id: row.store_id,
      branch: row.branch,
      transactions: row.transactions,
      sales: row.sales,
      profit: 0,
    });
  }

  for (const row of profit) {
    const existing = merged.get(row.store_id);
    if (existing) {
      existing.profit = row.profit;
      // Prefer the sales endpoint's figure, but don't show a blank if only the
      // profit endpoint knows about this branch.
      if (!existing.sales) existing.sales = row.sales;
    } else {
      merged.set(row.store_id, {
        store_id: row.store_id,
        branch: row.branch,
        transactions: 0,
        sales: row.sales,
        profit: row.profit,
      });
    }
  }

  return [...merged.values()].sort((a, b) => b.sales - a.sales);
}

/* ------------------------------------------------------------------- plumbing */

/** Loading / failed / empty handling, so each section says the same things. */
function Panel<T>({
  query,
  isEmpty,
  emptyIcon,
  emptyTitle,
  emptyHint,
  loadingLabel,
  children,
}: {
  query: UseQueryResult<T, Error>;
  isEmpty?: (data: T) => boolean;
  emptyIcon: IconName;
  emptyTitle: string;
  emptyHint?: string;
  loadingLabel?: string;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) {
    return (
      <Card>
        <Loading label={loadingLabel} />
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <EmptyState icon="cloud-off" title="Couldn't load" hint={errorMessage(query.error)} />
      </Card>
    );
  }

  if (isEmpty?.(query.data)) {
    return (
      <Card>
        <EmptyState icon={emptyIcon} title={emptyTitle} hint={emptyHint} />
      </Card>
    );
  }

  return <>{children(query.data)}</>;
}

/** Clamped percentage width, typed so React Native accepts it as a dimension. */
function pct(value: number): `${number}%` {
  return `${Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))}%` as `${number}%`;
}

function shortDate(key: string): string {
  // `new Date('2026-08-06')` is parsed as UTC midnight, which can render as the
  // previous day west of Greenwich. Build the date in local time instead.
  const [year, month, day] = key.split('-').map(Number);
  if (!year || !month || !day) return key;
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  footnote: {
    fontFamily: font.regular,
    fontSize: 11,
    color: colors.textFaint,
    lineHeight: 16,
    marginTop: spacing.sm,
  },
  subtle: { fontFamily: font.regular, fontSize: 13, color: colors.textMuted },

  hero: {
    backgroundColor: colors.primaryDeep,
    borderRadius: radius.xl,
    padding: spacing.xl,
    overflow: 'hidden',
    ...shadow.raised,
  },
  heroGlow: {
    position: 'absolute',
    top: -70,
    right: -50,
    width: 190,
    height: 190,
    borderRadius: 95,
    backgroundColor: colors.primaryBright,
    opacity: 0.4,
  },
  heroLabel: {
    fontFamily: font.medium,
    fontSize: 11,
    color: colors.onDarkMuted,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  heroAmount: {
    fontFamily: font.extrabold,
    fontSize: 38,
    color: colors.onDark,
    letterSpacing: -1.4,
    marginTop: 6,
  },
  heroDecimals: { fontFamily: font.bold, fontSize: 21, color: colors.onDarkMuted },
  heroMetaRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg, flexWrap: 'wrap' },
  heroChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.13)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  heroChipText: { fontFamily: font.semibold, fontSize: 11, color: colors.onDark },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  metric: { flexGrow: 1, flexBasis: '46%', padding: spacing.md },
  metricIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  metricLabel: { fontFamily: font.medium, fontSize: 11, color: colors.textMuted },
  metricValue: {
    fontFamily: font.extrabold,
    fontSize: 18,
    color: colors.text,
    letterSpacing: -0.5,
    marginTop: 2,
  },

  plot: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: CHART_HEIGHT,
    backgroundColor: colors.canvas,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
  },
  bar: { flex: 1, borderRadius: radius.sm, minWidth: 2 },
  axis: { flexDirection: 'row', marginTop: spacing.sm },
  axisLabel: { flex: 1, fontFamily: font.medium, fontSize: 10, color: colors.textFaint },

  trendFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  peakRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  peakSwatch: { width: 10, height: 10, borderRadius: 3, backgroundColor: colors.accent },
  peakText: { fontFamily: font.medium, fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  trendTotal: { fontFamily: font.bold, fontSize: 13, color: colors.text },

  ranked: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    overflow: 'hidden',
    marginBottom: 2,
  },
  rankedFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: radius.sm },
  rankedNum: { width: 18, fontFamily: font.extrabold, fontSize: 13, color: colors.textFaint },
  rankedName: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  rankedMeta: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 2 },
  rankedValue: { fontFamily: font.bold, fontSize: 14, color: colors.text },

  alert: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  alertText: { flex: 1, fontFamily: font.semibold, fontSize: 12, color: colors.danger },

  lossHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginBottom: spacing.xs,
  },
  lossHeadText: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },

  tableHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceSunken,
  },
  tableHeadCell: {
    fontFamily: font.semibold,
    fontSize: 10,
    color: colors.textFaint,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    overflow: 'hidden',
  },
  tableRowMine: { borderLeftWidth: 3, borderLeftColor: colors.primary },
  tableFill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  branchName: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  branchMeta: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 2 },
  cellValue: { fontFamily: font.semibold, fontSize: 12, color: colors.text, textAlign: 'right' },
  cellNum: { width: 82, textAlign: 'right' },
  cellPct: { width: 54, textAlign: 'right' },
});
