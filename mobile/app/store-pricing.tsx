import React, { useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { storePricing as pricingApi } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { useCan } from '../src/store/auth';
import { useStoreSelection } from '../src/store/storeSelection';
import { filterCatalogue, useCatalogue } from '../src/hooks/useCatalogue';
import { useLayout } from '../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing } from '../src/theme';
import { Badge, Button, EmptyState, Field, Icon, Loading } from '../src/ui/components';
import type { ProductWithStock, StorePriceRow } from '../src/api/types';

/** What the editor sheet is working on — an existing override or a fresh one. */
interface Draft {
  rowId: string | null;
  productId: string;
  name: string;
  sku: string;
  cataloguePrice: number;
}

export default function StorePricingScreen() {
  const store = useStoreSelection((s) => s.selected);
  const storeId = store?.id ?? null;
  const layout = useLayout();
  const canWrite = useCan('pricing.write');
  const queryClient = useQueryClient();

  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [price, setPrice] = useState('');
  const [priceError, setPriceError] = useState<string | null>(null);

  const overrides = useQuery({
    queryKey: ['store-pricing', storeId],
    enabled: Boolean(storeId),
    queryFn: () => pricingApi.list(storeId as string),
  });

  const catalogue = useCatalogue(storeId);

  const rows = useMemo(() => overrides.data ?? [], [overrides.data]);
  const products = catalogue.data?.items ?? [];
  const overrideByProduct = useMemo(
    () => new Map(rows.map((r) => [r.product_id, r])),
    [rows]
  );

  const visibleProducts = useMemo(
    () => filterCatalogue(products, search, null),
    [products, search]
  );

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['store-pricing', storeId] });
    // The sell screen reads prices from the catalogue, so it is stale the moment
    // an override lands.
    void queryClient.invalidateQueries({ queryKey: ['catalogue', storeId] });
  }

  const setPriceMutation = useMutation({
    mutationFn: ({ productId, value }: { productId: string; value: number }) =>
      pricingApi.set(storeId as string, productId, value),
    onSuccess: () => {
      invalidate();
      closeEditor();
    },
    onError: (err) => Alert.alert('Could not save the price', errorMessage(err)),
  });

  const removeMutation = useMutation({
    mutationFn: (rowId: string) => pricingApi.remove(rowId),
    onSuccess: () => {
      invalidate();
      closeEditor();
    },
    onError: (err) => Alert.alert('Could not remove the override', errorMessage(err)),
  });

  if (!store) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState icon="home" title="No store selected" hint="Choose a store from the Sell tab." />
      </SafeAreaView>
    );
  }

  function closeEditor() {
    setDraft(null);
    setPrice('');
    setPriceError(null);
  }

  function editRow(row: StorePriceRow) {
    if (!canWrite) return;
    setDraft({
      rowId: row.id,
      productId: row.product_id,
      name: row.product_name,
      sku: row.sku,
      cataloguePrice: row.default_price,
    });
    setPrice(row.store_price.toFixed(2));
    setPriceError(null);
  }

  function editProduct(product: ProductWithStock) {
    const existing = overrideByProduct.get(product.id);
    setDraft({
      rowId: existing?.id ?? null,
      productId: product.id,
      name: product.name,
      sku: product.sku,
      cataloguePrice: existing?.default_price ?? product.selling_price,
    });
    // Pre-filled with a real number so the user adjusts a price rather than
    // recalling one.
    setPrice((existing?.store_price ?? product.selling_price).toFixed(2));
    setPriceError(null);
    setPicking(false);
    setSearch('');
  }

  function saveDraft() {
    if (!draft) return;
    const parsed = Number(price.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setPriceError('Enter a price above zero.');
      return;
    }
    setPriceError(null);
    setPriceMutation.mutate({ productId: draft.productId, value: round2(parsed) });
  }

  function confirmRemove() {
    if (!draft?.rowId) return;
    const rowId = draft.rowId;
    Alert.alert(
      'Remove this override?',
      `${draft.name} goes back to the catalogue price of ${formatKwacha(
        draft.cataloguePrice
      )} at ${store?.name ?? 'this store'}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => removeMutation.mutate(rowId) },
      ]
    );
  }

  // Blank field means the user is mid-edit, not "free" — don't claim a difference.
  const typed = price.trim() ? Number(price.replace(/[^0-9.]/g, '')) : null;
  const previewHint =
    draft && typed !== null && Number.isFinite(typed)
      ? differenceLabel(typed - draft.cataloguePrice)
      : 'Enter what this store charges.';

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={[styles.intro, { marginHorizontal: layout.gutter }]}>
        <Icon name="tag" size={16} color={colors.accentDeep} />
        <Text style={styles.introText}>
          These prices replace the catalogue price at {store.name} only.
        </Text>
      </View>

      {overrides.isLoading ? (
        <Loading label="Loading prices" />
      ) : overrides.isError ? (
        <EmptyState
          icon="cloud-off"
          title="Couldn't load store prices"
          hint="Pricing is served live — it needs a connection."
          action={
            <Button
              label="Retry"
              icon="refresh-cw"
              variant="secondary"
              onPress={() => void overrides.refetch()}
            />
          }
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.id}
          contentContainerStyle={{
            padding: layout.gutter,
            paddingBottom: spacing.xxl,
            flexGrow: 1,
          }}
          refreshControl={
            <RefreshControl
              refreshing={overrides.isRefetching}
              onRefresh={() => void overrides.refetch()}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon="tag"
              title="No price overrides"
              hint={
                canWrite
                  ? 'Every product sells at its catalogue price here. Add an override to change one.'
                  : 'Every product sells at its catalogue price here.'
              }
            />
          }
          renderItem={({ item }) => (
            <PriceRow row={item} onPress={canWrite ? () => editRow(item) : undefined} />
          )}
        />
      )}

      {canWrite ? (
        <View style={[styles.actionBar, { paddingHorizontal: layout.gutter }]}>
          <Button
            label="Add price override"
            icon="plus"
            size="lg"
            disabled={catalogue.isLoading}
            onPress={() => setPicking(true)}
          />
        </View>
      ) : null}

      {/* ------------------------------------------------------ product picker */}
      <Modal visible={picking} animationType="slide" onRequestClose={() => setPicking(false)}>
        <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>Choose a product</Text>
            <Pressable onPress={() => setPicking(false)} hitSlop={10} style={styles.closeBtn}>
              <Icon name="x" size={20} color={colors.text} />
            </Pressable>
          </View>

          <View style={[styles.searchBox, { marginHorizontal: layout.gutter }]}>
            <Icon name="search" size={16} color={colors.textFaint} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Name, SKU or brand"
              placeholderTextColor={colors.textFaint}
              style={styles.searchInput}
              autoCorrect={false}
              returnKeyType="search"
            />
            {search.length > 0 ? (
              <Pressable onPress={() => setSearch('')} hitSlop={8}>
                <Icon name="x" size={16} color={colors.textFaint} />
              </Pressable>
            ) : null}
          </View>

          <View style={{ flex: 1 }}>
            {catalogue.isLoading ? (
              <Loading label="Loading catalogue" />
            ) : (
              <FlashList
                data={visibleProducts}
                keyExtractor={(p) => p.id}
                contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl }}
                ListEmptyComponent={
                  <EmptyState
                    icon="package"
                    title={search ? 'Nothing matches' : 'No products'}
                    hint={search ? 'Try a different name or SKU.' : undefined}
                  />
                }
                renderItem={({ item }) => {
                  const existing = overrideByProduct.get(item.id);
                  return (
                    <Pressable
                      onPress={() => editProduct(item)}
                      style={({ pressed }) => [styles.pickRow, pressed && { opacity: 0.7 }]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.name} numberOfLines={1}>
                          {item.name}
                        </Text>
                        <Text style={styles.sku} numberOfLines={1}>
                          {item.sku}
                        </Text>
                      </View>
                      {existing ? <Badge label="Overridden" tone="accent" /> : null}
                      <Text style={styles.pickPrice}>{formatKwacha(item.selling_price)}</Text>
                    </Pressable>
                  );
                }}
              />
            )}
          </View>
        </SafeAreaView>
      </Modal>

      {/* ------------------------------------------------------- price editor */}
      <Modal
        visible={draft !== null}
        transparent
        animationType="fade"
        onRequestClose={closeEditor}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.backdrop}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={closeEditor} />
          {draft ? (
            <View style={styles.editor}>
              <Text style={styles.editorName} numberOfLines={2}>
                {draft.name}
              </Text>
              <Text style={styles.sku}>{draft.sku}</Text>

              <View style={styles.catalogueLine}>
                <Text style={styles.catalogueLabel}>Catalogue price</Text>
                <Text style={styles.catalogueValue}>{formatKwacha(draft.cataloguePrice)}</Text>
              </View>

              <Field
                label={`Price at ${store.name}`}
                value={price}
                onChangeText={setPrice}
                keyboardType="decimal-pad"
                prefix="K"
                autoFocus
                error={priceError}
                hint={previewHint}
              />

              <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
                <Button
                  label="Save price"
                  icon="check"
                  size="lg"
                  loading={setPriceMutation.isPending}
                  onPress={saveDraft}
                />
                {draft.rowId ? (
                  <Button
                    label="Remove override"
                    icon="trash-2"
                    variant="danger"
                    loading={removeMutation.isPending}
                    onPress={confirmRemove}
                  />
                ) : null}
                <Button label="Cancel" variant="ghost" onPress={closeEditor} />
              </View>
            </View>
          ) : null}
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function PriceRow({ row, onPress }: { row: StorePriceRow; onPress?: () => void }) {
  const higher = row.difference > 0;

  const body = (
    <>
      <View style={{ flex: 1 }}>
        <Text style={styles.name} numberOfLines={1}>
          {row.product_name}
        </Text>
        <Text style={styles.sku} numberOfLines={1}>
          {row.sku}
        </Text>
        <View style={{ marginTop: 6 }}>
          <Badge
            label={differenceLabel(row.difference)}
            tone={Math.abs(row.difference) < 0.005 ? 'neutral' : higher ? 'accent' : 'success'}
            dot
          />
        </View>
      </View>

      <View style={{ alignItems: 'flex-end' }}>
        <Text style={styles.storePrice}>{formatKwacha(row.store_price)}</Text>
        <Text style={styles.wasPrice}>was {formatKwacha(row.default_price)}</Text>
      </View>

      {onPress ? <Icon name="chevron-right" size={18} color={colors.textFaint} /> : null}
    </>
  );

  if (!onPress) return <View style={styles.row}>{body}</View>;

  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={onPress}>
      {body}
    </Pressable>
  );
}

/**
 * A signed number behind a counter is a puzzle; the sentence is not. Anything
 * under half a ngwee is treated as the same price so rounding noise doesn't
 * claim a difference.
 */
function differenceLabel(difference: number): string {
  if (!Number.isFinite(difference) || Math.abs(difference) < 0.005) return 'Same as catalogue';
  return difference > 0
    ? `${formatKwacha(difference)} more than catalogue`
    : `${formatKwacha(Math.abs(difference))} less than catalogue`;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  intro: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  introText: { flex: 1, fontFamily: font.medium, fontSize: 12, color: colors.accentDeep, lineHeight: 17 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    minHeight: 76,
    ...shadow.card,
  },
  rowPressed: { transform: [{ scale: 0.99 }], opacity: 0.92 },
  name: { fontFamily: font.semibold, fontSize: 15, color: colors.text },
  sku: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 2 },
  storePrice: { fontFamily: font.extrabold, fontSize: 18, color: colors.text, letterSpacing: -0.4 },
  wasPrice: {
    fontFamily: font.regular,
    fontSize: 11,
    color: colors.textFaint,
    textDecorationLine: 'line-through',
    marginTop: 2,
  },

  actionBar: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.canvas,
  },

  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  sheetTitle: { fontFamily: font.bold, fontSize: 20, color: colors.text, letterSpacing: -0.4 },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSunken,
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
    height: 46,
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
    marginBottom: spacing.sm,
    minHeight: 66,
  },
  pickPrice: { fontFamily: font.bold, fontSize: 15, color: colors.text },

  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(16, 32, 26, 0.45)',
  },
  editor: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.sm,
    ...shadow.raised,
  },
  editorName: { fontFamily: font.bold, fontSize: 19, color: colors.text, letterSpacing: -0.4 },

  catalogueLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginVertical: spacing.md,
  },
  catalogueLabel: { fontFamily: font.medium, fontSize: 13, color: colors.textMuted },
  catalogueValue: { fontFamily: font.semibold, fontSize: 15, color: colors.text },
});
