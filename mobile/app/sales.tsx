import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useInfiniteQuery } from '@tanstack/react-query';

import { transactions as txApi } from '../src/api/endpoints';
import { useStoreSelection } from '../src/store/storeSelection';
import { useLayout } from '../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing } from '../src/theme';
import { Badge, Button, EmptyState, Icon, Loading } from '../src/ui/components';
import type { Transaction, TransactionType } from '../src/api/types';

const PAGE_SIZE = 40;

type Filter = 'all' | 'sale' | 'refund';

export default function SalesScreen() {
  const store = useStoreSelection((s) => s.selected);
  const layout = useLayout();
  const storeId = store?.id ?? null;

  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const query = useInfiniteQuery({
    queryKey: ['sales-history', storeId, filter],
    enabled: Boolean(storeId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      txApi.list(storeId as string, {
        limit: PAGE_SIZE,
        offset: pageParam,
        ...(filter === 'all' ? {} : { type: filter as TransactionType }),
      }),
    // A short page means the server has nothing left to give.
    getNextPageParam: (last, all) =>
      last.length < PAGE_SIZE ? undefined : all.length * PAGE_SIZE,
  });

  const rows = useMemo(() => query.data?.pages.flat() ?? [], [query.data]);

  // Search is deliberately local: staff look up a receipt they just printed,
  // which is always in the pages already loaded, and a round trip per keystroke
  // is exactly what a rural link can't afford.
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (t) =>
        t.receipt_number?.toLowerCase().includes(needle) ||
        (t.customer_name ?? '').toLowerCase().includes(needle) ||
        t.items.some((i) => i.product_name.toLowerCase().includes(needle))
    );
  }, [rows, search]);

  const sections = useMemo(() => groupByDay(filtered), [filtered]);

  if (!store) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState icon="home" title="No store selected" hint="Choose a store from the Sell tab." />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={[styles.toolbar, { paddingHorizontal: layout.gutter }]}>
        <View style={styles.searchBox}>
          <Icon name="search" size={16} color={colors.textFaint} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Receipt, customer or item"
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

        <View style={styles.filterRow}>
          <FilterChip label="All" active={filter === 'all'} onPress={() => setFilter('all')} />
          <FilterChip label="Sales" active={filter === 'sale'} onPress={() => setFilter('sale')} />
          <FilterChip
            label="Refunds"
            active={filter === 'refund'}
            onPress={() => setFilter('refund')}
          />
        </View>
      </View>

      {query.isLoading ? (
        <Loading label="Loading history" />
      ) : query.isError ? (
        <EmptyState
          icon="cloud-off"
          title="Couldn't load history"
          hint="Sales history is served live — it needs a connection."
          action={<Button label="Retry" icon="refresh-cw" variant="secondary" onPress={() => void query.refetch()} />}
        />
      ) : (
        <FlatList
          data={sections}
          keyExtractor={(item) => (item.kind === 'header' ? `h-${item.day}` : item.tx.id)}
          contentContainerStyle={{
            padding: layout.gutter,
            paddingBottom: spacing.xxl,
            flexGrow: 1,
          }}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching && !query.isFetchingNextPage}
              onRefresh={() => void query.refetch()}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon="file-text"
              title={search ? 'Nothing matches' : 'No transactions yet'}
              hint={search ? 'Try a different receipt number or item.' : 'Completed sales appear here.'}
            />
          }
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
          }}
          ListFooterComponent={
            query.isFetchingNextPage ? <Loading /> : <View style={{ height: spacing.lg }} />
          }
          renderItem={({ item }) =>
            item.kind === 'header' ? (
              <View style={styles.dayHeader}>
                <Text style={styles.dayLabel}>{item.label}</Text>
                <Text style={styles.dayTotal}>{formatKwacha(item.total)}</Text>
              </View>
            ) : (
              <TransactionRow tx={item.tx} />
            )
          }
        />
      )}
    </SafeAreaView>
  );
}

function TransactionRow({ tx }: { tx: Transaction }) {
  const isReversal = tx.transaction_type !== 'sale';
  const voided = tx.status === 'voided';

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => router.push(`/transaction/${tx.id}`)}
    >
      <View style={[styles.rowIcon, isReversal && { backgroundColor: colors.warningSoft }]}>
        <Icon
          name={isReversal ? 'corner-up-left' : 'shopping-bag'}
          size={16}
          color={isReversal ? colors.warning : colors.primary}
        />
      </View>

      <View style={{ flex: 1 }}>
        <Text style={[styles.receipt, voided && styles.struck]} numberOfLines={1}>
          {tx.receipt_number || 'Pending number'}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {new Date(tx.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
          {tx.items.length} item{tx.items.length === 1 ? '' : 's'}
          {tx.customer_name ? ` · ${tx.customer_name}` : ''}
        </Text>
      </View>

      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Text style={[styles.total, (isReversal || tx.total < 0) && { color: colors.danger }]}>
          {formatKwacha(tx.total)}
        </Text>
        {tx.status !== 'completed' ? (
          <Badge
            label={tx.status.toUpperCase()}
            tone={tx.status === 'refunded' ? 'warning' : tx.status === 'voided' ? 'danger' : 'neutral'}
          />
        ) : null}
      </View>

      <Icon name="chevron-right" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ grouping */

type Section =
  | { kind: 'header'; day: string; label: string; total: number }
  | { kind: 'row'; tx: Transaction };

/**
 * Flattened day sections rather than SectionList: the day subtotal has to be
 * computed from the rows anyway, and one flat list keeps pagination simple.
 */
function groupByDay(rows: Transaction[]): Section[] {
  const out: Section[] = [];
  let currentDay: string | null = null;
  let headerIndex = -1;

  for (const tx of rows) {
    const day = new Date(tx.created_at).toDateString();
    if (day !== currentDay) {
      currentDay = day;
      headerIndex = out.length;
      out.push({ kind: 'header', day, label: dayLabel(tx.created_at), total: 0 });
    }
    const header = out[headerIndex];
    if (header.kind === 'header') header.total += tx.total;
    out.push({ kind: 'row', tx });
  }

  return out;
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  toolbar: {
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
    backgroundColor: colors.canvas,
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

  filterRow: { flexDirection: 'row', gap: spacing.xs },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSunken,
  },
  chipActive: { backgroundColor: colors.primary },
  chipText: { fontFamily: font.semibold, fontSize: 12, color: colors.textMuted },
  chipTextActive: { color: '#fff' },

  dayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  dayLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  dayTotal: { fontFamily: font.bold, fontSize: 13, color: colors.textMuted },

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
    ...shadow.card,
  },
  rowPressed: { transform: [{ scale: 0.99 }], opacity: 0.92 },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  receipt: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  struck: { textDecorationLine: 'line-through', color: colors.textMuted },
  meta: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 2 },
  total: { fontFamily: font.bold, fontSize: 15, color: colors.text },
});
