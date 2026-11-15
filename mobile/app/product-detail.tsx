import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';

import { analytics } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { useLayout } from '../src/ui/responsive';
import { colors, formatKwacha, spacing } from '../src/theme';
import { Card, EmptyState, Loading } from '../src/ui/components';

/** One product: per shop, how many sold, the average price, and every price it sold at. */
export default function ProductDetailScreen() {
  const layout = useLayout();
  const params = useLocalSearchParams<Record<string, string>>();
  const query: Record<string, string> = {};
  for (const k of ['store_id', 'period', 'from', 'to', 'product_id', 'name']) {
    if (params[k]) query[k] = String(params[k]);
  }

  const rows = useQuery({
    queryKey: ['product-breakdown', query],
    queryFn: () => analytics.productBreakdown(query),
  });
  const total = (rows.data ?? []).reduce((s, r) => s + r.quantity, 0);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={{ padding: layout.gutter, gap: spacing.md }}>
        <Text style={styles.title}>{params.title || 'Product'}</Text>
        {rows.data?.length ? <Text style={styles.meta}>{total} sold across {rows.data.length} shop(s)</Text> : null}
        {rows.isLoading ? <Loading label="Loading" /> : null}
        {rows.error ? <Text style={styles.err}>{errorMessage(rows.error)}</Text> : null}
        {rows.data && !rows.data.length ? (
          <EmptyState icon="inbox" title="No sales" hint="Nothing sold in this period." />
        ) : null}

        {(rows.data ?? []).map((s) => (
          <Card key={s.store_id}>
            <Text style={styles.shop}>{s.store_name}</Text>
            <Text style={styles.line}>
              {s.quantity} sold · {formatKwacha(s.sales)} · average {formatKwacha(s.avg_price)}
            </Text>
            <Text style={styles.label}>Prices it sold at</Text>
            {s.prices.map((p) => (
              <View key={p.unit_price} style={styles.price}>
                <Text style={styles.line}>{formatKwacha(p.unit_price)} each</Text>
                <Text style={styles.line}>× {p.quantity}</Text>
              </View>
            ))}
          </Card>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  meta: { fontSize: 13, color: colors.textMuted },
  err: { color: colors.danger },
  shop: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 4 },
  line: { fontSize: 14, color: colors.text },
  label: { fontSize: 12, color: colors.textMuted, marginTop: spacing.sm, marginBottom: 2 },
  price: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
});
