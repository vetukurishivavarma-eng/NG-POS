import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { products as productsApi } from '../../src/api/endpoints';
import { useCan } from '../../src/store/auth';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing } from '../../src/theme';
import { Badge, Button, EmptyState, Icon, Loading } from '../../src/ui/components';
import type { Product } from '../../src/api/types';

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_LIMIT = 300;

export default function ProductsScreen() {
  const layout = useLayout();
  const canWrite = useCan('products.write');

  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [brand, setBrand] = useState<string | null>(null);

  // Search runs on the server so it reaches the whole catalogue, but only after
  // typing settles — a request per keystroke is what kills a rural link.
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useQuery({
    queryKey: ['products', 'list', term, brand],
    queryFn: () =>
      productsApi.list({
        limit: PAGE_LIMIT,
        ...(term ? { search: term } : {}),
        ...(brand ? { brand } : {}),
      }),
    // Keeps the previous rows on screen while a new filter loads, so the list
    // doesn't blink back to a spinner on every debounced keystroke.
    placeholderData: keepPreviousData,
  });

  // Nested under ['products'] so a write on the edit screen refreshes the brand
  // chips too — a new brand appears the moment its first product is saved.
  const brands = useQuery({
    queryKey: ['products', 'brands'],
    queryFn: () => productsApi.brands(),
  });

  const rows = query.data ?? [];
  const brandOptions = useMemo(
    () => (brands.data ?? []).filter((b) => Boolean(b && b.trim())),
    [brands.data]
  );

  const inactiveCount = useMemo(() => rows.filter((p) => !p.is_active).length, [rows]);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={[styles.toolbar, { paddingHorizontal: layout.gutter }]}>
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
            returnKeyType="search"
          />
          {search.length > 0 ? (
            <Pressable onPress={() => setSearch('')} hitSlop={10}>
              <Icon name="x" size={16} color={colors.textFaint} />
            </Pressable>
          ) : null}
        </View>

        {brandOptions.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.brandRow}
          >
            <BrandChip label="All brands" active={brand === null} onPress={() => setBrand(null)} />
            {brandOptions.map((b) => (
              <BrandChip
                key={b}
                label={b}
                active={brand === b}
                onPress={() => setBrand(brand === b ? null : b)}
              />
            ))}
          </ScrollView>
        ) : null}
      </View>

      {query.isLoading ? (
        <Loading label="Loading catalogue" />
      ) : query.isError ? (
        <EmptyState
          icon="cloud-off"
          title="Couldn't load the catalogue"
          hint="The product list is served live — it needs a connection."
          action={
            <Button
              label="Retry"
              icon="refresh-cw"
              variant="secondary"
              onPress={() => void query.refetch()}
            />
          }
        />
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{
            paddingHorizontal: layout.gutter,
            paddingBottom: spacing.lg,
          }}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => {
                void query.refetch();
                void brands.refetch();
              }}
              tintColor={colors.primary}
            />
          }
          ListHeaderComponent={
            rows.length > 0 ? (
              <View style={styles.countRow}>
                <Text style={styles.countText}>
                  {rows.length} product{rows.length === 1 ? '' : 's'}
                  {brand ? ` · ${brand}` : ''}
                </Text>
                {inactiveCount > 0 ? (
                  <Text style={styles.countMuted}>{inactiveCount} inactive</Text>
                ) : null}
              </View>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon="package"
              title={term || brand ? 'Nothing matches' : 'No products yet'}
              hint={
                term || brand
                  ? 'Try a shorter search, or clear the brand filter.'
                  : 'Products added here appear on the till and in stock counts.'
              }
              action={
                canWrite && !term && !brand ? (
                  <Button
                    label="New Product"
                    icon="plus"
                    onPress={() => router.push('/products/new')}
                  />
                ) : undefined
              }
            />
          }
          renderItem={({ item }) => <ProductRow product={item} />}
        />
      )}

      {canWrite ? (
        <View style={[styles.actionBar, { paddingHorizontal: layout.gutter }]}>
          <Button
            label="New Product"
            icon="plus"
            size="lg"
            onPress={() => router.push('/products/new')}
          />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function ProductRow({ product }: { product: Product }) {
  const inactive = !product.is_active;
  const meta = [product.sku, product.brand].filter(Boolean).join('  ·  ');

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => router.push(`/products/${product.id}`)}
    >
      <View style={[styles.rowIcon, inactive && styles.rowIconMuted]}>
        <Icon name="package" size={17} color={inactive ? colors.textFaint : colors.primary} />
      </View>

      <View style={{ flex: 1 }}>
        <Text style={[styles.name, inactive && styles.nameMuted]} numberOfLines={1}>
          {product.name}
        </Text>
        {meta ? (
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
        {inactive || product.tax_type === 'vat' ? (
          <View style={styles.badgeRow}>
            {inactive ? <Badge label="Inactive" tone="neutral" dot /> : null}
            {product.tax_type === 'vat' ? <Badge label="VAT" tone="accent" /> : null}
          </View>
        ) : null}
      </View>

      <View style={styles.rowRight}>
        <Text style={[styles.price, inactive && styles.nameMuted]}>
          {formatKwacha(product.selling_price)}
        </Text>
        {product.unit ? <Text style={styles.unit}>per {product.unit}</Text> : null}
      </View>

      <Icon name="chevron-right" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

function BrandChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && { opacity: 0.7 }]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  toolbar: { paddingTop: spacing.md, paddingBottom: spacing.sm, gap: spacing.md },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 48,
  },
  searchInput: { flex: 1, fontFamily: font.medium, fontSize: 15, color: colors.text, padding: 0 },

  brandRow: { gap: spacing.sm, paddingRight: spacing.lg },
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    maxWidth: 190,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontFamily: font.semibold, fontSize: 13, color: colors.textMuted },
  chipTextActive: { color: colors.onDark },

  countRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingVertical: spacing.sm,
  },
  countText: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  countMuted: { fontFamily: font.medium, fontSize: 11, color: colors.textFaint },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 72,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...shadow.card,
  },
  rowPressed: { transform: [{ scale: 0.99 }], opacity: 0.92 },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowIconMuted: { backgroundColor: colors.surfaceSunken },
  name: { fontFamily: font.semibold, fontSize: 15, color: colors.text },
  nameMuted: { color: colors.textMuted },
  meta: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 3 },
  badgeRow: { flexDirection: 'row', gap: spacing.xs, marginTop: 6 },

  rowRight: { alignItems: 'flex-end' },
  price: { fontFamily: font.bold, fontSize: 16, color: colors.text, letterSpacing: -0.3 },
  unit: { fontFamily: font.regular, fontSize: 10, color: colors.textFaint, marginTop: 2 },

  // Pinned rather than floating: on a till the thumb lives at the bottom of the
  // screen, and a bar can't drift over the last row the way a FAB does.
  actionBar: {
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    backgroundColor: colors.canvas,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
