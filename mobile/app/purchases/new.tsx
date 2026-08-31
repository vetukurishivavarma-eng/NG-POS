import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { purchases as purchasesApi, suppliers as suppliersApi } from '../../src/api/endpoints';
import { errorMessage } from '../../src/api/client';
import { useStoreSelection } from '../../src/store/storeSelection';
import { useCan } from '../../src/store/auth';
import { filterCatalogue, useCatalogue } from '../../src/hooks/useCatalogue';
import { useLeaveGuard } from '../../src/hooks/useLeaveGuard';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing } from '../../src/theme';
import {
  Button,
  EmptyState,
  Field,
  Icon,
  Loading,
  SectionLabel,
  Select,
  StatRow,
} from '../../src/ui/components';
import type { ProductWithStock, SupplierPaymentMethod } from '../../src/api/types';

/** A line as it is being typed. Quantity and cost stay text until submission. */
interface Line {
  product: ProductWithStock;
  quantity: string;
  unitCost: string;
}

type Settlement = 'credit' | 'part' | 'full';

/**
 * Recording a delivery.
 *
 * The point of this screen is that one entry does three jobs: the stock goes on
 * the shelf, the invoice number is filed against it, and what is owed is
 * tracked. Adding the stock without the paperwork is what leaves a shop unable
 * to say what it paid or who it still owes.
 */
export default function NewPurchaseScreen() {
  const layout = useLayout();
  const showCosts = useCan('costs.view');
  const queryClient = useQueryClient();
  const store = useStoreSelection((s) => s.selected);
  const storeId = store?.id ?? null;

  const suppliersQuery = useQuery({ queryKey: ['suppliers'], queryFn: () => suppliersApi.list() });
  const catalogue = useCatalogue(storeId);

  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [otherCharges, setOtherCharges] = useState('');
  const [taxAmount, setTaxAmount] = useState('');
  const [discount, setDiscount] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState('');

  const [settlement, setSettlement] = useState<Settlement>('credit');
  const [paidAmount, setPaidAmount] = useState('');
  const [method, setMethod] = useState<SupplierPaymentMethod>('cash');
  const [paymentRef, setPaymentRef] = useState('');
  const [busy, setBusy] = useState(false);
  // Flips once the invoice is filed, so the leave guard stops asking about an
  // entry that has already been saved.
  const [submitted, setSubmitted] = useState(false);

  const activeSuppliers = (suppliersQuery.data ?? []).filter((s) => s.is_active);

  const subtotal = useMemo(
    () => round2(lines.reduce((sum, l) => sum + numberOf(l.quantity) * numberOf(l.unitCost), 0)),
    [lines]
  );
  const total = round2(
    subtotal + numberOf(taxAmount) + numberOf(otherCharges) - numberOf(discount)
  );

  const paid =
    settlement === 'credit' ? 0 : settlement === 'full' ? total : round2(numberOf(paidAmount));
  const balance = round2(total - paid);

  const results = useMemo(
    () => filterCatalogue(catalogue.data?.items ?? [], search, null),
    [catalogue.data, search]
  );

  const linesComplete =
    lines.length > 0 &&
    lines.every((l) => numberOf(l.quantity) > 0 && l.unitCost.trim() !== '' && numberOf(l.unitCost) >= 0);
  const paymentValid = settlement !== 'part' || (paid > 0 && paid <= total);
  const canSubmit =
    Boolean(supplierId) &&
    invoiceNumber.trim().length > 0 &&
    linesComplete &&
    total >= 0 &&
    paymentValid &&
    !busy;

  function addLine(product: ProductWithStock) {
    setPicking(false);
    setSearch('');
    setLines((current) => {
      if (current.some((l) => l.product.id === product.id)) return current;
      return [
        ...current,
        {
          product,
          quantity: '',
          // Pre-filled with what the product last cost, because a delivery of the
          // same thing usually costs the same — but left editable, since the
          // whole point of the invoice is that this is the number that changed.
          unitCost: product.cost_price > 0 ? String(product.cost_price) : '',
        },
      ];
    });
  }

  function updateLine(id: string, patch: Partial<Line>) {
    setLines((current) => current.map((l) => (l.product.id === id ? { ...l, ...patch } : l)));
  }

  function removeLine(id: string) {
    setLines((current) => current.filter((l) => l.product.id !== id));
  }

  useLeaveGuard({
    hasUnsavedWork: () =>
      !submitted &&
      (lines.length > 0 ||
        Boolean(supplierId) ||
        invoiceNumber.trim().length > 0 ||
        notes.trim().length > 0),
    title: 'Leave without saving?',
    message: 'This delivery has not been recorded yet.',
    finishLabel: 'Post invoice',
    onFinish: async () => {
      if (!canSubmit) {
        Alert.alert(
          'Not ready to post',
          'Choose a supplier, enter the invoice number and add at least one line before posting.'
        );
        return false;
      }
      // submit() shows its own "Delivery recorded" prompt on success; leave
      // the screen through that rather than popping it from here.
      await submit();
      return false;
    },
    onDiscard: () => {},
  });

  async function submit(): Promise<boolean> {
    if (!canSubmit || !storeId || !supplierId) return false;
    setBusy(true);
    try {
      const invoice = await purchasesApi.create({
        supplier_id: supplierId,
        store_id: storeId,
        invoice_number: invoiceNumber.trim(),
        invoice_date: new Date().toISOString(),
        items: lines.map((l) => ({
          product_id: l.product.id,
          quantity: numberOf(l.quantity),
          unit_cost: numberOf(l.unitCost),
        })),
        tax_amount: numberOf(taxAmount),
        other_charges: numberOf(otherCharges),
        discount_amount: numberOf(discount),
        notes: notes.trim(),
        ...(settlement === 'credit'
          ? {}
          : {
              payment: {
                amount: paid,
                method,
                reference: paymentRef.trim(),
              },
            }),
      });

      void queryClient.invalidateQueries({ queryKey: ['purchases'] });
      void queryClient.invalidateQueries({ queryKey: ['purchase-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      void queryClient.invalidateQueries({ queryKey: ['catalogue', storeId] });
      void queryClient.invalidateQueries({ queryKey: ['movements', storeId] });

      setSubmitted(true);
      Alert.alert(
        'Delivery recorded',
        invoice.balance > 0
          ? `${lines.length} product${lines.length === 1 ? '' : 's'} added to ${store?.name}. ${formatKwacha(invoice.balance)} still owed to ${invoice.supplier_name}.`
          : `${lines.length} product${lines.length === 1 ? '' : 's'} added to ${store?.name}, paid in full.`,
        [{ text: 'View invoice', onPress: () => router.replace(`/purchases/${invoice.id}`) }]
      );
      return true;
    } catch (err) {
      Alert.alert("Couldn't record the delivery", errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!store) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="home"
          title="No shop selected"
          hint="Stock has to land somewhere. Choose the shop the delivery arrived at."
        />
      </SafeAreaView>
    );
  }

  /* ------------------------------------------------------- product picker */

  if (picking) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <View style={{ paddingHorizontal: layout.gutter, paddingTop: spacing.md, gap: spacing.sm }}>
          <Text style={styles.title}>Add a product</Text>
          <View style={styles.searchBox}>
            <Icon name="search" size={16} color={colors.textFaint} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Name, SKU or barcode"
              placeholderTextColor={colors.textFaint}
              style={styles.searchInput}
              autoCorrect={false}
              autoCapitalize="none"
              autoFocus
            />
          </View>
        </View>

        <ScrollView
          contentContainerStyle={{ padding: layout.gutter, gap: spacing.sm, paddingBottom: spacing.xxl }}
          keyboardShouldPersistTaps="handled"
        >
          {catalogue.isLoading ? (
            <Loading label="Loading the catalogue" />
          ) : results.length === 0 ? (
            <EmptyState
              icon="package"
              title={search ? 'Nothing matches' : 'No products yet'}
              hint={
                search
                  ? 'Try part of the name or the SKU.'
                  : 'Load the catalogue first — one product at a time, or from a spreadsheet.'
              }
            />
          ) : (
            results.slice(0, 60).map((product) => (
              <Pressable
                key={product.id}
                style={({ pressed }) => [styles.pickRow, pressed && { opacity: 0.85 }]}
                onPress={() => addLine(product)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.pickName} numberOfLines={1}>
                    {product.name}
                  </Text>
                  {/* "Last cost" is the stored buying price, so it is withheld
                      from an account without `costs.view` — which would read
                      K0.00, the placeholder the server sends. Typing the unit
                      cost off the invoice in hand is a different thing and stays
                      open to them; that is the job this screen exists for. */}
                  <Text style={styles.pickMeta} numberOfLines={1}>
                    {product.sku} · {product.quantity} in stock
                    {showCosts ? ` · last cost ${formatKwacha(product.cost_price)}` : ''}
                  </Text>
                </View>
                <Icon name="plus-circle" size={20} color={colors.primary} />
              </Pressable>
            ))
          )}
          <Button label="Done" variant="secondary" onPress={() => setPicking(false)} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  /* -------------------------------------------------------------- the form */

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl, gap: spacing.lg }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View>
          <Text style={styles.title}>Record a delivery</Text>
          <Text style={styles.lead}>
            Goods into {store.name}, the invoice they came with, and what has been paid for them.
          </Text>
        </View>

        {/* ------------------------------------------------------ supplier */}
        <View style={{ gap: spacing.md }}>
          <SectionLabel>Who it came from</SectionLabel>
          {suppliersQuery.isLoading ? (
            <Loading label="Loading suppliers" />
          ) : activeSuppliers.length === 0 ? (
            <View style={styles.notice}>
              <Icon name="alert-circle" size={16} color={colors.warning} />
              <Text style={styles.noticeText}>
                No suppliers yet. Add the wholesaler first, then come back and enter their invoice.
              </Text>
            </View>
          ) : (
            <Select<string>
              value={supplierId ?? ''}
              onChange={setSupplierId}
              options={activeSuppliers.map((s) => ({ value: s.id, label: s.name }))}
            />
          )}
          {activeSuppliers.length === 0 ? (
            <Button
              label="Add a Supplier"
              icon="plus"
              variant="secondary"
              onPress={() => router.push('/suppliers')}
            />
          ) : null}
        </View>

        {/* ------------------------------------------------------- invoice */}
        <View style={{ gap: spacing.md }}>
          <SectionLabel>The paperwork</SectionLabel>
          <Field
            label="Invoice number"
            value={invoiceNumber}
            onChangeText={setInvoiceNumber}
            placeholder="NV-4471"
            autoCapitalize="characters"
            hint="Exactly as printed on the supplier's invoice. Entering the same one twice is refused, so a delivery cannot be recorded into stock two times."
          />
        </View>

        {/* --------------------------------------------------------- lines */}
        <View style={{ gap: spacing.md }}>
          <SectionLabel>What arrived</SectionLabel>

          {lines.map((line) => (
            <View key={line.product.id} style={styles.lineCard}>
              <View style={styles.lineHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.lineName} numberOfLines={2}>
                    {line.product.name}
                  </Text>
                  <Text style={styles.lineSku} numberOfLines={1}>
                    {line.product.sku} · {line.product.quantity} on the shelf now
                  </Text>
                </View>
                <Pressable onPress={() => removeLine(line.product.id)} hitSlop={10}>
                  <Icon name="x-circle" size={20} color={colors.textFaint} />
                </Pressable>
              </View>

              <View style={styles.lineInputs}>
                <View style={{ flex: 1 }}>
                  <Field
                    label="Quantity"
                    value={line.quantity}
                    onChangeText={(t) => updateLine(line.product.id, { quantity: numericText(t) })}
                    placeholder="0"
                    keyboardType="numeric"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Field
                    label="Cost each"
                    value={line.unitCost}
                    onChangeText={(t) => updateLine(line.product.id, { unitCost: numericText(t) })}
                    placeholder="0.00"
                    keyboardType="numeric"
                    prefix="K"
                  />
                </View>
              </View>

              <Text style={styles.lineTotal}>
                {formatKwacha(round2(numberOf(line.quantity) * numberOf(line.unitCost)))}
                {numberOf(line.quantity) > 0
                  ? ` · takes stock to ${round3(line.product.quantity + numberOf(line.quantity))}`
                  : ''}
              </Text>
            </View>
          ))}

          <Button
            label={lines.length === 0 ? 'Add the First Product' : 'Add Another Product'}
            icon="plus"
            variant="secondary"
            onPress={() => setPicking(true)}
          />
        </View>

        {/* ------------------------------------------------------- charges */}
        <View style={{ gap: spacing.md }}>
          <SectionLabel>Anything else on the invoice</SectionLabel>
          <Field
            label="VAT"
            value={taxAmount}
            onChangeText={(t) => setTaxAmount(numericText(t))}
            placeholder="0.00"
            keyboardType="numeric"
            prefix="K"
          />
          <Field
            label="Delivery and handling"
            value={otherCharges}
            onChangeText={(t) => setOtherCharges(numericText(t))}
            placeholder="0.00"
            keyboardType="numeric"
            prefix="K"
          />
          <Field
            label="Discount given"
            value={discount}
            onChangeText={(t) => setDiscount(numericText(t))}
            placeholder="0.00"
            keyboardType="numeric"
            prefix="K"
          />
        </View>

        {/* ------------------------------------------------------- payment */}
        <View style={{ gap: spacing.md }}>
          <SectionLabel>What has been paid</SectionLabel>
          <Select<Settlement>
            value={settlement}
            onChange={(next) => {
              setSettlement(next);
              if (next !== 'part') setPaidAmount('');
            }}
            options={[
              { value: 'credit', label: 'Nothing yet' },
              { value: 'part', label: 'Part payment' },
              { value: 'full', label: 'Paid in full' },
            ]}
            hint={
              settlement === 'credit'
                ? 'Taken on credit. The whole invoice stays outstanding.'
                : settlement === 'full'
                  ? `The full ${formatKwacha(total)} settles it now.`
                  : 'Enter what was handed over. The rest stays owed.'
            }
          />

          {settlement === 'part' ? (
            <Field
              label="Amount paid now"
              value={paidAmount}
              onChangeText={(t) => setPaidAmount(numericText(t))}
              placeholder="0.00"
              keyboardType="numeric"
              prefix="K"
              error={
                paid > total ? 'That is more than the invoice comes to.' : null
              }
              hint={paid > 0 && paid <= total ? `${formatKwacha(balance)} would stay owed.` : undefined}
            />
          ) : null}

          {settlement !== 'credit' ? (
            <>
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
                label="Payment reference"
                value={paymentRef}
                onChangeText={setPaymentRef}
                placeholder="Cheque number, transfer reference, mobile code"
                autoCapitalize="characters"
              />
            </>
          ) : null}
        </View>

        <Field
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          placeholder="Delivered by truck GRZ 1234. Two bags short, credit promised."
          multiline
        />

        {/* --------------------------------------------------------- totals */}
        <View style={styles.totals}>
          <StatRow label="Goods" value={formatKwacha(subtotal)} />
          {numberOf(taxAmount) > 0 ? <StatRow label="VAT" value={formatKwacha(numberOf(taxAmount))} /> : null}
          {numberOf(otherCharges) > 0 ? (
            <StatRow label="Delivery and handling" value={formatKwacha(numberOf(otherCharges))} />
          ) : null}
          {numberOf(discount) > 0 ? (
            <StatRow label="Discount" value={`− ${formatKwacha(numberOf(discount))}`} />
          ) : null}
          <View style={styles.totalsDivider} />
          <StatRow label="Invoice total" value={formatKwacha(total)} emphasis />
          <StatRow label="Paid now" value={formatKwacha(paid)} tone="success" />
          <StatRow
            label="Balance owed"
            value={formatKwacha(balance)}
            emphasis
            tone={balance > 0 ? 'danger' : 'success'}
          />
        </View>

        <Button
          label={balance > 0 ? `Record and Owe ${formatKwacha(balance)}` : 'Record as Fully Paid'}
          icon="check"
          size="lg"
          loading={busy}
          disabled={!canSubmit}
          onPress={() => void submit()}
        />
        {!canSubmit && !busy ? (
          <Text style={styles.blocked}>{whatIsMissing(supplierId, invoiceNumber, lines, paymentValid)}</Text>
        ) : null}
        <Button label="Cancel" variant="ghost" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}

/* ---------------------------------------------------------------- helpers */

function whatIsMissing(
  supplierId: string | null,
  invoiceNumber: string,
  lines: Line[],
  paymentValid: boolean
): string {
  if (!supplierId) return 'Choose the supplier the delivery came from.';
  if (!invoiceNumber.trim()) return 'Enter the invoice number from the supplier’s paperwork.';
  if (lines.length === 0) return 'Add at least one product that arrived.';
  if (lines.some((l) => numberOf(l.quantity) <= 0)) return 'Every line needs a quantity.';
  if (lines.some((l) => l.unitCost.trim() === '')) return 'Every line needs a cost.';
  if (!paymentValid) return 'The amount paid has to be more than nothing and no more than the total.';
  return '';
}

function numberOf(text: string): number {
  const n = Number(text.trim());
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Digits and at most one decimal point. */
function numericText(text: string): string {
  const cleaned = text.replace(/[^0-9.]/g, '');
  const dot = cleaned.indexOf('.');
  if (dot === -1) return cleaned;
  return cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, '');
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  title: { fontFamily: font.bold, fontSize: 22, color: colors.text, letterSpacing: -0.5 },
  lead: {
    fontFamily: font.regular,
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 4,
    lineHeight: 18,
  },

  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 50,
  },
  searchInput: { flex: 1, fontFamily: font.medium, fontSize: 15, color: colors.text, padding: 0 },

  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    ...shadow.card,
  },
  pickName: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  pickMeta: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 2 },

  lineCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
    ...shadow.card,
  },
  lineHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  lineName: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  lineSku: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 2 },
  lineInputs: { flexDirection: 'row', gap: spacing.md },
  lineTotal: { fontFamily: font.bold, fontSize: 13, color: colors.primary },

  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  noticeText: { flex: 1, fontFamily: font.medium, fontSize: 12, color: colors.warning, lineHeight: 17 },

  totals: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    padding: spacing.lg,
    ...shadow.card,
  },
  totalsDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },

  blocked: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.textFaint,
    textAlign: 'center',
    marginTop: -spacing.sm,
  },
});
