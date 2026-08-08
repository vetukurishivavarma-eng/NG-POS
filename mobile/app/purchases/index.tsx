import React, { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { purchases as purchasesApi } from '../../src/api/endpoints';
import { useCan } from '../../src/store/auth';
import { useStoreSelection } from '../../src/store/storeSelection';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing } from '../../src/theme';
import { Badge, Button, EmptyState, Icon, Loading, Select } from '../../src/ui/components';
import { InvoiceStatusBadge } from '../../src/ui/invoiceStatus';
import type { SupplierInvoice } from '../../src/api/types';

type Filter = 'outstanding' | 'paid' | 'all';

/**
 * Supplier invoices for the current shop, newest first.
 *
 * Opens on "outstanding" rather than everything, because a list of invoices is
 * only consulted for one reason: to find the ones still to be paid.
 */
export default function PurchasesScreen() {
  const layout = useLayout();
  const store = useStoreSelection((s) => s.selected);
  const canWrite = useCan('purchases.write');
  const params = useLocalSearchParams<{ supplier_id?: string }>();
  const supplierId = params.supplier_id;

  const [filter, setFilter] = useState<Filter>('outstanding');

  const storeId = store?.id ?? null;

  const list = useQuery({
    queryKey: ['purchases', storeId, supplierId ?? null, filter],
    enabled: Boolean(storeId),
    queryFn: () =>
      purchasesApi.list({
        ...(storeId ? { store_id: storeId } : {}),
        ...(supplierId ? { supplier_id: supplierId } : {}),
        ...(filter === 'all' ? {} : { status: filter === 'paid' ? 'paid' : 'outstanding' }),
        limit: 100,
      }),
  });

  const summary = useQuery({
    queryKey: ['purchase-summary', storeId],
    enabled: Boolean(storeId),
    queryFn: () => purchasesApi.summary(storeId as string),
  });

  if (!store) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="home"
          title="No shop selected"
          hint="Choose a shop first — invoices are recorded against the shop the goods were delivered to."
          action={
            <Button
              label="Choose shop"
              icon="home"
              variant="secondary"
              onPress={() => router.push('/store-picker')}
            />
          }
        />
      </SafeAreaView>
    );
  }

  const rows = list.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.gutter,
          paddingBottom: spacing.xxl,
          gap: spacing.md,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={list.isRefetching}
            onRefresh={() => {
              void list.refetch();
              void summary.refetch();
            }}
            tintColor={colors.primary}
          />
        }
      >
        {summary.data ? (
          <View style={styles.hero}>
            <View style={styles.heroGlow} />
            <Text style={styles.heroLabel}>Still to pay · {store.name}</Text>
            <Text style={styles.heroValue}>{formatKwacha(summary.data.outstanding_total)}</Text>
            <Text style={styles.heroFoot}>
              {summary.data.open_invoice_count} open invoice
              {summary.data.open_invoice_count === 1 ? '' : 's'}
              {summary.data.overdue_count > 0
                ? ` · ${formatKwacha(summary.data.overdue_total)} overdue`
                : ''}
            </Text>
            {summary.data.overdue_count > 0 ? (
              <View style={styles.overdueTag}>
                <Icon name="alert-triangle" size={13} color={colors.accent} />
                <Text style={styles.overdueText}>
                  {summary.data.overdue_count} past its due date
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {canWrite ? (
          <Button
            label="Record a Delivery"
            icon="plus"
            onPress={() => router.push('/purchases/new')}
          />
        ) : null}

        <Select<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'outstanding', label: 'Outstanding' },
            { value: 'paid', label: 'Paid' },
            { value: 'all', label: 'All' },
          ]}
        />

        {supplierId ? (
          <Pressable style={styles.filterChip} onPress={() => router.setParams({ supplier_id: '' })}>
            <Icon name="filter" size={13} color={colors.primary} />
            <Text style={styles.filterChipText}>
              {rows[0]?.supplier_name ?? 'One supplier'} only — tap to clear
            </Text>
            <Icon name="x" size={13} color={colors.primary} />
          </Pressable>
        ) : null}

        {list.isLoading ? (
          <Loading label="Loading invoices" />
        ) : list.isError ? (
          <EmptyState
            icon="cloud-off"
            title="Couldn't load invoices"
            hint="Supplier invoices are served live — they need a connection."
            action={
              <Button
                label="Retry"
                icon="refresh-cw"
                variant="secondary"
                onPress={() => void list.refetch()}
              />
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="file-text"
            title={filter === 'outstanding' ? 'Nothing outstanding' : 'No invoices yet'}
            hint={
              filter === 'outstanding'
                ? 'Every supplier invoice for this shop has been settled.'
                : 'Record a delivery and the stock goes on the shelf, the cost is captured, and the amount owed is tracked — all from the one entry.'
            }
          />
        ) : (
          rows.map((invoice) => <InvoiceRow key={invoice.id} invoice={invoice} />)
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function InvoiceRow({ invoice }: { invoice: SupplierInvoice }) {
  const overdue =
    invoice.balance > 0 && invoice.due_date != null && new Date(invoice.due_date) < new Date();

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => router.push(`/purchases/${invoice.id}`)}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={styles.rowSupplier} numberOfLines={1}>
          {invoice.supplier_name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {invoice.invoice_number} · {new Date(invoice.invoice_date).toLocaleDateString()} ·{' '}
          {invoice.items.length} line{invoice.items.length === 1 ? '' : 's'}
        </Text>
        <View style={styles.rowTags}>
          <InvoiceStatusBadge status={invoice.status} />
          {overdue ? <Badge label="OVERDUE" tone="danger" dot /> : null}
        </View>
      </View>

      <View style={{ alignItems: 'flex-end', gap: 3 }}>
        <Text style={styles.rowTotal}>{formatKwacha(invoice.total)}</Text>
        {invoice.balance > 0 ? (
          <Text style={styles.rowBalance}>{formatKwacha(invoice.balance)} owed</Text>
        ) : (
          <Text style={styles.rowSettled}>Settled</Text>
        )}
      </View>

      <Icon name="chevron-right" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

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
    opacity: 0.38,
  },
  heroLabel: {
    fontFamily: font.medium,
    fontSize: 11,
    color: colors.onDarkMuted,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  heroValue: {
    fontFamily: font.extrabold,
    fontSize: 38,
    color: colors.onDark,
    letterSpacing: -1.4,
    marginTop: 4,
  },
  heroFoot: { fontFamily: font.regular, fontSize: 12, color: colors.onDarkMuted, marginTop: 2 },
  overdueTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.13)',
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: radius.pill,
    marginTop: spacing.md,
  },
  overdueText: { fontFamily: font.semibold, fontSize: 11, color: colors.onDark },

  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
  },
  filterChipText: { fontFamily: font.semibold, fontSize: 12, color: colors.primary },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    ...shadow.card,
  },
  rowPressed: { transform: [{ scale: 0.99 }], opacity: 0.9 },
  rowSupplier: { fontFamily: font.bold, fontSize: 15, color: colors.text },
  rowMeta: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint },
  rowTags: { flexDirection: 'row', gap: 6, marginTop: 3 },
  rowTotal: { fontFamily: font.bold, fontSize: 16, color: colors.text, letterSpacing: -0.4 },
  rowBalance: { fontFamily: font.semibold, fontSize: 11, color: colors.danger },
  rowSettled: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint },
});
