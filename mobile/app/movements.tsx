import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';

import { inventory as inventoryApi } from '../src/api/endpoints';
import { useStoreSelection } from '../src/store/storeSelection';
import { useLayout } from '../src/ui/responsive';
import { colors, font, radius, spacing } from '../src/theme';
import { Badge, Button, EmptyState, Icon, Loading, Select, type IconName } from '../src/ui/components';
import { MOVEMENT_LABELS, type MovementType, type StockMovement } from '../src/api/types';

const LIMIT = 200;

type Filter = 'all' | MovementType;

export default function MovementsScreen() {
  const store = useStoreSelection((s) => s.selected);
  const layout = useLayout();
  const storeId = store?.id ?? null;

  const [filter, setFilter] = useState<Filter>('all');

  // Key stays exactly ['movements', storeId]: the endpoint has no type parameter,
  // so filtering happens below rather than round-tripping per chip.
  const query = useQuery({
    queryKey: ['movements', storeId],
    enabled: Boolean(storeId),
    queryFn: () => inventoryApi.movements(storeId as string, { limit: LIMIT }),
  });

  const sections = useMemo(() => {
    const rows = (query.data ?? []).filter((m) => filter === 'all' || m.type === filter);
    const ordered = [...rows].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    return groupByDay(ordered);
  }, [query.data, filter]);

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
        <Select<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'purchase', label: MOVEMENT_LABELS.purchase },
            { value: 'adjustment', label: MOVEMENT_LABELS.adjustment },
            { value: 'transfer_in', label: MOVEMENT_LABELS.transfer_in },
            { value: 'transfer_out', label: MOVEMENT_LABELS.transfer_out },
          ]}
        />
      </View>

      {query.isLoading ? (
        <Loading label="Loading movements" />
      ) : query.isError ? (
        <EmptyState
          icon="cloud-off"
          title="Couldn't load movements"
          hint="The audit trail is served live — it needs a connection."
          action={
            <Button label="Retry" icon="refresh-cw" variant="secondary" onPress={() => void query.refetch()} />
          }
        />
      ) : (
        <FlatList
          data={sections}
          keyExtractor={(item) => (item.kind === 'header' ? `h-${item.day}` : item.movement.id)}
          contentContainerStyle={{
            paddingHorizontal: layout.gutter,
            paddingBottom: spacing.xxl,
            flexGrow: 1,
          }}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => void query.refetch()}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon="activity"
              title={filter === 'all' ? 'No stock has moved in this store yet' : 'Nothing of that kind'}
              hint={
                filter === 'all'
                  ? 'Deliveries, corrections and transfers all land here the moment they happen.'
                  : 'Try another movement type.'
              }
            />
          }
          ListFooterComponent={
            sections.length > 0 ? (
              <Text style={styles.footNote}>
                Showing the {LIMIT} most recent movements.
              </Text>
            ) : null
          }
          renderItem={({ item }) =>
            item.kind === 'header' ? (
              <View style={styles.dayHeader}>
                <Text style={styles.dayLabel}>{item.label}</Text>
                <Text style={styles.dayCount}>
                  {item.count} movement{item.count === 1 ? '' : 's'}
                </Text>
              </View>
            ) : (
              <MovementRow movement={item.movement} />
            )
          }
        />
      )}
    </SafeAreaView>
  );
}

function MovementRow({ movement }: { movement: StockMovement }) {
  const up = movement.quantity >= 0;
  const look = LOOK[movement.type];

  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <View style={[styles.rowIcon, { backgroundColor: up ? colors.successSoft : colors.dangerSoft }]}>
          <Icon name={look.icon} size={15} color={up ? colors.success : colors.danger} />
        </View>

        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {movement.product_name}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {movement.sku} · {time(movement.created_at)}
          </Text>
        </View>

        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.qty, { color: up ? colors.success : colors.danger }]}>
            {signed(movement.quantity)}
          </Text>
          <Text style={styles.balance}>balance {formatQty(movement.balance)}</Text>
        </View>
      </View>

      <View style={styles.rowBottom}>
        <Badge label={MOVEMENT_LABELS[movement.type] ?? movement.type} tone={look.tone} />
        {movement.reference ? (
          <View style={styles.ref}>
            <Icon name="hash" size={11} color={colors.textMuted} />
            <Text style={styles.refText} numberOfLines={1}>
              {movement.reference}
            </Text>
          </View>
        ) : null}
      </View>

      {movement.note ? (
        <Text style={styles.note} numberOfLines={3}>
          {movement.note}
        </Text>
      ) : null}
    </View>
  );
}

/** Warm tones only — the `info` blue would fight the bone-and-green palette. */
const LOOK: Record<MovementType, { icon: IconName; tone: 'success' | 'warning' | 'accent' | 'neutral' }> = {
  purchase: { icon: 'download', tone: 'success' },
  adjustment: { icon: 'edit-3', tone: 'warning' },
  transfer_in: { icon: 'arrow-down-left', tone: 'accent' },
  transfer_out: { icon: 'arrow-up-right', tone: 'neutral' },
};

/* ------------------------------------------------------------------ grouping */

type Section =
  | { kind: 'header'; day: string; label: string; count: number }
  | { kind: 'row'; movement: StockMovement };

/** Same flattened-sections shape as the sales history, for the same reason: the
 *  day tally is derived from the rows, and one flat list keeps the row heights honest. */
function groupByDay(rows: StockMovement[]): Section[] {
  const out: Section[] = [];
  let currentDay: string | null = null;
  let headerIndex = -1;

  for (const movement of rows) {
    const day = new Date(movement.created_at).toDateString();
    if (day !== currentDay) {
      currentDay = day;
      headerIndex = out.length;
      out.push({ kind: 'header', day, label: dayLabel(movement.created_at), count: 0 });
    }
    const header = out[headerIndex];
    if (header.kind === 'header') header.count += 1;
    out.push({ kind: 'row', movement });
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

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatQty(n: number): string {
  return String(Math.round((n + Number.EPSILON) * 1000) / 1000);
}

function signed(n: number): string {
  if (n > 0) return `+${formatQty(n)}`;
  if (n < 0) return `−${formatQty(-n)}`;
  return '0';
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  toolbar: { paddingTop: spacing.md, paddingBottom: spacing.xs, backgroundColor: colors.canvas },

  dayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    backgroundColor: colors.canvas,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  dayLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  dayCount: { fontFamily: font.semibold, fontSize: 11, color: colors.textMuted },

  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  meta: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 2 },
  qty: { fontFamily: font.extrabold, fontSize: 18, letterSpacing: -0.5 },
  balance: { fontFamily: font.regular, fontSize: 10, color: colors.textFaint, marginTop: 1 },

  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  ref: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: '60%',
  },
  refText: { fontFamily: font.semibold, fontSize: 11, color: colors.textMuted },

  note: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 17,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    paddingLeft: spacing.sm,
  },

  footNote: {
    fontFamily: font.regular,
    fontSize: 11,
    color: colors.textFaint,
    textAlign: 'center',
    marginTop: spacing.lg,
  },
});
