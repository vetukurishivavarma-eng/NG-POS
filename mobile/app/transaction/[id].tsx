import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { stores as storesApi, transactions as txApi } from '../../src/api/endpoints';
import { useAuth, can, capabilitiesFor } from '../../src/store/auth';
import { useStoreSelection } from '../../src/store/storeSelection';
import { printTransaction } from '../../src/printing/print';
import { printBlockedReason } from '../../src/printing/printer';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, formatKwacha, radius, spacing } from '../../src/theme';
import { Badge, Button, EmptyState, Icon, Loading } from '../../src/ui/components';

export default function TransactionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const layout = useLayout();
  const user = useAuth((s) => s.user);
  const selectedStore = useStoreSelection((s) => s.selected);
  const [printing, setPrinting] = useState(false);

  const tx = useQuery({
    queryKey: ['transaction', id],
    enabled: Boolean(id),
    queryFn: () => txApi.get(id as string),
  });

  // The receipt header needs the store the sale belongs to, which is not
  // necessarily the one the device is currently selling from.
  const store = useQuery({
    queryKey: ['store', tx.data?.store_id],
    enabled: Boolean(tx.data?.store_id),
    queryFn: () => storesApi.get(tx.data?.store_id as string),
    initialData:
      selectedStore && selectedStore.id === tx.data?.store_id ? selectedStore : undefined,
  });

  if (tx.isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <Loading label="Loading receipt" />
      </SafeAreaView>
    );
  }

  if (tx.isError || !tx.data) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="cloud-off"
          title="Couldn't load this transaction"
          hint="It needs a connection — offline sales have no receipt until they sync."
          action={<Button label="Retry" icon="refresh-cw" variant="secondary" onPress={() => void tx.refetch()} />}
        />
      </SafeAreaView>
    );
  }

  const t = tx.data;
  const isReversal = t.transaction_type !== 'sale';
  const canRefund =
    capabilitiesFor(user).includes('reports') &&
    t.transaction_type === 'sale' &&
    t.status === 'completed';
  const canSeeHistory = can(user, 'audit.read');

  async function reprint() {
    if (!store.data) return;
    setPrinting(true);
    try {
      await printTransaction(t, store.data);
    } finally {
      setPrinting(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl, gap: spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.hero, isReversal && { backgroundColor: colors.danger }]}>
          <View style={styles.heroGlow} />
          <Text style={styles.heroKind}>
            {t.transaction_type.replace('_', ' ').toUpperCase()}
          </Text>
          <Text style={styles.heroAmount}>{formatKwacha(t.total)}</Text>
          <Text style={styles.heroReceipt}>{t.receipt_number || 'Awaiting receipt number'}</Text>
          {t.status !== 'completed' ? (
            <View style={{ marginTop: spacing.md }}>
              <Badge
                label={t.status.toUpperCase()}
                tone={t.status === 'refunded' ? 'warning' : t.status === 'voided' ? 'danger' : 'neutral'}
              />
            </View>
          ) : null}
        </View>

        <View style={styles.card}>
          <Meta icon="clock" label="Date" value={new Date(t.created_at).toLocaleString()} />
          <Meta icon="user" label="Cashier" value={t.cashier_name || '—'} />
          <Meta icon="home" label="Store" value={store.data?.name ?? '—'} />
          {t.customer_name ? <Meta icon="users" label="Customer" value={t.customer_name} /> : null}
          {t.notes ? <Meta icon="file-text" label="Note" value={t.notes} /> : null}
        </View>

        <View style={styles.card}>
          {t.items.map((item, index) => (
            <View key={`${item.product_id}-${index}`} style={styles.item}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>{item.product_name}</Text>
                <Text style={styles.itemMeta}>
                  {item.quantity} × {formatKwacha(item.unit_price)}
                  {item.discount_amount > 0 ? ` · −${formatKwacha(item.discount_amount)}` : ''}
                  {item.tax_type === 'vat' ? ' · VAT' : ''}
                </Text>
              </View>
              <Text style={styles.itemTotal}>{formatKwacha(item.line_total)}</Text>
            </View>
          ))}

          <View style={styles.divider} />

          <TotalRow label="Subtotal" value={formatKwacha(t.subtotal)} />
          {t.discount_amount > 0 ? (
            <TotalRow label="Discount" value={`−${formatKwacha(t.discount_amount)}`} />
          ) : null}
          {t.tax_amount !== 0 ? <TotalRow label="VAT" value={formatKwacha(t.tax_amount)} /> : null}
          <TotalRow label="Total" value={formatKwacha(t.total)} strong />
        </View>

        {t.payments.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Payment</Text>
            {t.payments.map((p, index) => (
              <View key={index} style={styles.payRow}>
                <View style={styles.payLeft}>
                  <Icon
                    name={p.method === 'cash' ? 'dollar-sign' : p.method === 'card' ? 'credit-card' : 'smartphone'}
                    size={15}
                    color={colors.textMuted}
                  />
                  <Text style={styles.payMethod}>{p.method}</Text>
                </View>
                <Text style={styles.payAmount}>{formatKwacha(p.amount)}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={{ gap: spacing.sm }}>
          <Button
            label="Reprint Receipt"
            icon="printer"
            variant="secondary"
            loading={printing}
            disabled={!store.data}
            onPress={() => {
              const blocked = printBlockedReason();
              if (blocked) {
                Alert.alert('Cannot print', blocked);
                return;
              }
              void reprint();
            }}
          />

          {canRefund ? (
            <Button
              label="Refund This Sale"
              icon="corner-up-left"
              variant="danger"
              onPress={() => router.push(`/refund?id=${t.id}`)}
            />
          ) : null}

          {/* The receipt shows what the sale is now. This shows whether it has
              always been that — which is the question actually being asked when
              somebody brings a printed receipt back to the counter. */}
          {canSeeHistory ? (
            <Button
              label="History of This Sale"
              icon="clock"
              variant="ghost"
              onPress={() => router.push(`/history?entity=transaction&entity_id=${t.id}`)}
            />
          ) : null}

          {t.status === 'refunded' ? (
            <Text style={styles.note}>
              Already refunded. The reversal is a separate transaction in the history.
            </Text>
          ) : t.transaction_type === 'sale' && !capabilitiesFor(user).includes('reports') ? (
            <Text style={styles.note}>Refunds need a manager or administrator.</Text>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Meta({ icon, label, value }: { icon: 'clock' | 'user' | 'home' | 'users' | 'file-text'; label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <View style={styles.metaLeft}>
        <Icon name={icon} size={15} color={colors.textFaint} />
        <Text style={styles.metaLabel}>{label}</Text>
      </View>
      <Text style={styles.metaValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.totalRow}>
      <Text style={[styles.totalLabel, strong && styles.totalLabelStrong]}>{label}</Text>
      <Text style={[styles.totalValue, strong && styles.totalValueStrong]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  hero: {
    backgroundColor: colors.primaryDeep,
    borderRadius: radius.xl,
    padding: spacing.xl,
    overflow: 'hidden',
  },
  heroGlow: {
    position: 'absolute',
    top: -70,
    right: -50,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: colors.primaryBright,
    opacity: 0.35,
  },
  heroKind: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.onDarkMuted,
    letterSpacing: 1.4,
  },
  heroAmount: {
    fontFamily: font.extrabold,
    fontSize: 36,
    color: colors.onDark,
    letterSpacing: -1.2,
    marginTop: 6,
  },
  heroReceipt: { fontFamily: font.medium, fontSize: 13, color: colors.onDarkMuted, marginTop: 4 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  cardLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },

  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: 5,
  },
  metaLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  metaLabel: { fontFamily: font.medium, fontSize: 13, color: colors.textMuted },
  metaValue: {
    flex: 1,
    fontFamily: font.semibold,
    fontSize: 13,
    color: colors.text,
    textAlign: 'right',
  },

  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 7 },
  itemName: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  itemMeta: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 2 },
  itemTotal: { fontFamily: font.semibold, fontSize: 14, color: colors.text },

  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  totalLabel: { fontFamily: font.regular, fontSize: 13, color: colors.textMuted },
  totalLabelStrong: { fontFamily: font.bold, fontSize: 16, color: colors.text },
  totalValue: { fontFamily: font.medium, fontSize: 13, color: colors.text },
  totalValueStrong: { fontFamily: font.extrabold, fontSize: 18, color: colors.primary },

  payRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 },
  payLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  payMethod: {
    fontFamily: font.medium,
    fontSize: 13,
    color: colors.textMuted,
    textTransform: 'capitalize',
  },
  payAmount: { fontFamily: font.semibold, fontSize: 13, color: colors.text },

  note: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
});
