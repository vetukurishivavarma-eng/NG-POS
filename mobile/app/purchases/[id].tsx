import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { purchases as purchasesApi } from '../../src/api/endpoints';
import { errorMessage } from '../../src/api/client';
import { useCan } from '../../src/store/auth';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing } from '../../src/theme';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  Loading,
  SectionLabel,
  Select,
  StatRow,
} from '../../src/ui/components';
import { InvoiceStatusBadge } from '../../src/ui/invoiceStatus';
import type { SupplierPaymentMethod } from '../../src/api/types';

/**
 * One supplier invoice: what arrived, what it came to, and every instalment
 * paid against it. The balance is the headline because it is the only figure
 * anyone opens this screen to find.
 */
export default function PurchaseDetailScreen() {
  const layout = useLayout();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const canPay = useCan('purchases.write');
  const canDelete = useCan('purchases.delete');

  const [paying, setPaying] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<SupplierPaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);

  const query = useQuery({
    queryKey: ['purchase', id],
    enabled: Boolean(id),
    queryFn: () => purchasesApi.get(id as string),
  });

  const invoice = query.data;

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['purchase', id] });
    void queryClient.invalidateQueries({ queryKey: ['purchases'] });
    void queryClient.invalidateQueries({ queryKey: ['purchase-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
  }

  async function pay() {
    if (!invoice) return;
    const value = Number(amount.trim());
    if (!Number.isFinite(value) || value <= 0) return;

    setBusy(true);
    try {
      const updated = await purchasesApi.pay(invoice.id, {
        amount: value,
        method,
        reference: reference.trim(),
      });
      invalidate();
      setPaying(false);
      setAmount('');
      setReference('');
      Alert.alert(
        updated.balance > 0 ? 'Payment recorded' : 'Invoice settled',
        updated.balance > 0
          ? `${formatKwacha(updated.balance)} still owed to ${updated.supplier_name}.`
          : `${updated.supplier_name} has been paid in full.`
      );
    } catch (err) {
      Alert.alert("Couldn't record the payment", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    if (!invoice) return;
    Alert.alert(
      `Delete invoice ${invoice.invoice_number}?`,
      `The ${invoice.items.length} line${invoice.items.length === 1 ? '' : 's'} it added will be taken back off the shelf. This is for correcting a mis-keyed entry, not for returning goods.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete and reverse',
          style: 'destructive',
          onPress: () => {
            void purchasesApi
              .remove(invoice.id)
              .then(() => {
                invalidate();
                router.back();
              })
              .catch((err: unknown) => Alert.alert("Couldn't delete", errorMessage(err)));
          },
        },
      ]
    );
  }

  if (query.isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <Loading label="Loading the invoice" />
      </SafeAreaView>
    );
  }

  if (query.isError || !invoice) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="cloud-off"
          title="Couldn't load the invoice"
          hint="Supplier invoices are served live — they need a connection."
          action={
            <Button
              label="Retry"
              icon="refresh-cw"
              variant="secondary"
              onPress={() => void query.refetch()}
            />
          }
        />
      </SafeAreaView>
    );
  }

  const overdue =
    invoice.balance > 0 && invoice.due_date != null && new Date(invoice.due_date) < new Date();
  const typedAmount = Number(amount.trim());
  const amountValid = Number.isFinite(typedAmount) && typedAmount > 0 && typedAmount <= invoice.balance;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl, gap: spacing.lg }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <View style={styles.heroGlow} />
          <View style={styles.heroTop}>
            <View style={{ flex: 1 }}>
              <Text style={styles.heroSupplier} numberOfLines={2}>
                {invoice.supplier_name}
              </Text>
              <Text style={styles.heroMeta}>
                {invoice.invoice_number} · {new Date(invoice.invoice_date).toLocaleDateString()}
              </Text>
            </View>
            <InvoiceStatusBadge status={invoice.status} />
          </View>

          <Text style={styles.heroLabel}>{invoice.balance > 0 ? 'Still owed' : 'Settled'}</Text>
          <Text style={styles.heroValue}>{formatKwacha(invoice.balance)}</Text>
          <Text style={styles.heroFoot}>
            {formatKwacha(invoice.amount_paid)} paid of {formatKwacha(invoice.total)} · into{' '}
            {invoice.store_name}
          </Text>

          {invoice.due_date ? (
            <View style={[styles.dueTag, overdue && styles.dueTagLate]}>
              <Icon
                name={overdue ? 'alert-triangle' : 'calendar'}
                size={13}
                color={overdue ? colors.accent : colors.onDarkMuted}
              />
              <Text style={styles.dueText}>
                {overdue ? 'Was due ' : 'Due '}
                {new Date(invoice.due_date).toLocaleDateString()}
              </Text>
            </View>
          ) : null}
        </View>

        {/* -------------------------------------------------- record payment */}
        {canPay && invoice.balance > 0 ? (
          paying ? (
            <View style={styles.payCard}>
              <Text style={styles.payTitle}>Record a payment</Text>
              <Field
                label="Amount"
                value={amount}
                onChangeText={(t) => setAmount(numericText(t))}
                placeholder={String(invoice.balance)}
                keyboardType="numeric"
                prefix="K"
                autoFocus
                error={
                  amount.trim() && !amountValid
                    ? typedAmount > invoice.balance
                      ? `More than the ${formatKwacha(invoice.balance)} outstanding.`
                      : 'Enter an amount.'
                    : null
                }
                hint={
                  amountValid && typedAmount < invoice.balance
                    ? `${formatKwacha(round2(invoice.balance - typedAmount))} would stay owed.`
                    : undefined
                }
              />
              <Button
                label={`Pay the full ${formatKwacha(invoice.balance)}`}
                variant="secondary"
                onPress={() => setAmount(String(invoice.balance))}
              />
              <Select<SupplierPaymentMethod>
                label="How it was paid"
                value={method}
                onChange={setMethod}
                options={[
                  { value: 'cash', label: 'Cash' },
                  { value: 'bank_transfer', label: 'Bank transfer' },
                  { value: 'mobile', label: 'Mobile money' },
                  { value: 'cheque', label: 'Cheque' },
                  { value: 'card', label: 'Card' },
                  { value: 'other', label: 'Other' },
                ]}
              />
              <Field
                label="Reference"
                value={reference}
                onChangeText={setReference}
                placeholder="Cheque number, transfer reference, mobile code"
                autoCapitalize="characters"
              />
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Button
                  label="Cancel"
                  variant="secondary"
                  style={{ flex: 1 }}
                  onPress={() => {
                    setPaying(false);
                    setAmount('');
                  }}
                />
                <Button
                  label="Record"
                  icon="check"
                  style={{ flex: 1 }}
                  loading={busy}
                  disabled={!amountValid}
                  onPress={() => void pay()}
                />
              </View>
            </View>
          ) : (
            <Button label="Record a Payment" icon="credit-card" onPress={() => setPaying(true)} />
          )
        ) : null}

        {/* --------------------------------------------------------- lines */}
        <View style={{ gap: spacing.sm }}>
          <SectionLabel>What arrived</SectionLabel>
          <View style={styles.card}>
            {invoice.items.map((item, index) => (
              <View key={item.id} style={[styles.itemRow, index > 0 && styles.itemDivider]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName} numberOfLines={2}>
                    {item.product_name}
                  </Text>
                  <Text style={styles.itemMeta} numberOfLines={1}>
                    {item.sku || '—'} · {item.quantity} × {formatKwacha(item.unit_cost)}
                  </Text>
                </View>
                <Text style={styles.itemTotal}>{formatKwacha(item.line_total)}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* -------------------------------------------------------- totals */}
        <View style={styles.card}>
          <StatRow label="Goods" value={formatKwacha(invoice.subtotal)} />
          {invoice.tax_amount > 0 ? (
            <StatRow label="VAT" value={formatKwacha(invoice.tax_amount)} />
          ) : null}
          {invoice.other_charges > 0 ? (
            <StatRow label="Delivery and handling" value={formatKwacha(invoice.other_charges)} />
          ) : null}
          {invoice.discount_amount > 0 ? (
            <StatRow label="Discount" value={`− ${formatKwacha(invoice.discount_amount)}`} />
          ) : null}
          <View style={styles.divider} />
          <StatRow label="Invoice total" value={formatKwacha(invoice.total)} emphasis />
          <StatRow label="Paid" value={formatKwacha(invoice.amount_paid)} tone="success" />
          <StatRow
            label="Balance"
            value={formatKwacha(invoice.balance)}
            emphasis
            tone={invoice.balance > 0 ? 'danger' : 'success'}
          />
        </View>

        {/* ------------------------------------------------------ payments */}
        {invoice.payments.length > 0 ? (
          <View style={{ gap: spacing.sm }}>
            <SectionLabel>Payments made</SectionLabel>
            <View style={styles.card}>
              {invoice.payments.map((payment, index) => (
                <View key={payment.id} style={[styles.itemRow, index > 0 && styles.itemDivider]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{methodLabel(payment.method)}</Text>
                    <Text style={styles.itemMeta} numberOfLines={1}>
                      {new Date(payment.paid_at).toLocaleDateString()}
                      {payment.reference ? ` · ${payment.reference}` : ''}
                      {payment.user_name ? ` · ${payment.user_name}` : ''}
                    </Text>
                  </View>
                  <Text style={[styles.itemTotal, { color: colors.success }]}>
                    {formatKwacha(payment.amount)}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {invoice.notes ? (
          <View style={{ gap: spacing.sm }}>
            <SectionLabel>Notes</SectionLabel>
            <View style={styles.card}>
              <Text style={styles.notes}>{invoice.notes}</Text>
            </View>
          </View>
        ) : null}

        <View style={styles.footerMeta}>
          <Badge label={invoice.store_code} tone="neutral" />
          {invoice.created_by_name ? (
            <Text style={styles.footerText}>Entered by {invoice.created_by_name}</Text>
          ) : null}
        </View>

        {canDelete && invoice.amount_paid === 0 ? (
          <Button
            label="Delete and Reverse the Stock"
            icon="trash-2"
            variant="danger"
            onPress={confirmDelete}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function methodLabel(method: SupplierPaymentMethod): string {
  return {
    cash: 'Cash',
    bank_transfer: 'Bank transfer',
    mobile: 'Mobile money',
    cheque: 'Cheque',
    card: 'Card',
    other: 'Other',
  }[method];
}

function numericText(text: string): string {
  const cleaned = text.replace(/[^0-9.]/g, '');
  const dot = cleaned.indexOf('.');
  if (dot === -1) return cleaned;
  return cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, '');
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
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
    top: -80,
    right: -60,
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: colors.primaryBright,
    opacity: 0.38,
  },
  heroTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  heroSupplier: { fontFamily: font.bold, fontSize: 18, color: colors.onDark, letterSpacing: -0.4 },
  heroMeta: { fontFamily: font.regular, fontSize: 12, color: colors.onDarkMuted, marginTop: 3 },
  heroLabel: {
    fontFamily: font.medium,
    fontSize: 11,
    color: colors.onDarkMuted,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginTop: spacing.lg,
  },
  heroValue: {
    fontFamily: font.extrabold,
    fontSize: 42,
    color: colors.onDark,
    letterSpacing: -1.5,
    marginTop: 2,
  },
  heroFoot: { fontFamily: font.regular, fontSize: 11, color: colors.onDarkMuted, marginTop: 4 },
  dueTag: {
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
  dueTagLate: { backgroundColor: 'rgba(223,160,44,0.22)' },
  dueText: { fontFamily: font.semibold, fontSize: 11, color: colors.onDark },

  payCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.primary,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadow.card,
  },
  payTitle: { fontFamily: font.bold, fontSize: 16, color: colors.text },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    ...shadow.card,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },

  itemRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  itemDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  itemName: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  itemMeta: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 2 },
  itemTotal: { fontFamily: font.bold, fontSize: 14, color: colors.text },

  notes: { fontFamily: font.regular, fontSize: 13, color: colors.textMuted, lineHeight: 19 },

  footerMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  footerText: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint },
});
