import React, { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { analytics, stores as storesApi } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { useAuth, useCan } from '../src/store/auth';
import { placeLabel, warehouseFirst } from '../src/store/place';
import { useStoreSelection } from '../src/store/storeSelection';
import { useQuery } from '@tanstack/react-query';
import { shareOrderReportPdf } from '../src/printing/print';
import { useLayout } from '../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing } from '../src/theme';
import { Button, EmptyState, Icon, Loading, Select } from '../src/ui/components';

const ALL_SHOPS = 'all';
const MONTH_OPTIONS = [1, 2, 3] as const;

export default function ReorderScreen() {
  const layout = useLayout();
  const user = useAuth((s) => s.user);
  const selectedStore = useStoreSelection((s) => s.selected);
  const canBuy = useCan('purchases.write');

  const [months, setMonths] = useState<number>(1);
  const [scope, setScope] = useState<string>(selectedStore?.id ?? ALL_SHOPS);
  const [search, setSearch] = useState('');
  const [sharing, setSharing] = useState(false);

  const storeList = useQuery({ queryKey: ['stores'], queryFn: () => storesApi.list() });

  const visibleStores = useMemo(() => {
    const active = (storeList.data ?? []).filter((s) => s.is_active);
    if (!user || user.role === 'ORG_ADMIN') return active;
    const assigned = user.assigned_stores;
    if (!assigned || assigned.length === 0) return active;
    return active.filter((s) => assigned.includes(s.id));
  }, [storeList.data, user]);

  const scopeIsKnown =
    scope === ALL_SHOPS || !storeList.data || visibleStores.some((s) => s.id === scope);
  const effectiveScope = scopeIsKnown ? scope : ALL_SHOPS;
  const storeId = effectiveScope === ALL_SHOPS ? null : effectiveScope;
  const scopeLabel =
    storeId === null
      ? 'All shops'
      : (visibleStores.find((s) => s.id === storeId)?.name ?? selectedStore?.name ?? 'This shop');

  const storeOptions = useMemo(
    () => [
      { value: ALL_SHOPS, label: 'All shops' },
      ...warehouseFirst(visibleStores).map((s) => ({ value: s.id, label: placeLabel(s) })),
    ],
    [visibleStores]
  );

  const query = useQuery({
    queryKey: ['reorder', storeId, months],
    queryFn: () => analytics.reorder(storeId, months),
  });

  const rows = useMemo(() => {
    const all = [...(query.data ?? [])].sort((a, b) => b.quantity - a.quantity);
    const needle = search.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (r) =>
        r.product_name.toLowerCase().includes(needle) ||
        (r.brand ?? '').toLowerCase().includes(needle)
    );
  }, [query.data, search]);

  const totalUnits = rows.reduce((sum, r) => sum + r.quantity, 0);
  const totalValue = rows.reduce((sum, r) => sum + r.sales, 0);

  async function sharePdf() {
    if (!query.data || query.data.length === 0) return;
    setSharing(true);
    try {
      // Always the full ranked list, not whatever the search box has narrowed to.
      const lines = [...query.data]
        .sort((a, b) => b.quantity - a.quantity)
        .map((r) => ({ name: r.product_name, brand: r.brand, quantity: r.quantity, value: r.sales }));
      await shareOrderReportPdf({
        storeName: scopeLabel,
        months,
        preparedBy: user?.full_name ?? 'Unknown',
        lines,
      });
    } finally {
      setSharing(false);
    }
  }

  if (!canBuy) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="lock"
          title="Not permitted"
          hint="The order list is for a store manager or an administrator."
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl, gap: spacing.lg }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => void query.refetch()}
            tintColor={colors.primary}
          />
        }
      >
        <View>
          <Text style={styles.title}>Order list</Text>
          <Text style={styles.lead}>
            What sold over the last {months} month{months === 1 ? '' : 's'}, biggest first — the
            starting point for a purchase order.
          </Text>
        </View>

        <View style={styles.controls}>
          <Select label="Shop" value={effectiveScope} options={storeOptions} onChange={setScope} />
          <View>
            <Text style={styles.fieldLabel}>Window</Text>
            <View style={styles.monthRow}>
              {MONTH_OPTIONS.map((m) => {
                const active = m === months;
                return (
                  <Pressable
                    key={m}
                    onPress={() => setMonths(m)}
                    style={[styles.monthChip, active && styles.monthChipActive]}
                  >
                    <Text style={[styles.monthText, active && styles.monthTextActive]}>
                      {m} month{m === 1 ? '' : 's'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>

        {query.isLoading ? (
          <Loading label="Adding up sales" />
        ) : query.isError ? (
          <EmptyState
            icon="cloud-off"
            title="Couldn't load"
            hint={errorMessage(query.error)}
            action={
              <Button label="Retry" icon="refresh-cw" variant="secondary" onPress={() => void query.refetch()} />
            }
          />
        ) : (query.data ?? []).length === 0 ? (
          <EmptyState
            icon="package"
            title="Nothing sold"
            hint={`No sales at ${scopeLabel} in the last ${months} month${months === 1 ? '' : 's'}.`}
          />
        ) : (
          <>
            <View style={styles.searchBox}>
              <Icon name="search" size={16} color={colors.textFaint} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Filter by name or brand"
                placeholderTextColor={colors.textFaint}
                style={styles.searchInput}
                autoCorrect={false}
              />
              {search.length > 0 ? (
                <Pressable onPress={() => setSearch('')} hitSlop={8}>
                  <Icon name="x" size={16} color={colors.textFaint} />
                </Pressable>
              ) : null}
            </View>

            <View style={styles.card}>
              {rows.map((row, index) => (
                <View key={row.product_id ?? `${row.product_name}-${index}`}>
                  {index > 0 ? <View style={styles.divider} /> : null}
                  <View style={styles.row}>
                    <Text style={styles.rank}>{index + 1}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.name} numberOfLines={1}>
                        {row.product_name}
                      </Text>
                      <Text style={styles.meta} numberOfLines={1}>
                        {row.brand ? `${row.brand} · ` : ''}
                        {formatKwacha(row.sales)}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={styles.qty}>{formatQty(row.quantity)}</Text>
                      <Text style={styles.qtyLabel}>sold</Text>
                    </View>
                  </View>
                </View>
              ))}
            </View>

            <View style={styles.totals}>
              <Text style={styles.totalsText}>
                {rows.length} product{rows.length === 1 ? '' : 's'} · {formatQty(totalUnits)} units ·{' '}
                {formatKwacha(totalValue)}
              </Text>
            </View>

            <Button
              label="Save as PDF / Share"
              icon="share-2"
              size="lg"
              loading={sharing}
              onPress={() => void sharePdf()}
            />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  title: { fontFamily: font.bold, fontSize: 22, color: colors.text, letterSpacing: -0.5 },
  lead: { fontFamily: font.regular, fontSize: 13, color: colors.textMuted, marginTop: 4, lineHeight: 18 },

  controls: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadow.card,
  },
  fieldLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  monthRow: { flexDirection: 'row', gap: spacing.sm },
  monthChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  monthChipActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  monthText: { fontFamily: font.semibold, fontSize: 12, color: colors.textMuted },
  monthTextActive: { color: colors.primary },

  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 46,
  },
  searchInput: { flex: 1, fontFamily: font.medium, fontSize: 14, color: colors.text, padding: 0 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    ...shadow.card,
  },
  divider: { height: 1, backgroundColor: colors.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  rank: {
    minWidth: 20,
    fontFamily: font.bold,
    fontSize: 12,
    color: colors.textFaint,
    textAlign: 'center',
  },
  name: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  meta: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 2 },
  qty: { fontFamily: font.extrabold, fontSize: 18, color: colors.text, letterSpacing: -0.4 },
  qtyLabel: {
    fontFamily: font.regular,
    fontSize: 9,
    color: colors.textFaint,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },

  totals: { alignItems: 'center' },
  totalsText: { fontFamily: font.semibold, fontSize: 12, color: colors.textMuted },
});
