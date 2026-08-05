import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { stores as storesApi, transactions as txApi } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { newClientReference } from '../src/api/types';
import { useAuth, capabilitiesFor } from '../src/store/auth';
import { useStoreSelection } from '../src/store/storeSelection';
import { offerReceipt } from '../src/printing/print';
import { useLayout } from '../src/ui/responsive';
import { colors, font, formatKwacha, radius, spacing } from '../src/theme';
import { Badge, Button, EmptyState, Icon, Loading } from '../src/ui/components';
import type { TransactionItem } from '../src/api/types';

/** One refundable row per product, with how many units are being sent back. */
interface RefundLine {
  product_id: string;
  name: string;
  sold: number;
  unitPrice: number;
  /** Share of the sale total this line carried, VAT and discount included. */
  lineTotal: number;
  refunding: number;
}

export default function RefundScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const layout = useLayout();
  const queryClient = useQueryClient();
  const user = useAuth((s) => s.user);
  const selectedStore = useStoreSelection((s) => s.selected);

  const [lines, setLines] = useState<RefundLine[] | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const tx = useQuery({
    queryKey: ['transaction', id],
    enabled: Boolean(id),
    queryFn: () => txApi.get(id as string),
  });

  const store = useQuery({
    queryKey: ['store', tx.data?.store_id],
    enabled: Boolean(tx.data?.store_id),
    queryFn: () => storesApi.get(tx.data?.store_id as string),
    initialData:
      selectedStore && selectedStore.id === tx.data?.store_id ? selectedStore : undefined,
  });

  // Seeded once the sale arrives; defaults to a full refund, which is what most
  // returns actually are.
  const seeded = useMemo(() => (tx.data ? toRefundLines(tx.data.items) : null), [tx.data]);
  const rows = lines ?? seeded;

  if (!capabilitiesFor(user).includes('reports')) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="lock"
          title="Not permitted"
          hint="Refunds can only be issued by a store manager or an administrator."
        />
      </SafeAreaView>
    );
  }

  if (tx.isLoading || !rows) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <Loading label="Loading sale" />
      </SafeAreaView>
    );
  }

  if (tx.isError || !tx.data) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState icon="cloud-off" title="Couldn't load the sale" hint="Refunds need a connection." />
      </SafeAreaView>
    );
  }

  const t = tx.data;
  const estimate = rows.reduce(
    (sum, l) => sum + (l.sold > 0 ? (l.lineTotal * l.refunding) / l.sold : 0),
    0
  );
  const anything = rows.some((l) => l.refunding > 0);
  const isFull = rows.every((l) => l.refunding === l.sold);

  function setQuantity(productId: string, next: number) {
    setLines(
      (rows as RefundLine[]).map((l) =>
        l.product_id === productId
          ? { ...l, refunding: Math.max(0, Math.min(l.sold, next)) }
          : l
      )
    );
  }

  function submit() {
    Alert.alert(
      isFull ? 'Refund whole sale?' : 'Refund part of this sale?',
      `${formatKwacha(estimate)} goes back to the customer and the stock returns to ${
        store.data?.name ?? 'the store'
      }. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Refund', style: 'destructive', onPress: () => void run() },
      ]
    );
  }

  async function run() {
    setBusy(true);
    try {
      const refund = await txApi.refund(t.id, {
        reason: reason.trim() || `Refund of ${t.receipt_number}`,
        // A full refund goes up without an item list, which is how the server
        // distinguishes "everything" from "these exact units".
        items: isFull
          ? undefined
          : (rows as RefundLine[])
              .filter((l) => l.refunding > 0)
              .map((l) => ({ product_id: l.product_id, quantity: l.refunding })),
        client_reference: newClientReference(),
      });

      void queryClient.invalidateQueries({ queryKey: ['transaction', t.id] });
      void queryClient.invalidateQueries({ queryKey: ['sales-history'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['recent-transactions'] });
      if (t.store_id) void queryClient.invalidateQueries({ queryKey: ['catalogue', t.store_id] });

      router.back();
      if (store.data) offerReceipt(refund, store.data, 'Refund issued');
      else Alert.alert('Refund issued', formatKwacha(refund.total));
    } catch (err) {
      Alert.alert('Refund failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl, gap: spacing.lg }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.originCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.originLabel}>Refunding against</Text>
            <Text style={styles.originReceipt}>{t.receipt_number}</Text>
            <Text style={styles.originMeta}>
              {new Date(t.created_at).toLocaleString()} · {formatKwacha(t.total)}
            </Text>
          </View>
          <Badge label={isFull ? 'FULL' : 'PARTIAL'} tone={isFull ? 'danger' : 'warning'} />
        </View>

        <View>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionLabel}>Items coming back</Text>
            <Pressable
              onPress={() =>
                setLines(
                  (rows as RefundLine[]).map((l) => ({
                    ...l,
                    refunding: isFull ? 0 : l.sold,
                  }))
                )
              }
            >
              <Text style={styles.link}>{isFull ? 'Clear all' : 'Select all'}</Text>
            </Pressable>
          </View>

          <View style={styles.card}>
            {rows.map((line, index) => (
              <View key={line.product_id}>
                {index > 0 ? <View style={styles.divider} /> : null}
                <View style={styles.line}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.lineName} numberOfLines={2}>
                      {line.name}
                    </Text>
                    <Text style={styles.lineMeta}>
                      {line.sold} sold · {formatKwacha(line.unitPrice)} each
                    </Text>
                  </View>

                  <View style={styles.stepper}>
                    <Step
                      icon="minus"
                      disabled={line.refunding <= 0}
                      onPress={() => setQuantity(line.product_id, line.refunding - 1)}
                    />
                    <Text style={styles.stepValue}>{line.refunding}</Text>
                    <Step
                      icon="plus"
                      disabled={line.refunding >= line.sold}
                      onPress={() => setQuantity(line.product_id, line.refunding + 1)}
                    />
                  </View>
                </View>
              </View>
            ))}
          </View>
        </View>

        <View>
          <Text style={styles.sectionLabel}>Reason</Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Damaged, wrong item, customer changed mind…"
            placeholderTextColor={colors.textFaint}
            style={styles.reason}
            multiline
          />
        </View>

        <View style={styles.summary}>
          <View style={{ flex: 1 }}>
            <Text style={styles.summaryLabel}>Refund total</Text>
            <Text style={styles.summaryHint}>
              Estimated from the original lines; the server sets the final figure.
            </Text>
          </View>
          <Text style={styles.summaryAmount}>{formatKwacha(estimate)}</Text>
        </View>

        <Button
          label={busy ? 'Processing' : 'Issue Refund'}
          icon="corner-up-left"
          variant="danger"
          size="lg"
          loading={busy}
          disabled={!anything}
          onPress={submit}
        />
        <Button label="Cancel" variant="ghost" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Step({
  icon,
  onPress,
  disabled,
}: {
  icon: 'plus' | 'minus';
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [
        styles.step,
        disabled && { opacity: 0.3 },
        pressed && !disabled && { backgroundColor: colors.border },
      ]}
    >
      <Icon name={icon} size={16} color={colors.text} />
    </Pressable>
  );
}

/**
 * Collapses the sale into one row per product. The server matches refund
 * quantities on `product_id`, so two lines of the same product would otherwise
 * each be refunded the quantity meant for one.
 */
function toRefundLines(items: TransactionItem[]): RefundLine[] {
  const byProduct = new Map<string, RefundLine>();

  for (const item of items) {
    const quantity = Math.abs(item.quantity);
    const existing = byProduct.get(item.product_id);
    if (existing) {
      existing.sold += quantity;
      existing.lineTotal += item.line_total;
      existing.refunding = existing.sold;
    } else {
      byProduct.set(item.product_id, {
        product_id: item.product_id,
        name: item.product_name,
        sold: quantity,
        unitPrice: item.unit_price,
        lineTotal: item.line_total,
        refunding: quantity,
      });
    }
  }

  return [...byProduct.values()];
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  originCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: '#EFD3CB',
    padding: spacing.lg,
  },
  originLabel: { fontFamily: font.medium, fontSize: 11, color: colors.danger, letterSpacing: 0.6 },
  originReceipt: { fontFamily: font.bold, fontSize: 16, color: colors.text, marginTop: 2 },
  originMeta: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted, marginTop: 2 },

  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  sectionLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  link: {
    fontFamily: font.semibold,
    fontSize: 12,
    color: colors.primary,
    marginBottom: spacing.sm,
  },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },

  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  lineName: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  lineMeta: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 2 },

  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.pill,
    padding: 4,
  },
  step: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepValue: {
    minWidth: 22,
    textAlign: 'center',
    fontFamily: font.bold,
    fontSize: 15,
    color: colors.text,
  },

  reason: {
    minHeight: 76,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    fontFamily: font.regular,
    fontSize: 14,
    color: colors.text,
    textAlignVertical: 'top',
  },

  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  summaryLabel: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  summaryHint: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 2 },
  summaryAmount: { fontFamily: font.extrabold, fontSize: 24, color: colors.danger, letterSpacing: -0.8 },
});
