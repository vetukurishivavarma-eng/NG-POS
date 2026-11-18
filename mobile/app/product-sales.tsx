import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { belowCostHref, productDetailHref } from '../src/nav/productLinks';

import { analytics, stores as storesApi } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { useCan } from '../src/store/auth';
import { useLayout } from '../src/ui/responsive';
import { colors, formatKwacha, radius, spacing } from '../src/theme';
import { DateField, MultiSelectField } from '../src/ui/pickers';
import { Badge, Card, EmptyState, Loading, SectionLabel, Select } from '../src/ui/components';

const NO_BRAND = 'No brand';
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400000));
const PRESETS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom dates' },
];

/**
 * What sells, per shop and date range. Tap products to look at just those
 * (none ticked = all products); "Below cost only" lists lines sold for less
 * than they cost. Owner-only, like the other reports.
 */
export default function ProductSalesScreen() {
  const layout = useLayout();
  const router = useRouter();
  const allowed = useCan('costs.view');
  const [storeId, setStoreId] = useState('');
  const [preset, setPreset] = useState('30');
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(iso(new Date()));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [brands, setBrands] = useState<Set<string>>(new Set());
  const [belowCost, setBelowCost] = useState(false);

  const shops = useQuery({ queryKey: ['stores'], queryFn: storesApi.list, enabled: allowed });
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const rows = useQuery({
    queryKey: ['product-sales', storeId, from, to],
    queryFn: () => analytics.productSales(storeId || null, from, to),
    enabled: allowed && valid,
  });

  const choosePreset = (v: string) => {
    setPreset(v);
    if (v !== 'custom') {
      setFrom(daysAgo(Number(v)));
      setTo(iso(new Date()));
    }
  };
  const toggle = (key: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (!n.delete(key)) n.add(key);
      return n;
    });

  const shown = useMemo(
    () =>
      (rows.data ?? []).filter(
        (r) =>
          (!picked.size || picked.has(r.product_name)) &&
          (!brands.size || brands.has(r.brand || NO_BRAND)) &&
          (!belowCost || (r.sold_below_cost_qty ?? 0) > 0)
      ),
    [rows.data, picked, brands, belowCost]
  );
  const brandNames = useMemo(
    () => [...new Set((rows.data ?? []).map((r) => r.brand || NO_BRAND))].sort(),
    [rows.data]
  );
  // Product choices come from the unfiltered result so a pick never hides itself.
  const names = useMemo(
    () => [...new Set((rows.data ?? []).map((r) => r.product_name))].sort(),
    [rows.data]
  );
  const byShop = useMemo(() => {
    const m = new Map<string, typeof shown>();
    for (const r of shown) m.set(r.store_name, [...(m.get(r.store_name) ?? []), r]);
    return [...m.entries()];
  }, [shown]);

  if (!allowed) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState icon="lock" title="Not available for your role" hint="Only an owner can open this report." />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={{ padding: layout.gutter, gap: spacing.md }}>
        <SectionLabel>Shop</SectionLabel>
        <Select
          value={storeId}
          onChange={setStoreId}
          options={[
            { value: '', label: 'All shops' },
            ...(shops.data ?? []).map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
        <SectionLabel>Dates</SectionLabel>
        <Select value={preset} onChange={choosePreset} options={PRESETS} />
        <View style={styles.row}>
          <DateField label="From" value={from} max={to} onChange={(v) => { setFrom(v); setPreset('custom'); }} />
          <DateField label="To" value={to} max={iso(new Date())} onChange={(v) => { setTo(v); setPreset('custom'); }} />
        </View>
        {!valid ? <Text style={styles.err}>Enter dates as YYYY-MM-DD, from on or before to.</Text> : null}

        <View style={styles.row}>
          <Text style={styles.label}>Below cost only</Text>
          <Switch value={belowCost} onValueChange={setBelowCost} />
        </View>

        {brandNames.length > 1 ? (
          <MultiSelectField
            label="Brands"
            allLabel="All brands"
            options={brandNames}
            selected={brands}
            onChange={setBrands}
          />
        ) : null}

        {names.length ? (
          <MultiSelectField
            label="Products"
            allLabel="All products"
            options={names}
            selected={picked}
            onChange={setPicked}
          />
        ) : null}

        {rows.isLoading ? <Loading label="Loading sales" /> : null}
        {rows.error ? <Text style={styles.err}>{errorMessage(rows.error)}</Text> : null}
        {rows.data && !shown.length ? (
          <EmptyState icon="inbox" title="Nothing sold" hint="No matching sales in these dates." />
        ) : null}

        {byShop.map(([shop, list]) => (
          <Card key={shop}>
            <Text style={styles.shop}>{shop}</Text>
            {list.map((r) => (
              <Pressable
                key={r.product_name}
                style={styles.line}
                onPress={() =>
                  router.push(
                    productDetailHref({ product_id: r.product_id, name: r.product_name, store_id: r.store_id, from, to })
                  )
                }
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{r.product_name}</Text>
                  <Text style={styles.sub}>
                    {r.brand ? `${r.brand} · ` : ''}
                    {r.quantity} sold · {formatKwacha(r.sales)}
                    {r.profit !== undefined ? ` · profit ${formatKwacha(r.profit)}` : ''}
                  </Text>
                </View>
                {(r.sold_below_cost_qty ?? 0) > 0 ? (
                  <Pressable
                    onPress={() =>
                      router.push(
                        belowCostHref({ product_id: r.product_id, name: r.product_name, store_id: r.store_id, from, to })
                      )
                    }
                  >
                    <Badge label={`${r.sold_below_cost_qty} below cost`} tone="danger" />
                  </Pressable>
                ) : null}
              </Pressable>
            ))}
          </Card>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm,
    color: colors.text,
  },
  label: { fontSize: 15, color: colors.text },
  err: { color: colors.danger },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.text, fontSize: 13 },
  chipOnText: { color: '#fff', fontSize: 13 },
  shop: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  line: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: spacing.sm },
  name: { color: colors.text, fontSize: 15 },
  sub: { color: colors.textMuted, fontSize: 13 },
});
