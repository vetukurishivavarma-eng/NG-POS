import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { useStoreSelection } from '../../src/store/storeSelection';
import { computeTotals, maxSellable, useCart } from '../../src/store/cart';
import { useSync } from '../../src/db/sync';
import { useCatalogue, filterCatalogue } from '../../src/hooks/useCatalogue';
import { useLayout } from '../../src/ui/responsive';
import { CartPanel } from '../../src/ui/CartPanel';
import { useFlyToCart } from '../../src/ui/flyToCart';
import { bevel, colors, font, formatKwacha, motion, radius, shadow, spacing } from '../../src/theme';
import { Badge, Button, EmptyState, Icon, Loading, QtyStepper } from '../../src/ui/components';
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
  const setQuantity = useCart((s) => s.setQuantity);
  const { fly } = useFlyToCart();

  /** Cart quantity by product id, so a tile can show its own count in one lookup. */
  const inCart = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of lines) map.set(l.product.id, l.quantity);
    return map;
  }, [lines]);

  // Told to the cashier when a stepper refuses to go further, because a button
  // that silently does nothing reads as a broken button.
  const [limitNote, setLimitNote] = useState<string | null>(null);
  const limitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashLimit = useCallback((message: string) => {
    setLimitNote(message);
    if (limitTimer.current) clearTimeout(limitTimer.current);
    limitTimer.current = setTimeout(() => setLimitNote(null), 2200);
  }, []);

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
          title="Nowhere selected yet"
          hint="Pick your shop, or the warehouse, to start a session."
          action={
            <Button label="Choose" icon="chevron-right" onPress={() => router.push('/store-picker')} />
          }
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
          renderItem={({ item }) => {
            const props = {
              product: item,
              quantity: inCart.get(item.id) ?? 0,
              onAdd: (from: { x: number; y: number; width: number; height: number }) => {
                add(item);
                fly(from, item.name.charAt(0).toUpperCase());
              },
              onSetQuantity: (next: number) => setQuantity(item.id, next),
              onLimit: (edge: 'min' | 'max') => {
                if (edge !== 'max') return;
                flashLimit(
                  item.quantity > 0
                    ? `Only ${formatStock(item.quantity)} of ${item.name} in stock.`
                    : `${item.name} is already oversold to the limit — count the shelf before selling more.`
                );
              },
            };
            return layout.productColumns > 1 ? (
              <ProductTile {...props} />
            ) : (
              <ProductRow {...props} />
            );
          }}
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

      {limitNote ? (
        <View style={styles.limitToast} pointerEvents="none">
          <Icon name="alert-circle" size={15} color={colors.accentDeep} />
          <Text style={styles.limitText}>{limitNote}</Text>
        </View>
      ) : null}

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
          {lines.length > 0 ? <CartBar itemCount={totals.itemCount} total={totals.total} /> : null}
        </>
      )}
    </SafeAreaView>
  );
}

/**
 * The bar doubles as the flight's destination, so it reports its own position
 * rather than the screen guessing at one. It is re-measured on every layout —
 * the keyboard opening or a rotation moves it, and a token flying to where it
 * used to be looks worse than no animation at all.
 */
function CartBar({ itemCount, total }: { itemCount: number; total: number }) {
  const { setTarget, bump } = useFlyToCart();
  const ref = useRef<View>(null);
  const enter = useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    Animated.spring(enter, { toValue: 1, ...motion.spring, useNativeDriver: true }).start();
    return () => setTarget(null);
  }, [enter, setTarget]);

  const measure = useCallback(() => {
    ref.current?.measureInWindow((x, y, width, height) => setTarget({ x, y, width, height }));
  }, [setTarget]);

  return (
    <Animated.View
      style={[
        styles.cartBarWrap,
        {
          opacity: enter,
          transform: [
            { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [80, 0] }) },
          ],
        },
      ]}
    >
      <Pressable
        ref={ref}
        onLayout={measure}
        style={styles.cartBar}
        onPress={() => router.push('/cart')}
      >
        <Animated.View style={[styles.cartCount, { transform: [{ scale: bump }] }]}>
          <Text style={styles.cartCountText}>{itemCount}</Text>
        </Animated.View>
        <Text style={styles.cartLabel}>View Cart</Text>
        <Text style={styles.cartTotal}>{formatKwacha(total)}</Text>
        <Icon name="chevron-right" size={18} color="#fff" />
      </Pressable>
    </Animated.View>
  );
}

function formatStock(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

function stockTone(p: ProductWithStock) {
  // Oversold gets its own label rather than a flat "Out of stock": once a sale
  // can push the count negative, the badge needs to say by how much, not just
  // that it's at zero.
  if (p.quantity < 0) return { label: `${formatStock(Math.abs(p.quantity))} oversold`, tone: 'danger' as const };
  if (p.quantity === 0) return { label: 'Out of stock', tone: 'danger' as const };
  if (p.quantity <= p.reorder_level)
    return { label: `${formatStock(p.quantity)} left`, tone: 'warning' as const };
  return { label: `${formatStock(p.quantity)} in stock`, tone: 'success' as const };
}

type Rect = { x: number; y: number; width: number; height: number };

interface ProductProps {
  product: ProductWithStock;
  quantity: number;
  onAdd: (from: Rect) => void;
  onSetQuantity: (next: number) => void;
  onLimit: (edge: 'min' | 'max') => void;
}

/**
 * Press physics shared by both card shapes.
 *
 * The card sinks toward the page under the finger and springs back — the same
 * motion a real key makes. It is also what carries the depth: a raised surface
 * that does not move when pressed just looks like a picture of one.
 */
function usePressDepth() {
  const depth = useRef(new Animated.Value(0)).current;
  const press = useCallback(
    (down: boolean) =>
      Animated.spring(depth, {
        toValue: down ? 1 : 0,
        ...motion.spring,
        useNativeDriver: true,
      }).start(),
    [depth]
  );
  const style = {
    transform: [
      { scale: depth.interpolate({ inputRange: [0, 1], outputRange: [1, 0.972] }) },
      { translateY: depth.interpolate({ inputRange: [0, 1], outputRange: [0, 2] }) },
    ],
  };
  return { style, onPressIn: () => press(true), onPressOut: () => press(false) };
}

/**
 * The flight has to start from where the product actually is on screen, which
 * only the native view knows. `measureInWindow` is asynchronous, so the add is
 * done inside the callback — the token and the count then change together.
 */
function useFlightOrigin(onAdd: (from: Rect) => void) {
  const ref = useRef<View>(null);
  const launch = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    node.measureInWindow((x, y, width, height) => onAdd({ x, y, width, height }));
  }, [onAdd]);
  return { ref, launch };
}

function ProductRow({ product, quantity, onAdd, onSetQuantity, onLimit }: ProductProps) {
  // Disabled only once the oversell floor (see cart.ts) is actually reached —
  // an out-of-stock product can still be sold, up to that point.
  const out = maxSellable(product) <= 0;
  const stock = stockTone(product);
  const depth = usePressDepth();
  const { ref, launch } = useFlightOrigin(onAdd);
  const inCart = quantity > 0;

  return (
    <Animated.View style={depth.style}>
      <Pressable
        ref={ref}
        onPress={launch}
        onPressIn={depth.onPressIn}
        onPressOut={depth.onPressOut}
        disabled={out}
        style={[styles.row, out && styles.dimmed, inCart && styles.rowInCart]}
      >
        <View style={[styles.thumb, inCart && styles.thumbInCart]}>
          <Text style={[styles.thumbText, inCart && styles.thumbTextInCart]}>
            {product.name.charAt(0).toUpperCase()}
          </Text>
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
          {out ? null : inCart ? (
            // Once it is in the basket the tile stops being a button and becomes
            // the line itself — correcting a miscount no longer means opening
            // the cart, which was three taps to undo one.
            <QtyStepper
              size="sm"
              value={quantity}
              max={maxSellable(product)}
              onChange={onSetQuantity}
              onLimit={onLimit}
            />
          ) : (
            <View style={styles.addBtn}>
              <Icon name="plus" size={17} color="#fff" />
            </View>
          )}
        </View>
      </Pressable>
    </Animated.View>
  );
}

function ProductTile({ product, quantity, onAdd, onSetQuantity, onLimit }: ProductProps) {
  // Disabled only once the oversell floor (see cart.ts) is actually reached —
  // an out-of-stock product can still be sold, up to that point.
  const out = maxSellable(product) <= 0;
  const stock = stockTone(product);
  const depth = usePressDepth();
  const { ref, launch } = useFlightOrigin(onAdd);
  const inCart = quantity > 0;

  return (
    <Animated.View style={[styles.tileWrap, depth.style]}>
      <Pressable
        ref={ref}
        onPress={launch}
        onPressIn={depth.onPressIn}
        onPressOut={depth.onPressOut}
        disabled={out}
        style={[styles.tile, out && styles.dimmed, inCart && styles.tileInCart]}
      >
        <View style={styles.tileTop}>
          <View style={[styles.thumb, inCart && styles.thumbInCart]}>
            <Text style={[styles.thumbText, inCart && styles.thumbTextInCart]}>
              {product.name.charAt(0).toUpperCase()}
            </Text>
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
          {out ? null : inCart ? (
            <QtyStepper
              size="sm"
              value={quantity}
              max={maxSellable(product)}
              onChange={onSetQuantity}
              onLimit={onLimit}
            />
          ) : (
            <View style={styles.addBtn}>
              <Icon name="plus" size={17} color="#fff" />
            </View>
          )}
        </View>
      </Pressable>
    </Animated.View>
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

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    margin: 4,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderLeftColor: colors.border,
    borderRightColor: colors.border,
    ...bevel.light,
    ...shadow.tile,
  },
  // A product already in the basket is tinted and outlined in the brand green,
  // so a half-built cart is legible from the grid without opening it.
  rowInCart: { borderLeftColor: colors.primary, borderLeftWidth: 3, backgroundColor: '#FCFDFC' },
  rowRight: { alignItems: 'flex-end', gap: spacing.sm },

  tileWrap: { flex: 1 },
  tile: {
    flex: 1,
    backgroundColor: colors.surface,
    margin: 4,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderLeftColor: colors.border,
    borderRightColor: colors.border,
    gap: 3,
    ...bevel.light,
    ...shadow.tile,
  },
  tileInCart: { borderLeftColor: colors.primary, borderLeftWidth: 3, backgroundColor: '#FCFDFC' },
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
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    ...bevel.light,
  },
  thumbInCart: { backgroundColor: colors.primary },
  thumbText: { fontFamily: font.bold, fontSize: 17, color: colors.primary },
  thumbTextInCart: { color: '#fff' },

  itemName: { fontFamily: font.semibold, fontSize: 15, color: colors.text, lineHeight: 20 },
  itemMeta: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted },
  price: { fontFamily: font.bold, fontSize: 16, color: colors.text, letterSpacing: -0.3 },
  addBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...bevel.dark,
    ...shadow.card,
  },

  limitToast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: 92,
    zIndex: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...bevel.light,
    ...shadow.raised,
  },
  limitText: { flex: 1, fontFamily: font.semibold, fontSize: 12, color: colors.accentDeep },

  cartBarWrap: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
  },
  cartBar: {
    height: 62,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    ...bevel.dark,
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
