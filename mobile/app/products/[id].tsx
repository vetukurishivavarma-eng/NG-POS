import React, { useEffect, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { products as productsApi } from '../../src/api/endpoints';
import { PRODUCT_CATEGORIES, normaliseCategory } from '../../src/api/categories';
import { errorMessage } from '../../src/api/client';
import { useCan } from '../../src/store/auth';
import { useScanCapture } from '../../src/store/scanCapture';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing } from '../../src/theme';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Loading,
  RowDivider,
  SectionLabel,
  Select,
  StatRow,
  Toggle,
} from '../../src/ui/components';
import type { ProductDraft, TaxType } from '../../src/api/types';

const TAX_OPTIONS: { value: TaxType; label: string }[] = [
  { value: 'exempt', label: 'Exempt' },
  { value: 'vat', label: 'VAT' },
];

export default function ProductFormScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const productId = typeof id === 'string' ? id : '';
  const isNew = productId === 'new';

  const layout = useLayout();
  const canWrite = useCan('products.write');
  const canDelete = useCan('products.delete');
  const showCosts = useCan('costs.view');
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');
  const [brand, setBrand] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [cost, setCost] = useState('');
  const [selling, setSelling] = useState('');
  const [taxType, setTaxType] = useState<TaxType>('exempt');
  const [unit, setUnit] = useState('');
  const [chemicalName, setChemicalName] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [isActive, setIsActive] = useState(true);
  /** Field errors stay hidden until the first save attempt, so an empty new form isn't red. */
  const [submitted, setSubmitted] = useState(false);

  const detail = useQuery({
    queryKey: ['products', 'detail', productId],
    enabled: !isNew && productId.length > 0,
    queryFn: () => productsApi.get(productId),
  });

  const loaded = detail.data;
  useEffect(() => {
    if (!loaded) return;
    setName(loaded.name);
    setSku(loaded.sku);
    setBarcode(loaded.barcode ?? '');
    setBrand(loaded.brand ?? '');
    // Legacy spellings ("Fertilizers", "Tools") open with the head they belong
    // to already selected; anything the list doesn't recognise opens as Not set,
    // waiting to be filed, because the server would refuse to save it back.
    setCategory(normaliseCategory(loaded.category) ?? '');
    setDescription(loaded.description ?? '');
    setCost(moneyToInput(loaded.cost_price));
    setSelling(moneyToInput(loaded.selling_price));
    setTaxType(loaded.tax_type);
    setUnit(loaded.unit ?? '');
    setChemicalName(loaded.chemical_name ?? '');
    setExpiryDate(loaded.expiry_date ?? '');
    setIsActive(loaded.is_active);
  }, [loaded]);

  // The scanner has no way to return a value through the router, so it parks
  // the code in a store; this picks it up when that modal closes.
  const scanned = useScanCapture((s) => s.value);
  const consumeScan = useScanCapture((s) => s.consume);
  useEffect(() => {
    if (scanned === null) return;
    setBarcode(scanned);
    consumeScan();
  }, [scanned, consumeScan]);

  const costValue = parseMoney(cost);
  const sellValue = parseMoney(selling);

  const errors = useMemo(
    () => ({
      name: name.trim() ? null : 'A name is required.',
      sku: sku.trim() ? null : 'An SKU is required — it identifies the product on receipts.',
      // Only where the field is on the screen. A hidden cost price is never
      // filled in, so validating it would fail a form with nothing visibly
      // wrong on it — and `submit` returns early on any error, so the Save
      // button would simply stop working with no explanation anywhere.
      cost: showCosts ? priceError(costValue) : null,
      selling: priceError(sellValue),
      // Blank is fine — most lines do not expire. Anything else has to be the
      // one shape the server stores, because a date typed 07/15 could be July
      // or could be the fifteenth and neither of us should be guessing.
      expiry: expiryDate.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate.trim())
        ? 'Write it year first: 2027-07-15.'
        : null,
    }),
    [name, sku, costValue, sellValue, showCosts, expiryDate]
  );

  const save = useMutation({
    mutationFn: (draft: ProductDraft) =>
      isNew ? productsApi.create(draft) : productsApi.update(productId, draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['catalogue'] });
      router.back();
    },
    onError: (err) =>
      Alert.alert(isNew ? "Couldn't create product" : "Couldn't save changes", errorMessage(err)),
  });

  const deactivate = useMutation({
    mutationFn: () => productsApi.remove(productId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['catalogue'] });
      router.back();
    },
    onError: (err) => Alert.alert("Couldn't deactivate", errorMessage(err)),
  });

  function submit() {
    setSubmitted(true);
    if (errors.name || errors.sku || errors.cost || errors.selling || errors.expiry) return;

    save.mutate({
      name: name.trim(),
      sku: sku.trim(),
      barcode: barcode.trim() || null,
      brand: brand.trim() || null,
      category: category.trim() || null,
      description: description.trim() || null,
      // Never sent by an account that cannot see it. Such an account was given
      // 0 in place of the real figure, so posting the field back would write
      // that 0 over a buying price it was never shown. The server drops it as
      // well; this is the half that does not depend on the server being right.
      ...(showCosts ? { cost_price: costValue ?? 0 } : {}),
      selling_price: sellValue ?? 0,
      tax_type: taxType,
      unit: unit.trim() || null,
      chemical_name: chemicalName.trim() || null,
      expiry_date: expiryDate.trim() || null,
      is_active: isActive,
    });
  }

  function confirmDeactivate() {
    Alert.alert(
      `Deactivate ${loaded?.name ?? 'this product'}?`,
      'It disappears from the till and from new stock counts. Past receipts keep referencing it, so old sales and reports are unchanged. You can switch it back on from this screen.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Deactivate', style: 'destructive', onPress: () => deactivate.mutate() },
      ]
    );
  }

  if (!isNew && detail.isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <Loading label="Loading product" />
      </SafeAreaView>
    );
  }

  if (!isNew && detail.isError) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="cloud-off"
          title="Couldn't load this product"
          hint="Product details are served live — they need a connection."
          action={
            <Button
              label="Retry"
              icon="refresh-cw"
              variant="secondary"
              onPress={() => void detail.refetch()}
            />
          }
        />
      </SafeAreaView>
    );
  }

  if (!canWrite) {
    // A cashier can land here from the catalogue list. The server would refuse
    // the write anyway, so show the figures rather than a form that can't save.
    if (isNew || !loaded) {
      return (
        <SafeAreaView style={styles.safe} edges={['bottom']}>
          <EmptyState
            icon="lock"
            title="Not your permission"
            hint="Only a manager or an admin can add or change products."
          />
        </SafeAreaView>
      );
    }

    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <ScrollView contentContainerStyle={[styles.scroll, { padding: layout.gutter }]}>
          <View>
            <Text style={styles.readTitle}>{loaded.name}</Text>
            <Text style={styles.readMeta}>{loaded.sku}</Text>
          </View>
          {/* The margin card is the cost price with subtraction applied, so it
              goes wherever the cost price goes. */}
          {showCosts ? <MarginCard cost={loaded.cost_price} selling={loaded.selling_price} /> : null}
          <Card>
            <StatRow label="Selling price" value={formatKwacha(loaded.selling_price)} emphasis />
            {showCosts ? (
              <>
                <RowDivider />
                <StatRow label="Cost price" value={formatKwacha(loaded.cost_price)} />
              </>
            ) : null}
            <RowDivider />
            <StatRow label="Tax" value={loaded.tax_type === 'vat' ? 'VAT' : 'Exempt'} />
            <RowDivider />
            <StatRow label="Brand" value={loaded.brand || '—'} />
            <RowDivider />
            <StatRow
              label="Category"
              value={normaliseCategory(loaded.category) ?? loaded.category ?? '—'}
            />
            <RowDivider />
            <StatRow label="Unit" value={loaded.unit || '—'} />
            <RowDivider />
            <StatRow label="Chemical" value={loaded.chemical_name || '—'} />
            <RowDivider />
            <StatRow label="Expires" value={loaded.expiry_date || '—'} />
            <RowDivider />
            <StatRow label="Barcode" value={loaded.barcode || '—'} />
          </Card>
          {loaded.description ? <Text style={styles.readBody}>{loaded.description}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  const busy = save.isPending || deactivate.isPending;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      {/* `padding` on Android too — see the note in `login.tsx`. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView
          contentContainerStyle={[styles.scroll, { padding: layout.gutter }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.section}>
            <SectionLabel>Identity</SectionLabel>
            <View style={styles.stack}>
              <Field
                label="Product name"
                value={name}
                onChangeText={setName}
                placeholder="e.g. Dewormer 500ml"
                autoCapitalize="words"
                autoFocus={isNew}
                error={submitted ? errors.name : null}
              />
              <Field
                label="SKU"
                value={sku}
                onChangeText={setSku}
                placeholder="e.g. AGV-DW-500"
                autoCapitalize="characters"
                error={submitted ? errors.sku : null}
              />
              <Field
                label="Barcode"
                value={barcode}
                onChangeText={setBarcode}
                placeholder="Scanned at the till"
                keyboardType="number-pad"
                hint="Optional. Leave empty for loose or weighed goods."
              />
              <Button
                label="Scan barcode"
                icon="camera"
                variant="secondary"
                onPress={() => router.push('/scan?mode=capture')}
              />
            </View>
          </View>

          <View style={styles.section}>
            <SectionLabel>Pricing</SectionLabel>
            <View style={styles.stack}>
              {/* Hidden rather than disabled for an account without
                  `costs.view`: it would otherwise show K0.00, which is not this
                  product's cost price but the placeholder the server sends in
                  its place. The server drops the field from such an account's
                  updates too, so the real figure survives their edits. */}
              {showCosts ? (
                <Field
                  label="Cost price"
                  value={cost}
                  onChangeText={setCost}
                  placeholder="0.00"
                  keyboardType="decimal-pad"
                  prefix="K"
                  error={submitted ? errors.cost : null}
                />
              ) : null}
              <Field
                label="Selling price"
                value={selling}
                onChangeText={setSelling}
                placeholder="0.00"
                keyboardType="decimal-pad"
                prefix="K"
                error={submitted ? errors.selling : null}
              />
              {/* Margin is the cost price with subtraction applied, so it goes
                  wherever the cost price goes — same gate as the read-only
                  view above and the Cost price field itself. */}
              {showCosts ? <MarginCard cost={costValue ?? 0} selling={sellValue ?? 0} /> : null}
              <Select
                label="Tax treatment"
                value={taxType}
                options={TAX_OPTIONS}
                onChange={setTaxType}
                hint="VAT-rated lines carry tax on the receipt; exempt lines don't."
              />
            </View>
          </View>

          <View style={styles.section}>
            <SectionLabel>Classification</SectionLabel>
            <View style={styles.stack}>
              <Field
                label="Brand"
                value={brand}
                onChangeText={setBrand}
                placeholder="e.g. Coopers"
                autoCapitalize="words"
              />
              {/* A fixed list, not a text box: the whole point is that every
                  product ends up under one of the shop's heads. */}
              <Select
                label="Category"
                value={category}
                onChange={setCategory}
                options={[
                  { value: '', label: 'Not set' },
                  ...PRODUCT_CATEGORIES.map((c) => ({ value: c as string, label: c })),
                ]}
                hint="Used by the catalogue filter and by stock reports."
              />
              <Field
                label="Unit"
                value={unit}
                onChangeText={setUnit}
                placeholder="e.g. bottle"
                autoCapitalize="none"
                hint="How it is sold: bottle, kg, litre, bag, each."
              />
              {/* The counter is asked for the chemical as often as for the
                  brand on the tin, and several brands share one. */}
              <Field
                label="Chemical name"
                value={chemicalName}
                onChangeText={setChemicalName}
                placeholder="e.g. Pirimiphos-methyl 1.6%"
                autoCapitalize="sentences"
                hint="The active ingredient, as printed on the label."
              />
              <Field
                label="Expiry date"
                value={expiryDate}
                onChangeText={setExpiryDate}
                placeholder="2027-07-15"
                autoCapitalize="none"
                error={submitted ? errors.expiry : null}
                hint="Year first: 2027-07-15. Leave blank if the line does not expire."
              />
              <Field
                label="Description"
                value={description}
                onChangeText={setDescription}
                placeholder="Anything staff should know when selling it"
                multiline
              />
            </View>
          </View>

          <View style={styles.section}>
            <SectionLabel>Availability</SectionLabel>
            <Card>
              <Toggle
                label="Active"
                hint="Inactive products are hidden from the till and from new stock counts."
                value={isActive}
                onChange={setIsActive}
              />
            </Card>
          </View>

          {!isNew && canDelete && loaded?.is_active ? (
            <View style={styles.section}>
              <SectionLabel>Retire</SectionLabel>
              <Button
                label="Deactivate Product"
                icon="archive"
                variant="secondary"
                disabled={busy}
                onPress={confirmDeactivate}
              />
              <Text style={styles.retireNote}>
                Nothing is deleted. Past receipts and reports keep referencing this product.
              </Text>
            </View>
          ) : null}

          {loaded ? (
            <Text style={styles.stamp}>
              Added {new Date(loaded.created_at).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </Text>
          ) : null}
        </ScrollView>

        <View style={[styles.footer, { paddingHorizontal: layout.gutter }]}>
          <Button
            label={isNew ? 'Create Product' : 'Save Changes'}
            icon="check"
            size="lg"
            loading={save.isPending}
            disabled={busy}
            onPress={submit}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* -------------------------------------------------------------------- margin */

/**
 * The number an agro-vet retailer actually runs on. Margin is taken against the
 * selling price (not markup on cost), which is how the trade quotes it.
 */
function MarginCard({ cost, selling }: { cost: number; selling: number }) {
  const margin = selling - cost;
  const pct = selling > 0 ? (margin / selling) * 100 : null;
  const belowCost = margin < 0;
  const blank = selling === 0 && cost === 0;

  return (
    <View style={[styles.margin, belowCost && styles.marginDanger]}>
      <View style={styles.marginHead}>
        <View style={styles.marginLabelRow}>
          <Icon
            name={belowCost ? 'trending-down' : 'trending-up'}
            size={14}
            color={belowCost ? colors.danger : colors.accentDeep}
          />
          <Text style={[styles.marginLabel, belowCost && { color: colors.danger }]}>
            Margin per unit
          </Text>
        </View>
        {pct !== null && !blank ? (
          <Badge label={`${pct.toFixed(1)}%`} tone={belowCost ? 'danger' : 'accent'} />
        ) : null}
      </View>

      <Text style={[styles.marginValue, belowCost && { color: colors.danger }]}>
        {blank ? '—' : formatKwacha(margin)}
      </Text>

      {belowCost ? (
        <Text style={styles.marginWarn}>
          Selling below cost — every sale loses {formatKwacha(Math.abs(margin))}. Fine for a
          clearance, otherwise check the prices.
        </Text>
      ) : null}
    </View>
  );
}

/* --------------------------------------------------------------------- money */

/**
 * Blank means "nothing typed yet" and counts as zero; anything that isn't a
 * number comes back as null so validation can refuse it rather than silently
 * posting NaN. Thousands separators are tolerated because staff type them.
 */
function parseMoney(raw: string): number | null {
  const cleaned = raw.trim().replace(/,/g, '');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function priceError(value: number | null): string | null {
  if (value === null) return 'Enter a number.';
  if (value < 0) return 'Price cannot be negative.';
  return null;
}

function moneyToInput(n: number): string {
  return Number.isFinite(n) ? String(n) : '';
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  scroll: { gap: spacing.xl, paddingBottom: spacing.xxl },
  section: { gap: spacing.sm },
  stack: { gap: spacing.lg },

  margin: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.accent,
    padding: spacing.lg,
    gap: 2,
  },
  marginDanger: { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
  marginHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  marginLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  marginLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.accentDeep,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  marginValue: {
    fontFamily: font.extrabold,
    fontSize: 28,
    color: colors.accentDeep,
    letterSpacing: -0.8,
    marginTop: 4,
  },
  marginWarn: {
    fontFamily: font.medium,
    fontSize: 12,
    color: colors.danger,
    lineHeight: 17,
    marginTop: spacing.sm,
  },

  retireNote: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.textFaint,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  stamp: {
    fontFamily: font.regular,
    fontSize: 11,
    color: colors.textFaint,
    textAlign: 'center',
  },

  readTitle: { fontFamily: font.bold, fontSize: 22, color: colors.text, letterSpacing: -0.5 },
  readMeta: { fontFamily: font.medium, fontSize: 13, color: colors.textMuted, marginTop: 4 },
  readBody: { fontFamily: font.regular, fontSize: 14, color: colors.textMuted, lineHeight: 21 },

  footer: {
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    backgroundColor: colors.canvas,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    ...shadow.card,
  },
});
