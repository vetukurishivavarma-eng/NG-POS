import React, { useMemo, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { transactions as txApi } from '../src/api/endpoints';
import { useAuth } from '../src/store/auth';
import { useStoreSelection } from '../src/store/storeSelection';
import { useSync } from '../src/db/sync';
import { printDayReport } from '../src/printing/print';
import { printBlockedReason } from '../src/printing/printer';
import { useLayout } from '../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing, splitAmount } from '../src/theme';
import { Button, EmptyState, Icon, Loading, type IconName } from '../src/ui/components';
import type { DailyReport, Transaction } from '../src/api/types';

export default function DayReportScreen() {
  const store = useStoreSelection((s) => s.selected);
  const user = useAuth((s) => s.user);
  const layout = useLayout();
  const pendingCount = useSync((s) => s.pendingCount);
  const signOut = useAuth((s) => s.signOut);

  const [offset, setOffset] = useState(0); // 0 = today, 1 = yesterday, …
  const [printing, setPrinting] = useState(false);

  const day = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [offset]);

  const dateKey = toDateKey(day);
  const storeId = store?.id ?? null;

  // The day's rows are fetched regardless: they drive the top-item list, and
  // they are what the figures fall back to if the report endpoint isn't there.
  const rows = useQuery({
    queryKey: ['day-transactions', storeId, dateKey],
    enabled: Boolean(storeId),
    queryFn: () =>
      txApi.list(storeId as string, {
        limit: 200,
        from: day.toISOString(),
        to: endOfDay(day).toISOString(),
      }),
  });

  const report = useQuery({
    queryKey: ['daily-report', storeId, dateKey],
    enabled: Boolean(storeId),
    // A missing endpoint is not a transient failure; don't burn a retry on it.
    retry: false,
    queryFn: () => txApi.dailyReport(storeId as string, dateKey),
  });

  // Belt and braces: the server's figures if they arrived, ours if they didn't.
  // Either way the screen shows numbers rather than an error.
  const figures: DailyReport | null = useMemo(() => {
    if (report.data) return report.data;
    if (!rows.data || !storeId) return null;
    return computeReport(storeId, dateKey, rows.data);
  }, [report.data, rows.data, storeId, dateKey]);

  const topItems = useMemo(() => topSellers(rows.data ?? []), [rows.data]);

  if (!store) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState icon="home" title="No store selected" hint="Choose a store from the Sell tab." />
      </SafeAreaView>
    );
  }

  async function print() {
    if (!figures || !store) return;
    const blocked = printBlockedReason();
    if (blocked) {
      Alert.alert('Cannot print', blocked);
      return;
    }
    setPrinting(true);
    try {
      await printDayReport({
        store,
        report: figures,
        cashierName: user?.full_name ?? 'Unknown',
        topItems: topItems.map((i) => ({ name: i.name, quantity: i.quantity, total: i.total })),
      });
    } finally {
      setPrinting(false);
    }
  }

  function endSession() {
    const warn =
      pendingCount > 0
        ? `\n\n${pendingCount} offline sale(s) haven't reached the server — they are not in these figures and stay on this device until it syncs.`
        : '';

    Alert.alert(
      'End session?',
      `Print the day report, then sign out of ${store?.name}.${warn}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Print & Sign Out',
          onPress: async () => {
            await print();
            await signOut();
            router.replace('/login');
          },
        },
        {
          text: 'Sign Out Only',
          style: 'destructive',
          onPress: async () => {
            await signOut();
            router.replace('/login');
          },
        },
      ]
    );
  }

  const loading = rows.isLoading || (report.isLoading && !report.isError);
  const net = splitAmount(figures?.gross_total ?? 0);
  const tendered = figures
    ? figures.by_payment_method.cash + figures.by_payment_method.card + figures.by_payment_method.mobile
    : 0;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl, gap: spacing.lg }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={rows.isRefetching || report.isRefetching}
            onRefresh={() => {
              void rows.refetch();
              void report.refetch();
            }}
            tintColor={colors.primary}
          />
        }
      >
        <View style={styles.dateBar}>
          <Pressable onPress={() => setOffset((o) => o + 1)} hitSlop={8} style={styles.dateArrow}>
            <Icon name="chevron-left" size={20} color={colors.text} />
          </Pressable>
          <View style={{ alignItems: 'center' }}>
            <Text style={styles.dateLabel}>{offsetLabel(offset)}</Text>
            <Text style={styles.dateValue}>
              {day.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}
            </Text>
          </View>
          <Pressable
            onPress={() => setOffset((o) => Math.max(0, o - 1))}
            hitSlop={8}
            disabled={offset === 0}
            style={[styles.dateArrow, offset === 0 && { opacity: 0.25 }]}
          >
            <Icon name="chevron-right" size={20} color={colors.text} />
          </Pressable>
        </View>

        {loading ? (
          <Loading label="Adding up the day" />
        ) : !figures ? (
          <EmptyState
            icon="cloud-off"
            title="Couldn't reach the server"
            hint="The day report is compiled from server records — it needs a connection."
            action={<Button label="Retry" icon="refresh-cw" variant="secondary" onPress={() => void rows.refetch()} />}
          />
        ) : (
          <>
            <View style={styles.hero}>
              <View style={styles.heroGlow} />
              <Text style={styles.heroLabel}>Net Takings</Text>
              <Text style={styles.heroAmount}>
                {net.whole}
                <Text style={styles.heroDecimals}>{net.decimals}</Text>
              </Text>
              <View style={styles.heroMetaRow}>
                <View style={styles.heroChip}>
                  <Icon name="shopping-bag" size={12} color={colors.onDark} />
                  <Text style={styles.heroChipText}>
                    {figures.transaction_count} transaction{figures.transaction_count === 1 ? '' : 's'}
                  </Text>
                </View>
                <View style={styles.heroChip}>
                  <Icon name="percent" size={12} color={colors.onDark} />
                  <Text style={styles.heroChipText}>{formatKwacha(figures.tax_total)} VAT</Text>
                </View>
              </View>
              {report.isError ? (
                <Text style={styles.heroNote}>Totalled on this device from the day's sales.</Text>
              ) : null}
            </View>

            <View>
              <Text style={styles.sectionLabel}>Takings by method</Text>
              <View style={styles.card}>
                <Row icon="dollar-sign" label="Cash" value={formatKwacha(figures.by_payment_method.cash)} />
                <View style={styles.divider} />
                <Row icon="credit-card" label="Card" value={formatKwacha(figures.by_payment_method.card)} />
                <View style={styles.divider} />
                <Row icon="smartphone" label="Mobile Money" value={formatKwacha(figures.by_payment_method.mobile)} />
                <View style={styles.divider} />
                <Row icon="check-circle" label="Tendered" value={formatKwacha(tendered)} strong />
              </View>
            </View>

            <View>
              <Text style={styles.sectionLabel}>Reconciliation</Text>
              <View style={styles.card}>
                <Row
                  icon="trending-up"
                  label="Gross sales"
                  value={formatKwacha(figures.gross_total + figures.refund_total)}
                />
                <View style={styles.divider} />
                <Row
                  icon="corner-up-left"
                  label="Refunds"
                  value={`−${formatKwacha(figures.refund_total)}`}
                  tone={figures.refund_total > 0 ? colors.danger : undefined}
                />
                <View style={styles.divider} />
                <Row icon="award" label="Net" value={formatKwacha(figures.gross_total)} strong />
              </View>
            </View>

            {topItems.length > 0 ? (
              <View>
                <Text style={styles.sectionLabel}>Top items</Text>
                <View style={styles.card}>
                  {topItems.map((item, index) => (
                    <View key={item.name}>
                      {index > 0 ? <View style={styles.divider} /> : null}
                      <View style={styles.topRow}>
                        <Text style={styles.topRank}>{index + 1}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.topName} numberOfLines={1}>
                            {item.name}
                          </Text>
                          <Text style={styles.topMeta}>{item.quantity} sold</Text>
                        </View>
                        <Text style={styles.topTotal}>{formatKwacha(item.total)}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}

            {pendingCount > 0 ? (
              <View style={styles.warn}>
                <Icon name="alert-triangle" size={16} color={colors.warning} />
                <Text style={styles.warnText}>
                  {pendingCount} offline sale(s) not yet synced. They are not counted here.
                </Text>
              </View>
            ) : null}

            <View style={{ gap: spacing.sm }}>
              <Button
                label="Print Day Report"
                icon="printer"
                variant="secondary"
                loading={printing}
                onPress={() => void print()}
              />
              {offset === 0 ? (
                <Button label="End Session" icon="log-out" variant="danger" onPress={endSession} />
              ) : null}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({
  icon,
  label,
  value,
  strong,
  tone,
}: {
  icon: IconName;
  label: string;
  value: string;
  strong?: boolean;
  tone?: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowLeft}>
        <Icon name={icon} size={16} color={strong ? colors.primary : colors.textFaint} />
        <Text style={[styles.rowLabel, strong && styles.rowLabelStrong]}>{label}</Text>
      </View>
      <Text style={[styles.rowValue, strong && styles.rowValueStrong, tone ? { color: tone } : null]}>
        {value}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------- figures */

/**
 * The same arithmetic the server does, run on the device. Kept deliberately
 * identical to `GET /transactions/reports/daily` so a fallback report and a
 * server report can't disagree: voided rows are excluded, refunds carry
 * negative totals, and only real tenders count towards the payment split.
 */
function computeReport(storeId: string, date: string, rows: Transaction[]): DailyReport {
  const byMethod = { cash: 0, card: 0, mobile: 0 };
  let gross = 0;
  let tax = 0;
  let refunds = 0;
  let count = 0;

  for (const t of rows) {
    if (t.status === 'voided') continue;
    count += 1;
    gross += t.total;
    tax += t.tax_amount;
    if (t.transaction_type !== 'sale') refunds += Math.abs(t.total);
    for (const p of t.payments) {
      if (p.method in byMethod) byMethod[p.method] += p.amount;
    }
  }

  return {
    store_id: storeId,
    date,
    transaction_count: count,
    gross_total: round2(gross),
    tax_total: round2(tax),
    refund_total: round2(refunds),
    by_payment_method: {
      cash: round2(byMethod.cash),
      card: round2(byMethod.card),
      mobile: round2(byMethod.mobile),
    },
  };
}

function topSellers(rows: Transaction[]): { name: string; quantity: number; total: number }[] {
  const tally = new Map<string, { name: string; quantity: number; total: number }>();

  for (const t of rows) {
    if (t.status === 'voided' || t.transaction_type !== 'sale') continue;
    for (const item of t.items) {
      const entry = tally.get(item.product_name) ?? {
        name: item.product_name,
        quantity: 0,
        total: 0,
      };
      entry.quantity += item.quantity;
      entry.total += item.line_total;
      tally.set(item.product_name, entry);
    }
  }

  return [...tally.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 5);
}

function toDateKey(d: Date): string {
  // Local calendar date, not UTC — a sale at 21:00 in Lusaka belongs to that day.
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${dayOfMonth}`;
}

function endOfDay(d: Date): Date {
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return end;
}

function offsetLabel(offset: number): string {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Yesterday';
  return `${offset} days ago`;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  dateBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  dateArrow: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSunken,
  },
  dateLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  dateValue: { fontFamily: font.bold, fontSize: 15, color: colors.text, marginTop: 2 },

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
    fontSize: 40,
    color: colors.onDark,
    letterSpacing: -1.4,
    marginTop: 6,
  },
  heroDecimals: { fontFamily: font.bold, fontSize: 22, color: colors.onDarkMuted },
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
  heroNote: {
    fontFamily: font.regular,
    fontSize: 11,
    color: colors.onDarkMuted,
    marginTop: spacing.md,
  },

  sectionLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    ...shadow.card,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },

  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowLabel: { fontFamily: font.medium, fontSize: 14, color: colors.textMuted },
  rowLabelStrong: { fontFamily: font.bold, fontSize: 15, color: colors.text },
  rowValue: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  rowValueStrong: { fontFamily: font.extrabold, fontSize: 18, color: colors.primary },

  topRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  topRank: {
    width: 22,
    fontFamily: font.extrabold,
    fontSize: 15,
    color: colors.textFaint,
  },
  topName: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  topMeta: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 2 },
  topTotal: { fontFamily: font.semibold, fontSize: 14, color: colors.text },

  warn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  warnText: { flex: 1, fontFamily: font.medium, fontSize: 12, color: colors.warning },
});
