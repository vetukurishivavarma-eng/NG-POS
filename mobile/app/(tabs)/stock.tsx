import React, { useMemo, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useStoreSelection } from '../../src/store/storeSelection';
import { useCatalogue, filterCatalogue } from '../../src/hooks/useCatalogue';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing } from '../../src/theme';
import { Badge, EmptyState, Icon, Loading, SectionLabel, Subtitle, Title } from '../../src/ui/components';

type Filter = 'all' | 'in' | 'low' | 'out';

export default function StockScreen() {
  const store = useStoreSelection((s) => s.selected);
  const layout = useLayout();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const { data, isLoading, refetch, isRefetching } = useCatalogue(store?.id ?? null);
  const items = data?.items ?? [];

  const summary = useMemo(() => {
    let inStock = 0;
    let low = 0;
    let out = 0;
    let value = 0;
    for (const p of items) {
      value += p.quantity * p.cost_price;
      if (p.quantity <= 0) out += 1;
      else if (p.quantity <= p.reorder_level) low += 1;
      else inStock += 1;
    }
    return { total: items.length, inStock, low, out, value };
  }, [items]);

  const visible = useMemo(() => {
    const searched = filterCatalogue(items, search, null);
    if (filter === 'all') return searched;
    return searched.filter((p) => {
      if (filter === 'out') return p.quantity <= 0;
      if (filter === 'low') return p.quantity > 0 && p.quantity <= p.reorder_level;
      return p.quantity > p.reorder_level;
    });
  }, [items, search, filter]);

  if (!store) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <EmptyState
          icon="home"
          title="Nowhere selected yet"
          hint="Pick your shop or the warehouse from the Sell tab to see what is on its shelves."
        />
      </SafeAreaView>
    );
  }

  const filters: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: summary.total },
    { key: 'in', label: 'In Stock', count: summary.inStock },
    { key: 'low', label: 'Low', count: summary.low },
    { key: 'out', label: 'Out', count: summary.out },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Title>Inventory</Title>
        <Subtitle>{store.name}</Subtitle>
      </View>

      <View style={[styles.valueCard, { marginHorizontal: layout.gutter }]}>
        <View>
          <Text style={styles.valueLabel}>Stock value at cost</Text>
          <Text style={styles.valueAmount}>{formatKwacha(summary.value)}</Text>
        </View>
        <View style={styles.valueIcon}>
          <Icon name="layers" size={22} color={colors.accentDeep} />
        </View>
      </View>

      <View style={[styles.filters, { paddingHorizontal: layout.gutter }]}>
        {filters.map((f) => {
          const active = filter === f.key;
          return (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              style={[styles.filterChip, active && styles.filterChipActive]}
            >
              <Text style={[styles.filterLabel, active && styles.filterLabelActive]}>{f.label}</Text>
              <Text style={[styles.filterCount, active && styles.filterCountActive]}>{f.count}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.searchField, { marginHorizontal: layout.gutter }]}>
        <Icon name="search" size={16} color={colors.textFaint} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search stock"
          placeholderTextColor={colors.textFaint}
          style={styles.searchInput}
        />
      </View>

      {/* Without this, a failed fetch silently shows the last synced copy and a
          product added minutes ago simply is not there — indistinguishable from
          the save having failed. Every other catalogue screen says so; this one
          is the one people check after adding stock. */}
      {data?.fromCache ? (
        <View style={[styles.cacheBanner, { marginHorizontal: layout.gutter }]}>
          <Icon name="download-cloud" size={14} color={colors.warning} />
          <Text style={styles.cacheText}>
            Showing last synced catalogue — pull down to refresh.
          </Text>
        </View>
      ) : null}

      {isLoading ? (
        <Loading />
      ) : (
        <FlashList
          key={`stock-${layout.productColumns}`}
          data={visible}
          numColumns={layout.isTablet ? 2 : 1}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ paddingHorizontal: layout.gutter - 4, paddingBottom: spacing.lg }}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
          }
          ListEmptyComponent={<EmptyState icon="package" title="Nothing here" />}
          renderItem={({ item }) => {
            const out = item.quantity <= 0;
            const low = !out && item.quantity <= item.reorder_level;
            return (
              <View style={styles.row}>
                <View style={styles.rowMain}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.sku} numberOfLines={1}>
                    {item.sku}
                  </Text>
                  <View style={{ marginTop: 6 }}>
                    <Badge
                      label={out ? 'Out of stock' : low ? 'Low stock' : 'In stock'}
                      tone={out ? 'danger' : low ? 'warning' : 'success'}
                      dot
                    />
                  </View>
                </View>
                <View style={styles.rowRight}>
                  <Text style={[styles.qty, out && { color: colors.danger }]}>{item.quantity}</Text>
                  <Text style={styles.reorder}>reorder at {item.reorder_level}</Text>
                </View>
              </View>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md },

  valueCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.primaryDeep,
    borderRadius: radius.lg,
    padding: spacing.lg,
    ...shadow.card,
  },
  valueLabel: {
    fontFamily: font.medium,
    fontSize: 11,
    color: colors.onDarkMuted,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  valueAmount: {
    fontFamily: font.extrabold,
    fontSize: 26,
    color: colors.onDark,
    letterSpacing: -0.6,
    marginTop: 4,
  },
  valueIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },

  filters: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  filterChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterLabel: { fontFamily: font.semibold, fontSize: 11, color: colors.textMuted },
  filterLabelActive: { color: '#fff' },
  filterCount: { fontFamily: font.bold, fontSize: 16, color: colors.text, marginTop: 1 },
  filterCountActive: { color: '#fff' },

  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 46,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  searchInput: { flex: 1, fontFamily: font.medium, fontSize: 14, color: colors.text },

  cacheBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.warningSoft,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    marginTop: spacing.sm,
  },
  cacheText: { flex: 1, fontFamily: font.medium, fontSize: 11, color: colors.warning },

  row: {
    flex: 1,
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
  rowMain: { flex: 1 },
  name: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  sku: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 2 },
  rowRight: { alignItems: 'flex-end' },
  qty: { fontFamily: font.extrabold, fontSize: 20, color: colors.text, letterSpacing: -0.5 },
  reorder: { fontFamily: font.regular, fontSize: 10, color: colors.textFaint },
});
