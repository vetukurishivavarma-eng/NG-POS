import React from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';

import { analytics, transactions as txApi } from '../../src/api/endpoints';
import { placeLabel } from '../../src/store/place';
import { useStoreSelection } from '../../src/store/storeSelection';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing, splitAmount } from '../../src/theme';
import {
  Badge,
  EmptyState,
  Icon,
  Loading,
  SectionLabel,
  Subtitle,
  Title,
  type IconName,
} from '../../src/ui/components';

export default function ReportsScreen() {
  const store = useStoreSelection((s) => s.selected);
  const layout = useLayout();
  const storeId = store?.id ?? null;

  const dash = useQuery({
    queryKey: ['dashboard', storeId],
    enabled: Boolean(storeId),
    queryFn: () => analytics.dashboard(storeId as string),
  });

  const recent = useQuery({
    queryKey: ['recent-transactions', storeId],
    enabled: Boolean(storeId),
    queryFn: () => txApi.list(storeId as string, { limit: 10 }),
  });

  if (!store) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <EmptyState
          icon="home"
          title="Nowhere selected yet"
          hint="Pick your shop or the warehouse from the Sell tab and the day's figures appear here."
        />
      </SafeAreaView>
    );
  }

  const d = dash.data;
  const today = splitAmount(d?.today_sales ?? 0);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xl }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={dash.isRefetching || recent.isRefetching}
            onRefresh={() => {
              void dash.refetch();
              void recent.refetch();
            }}
            tintColor={colors.primary}
          />
        }
      >
        <View style={styles.header}>
          <Title>Dashboard</Title>
          {/* The warehouse says so. It is a store row like any other in the
              data, and somebody standing in it being shown a bare shop name is
              the app failing to know where they are. */}
          <Subtitle>{placeLabel(store)}</Subtitle>
        </View>

        {dash.isLoading ? (
          <Loading />
        ) : dash.isError ? (
          <EmptyState
            icon="cloud-off"
            title="Couldn't load figures"
            hint="Reports are live figures — they need a connection."
          />
        ) : (
          <>
            <View style={styles.hero}>
              <View style={styles.heroGlow} />
              <Text style={styles.heroLabel}>Today's Sales</Text>
              <Text style={styles.heroAmount}>
                {today.whole}
                <Text style={styles.heroDecimals}>{today.decimals}</Text>
              </Text>
              <View style={styles.heroMetaRow}>
                <View style={styles.heroChip}>
                  <Icon name="shopping-bag" size={12} color={colors.onDark} />
                  <Text style={styles.heroChipText}>
                    {d?.today_transactions ?? 0} transactions
                  </Text>
                </View>
                <View style={styles.heroChip}>
                  <Icon name="percent" size={12} color={colors.onDark} />
                  <Text style={styles.heroChipText}>
                    {formatKwacha(d?.tax_collected_today ?? 0)} VAT
                  </Text>
                </View>
              </View>
            </View>

            <SectionLabel>Performance</SectionLabel>
            <View style={styles.grid}>
              <Kpi
                icon="calendar"
                label="This Week"
                value={formatKwacha(d?.week_sales ?? 0)}
                hint={`${d?.week_transactions ?? 0} transactions`}
                wide={layout.isTablet}
              />
              <Kpi
                icon="trending-up"
                label="This Month"
                value={formatKwacha(d?.month_sales ?? 0)}
                hint={`${d?.month_transactions ?? 0} transactions`}
                wide={layout.isTablet}
              />
            </View>

            <SectionLabel>Catalogue</SectionLabel>
            <View style={styles.grid}>
              <Kpi icon="home" label="Active Stores" value={String(d?.active_stores ?? 0)} wide={layout.isTablet} />
              <Kpi icon="package" label="Products" value={String(d?.total_products ?? 0)} wide={layout.isTablet} />
              <Kpi
                icon="alert-triangle"
                label="Low Stock"
                value={String(d?.low_stock_count ?? 0)}
                tone={colors.danger}
                wide={layout.isTablet}
              />
            </View>
          </>
        )}

        <SectionLabel>Recent Transactions</SectionLabel>
        {recent.isLoading ? (
          <Loading />
        ) : (recent.data ?? []).length === 0 ? (
          <EmptyState icon="file-text" title="No sales yet" hint="Completed sales appear here." />
        ) : (
          (recent.data ?? []).map((t) => (
            <View key={t.id} style={styles.txRow}>
              <View style={styles.txIcon}>
                <Icon
                  name={t.status === 'refunded' ? 'corner-up-left' : 'check'}
                  size={16}
                  color={t.status === 'refunded' ? colors.warning : colors.success}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.txReceipt} numberOfLines={1}>
                  {t.receipt_number}
                </Text>
                <Text style={styles.txMeta}>
                  {new Date(t.created_at).toLocaleString()} · {t.items.length} items
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Text style={[styles.txTotal, t.total < 0 && { color: colors.danger }]}>
                  {formatKwacha(t.total)}
                </Text>
                <Badge
                  label={t.status.toUpperCase()}
                  tone={
                    t.status === 'completed' ? 'success' : t.status === 'refunded' ? 'warning' : 'neutral'
                  }
                />
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Kpi({
  icon,
  label,
  value,
  hint,
  tone,
  wide,
}: {
  icon: IconName;
  label: string;
  value: string;
  hint?: string;
  tone?: string;
  wide?: boolean;
}) {
  return (
    <View style={[styles.kpi, wide && { flexBasis: '31%' }]}>
      <View style={styles.kpiIcon}>
        <Icon name={icon} size={15} color={colors.primary} />
      </View>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, tone ? { color: tone } : null]} numberOfLines={1}>
        {value}
      </Text>
      {hint ? <Text style={styles.kpiHint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  header: { marginBottom: spacing.lg },

  hero: {
    backgroundColor: colors.primaryDeep,
    borderRadius: radius.xl,
    padding: spacing.xl,
    marginBottom: spacing.xl,
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

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  kpi: {
    flexGrow: 1,
    flexBasis: '46%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    ...shadow.card,
  },
  kpiIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  kpiLabel: { fontFamily: font.medium, fontSize: 12, color: colors.textMuted },
  kpiValue: {
    fontFamily: font.extrabold,
    fontSize: 21,
    color: colors.text,
    letterSpacing: -0.6,
    marginTop: 3,
  },
  kpiHint: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 2 },

  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...shadow.card,
  },
  txIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  txReceipt: { fontFamily: font.semibold, fontSize: 13, color: colors.text },
  txMeta: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 2 },
  txTotal: { fontFamily: font.bold, fontSize: 15, color: colors.text },
});
