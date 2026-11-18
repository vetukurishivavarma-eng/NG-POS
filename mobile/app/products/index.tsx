import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';

import { products as productsApi, stores as storesApi } from '../../src/api/endpoints';
import { PRODUCT_CATEGORIES, normaliseCategory } from '../../src/api/categories';
import { MultiSelectField } from '../../src/ui/pickers';
import { useCan } from '../../src/store/auth';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing } from '../../src/theme';
import { Badge, Button, EmptyState, Icon, Loading } from '../../src/ui/components';
import type { Product, ProductWithStock } from '../../src/api/types';

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_LIMIT = 300;

/** Stands in for "no category yet" in the filter, which is not a category name. */
const UNFILED = 'Unfiled';

type Row = (Product | ProductWithStock) & { shopId?: string; shopName?: string };

export default function ProductsScreen() {
  const layout = useLayout();
  const canWrite = useCan('products.write');

  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  /** Empty = all. */
  const [brandSet, setBrandSet] = useState<Set<string>>(new Set());
  /** Category names and/or the UNFILED entry; empty = all. */
  const [categorySet, setCategorySet] = useState<Set<string>>(new Set());
  /** Off by default: a deactivated product no longer inflates "N products". */
  const [includeInactive, setIncludeInactive] = useState(false);
  /** Shop names ticked; empty = All Shops (the org-wide master list). */
  const [shopSet, setShopSet] = useState<Set<string>>(new Set());

  // Search runs on the server so it reaches the whole catalogue, but only after
  // typing settles — a request per keystroke is what kills a rural link.
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const storesQuery = useQuery({ queryKey: ['stores', 'list'], queryFn: () => storesApi.list() });

  const shopIds = useMemo(
    () => (storesQuery.data ?? []).filter((st) => shopSet.has(st.name)),
    [storesQuery.data, shopSet]
  );
  const brandParam = [...brandSet].join('|');
  const headParam = [...categorySet].filter((c) => c !== UNFILED).join('|');

  // The master list filters on the server ('|' = any of several). A shop's
  // list is `with-stock` — that shop's own price and stock — filtered here.
  const query = useQuery({
    queryKey: ['products', 'list', term, brandParam, headParam, categorySet.has(UNFILED), includeInactive],
    queryFn: () =>
      productsApi.list({
        limit: PAGE_LIMIT,
        ...(term ? { search: term } : {}),
        ...(brandParam ? { brand: brandParam } : {}),
        ...(headParam ? { category: headParam } : {}),
        ...(categorySet.has(UNFILED) ? { uncategorized: true } : {}),
        include_inactive: includeInactive,
      }),
    enabled: shopIds.length === 0,
    // Keeps the previous rows on screen while a new filter loads, so the list
    // doesn't blink back to a spinner on every debounced keystroke.
    placeholderData: keepPreviousData,
  });
  const shopQueries = useQueries({
    queries: shopIds.map((st) => ({
      queryKey: ['products', 'with-stock', st.id],
      queryFn: () => productsApi.withStock(st.id),
    })),
  });
  const shopStamp = shopQueries.map((q) => q.dataUpdatedAt).join(',');

  const filteredRows = useMemo<Row[]>(() => {
    if (!shopIds.length) return query.data ?? [];
    const needle = term.trim().toLowerCase();
    return shopIds.flatMap((st, i) =>
      (shopQueries[i]?.data ?? [])
        .filter((p) => {
          if (brandSet.size && !brandSet.has(p.brand ?? '')) return false;
          if (categorySet.size) {
            const head = normaliseCategory(p.category);
            if (!(head ? categorySet.has(head) : categorySet.has(UNFILED))) return false;
          }
          if (!needle) return true;
          return (
            p.name.toLowerCase().includes(needle) ||
            p.sku.toLowerCase().includes(needle) ||
            (p.barcode ?? '').toLowerCase().includes(needle)
          );
        })
        .map((p) => ({ ...p, shopId: st.id, shopName: st.name }))
    );
    // shopQueries is a new array every render; shopStamp is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, shopIds, term, brandSet, categorySet, shopStamp]);
  const loading = shopIds.length ? shopQueries.some((q) => q.isLoading) : query.isLoading;
  const failed = shopIds.length ? shopQueries.some((q) => q.isError) : query.isError;
  const refetchAll = () => {
    if (shopIds.length) shopQueries.forEach((q) => void q.refetch());
    else void query.refetch();
  };

  // Nested under ['products'] so a write on the edit screen refreshes the brand
  // chips too — a new brand appears the moment its first product is saved.
  const brands = useQuery({
    queryKey: ['products', 'brands'],
    queryFn: () => productsApi.brands(),
  });

  // Same nesting: filing a product under a head updates the counts here without
  // a manual refresh.
  const categories = useQuery({
    queryKey: ['products', 'categories'],
    queryFn: () => productsApi.categories(),
  });

  const rows = filteredRows;
  const brandOptions = useMemo(
    () => (brands.data ?? []).filter((b) => Boolean(b && b.trim())),
    [brands.data]
  );

  const inactiveCount = useMemo(() => rows.filter((p) => !p.is_active).length, [rows]);

  // The server's counts when they arrive; the bare list until then, so the row
  // of heads is there from the first frame instead of popping in.
  // `count: null` while the request is in flight — a chip reading "Equipment 0"
  // before the counts land would be stating something we don't know yet.
  const categoryOptions = useMemo(
    () =>
      categories.data?.categories ??
      PRODUCT_CATEGORIES.map((name) => ({ name, count: null as number | null })),
    [categories.data]
  );
  const unfiled = categories.data?.uncategorized ?? 0;
  const categoryNames = useMemo(
    () => [...(unfiled > 0 ? [UNFILED] : []), ...categoryOptions.map((c) => c.name)],
    [categoryOptions, unfiled]
  );
  const filtering = Boolean(term || brandSet.size || categorySet.size);

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

        {/* Browsing "in a shop" shows that shop's own price and stock, not
            the master — the same override the till uses. Also what makes
            Add/Edit shop-wise: opening a product from here carries the shop
            through to its screen. */}
        {(storesQuery.data ?? []).length > 0 ? (
          <MultiSelectField
            label="Shops"
            allLabel="All Shops (master list)"
            options={(storesQuery.data ?? []).map((st) => st.name)}
            selected={shopSet}
            onChange={setShopSet}
          />
        ) : null}

        {!shopIds.length ? (
          <BrandChip
            label={includeInactive ? 'Showing inactive' : 'Include inactive'}
            active={includeInactive}
            onPress={() => setIncludeInactive((v) => !v)}
          />
        ) : null}

        {brandOptions.length > 0 ? (
          <MultiSelectField
            label="Brands"
            allLabel="All brands"
            options={brandOptions}
            selected={brandSet}
            onChange={setBrandSet}
          />
        ) : null}

        <MultiSelectField
          label="Categories"
          allLabel="All categories"
          options={categoryNames}
          selected={categorySet}
          onChange={setCategorySet}
        />
      </View>

      {loading ? (
        <Loading label="Loading catalogue" />
      ) : failed ? (
        <EmptyState
          icon="cloud-off"
          title="Couldn't load the catalogue"
          hint="The product list is served live — it needs a connection."
          action={
            <Button
              label="Retry"
              icon="refresh-cw"
              variant="secondary"
              onPress={refetchAll}
            />
          }
        />
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(p) => `${p.shopId ?? ''}-${p.id}`}
          contentContainerStyle={{
            paddingHorizontal: layout.gutter,
            paddingBottom: spacing.lg,
          }}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => {
                refetchAll();
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
                  {shopIds.length ? ` · ${shopIds.map((st) => st.name).join(', ')}` : ''}
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
              title={filtering ? 'Nothing matches' : 'No products yet'}
              hint={
                filtering
                  ? 'Try a shorter search, or remove a filter.'
                  : 'Products added here appear on the till and in stock counts.'
              }
              action={
                canWrite && !filtering ? (
                  <Button
                    label="New Product"
                    icon="plus"
                    onPress={() => router.push('/products/new')}
                  />
                ) : undefined
              }
            />
          }
          renderItem={({ item }) => (
            <ProductRow product={item} storeId={item.shopId ?? null} showShop={shopIds.length > 1} />
          )}
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

function ProductRow({ product, storeId, showShop }: { product: Row; storeId: string | null; showShop: boolean }) {
  const inactive = !product.is_active;
  const meta = [showShop ? product.shopName : null, product.sku, product.brand].filter(Boolean).join('  ·  ');

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() =>
        router.push(
          storeId ? `/products/${product.id}?store=${storeId}` : `/products/${product.id}`
        )
      }
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
