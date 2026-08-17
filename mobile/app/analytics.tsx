import React, { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { analytics, stores as storesApi } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { PERIOD_LABELS } from '../src/api/types';
import { useAuth, useCan } from '../src/store/auth';
import { placeLabel, warehouseFirst } from '../src/store/place';
import { useStoreSelection } from '../src/store/storeSelection';
import { useLayout } from '../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing, splitAmount } from '../src/theme';
import { Donut, DonutLegend, type DonutSlice } from '../src/ui/Donut';
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
  MarginSummary,
  ProfitPerBranchRow,
  ProfitPerProductRow,
  SalesPerBranchRow,
  SalesSummary,
  SalesTrendPoint,
  TopProduct,
} from '../src/api/types';

/** Sentinel for the store picker: the whole organisation rather than one shop. */
const ALL_SHOPS = 'all';

const PERIOD_OPTIONS = (Object.keys(PERIOD_LABELS) as AnalyticsPeriod[]).map((value) => ({
  value,
  label: PERIOD_LABELS[value],
}));

/**
 * How much history the trend chart shows for each period. The window is wider
 * than the period itself on purpose — a "today" figure means nothing without
 * the week around it — while staying short enough that 1px bars don't happen.
 *
 * Quarterly and yearly stop well short of their own length: 365 bars on a phone
 * is a smear, and the trend is there to show shape, not to be read off.
 */
const TREND_DAYS: Record<AnalyticsPeriod, number> = {
  daily: 7,
  weekly: 30,
  monthly: 90,
  quarterly: 120,
  yearly: 365,
};

/**
 * The three parts of a selling price. Grey is money that left for the supplier,
 * gold is money owed onward to ZRA, green is what the shop actually kept — the
 * colours carry that meaning everywhere they appear, ring and bars alike.
 */
const PART_COLORS = {
  cost: '#8B8178',
  tax: colors.accent,
  profit: colors.primaryBright,
};

const CHART_HEIGHT = 132;
/** Zero days still get a visible baseline rather than disappearing entirely. */
const BAR_FLOOR = 2;

export default function AnalyticsScreen() {
  const store = useStoreSelection((s) => s.selected);
  const user = useAuth((s) => s.user);
  const layout = useLayout();

  const [period, setPeriod] = useState<AnalyticsPeriod>('monthly');
  // Opens on the till's own shop, because that is whose figures the person
  // holding the device is nearly always after.
  const [scope, setScope] = useState<string>(store?.id ?? ALL_SHOPS);
  const [focusProductId, setFocusProductId] = useState<string | null>(null);
  const seesCosts = useCan('costs.view');

  const storeList = useQuery({ queryKey: ['stores'], queryFn: () => storesApi.list() });

  /**
   * An admin reports on any shop. Everyone else is held to the shops they are
   * assigned to — the same set the server would allow, so the picker cannot
   * offer a choice that comes back empty. An unrestricted user (no assignments)
   * sees them all, which is what the backend's own scope check does.
   */
  const visibleStores = useMemo(() => {
    const active = (storeList.data ?? []).filter((s) => s.is_active);
    if (!user || user.role === 'ORG_ADMIN') return active;
    const assigned = user.assigned_stores;
    if (!assigned || assigned.length === 0) return active;
    return active.filter((s) => assigned.includes(s.id));
  }, [storeList.data, user]);

  // A shop can be deactivated, or unassigned from this user, while it is the
  // one selected here. Fall back to the whole organisation rather than report
  // on a shop that no longer answers — but only once the list has actually
  // loaded, or the first render would discard a perfectly good selection.
  const scopeIsKnown =
    scope === ALL_SHOPS || !storeList.data || visibleStores.some((s) => s.id === scope);
  const effectiveScope = scopeIsKnown ? scope : ALL_SHOPS;
  const storeId = effectiveScope === ALL_SHOPS ? null : effectiveScope;

  const storeOptions = useMemo(
    () => [
      { value: ALL_SHOPS, label: 'All shops' },
      // The warehouse is in this list too, and it reports very different
      // figures — mostly stock moving, very little selling. Say which one it is.
      ...warehouseFirst(visibleStores).map((s) => ({ value: s.id, label: placeLabel(s) })),
    ],
    [visibleStores]
  );

  const margin = useQuery({
    queryKey: ['analytics', 'margin-summary', storeId, period],
    queryFn: () => analytics.marginSummary(storeId, period),
  });

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
    margin.isRefetching ||
    summary.isRefetching ||
    trend.isRefetching ||
    top.isRefetching ||
    profit.isRefetching ||
    branchSales.isRefetching ||
    branchProfit.isRefetching;

  function refreshAll() {
    void storeList.refetch();
    void margin.refetch();
    void summary.refetch();
    void trend.refetch();
    void top.refetch();
    void profit.refetch();
    void branchSales.refetch();
    void branchProfit.refetch();
  }

  const scopeLabel =
    storeId === null
      ? 'All shops'
      : (visibleStores.find((s) => s.id === storeId)?.name ?? store?.name ?? 'This shop');

  // The focused product is looked up in the rows currently on screen rather than
  // held as state of its own, so changing period or shop silently drops a
  // product that is no longer in the results instead of showing stale slices.
  const focus = useMemo(
    () => (profit.data ?? []).find((r) => r.product_id === focusProductId) ?? null,
    [profit.data, focusProductId]
  );

  const breakdown: Breakdown | null = focus
    ? {
        label: focus.product_name,
        selling: focus.sales,
        cost: focus.cost,
        tax: focus.tax,
        profit: focus.profit,
      }
    : margin.data
      ? {
          label: scopeLabel,
          selling: margin.data.selling_price,
          cost: margin.data.cost_price,
          tax: margin.data.tax,
          profit: margin.data.gross_profit,
        }
      : null;

  // Every panel on this screen is built from the buying price, and the three
  // endpoints behind them now refuse an account without `costs.view`. The link
  // into it is hidden from the same accounts, but a handset can be sitting on
  // this route when its permissions change, and half a dozen red error cards is
  // a worse answer than one plain sentence.
  if (!seesCosts) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="lock"
          title="Not your screen"
          hint="Margins and profit are kept to the owner and the warehouse. Today's takings are on the Reports tab."
        />
      </SafeAreaView>
    );
  }

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
            label="Shop"
            value={effectiveScope}
            options={storeOptions}
            onChange={setScope}
            hint={
              storeList.isError
                ? "Couldn't load the shop list, so only the organisation-wide view is available."
                : undefined
            }
          />
        </Card>

        {/* ------------------------------------------------- what the money was */}
        <View>
          <SectionLabel>Where the money went · {scopeLabel}</SectionLabel>
          <Panel
            query={margin}
            loadingLabel="Splitting cost from profit"
            isEmpty={(m: MarginSummary) => m.selling_price === 0 && m.transactions === 0}
            emptyIcon="pie-chart"
            emptyTitle="Nothing sold yet"
            emptyHint={`No sales recorded for ${PERIOD_LABELS[period].toLowerCase()}.`}
          >
            {() =>
              breakdown ? (
                <MarginBlock
                  breakdown={breakdown}
                  isProduct={Boolean(focus)}
                  onClearFocus={() => setFocusProductId(null)}
                />
              ) : null
            }
          </Panel>
        </View>

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
          <SectionLabel>Product by product · {scopeLabel}</SectionLabel>
          <Panel
            query={profit}
            loadingLabel="Working out margins"
            isEmpty={(rows: ProfitPerProductRow[]) => rows.length === 0}
            emptyIcon="trending-up"
            emptyTitle="No margin data"
            emptyHint="Profit is worked out from the cost price captured at the time of sale."
          >
            {(rows) => (
              <ProfitByProduct
                rows={rows}
                focusId={focus?.product_id ?? null}
                onFocus={(id) => setFocusProductId((current) => (current === id ? null : id))}
              />
            )}
          </Panel>
          <Text style={styles.footnote}>
            Each bar is that product's takings, split into what the goods cost, the VAT, and what
            the shop kept. Tap a product to break it out in the ring above.
          </Text>
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
            Branch figures compare every shop you can see against each other, so the shop picker
            above does not narrow them — only the period does.
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

/* ------------------------------------------------------------------- margin */

interface Breakdown {
  label: string;
  selling: number;
  cost: number;
  tax: number;
  profit: number;
}

/**
 * The client asked for a pie of cost price, selling price and gross profit.
 * Drawn literally that is a lie: cost + profit *is* the selling price, so the
 * three would sum to twice the takings and every slice would be half its true
 * share. What is drawn instead is the selling price as the whole ring, cut into
 * the three things it is actually made of — cost, VAT, and what the shop kept.
 * All three figures the client named are still on screen, and they now add up.
 */
function MarginBlock({
  breakdown,
  isProduct,
  onClearFocus,
}: {
  breakdown: Breakdown;
  isProduct: boolean;
  onClearFocus: () => void;
}) {
  const slices: DonutSlice[] = [
    { key: 'cost', label: 'Cost of goods', value: breakdown.cost, color: PART_COLORS.cost },
    { key: 'tax', label: 'VAT', value: breakdown.tax, color: PART_COLORS.tax },
    { key: 'profit', label: 'Gross profit', value: breakdown.profit, color: PART_COLORS.profit },
  ];

  // A ring can only show parts of a whole. Sold below cost, the parts no longer
  // are parts — so the figures are shown without a chart rather than drawing a
  // shape that quietly hides the loss.
  const drawable = breakdown.selling > 0 && slices.every((s) => s.value >= 0);
  const marginPercent = breakdown.selling !== 0 ? (breakdown.profit / breakdown.selling) * 100 : null;

  return (
    <Card style={{ gap: spacing.md }}>
      {isProduct ? (
        <Pressable onPress={onClearFocus} style={styles.focusChip} hitSlop={6}>
          <Icon name="corner-up-left" size={12} color={colors.primary} />
          <Text style={styles.focusChipText} numberOfLines={1}>
            {breakdown.label} — tap to show every product
          </Text>
        </Pressable>
      ) : null}

      {drawable ? (
        <View style={styles.donutRow}>
          <Donut
            slices={slices}
            caption="Takings"
            value={formatKwacha(breakdown.selling)}
            holeColor={colors.surface}
          />
          <DonutLegend slices={slices} total={breakdown.selling} format={formatKwacha} />
        </View>
      ) : (
        <>
          <View style={styles.alert}>
            <Icon name="alert-triangle" size={16} color={colors.danger} />
            <Text style={styles.alertText}>
              {breakdown.selling > 0
                ? 'These goods sold for less than they cost, so there is no whole to divide.'
                : 'Nothing was sold, so there is nothing to divide.'}
            </Text>
          </View>
          <DonutLegend slices={slices} total={breakdown.selling} format={formatKwacha} />
        </>
      )}

      <View style={styles.marginFoot}>
        <Text style={styles.marginFootLabel}>Gross margin</Text>
        <Text
          style={[
            styles.marginFootValue,
            marginPercent !== null && marginPercent < 0 && { color: colors.danger },
          ]}
        >
          {marginPercent === null ? '—' : `${marginPercent.toFixed(1)}%`}
        </Text>
      </View>
    </Card>
  );
}

/* ---------------------------------------------------------- profit by product */

function ProfitByProduct({
  rows,
  focusId,
  onFocus,
}: {
  rows: ProfitPerProductRow[];
  focusId: string | null;
  onFocus: (id: string) => void;
}) {
  const sorted = [...rows].sort((a, b) => b.profit - a.profit);
  const losses = sorted.filter((r) => r.profit < 0);
  // Best ten by profit, then every loss-making line regardless of where it fell
  // in that ranking — a product sold below cost must never be cut off by a
  // top-N slice, because it is the whole reason to look at this section.
  const earners = sorted.filter((r) => r.profit >= 0).slice(0, 10);
  // Bars are scaled against the biggest *takings* on show, not the biggest
  // profit, so bar length reads as "how much this product sold" and the colours
  // inside it read as "and where that money went".
  const max = [...earners, ...losses].reduce((m, r) => Math.max(m, r.sales), 0);

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
            <ProductBar
              key={row.product_id ?? `${row.product_name}-${index}`}
              rank={index + 1}
              row={row}
              max={max}
              focused={row.product_id !== null && row.product_id === focusId}
              onPress={row.product_id ? () => onFocus(row.product_id as string) : undefined}
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
              <ProductBar
                key={row.product_id ?? `loss-${row.product_name}-${index}`}
                row={row}
                max={max}
                focused={row.product_id !== null && row.product_id === focusId}
                onPress={row.product_id ? () => onFocus(row.product_id as string) : undefined}
              />
            ))}
          </>
        ) : null}
      </Card>
    </View>
  );
}

/**
 * One product's takings as a stacked bar: cost, VAT, then profit, in the same
 * colours as the ring above. A loss-making product simply has no green segment,
 * which is the point — the eye finds it without reading a single figure.
 */
function ProductBar({
  rank,
  row,
  max,
  focused,
  onPress,
}: {
  rank?: number;
  row: ProfitPerProductRow;
  max: number;
  focused: boolean;
  onPress?: () => void;
}) {
  const cost = Math.max(0, row.cost);
  const tax = Math.max(0, row.tax);
  const profit = Math.max(0, row.profit);
  const parts = cost + tax + profit;

  // Length is this product's share of the biggest seller; the floor keeps a
  // small line from vanishing to nothing.
  const width = max > 0 ? Math.max(4, (row.sales / max) * 100) : 0;

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.productRow,
        focused && styles.productRowFocused,
        pressed && { opacity: 0.7 },
      ]}
    >
      <View style={styles.productHead}>
        {rank !== undefined ? <Text style={styles.rankedNum}>{rank}</Text> : null}
        <View style={{ flex: 1 }}>
          <Text style={styles.rankedName} numberOfLines={1}>
            {row.product_name}
          </Text>
          <Text style={styles.rankedMeta} numberOfLines={1}>
            {row.quantity} sold · {formatKwacha(row.sales)} takings
          </Text>
        </View>
        <Text style={[styles.rankedValue, row.profit < 0 && { color: colors.danger }]}>
          {formatKwacha(row.profit)}
        </Text>
      </View>

      {parts > 0 ? (
        <View style={[styles.stack, { width: pct(width) }]}>
          {cost > 0 ? <View style={{ flex: cost, backgroundColor: PART_COLORS.cost }} /> : null}
          {tax > 0 ? <View style={{ flex: tax, backgroundColor: PART_COLORS.tax }} /> : null}
          {profit > 0 ? (
            <View style={{ flex: profit, backgroundColor: PART_COLORS.profit }} />
          ) : null}
        </View>
      ) : null}
    </Pressable>
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

  // Ring beside legend where there is room, ring above it where there is not.
  donutRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  focusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    backgroundColor: colors.primarySoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  focusChipText: { flexShrink: 1, fontFamily: font.semibold, fontSize: 12, color: colors.primary },
  marginFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  marginFootLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  marginFootValue: { fontFamily: font.extrabold, fontSize: 20, color: colors.text, letterSpacing: -0.5 },

  productRow: {
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    marginBottom: 2,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  productRowFocused: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  productHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stack: {
    flexDirection: 'row',
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: colors.surfaceSunken,
  },

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
