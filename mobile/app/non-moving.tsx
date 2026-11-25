import React, { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';

import { analytics, stores as storesApi } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { useAuth, useCan } from '../src/store/auth';
import { placeLabel, warehouseFirst } from '../src/store/place';
import { shareStatement } from '../src/printing/csv';
import { useLayout } from '../src/ui/responsive';
import { MultiSelectField } from '../src/ui/pickers';
import { colors, font, formatKwacha, radius, spacing } from '../src/theme';
import { Button, Card, EmptyState, Loading, Select } from '../src/ui/components';

const WINDOWS = [3, 6, 12] as const;
const lastSold = (iso: string | null) => (iso ? iso.slice(0, 10) : 'Never sold here');

/**
 * Stock with no sale in the last 3/6/12 months, per shop or all shops — what to
 * return to the supplier or move to a shop where it sells.
 */
export default function NonMovingScreen() {
  const layout = useLayout();
  const user = useAuth((s) => s.user);
  const allowed = useCan('purchases.write');
  const [months, setMonths] = useState<number>(3);
  const [storeId, setStoreId] = useState('');
  const [brands, setBrands] = useState<Set<string>>(new Set());
  const [sharing, setSharing] = useState(false);

  const shops = useQuery({ queryKey: ['stores'], queryFn: () => storesApi.list(), enabled: allowed });
  const query = useQuery({
    queryKey: ['non-moving', storeId, months],
    queryFn: () => analytics.nonMoving(storeId || null, months),
    enabled: allowed,
  });

  const shopOptions = useMemo(() => {
    const active = (shops.data ?? []).filter((s) => s.is_active);
    const assigned = user?.role === 'ORG_ADMIN' ? null : user?.assigned_stores;
    const mine = assigned?.length ? active.filter((s) => assigned.includes(s.id)) : active;
    return [
      { value: '', label: 'All shops' },
      ...warehouseFirst(mine).map((s) => ({ value: s.id, label: placeLabel(s) })),
    ];
  }, [shops.data, user]);
  const brandNames = useMemo(
    () => [...new Set((query.data ?? []).map((r) => r.brand).filter((b): b is string => Boolean(b)))].sort(),
    [query.data]
  );

  const shown = useMemo(
    () => (query.data ?? []).filter((r) => !brands.size || brands.has(r.brand ?? '')),
    [query.data, brands]
  );
  const byShop = useMemo(() => {
    const m = new Map<string, typeof shown>();
    for (const r of shown) m.set(r.store_name, [...(m.get(r.store_name) ?? []), r]);
    return [...m.entries()];
  }, [shown]);
  const showValue = shown.some((r) => r.value !== undefined);
  const total = shown.reduce((sum, r) => sum + (r.value ?? 0), 0);
  const shopLabel = shopOptions.find((o) => o.value === storeId)?.label ?? 'All shops';

  async function sharePdf(format: 'pdf' | 'csv' = 'pdf') {
    setSharing(true);
    try {
      await shareStatement(
        format,
        {
          title: 'Non-moving stock',
          subject: brands.size ? `${shopLabel} — ${[...brands].join(', ')}` : shopLabel,
          meta: [`No sale in the last ${months} months`, `Prepared by ${user?.full_name ?? 'Unknown'}`],
          columns: [
            { label: 'Shop' },
            { label: 'Product' },
            { label: 'Brand' },
            { label: 'Qty', align: 'right' },
            { label: 'Last sold' },
            { label: 'In shop since' },
            ...(showValue ? [{ label: 'Value at cost', align: 'right' as const }] : []),
          ],
          rows: shown.map((r) => [
            r.store_name,
            r.product_name,
            r.brand ?? '',
            String(r.quantity),
            lastSold(r.last_sold),
            r.first_seen ? r.first_seen.slice(0, 10) : '',
            ...(showValue ? [formatKwacha(r.value ?? 0)] : []),
          ]),
          ...(showValue ? { totals: ['Total', '', '', '', '', '', formatKwacha(total)] } : {}),
          empty: 'Nothing is sitting unsold.',
        },
        `Non-moving-${shopLabel}-${months}m`
      );
    } finally {
      setSharing(false);
    }
  }

  if (!allowed) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState icon="lock" title="Not permitted" hint="This report is for a store manager or an administrator." />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl, gap: spacing.md }}
        refreshControl={
          <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} tintColor={colors.primary} />
        }
      >
        <Text style={styles.lead}>
          In stock but not sold in the last {months} months — return it, or move it to a shop where it sells.
          "In shop since" shows when it first arrived there.
        </Text>
        <Select label="Shop" value={storeId} options={shopOptions} onChange={setStoreId} />
        <View style={styles.chips}>
          {WINDOWS.map((m) => (
            <Pressable key={m} onPress={() => setMonths(m)} style={[styles.chip, m === months && styles.chipOn]}>
              <Text style={[styles.chipText, m === months && styles.chipTextOn]}>{m} months</Text>
            </Pressable>
          ))}
        </View>
        {brandNames.length > 1 ? (
          <MultiSelectField label="Brands" allLabel="All brands" options={brandNames} selected={brands} onChange={setBrands} />
        ) : null}

        {query.isLoading ? <Loading label="Checking shelves" /> : null}
        {query.error ? <Text style={styles.err}>{errorMessage(query.error)}</Text> : null}
        {query.data && !shown.length ? (
          <EmptyState icon="check-circle" title="Nothing sitting unsold" hint={`Everything in stock sold in the last ${months} months.`} />
        ) : null}

        {shown.length ? (
          <Text style={styles.total}>
            {shown.length} line{shown.length === 1 ? '' : 's'}
            {showValue ? ` · ${formatKwacha(total)} at cost` : ''}
          </Text>
        ) : null}

        {byShop.map(([shop, list]) => (
          <Card key={shop}>
            <Text style={styles.shop}>{shop}</Text>
            {list.map((r) => (
              <View key={r.product_id} style={styles.line}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{r.product_name}</Text>
                  <Text style={styles.sub}>
                    {r.brand ? `${r.brand} · ` : ''}
                    Last sold: {lastSold(r.last_sold)}
                    {r.first_seen ? ` · In shop since ${r.first_seen.slice(0, 10)}` : ''}
                    {r.value !== undefined ? ` · ${formatKwacha(r.value)}` : ''}
                  </Text>
                </View>
                <Text style={styles.qty}>{r.quantity}</Text>
              </View>
            ))}
          </Card>
        ))}

        {shown.length ? (
          <>
            <Button label="Save as PDF / Share" icon="share-2" size="lg" loading={sharing} onPress={() => void sharePdf()} />
            <Button label="Export to Excel" icon="download" variant="secondary" size="lg" loading={sharing} onPress={() => void sharePdf('csv')} />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  lead: { fontFamily: font.regular, fontSize: 13, color: colors.textMuted, lineHeight: 18 },
  chips: { flexDirection: 'row', gap: spacing.sm },
  chip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  chipText: { fontFamily: font.semibold, fontSize: 12, color: colors.textMuted },
  chipTextOn: { color: colors.primary },
  err: { color: colors.danger },
  total: { fontFamily: font.semibold, fontSize: 13, color: colors.text },
  shop: { fontFamily: font.bold, fontSize: 16, color: colors.text, marginBottom: spacing.sm },
  line: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: spacing.sm },
  name: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  sub: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted },
  qty: { fontFamily: font.extrabold, fontSize: 18, color: colors.text },
});
