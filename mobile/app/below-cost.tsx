import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { analytics } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { useCan } from '../src/store/auth';
import { useLayout } from '../src/ui/responsive';
import { colors, formatKwacha, spacing } from '../src/theme';
import { Badge, Card, EmptyState, Loading } from '../src/ui/components';

/**
 * Every sale line that went out below cost: which receipt, which shop, which
 * login (cashier) and which device, at what price against what cost. Opens from
 * Analytics (all products, or one) and from Product Sales. Tap a sale for the receipt.
 */
export default function BelowCostScreen() {
  const layout = useLayout();
  const router = useRouter();
  const allowed = useCan('costs.view');
  const params = useLocalSearchParams<Record<string, string>>();
  const query: Record<string, string> = {};
  for (const k of ['store_id', 'period', 'from', 'to', 'product_id', 'name']) {
    if (params[k]) query[k] = String(params[k]);
  }

  const rows = useQuery({
    queryKey: ['below-cost-sales', query],
    queryFn: () => analytics.belowCostSales(query),
    enabled: allowed,
  });

  if (!allowed) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState icon="lock" title="Not available for your role" hint="Only an owner can open this." />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={{ padding: layout.gutter, gap: spacing.md }}>
        <Text style={styles.title}>
          Sold below cost{params.title ? ` · ${params.title}` : ''}
        </Text>
        {rows.isLoading ? <Loading label="Finding the sales" /> : null}
        {rows.error ? <Text style={styles.err}>{errorMessage(rows.error)}</Text> : null}
        {rows.data && rows.data.length === 0 ? (
          <EmptyState icon="check-circle" title="None found" hint="No sale in this period went out below cost." />
        ) : null}

        {(rows.data ?? []).map((r, i) => (
          <Pressable key={`${r.transaction_id}-${i}`} onPress={() => router.push(`/transaction/${r.transaction_id}`)}>
            <Card>
              <View style={styles.head}>
                <Text style={styles.receipt}>{r.receipt_number}</Text>
                <Badge label={`Loss ${formatKwacha(r.loss)}`} tone="danger" />
              </View>
              <Text style={styles.product}>
                {r.product_name} × {r.quantity}
              </Text>
              <Text style={styles.line}>
                Sold at {formatKwacha(r.net_price)} each (ex-VAT) · cost {formatKwacha(r.cost_price)}
              </Text>
              <Text style={styles.meta}>Shop: {r.store_name}</Text>
              <Text style={styles.meta}>Login: {r.cashier_name || '—'}</Text>
              <Text style={styles.meta}>Device: {r.device_name ?? 'not recorded (sale predates tracking)'}</Text>
              <Text style={styles.meta}>{new Date(r.created_at).toLocaleString()}</Text>
            </Card>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  err: { color: colors.danger },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  receipt: { fontSize: 15, fontWeight: '700', color: colors.text },
  product: { fontSize: 15, color: colors.text },
  line: { fontSize: 13, color: colors.danger, marginBottom: 6 },
  meta: { fontSize: 13, color: colors.textMuted },
});
