import React, { useMemo, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { useStoreSelection } from '../../src/store/storeSelection';
import { computeTotals, useCart } from '../../src/store/cart';
import { useSync } from '../../src/db/sync';
import { useCatalogue, filterCatalogue } from '../../src/hooks/useCatalogue';
import { useLayout } from '../../src/ui/responsive';
import { CartPanel } from '../../src/ui/CartPanel';
import { colors, font, formatKwacha, radius, shadow, spacing } from '../../src/theme';
import { Badge, Button, EmptyState, Icon, Loading } from '../../src/ui/components';
import type { ProductWithStock } from '../../src/api/types';

export default function SellScreen() {
  const store = useStoreSelection((s) => s.selected);
  const online = useSync((s) => s.online);
  const pendingCount = useSync((s) => s.pendingCount);
  const layout = useLayout();

  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState<string | null>(null);

  const { data, isLoading, isError, refetch, isRefetching } = useCatalogue(store?.id ?? null);
  const lines = useCart((s) => s.lines);
  const add = useCart((s) => s.add);

  const items = data?.items ?? [];
  const brands = useMemo(
    () => Array.from(new Set(items.map((p) => p.brand).filter(Boolean) as string[])).sort(),
    [items]
  );
  const visible = useMemo(() => filterCatalogue(items, search, brand), [items, search, brand]);
  const totals = useMemo(() => computeTotals(lines), [lines]);

  if (!store) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <EmptyState
          icon="home"
          title="No store selected"
          hint="Pick which store you're selling from to start a session."
          action={<Button label="Select Store" icon="chevron-right" onPress={() => router.push('/store-picker')} />}
        />
      </SafeAreaView>
    );
  }

  const productArea = (
    <View style={styles.flex}>
      <View style={[styles.controls, { paddingHorizontal: layout.gutter }]}>
        <View style={styles.searchField}>
          <Icon name="search" size={17} color={colors.textFaint} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search name, SKU or barcode"
            placeholderTextColor={colors.textFaint}
            style={styles.searchInput}
            autoCorrect={false}
          />
          {search.length > 0 ? (
            <Pressable onPress={() => setSearch('')} hitSlop={10}>
              <Icon name="x-circle" size={17} color={colors.textFaint} />
            </Pressable>
          ) : null}
        </View>
        <Pressable style={styles.scanBtn} onPress={() => router.push('/scan')}>
          <Icon name="maximize" size={20} color="#fff" />
        </Pressable>
      </View>

      {brands.length > 0 ? (
        <View style={styles.brandRow}>
          <FlashList
            horizontal
            data={[null, ...brands]}
            keyExtractor={(b) => b ?? '__all'}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: layout.gutter }}
            renderItem={({ item }) => {
              const active = brand === item;
              return (
                <Pressable
                  onPress={() => setBrand(item)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {item ?? 'All Brands'}
                  </Text>
                </Pressable>
              );
            }}
          />
        </View>
      ) : null}

      {data?.fromCache ? (
        <View style={styles.cacheBanner}>
          <Icon name="download-cloud" size={14} color={colors.warning} />
          <Text style={styles.cacheText}>
            Showing last synced catalogue — prices and stock may be out of date.
          </Text>
        </View>
      ) : null}

      {isLoading ? (
        <Loading label="Loading catalogue…" />
      ) : isError ? (
        <EmptyState
          icon="cloud-off"
          title="Couldn't load products"
          hint="No connection, and nothing cached for this store yet. Connect once to sync."
          action={<Button label="Retry" variant="secondary" icon="refresh-cw" onPress={() => void refetch()} />}
        />
      ) : (
        <FlashList
          key={`grid-${layout.productColumns}`}
          data={visible}
          numColumns={layout.productColumns}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{
            paddingHorizontal: layout.gutter - 4,
            paddingBottom: !layout.isTablet && lines.length > 0 ? 100 : spacing.lg,
          }}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
          }
          ListEmptyComponent={
            <EmptyState icon="search" title="No matching products" hint="Try a different search or brand." />
          }
          renderItem={({ item }) =>
            layout.productColumns > 1 ? (
              <ProductTile product={item} onAdd={() => add(item)} />
            ) : (
              <ProductRow product={item} onAdd={() => add(item)} />
            )
          }
        />
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable style={styles.headerStore} onPress={() => router.push('/store-picker')}>
          <View>
            <Text style={styles.storeLabel}>Selling from</Text>
            <View style={styles.storeNameRow}>
              <Text style={styles.storeName}>{store.name}</Text>
              <Icon name="chevron-down" size={16} color={colors.onDarkMuted} />
            </View>
          </View>
        </Pressable>

        <View style={styles.headerStatus}>
          <View style={[styles.statusPill, !online && styles.statusPillOffline]}>
            <View style={[styles.dot, { backgroundColor: online ? colors.accent : colors.warning }]} />
            <Text style={styles.statusText}>{online ? 'Online' : 'Offline'}</Text>
          </View>
          {pendingCount > 0 ? (
            <View style={styles.queuePill}>
              <Icon name="upload-cloud" size={12} color={colors.accentDeep} />
              <Text style={styles.queueText}>{pendingCount}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {layout.isTablet ? (
        <View style={styles.split}>
          {productArea}
          <View style={{ width: layout.cartPanelWidth }}>
            <CartPanel docked />
          </View>
        </View>
      ) : (
        <>
          {productArea}
          {lines.length > 0 ? (
            <Pressable style={styles.cartBar} onPress={() => router.push('/cart')}>
              <View style={styles.cartCount}>
                <Text style={styles.cartCountText}>{totals.itemCount}</Text>
              </View>
              <Text style={styles.cartLabel}>View Cart</Text>
              <Text style={styles.cartTotal}>{formatKwacha(totals.total)}</Text>
              <Icon name="chevron-right" size={18} color="#fff" />
            </Pressable>
          ) : null}
        </>
      )}
    </SafeAreaView>
  );
}

function stockTone(p: ProductWithStock) {
  if (p.quantity <= 0) return { label: 'Out of stock', tone: 'danger' as const };
  if (p.quantity <= p.reorder_level) return { label: `${p.quantity} left`, tone: 'warning' as const };
  return { label: `${p.quantity} in stock`, tone: 'success' as const };
}

function ProductRow({ product, onAdd }: { product: ProductWithStock; onAdd: () => void }) {
  const out = product.quantity <= 0;
  const stock = stockTone(product);

  return (
    <Pressable
      onPress={onAdd}
      disabled={out}
      style={({ pressed }) => [styles.row, out && styles.dimmed, pressed && styles.pressed]}
    >
      <View style={styles.thumb}>
        <Text style={styles.thumbText}>{product.name.charAt(0).toUpperCase()}</Text>
      </View>

      <View style={styles.flex}>
        <Text style={styles.itemName} numberOfLines={2}>
          {product.name}
        </Text>
        <Text style={styles.itemMeta} numberOfLines={1}>
          {product.brand ?? '—'}
        </Text>
        <View style={{ marginTop: 5 }}>
          <Badge label={stock.label} tone={stock.tone} dot />
        </View>
      </View>

      <View style={styles.rowRight}>
        <Text style={styles.price}>{formatKwacha(product.selling_price)}</Text>
        {!out ? (
          <View style={styles.addBtn}>
            <Icon name="plus" size={17} color="#fff" />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function ProductTile({ product, onAdd }: { product: ProductWithStock; onAdd: () => void }) {
  const out = product.quantity <= 0;
  const stock = stockTone(product);

  return (
    <Pressable
      onPress={onAdd}
      disabled={out}
      style={({ pressed }) => [styles.tile, out && styles.dimmed, pressed && styles.pressed]}
    >
      <View style={styles.tileTop}>
        <View style={styles.thumb}>
          <Text style={styles.thumbText}>{product.name.charAt(0).toUpperCase()}</Text>
        </View>
        <Badge label={stock.label} tone={stock.tone} dot />
      </View>

      <Text style={styles.tileName} numberOfLines={2}>
        {product.name}
      </Text>
      <Text style={styles.itemMeta} numberOfLines={1}>
        {product.brand ?? '—'}
      </Text>

      <View style={styles.tileFooter}>
        <Text style={styles.price}>{formatKwacha(product.selling_price)}</Text>
        {!out ? (
          <View style={styles.addBtn}>
            <Icon name="plus" size={17} color="#fff" />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1 },
  split: { flex: 1, flexDirection: 'row' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.primaryDeep,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerStore: { flex: 1 },
  storeLabel: {
    fontFamily: font.medium,
    fontSize: 10,
    color: colors.onDarkMuted,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  storeNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  storeName: { fontFamily: font.bold, fontSize: 19, color: colors.onDark, letterSpacing: -0.3 },

  headerStatus: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  statusPillOffline: { backgroundColor: 'rgba(223,160,44,0.2)' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontFamily: font.semibold, fontSize: 11, color: colors.onDark },
  queuePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  queueText: { fontFamily: font.bold, fontSize: 11, color: colors.accentDeep },

  controls: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.md },
  searchField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 48,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    ...shadow.card,
  },
  searchInput: { flex: 1, fontFamily: font.medium, fontSize: 15, color: colors.text },
  scanBtn: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },

  brandRow: { height: 42 },
  chip: {
    paddingHorizontal: spacing.md,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontFamily: font.semibold, fontSize: 12, color: colors.textMuted },
  chipTextActive: { color: '#fff' },

  cacheBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.warningSoft,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  cacheText: { flex: 1, fontFamily: font.medium, fontSize: 11, color: colors.warning },

  dimmed: { opacity: 0.5 },
  pressed: { transform: [{ scale: 0.98 }] },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    margin: 4,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  rowRight: { alignItems: 'flex-end', gap: spacing.sm },

  tile: {
    flex: 1,
    backgroundColor: colors.surface,
    margin: 4,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 3,
    ...shadow.card,
  },
  tileTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  tileName: { fontFamily: font.semibold, fontSize: 14, color: colors.text, lineHeight: 19 },
  tileFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },

  thumb: {
    width: 42,
    height: 42,
    borderRadius: radius.sm,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbText: { fontFamily: font.bold, fontSize: 17, color: colors.primary },

  itemName: { fontFamily: font.semibold, fontSize: 15, color: colors.text, lineHeight: 20 },
  itemMeta: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted },
  price: { fontFamily: font.bold, fontSize: 16, color: colors.text, letterSpacing: -0.3 },
  addBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },

  cartBar: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
    height: 62,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    ...shadow.raised,
  },
  cartCount: {
    minWidth: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 7,
  },
  cartCountText: { fontFamily: font.bold, fontSize: 13, color: '#fff' },
  cartLabel: { flex: 1, fontFamily: font.semibold, fontSize: 16, color: '#fff' },
  cartTotal: { fontFamily: font.extrabold, fontSize: 18, color: '#fff', letterSpacing: -0.4 },
});
