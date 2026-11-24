import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { products as productsApi, transactions as txApi } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { useAuth, can } from '../src/store/auth';
import { useLayout } from '../src/ui/responsive';
import { colors, font, formatKwacha, radius, spacing } from '../src/theme';
import { Button, EmptyState, Field, Icon, Loading, Select } from '../src/ui/components';

/**
 * Admin: fix a sale in place without refunding it (POST /transactions/:id/correct).
 * Same receipt number; stock moves by the difference only.
 */
interface Line {
  product_id: string;
  name: string;
  qty: string;
  price: string;
  discount: string;
}

type Method = 'cash' | 'card' | 'mobile';

export default function CorrectInvoiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const layout = useLayout();
  const queryClient = useQueryClient();
  const user = useAuth((s) => s.user);

  const [lines, setLines] = useState<Line[] | null>(null);
  const [method, setMethod] = useState<Method>('cash');
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const tx = useQuery({
    queryKey: ['transaction', id],
    enabled: Boolean(id),
    queryFn: () => txApi.get(id as string),
  });

  const found = useQuery({
    queryKey: ['correct-search', search],
    enabled: search.trim().length >= 2,
    queryFn: () => productsApi.list({ search: search.trim(), limit: 15 }),
  });

  // Seed the form once from the sale.
  useEffect(() => {
    const t = tx.data;
    if (!t || lines) return;
    setLines(
      t.items
        .filter((i) => i.product_id)
        .map((i) => ({
          product_id: i.product_id as string,
          name: i.product_name,
          qty: String(i.quantity),
          price: String(i.unit_price),
          discount: i.discount_amount > 0 ? String(i.discount_amount) : '',
        }))
    );
    setMethod((t.payments[0]?.method as Method) ?? 'cash');
    setCustomer(t.customer_name ?? '');
    setPhone(t.customer_phone ?? '');
  }, [tx.data, lines]);

  if (!can(user, 'transactions.correct')) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState icon="lock" title="Not permitted" hint="Only an administrator can correct an invoice." />
      </SafeAreaView>
    );
  }
  if (tx.isLoading || !lines) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <Loading label="Loading invoice" />
      </SafeAreaView>
    );
  }

  const t = tx.data!;
  const num = (s: string) => Number(s.replace(',', '.'));
  // Preview only (VAT not included); the server recomputes the real total.
  const preview = lines.reduce((sum, l) => sum + (num(l.qty) || 0) * (num(l.price) || 0) - (num(l.discount) || 0), 0);
  const update = (i: number, patch: Partial<Line>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function save() {
    if (!lines) return;
    const bad = lines.find((l) => !(num(l.qty) > 0) || !(num(l.price) >= 0) || Number.isNaN(num(l.price)));
    if (lines.length === 0) return Alert.alert('No items', 'An invoice needs at least one item.');
    if (bad) return Alert.alert('Check the lines', `${bad.name}: quantity must be above 0 and price a number.`);
    if (!reason.trim()) return Alert.alert('Reason needed', 'Say why the invoice is being corrected.');

    setBusy(true);
    try {
      await txApi.correct(id as string, {
        items: lines.map((l) => ({
          product_id: l.product_id,
          quantity: num(l.qty),
          unit_price: num(l.price),
          ...(l.discount ? { discount_amount: num(l.discount) } : {}),
        })),
        // Single tender: the server sets its amount to the corrected total.
        payments: [{ method, amount: 0 }],
        customer_name: customer.trim() || null,
        customer_phone: phone.trim() || null,
        reason: reason.trim(),
      });
      await queryClient.invalidateQueries();
      router.back();
    } catch (error) {
      Alert.alert('Could not correct', errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl, gap: spacing.lg }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.head}>
          {t.receipt_number} · was {formatKwacha(t.total)}
        </Text>
        <Text style={styles.note}>
          Same receipt number. No refund is made — stock is adjusted only by what changed.
        </Text>

        <View style={styles.card}>
          {lines.map((l, i) => (
            <View key={`${l.product_id}-${i}`} style={styles.line}>
              <View style={styles.lineTop}>
                <Text style={styles.name} numberOfLines={2}>{l.name}</Text>
                <Pressable onPress={() => setLines(lines.filter((_, j) => j !== i))} hitSlop={10}>
                  <Icon name="trash-2" size={18} color={colors.danger} />
                </Pressable>
              </View>
              <View style={styles.inputs}>
                <Small label="Qty" value={l.qty} onChange={(v) => update(i, { qty: v })} />
                <Small label="Unit price" value={l.price} onChange={(v) => update(i, { price: v })} />
                <Small label="Discount" value={l.discount} onChange={(v) => update(i, { discount: v })} />
              </View>
            </View>
          ))}
          <Text style={styles.total}>New total ≈ {formatKwacha(preview)}</Text>
        </View>

        <View style={styles.card}>
          <Field label="Add a product" value={search} onChangeText={setSearch} placeholder="Type 2+ letters" />
          {(found.data ?? []).map((p) => (
            <Pressable
              key={p.id}
              style={styles.result}
              onPress={() => {
                setLines([
                  ...lines,
                  { product_id: p.id, name: p.name, qty: '1', price: String(p.selling_price), discount: '' },
                ]);
                setSearch('');
              }}
            >
              <Text style={styles.name}>{p.name}</Text>
              <Text style={styles.meta}>{formatKwacha(p.selling_price)}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.card}>
          <Select<Method>
            label="Paid by"
            value={method}
            onChange={setMethod}
            options={[
              { value: 'cash', label: 'Cash' },
              { value: 'card', label: 'Card' },
              { value: 'mobile', label: 'Mobile money' },
            ]}
            hint={t.payments.length > 1 ? 'This sale was split; the correction records one tender.' : undefined}
          />
          <Field label="Customer name" value={customer} onChangeText={setCustomer} />
          <Field label="Customer phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          <Field label="Reason (required)" value={reason} onChangeText={setReason} placeholder="e.g. wrong quantity keyed" />
        </View>

        <Button label="Save Correction" icon="check" loading={busy} onPress={() => void save()} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Small({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.meta}>{label}</Text>
      <TextInput style={styles.input} value={value} onChangeText={onChange} keyboardType="decimal-pad" />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: { fontFamily: font.bold, fontSize: 16, color: colors.text },
  note: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  line: { gap: spacing.sm, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  lineTop: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  inputs: { flexDirection: 'row', gap: spacing.sm },
  name: { flex: 1, fontFamily: font.semibold, fontSize: 14, color: colors.text },
  meta: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    fontFamily: font.medium,
    fontSize: 14,
    color: colors.text,
    marginTop: 2,
  },
  total: { fontFamily: font.bold, fontSize: 15, color: colors.primary, textAlign: 'right' },
  result: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 6 },
});
