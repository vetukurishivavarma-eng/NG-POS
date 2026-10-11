import React, { useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { stores as storesApi, transfers as transfersApi } from '../../src/api/endpoints';
import { errorMessage } from '../../src/api/client';
import { printTransferNote, shareStatementPdf, shareTransferPdf } from '../../src/printing/print';
import { useCan } from '../../src/store/auth';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, radius, shadow, spacing } from '../../src/theme';
import { Badge, Button, EmptyState, Icon, Loading, Select } from '../../src/ui/components';
import type { IconName } from '../../src/ui/components';
import type { Transfer, TransferListParams } from '../../src/api/types';

type Period = 'all' | '7' | '30' | '90';

/** Local YYYY-MM-DD, `daysAgo` days before today. */
function dayKey(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function TransfersScreen() {
  const layout = useLayout();
  const canCreate = useCan('transfers.create');

  // '' = any shop. Any filter set turns the feed into a full report the
  // server returns in full (not just the latest 100), ready to download.
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [period, setPeriod] = useState<Period>('all');
  const params: TransferListParams = {
    ...(fromId ? { from_store_id: fromId } : {}),
    ...(toId ? { to_store_id: toId } : {}),
    ...(period !== 'all' ? { from: dayKey(Number(period) - 1), to: dayKey(0) } : {}),
  };
  const filtered = Object.keys(params).length > 0;

  const directory = useQuery({ queryKey: ['store-directory'], queryFn: storesApi.directory });
  const shopOptions = [
    { value: '', label: 'Any shop' },
    ...(directory.data ?? []).map((st) => ({ value: st.id, label: st.name })),
  ];

  const query = useQuery({
    // Unfiltered keeps the old ['transfers'] key, which other screens invalidate.
    queryKey: filtered ? ['transfers', params] : ['transfers'],
    queryFn: () => transfersApi.list(filtered ? params : undefined),
    // Keep showing the last result while a new filter loads, so the filter bar
    // (rendered in the list header) does not vanish mid-tap.
    placeholderData: (previous) => previous,
  });

  const rows = query.data ?? [];

  function download() {
    const nameOf = (id: string) => shopOptions.find((o) => o.value === id)?.label ?? '';
    const lines = rows.flatMap((t) =>
      t.items.map((i) => [
        new Date(t.created_at).toLocaleDateString(),
        t.reference,
        t.from_store ?? '',
        t.to_store ?? '',
        i.product_name,
        t.status === 'cancelled' ? 'revoked' : t.status.replace(/_/g, ' '),
        String(i.quantity),
      ])
    );
    const units = rows
      .filter((t) => t.status !== 'cancelled')
      .reduce((sum, t) => sum + t.items.reduce((s, i) => s + i.quantity, 0), 0);

    void shareStatementPdf(
      {
        title: 'Transfer list',
        subject: `${fromId ? nameOf(fromId) : 'Any shop'} → ${toId ? nameOf(toId) : 'Any shop'}`,
        meta: [
          period === 'all' ? (filtered ? 'All dates' : 'Latest 100 transfers') : `Last ${period} days`,
          `${rows.length} transfer${rows.length === 1 ? '' : 's'}`,
        ],
        columns: [
          { label: 'Date' },
          { label: 'Ref' },
          { label: 'From' },
          { label: 'To' },
          { label: 'Product' },
          { label: 'Status' },
          { label: 'Qty', align: 'right' },
        ],
        rows: lines,
        totals: ['', '', '', '', 'Units moved (excl. revoked)', '', String(units)],
        empty: 'No transfers match these filters.',
      },
      'Transfer-List'
    );
  }

  const filters = (
    <View style={styles.filters}>
      <Select label="From" value={fromId} options={shopOptions} onChange={setFromId} />
      <Select label="To" value={toId} options={shopOptions} onChange={setToId} />
      <Select<Period>
        label="Period"
        value={period}
        options={[
          { value: 'all', label: 'All' },
          { value: '7', label: '7 days' },
          { value: '30', label: '30 days' },
          { value: '90', label: '90 days' },
        ]}
        onChange={setPeriod}
      />
      <Button
        label="Download list"
        icon="download"
        variant="secondary"
        disabled={rows.length === 0}
        onPress={download}
      />
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      {canCreate ? (
        <View style={[styles.toolbar, { paddingHorizontal: layout.gutter }]}>
          <Button
            label="New Transfer"
            icon="plus"
            onPress={() => router.push('/transfers/new')}
          />
        </View>
      ) : null}

      {query.isLoading ? (
        <Loading label="Loading transfers" />
      ) : query.isError ? (
        <EmptyState
          icon="cloud-off"
          title="Couldn't load transfers"
          hint="Transfer history is served live — it needs a connection."
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
        <FlatList
          data={rows}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{
            padding: layout.gutter,
            paddingBottom: spacing.xxl,
            flexGrow: 1,
            gap: spacing.sm,
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
              icon="shuffle"
              title={filtered ? 'No transfers match these filters' : 'No stock has been transferred yet'}
              hint="Moving stock between two shops records a transfer here, with every line it moved."
            />
          }
          ListHeaderComponent={filters}
          renderItem={({ item }) => <TransferCard transfer={item} />}
        />
      )}
    </SafeAreaView>
  );
}

function TransferCard({ transfer }: { transfer: Transfer }) {
  const [open, setOpen] = useState(false);
  const canCreate = useCan('transfers.create');
  const queryClient = useQueryClient();

  // Undoing a transfer moves stock on two shops at once, so everything cached
  // is potentially stale afterwards — cheaper to refetch the lot than to guess
  // which screens were showing a number that just changed.
  const revoke = useMutation({
    mutationFn: () => transfersApi.revoke(transfer.id),
    onSuccess: (r) => {
      void queryClient.invalidateQueries();
      Alert.alert('Transfer revoked', r.detail);
    },
    onError: (error) => Alert.alert("Can't revoke this transfer", errorMessage(error)),
  });

  const confirmRevoke = () =>
    Alert.alert(
      `Revoke ${transfer.reference}?`,
      `Every line goes back to ${transfer.from_store ?? 'the sending shop'}. ` +
        'Only possible while the stock is untouched at ' +
        `${transfer.to_store ?? 'the receiving shop'} — if any of it has been sold, ` +
        'counted or passed on, this will be refused.',
      [
        { text: 'Keep it', style: 'cancel' },
        { text: 'Revoke', style: 'destructive', onPress: () => revoke.mutate() },
      ]
    );

  const units = transfer.items.reduce((sum, i) => sum + i.quantity, 0);
  const tone = statusTone(transfer.status);

  return (
    <Pressable
      onPress={() => setOpen((o) => !o)}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.cardTop}>
        <Text style={styles.reference}>{transfer.reference}</Text>
        <Badge label={transfer.status.replace(/_/g, ' ').toUpperCase()} tone={tone} dot />
      </View>

      {transfer.source_reference ? (
        <View style={styles.chainRow}>
          <Icon name="corner-up-right" size={12} color={colors.textMuted} />
          <Text style={styles.chainText} numberOfLines={1}>
            Passed on from {transfer.source_reference}
          </Text>
        </View>
      ) : null}

      <View style={styles.route}>
        <View style={styles.routeSide}>
          <Text style={styles.routeLabel}>From</Text>
          <Text style={styles.routeStore} numberOfLines={1}>
            {transfer.from_store ?? 'Unknown store'}
          </Text>
        </View>
        <View style={styles.routeArrow}>
          <Icon name="arrow-right" size={15} color={colors.primary} />
        </View>
        <View style={[styles.routeSide, { alignItems: 'flex-end' }]}>
          <Text style={styles.routeLabel}>To</Text>
          <Text style={styles.routeStore} numberOfLines={1}>
            {transfer.to_store ?? 'Unknown store'}
          </Text>
        </View>
      </View>

      <View style={styles.cardBottom}>
        <Text style={styles.meta} numberOfLines={1}>
          {formatWhen(transfer.created_at)}
          {'  ·  '}
          {transfer.items.length} product{transfer.items.length === 1 ? '' : 's'} · {units} unit
          {units === 1 ? '' : 's'}
        </Text>
        <View style={styles.disclosure}>
          <Text style={styles.disclosureText}>{open ? 'Hide' : 'Lines'}</Text>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={15} color={colors.textMuted} />
        </View>
      </View>

      {open ? (
        <View style={styles.lines}>
          {transfer.items.map((item, index) => (
            <View key={`${item.product_id}-${index}`} style={styles.line}>
              <View style={{ flex: 1 }}>
                <Text style={styles.lineName} numberOfLines={1}>
                  {item.product_name}
                </Text>
                <Text style={styles.lineSku} numberOfLines={1}>
                  {item.sku}
                </Text>
              </View>
              <Text style={styles.lineQty}>{item.quantity}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* Both ways out, side by side: paper for the driver, a PDF for the office. */}
      <View style={styles.actions}>
        <PrintChip
          icon="file-text"
          label="PDF"
          onPress={() => void shareTransferPdf(transfer)}
        />
        <PrintChip
          icon="printer"
          label="Print"
          onPress={() => void printTransferNote(transfer)}
        />
        {canCreate ? (
          <PrintChip
            icon="repeat"
            label="Send again"
            onPress={() => router.push(`/transfers/new?repeat=${transfer.id}`)}
          />
        ) : null}
        {canCreate ? (
          <PrintChip
            icon="corner-up-right"
            label="Pass on"
            onPress={() => router.push(`/transfers/new?passon=${transfer.id}`)}
          />
        ) : null}
        {canCreate && transfer.status === 'completed' ? (
          <PrintChip
            icon="rotate-ccw"
            label={revoke.isPending ? 'Revoking…' : 'Revoke'}
            danger
            onPress={confirmRevoke}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

function PrintChip({
  icon,
  label,
  onPress,
  danger,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  /** Reverses stock rather than printing it — coloured so it is not a misfire. */
  danger?: boolean;
}) {
  const tint = danger ? colors.danger : colors.primary;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        styles.chip,
        danger && styles.chipDanger,
        pressed && styles.chipPressed,
      ]}
    >
      <Icon name={icon} size={15} color={tint} />
      <Text style={[styles.chipLabel, { color: tint }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The API keeps `status` a free string; anything unrecognised stays neutral. */
function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  const s = status.toLowerCase();
  if (s === 'completed' || s === 'received') return 'success';
  if (s === 'pending' || s === 'in_transit') return 'warning';
  if (s === 'cancelled' || s === 'rejected') return 'danger';
  return 'neutral';
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === today.toDateString()) return `Today ${time}`;
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  toolbar: { paddingTop: spacing.md, paddingBottom: spacing.xs },
  filters: { gap: spacing.xs, marginBottom: spacing.sm },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadow.card,
  },
  cardPressed: { transform: [{ scale: 0.995 }], opacity: 0.94 },

  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  reference: { fontFamily: font.extrabold, fontSize: 16, color: colors.text, letterSpacing: 0.4 },

  chainRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.xs },
  chainText: { flex: 1, fontFamily: font.medium, fontSize: 11, color: colors.textMuted },

  route: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  routeSide: { flex: 1 },
  routeLabel: {
    fontFamily: font.semibold,
    fontSize: 9,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  routeStore: { fontFamily: font.semibold, fontSize: 14, color: colors.text, marginTop: 2 },
  routeArrow: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },

  cardBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  meta: { flex: 1, fontFamily: font.regular, fontSize: 12, color: colors.textMuted },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  disclosureText: { fontFamily: font.semibold, fontSize: 12, color: colors.textMuted },

  // Wraps so four chips reflow to two rows on a phone and sit in one row on a
  // tablet. `flexBasis` keeps each chip readable before it wraps rather than
  // letting all four shrink to slivers.
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 104,
    minWidth: 104,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.primarySoft,
  },
  chipDanger: { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
  chipPressed: { opacity: 0.7 },
  chipLabel: { fontFamily: font.semibold, fontSize: 13, color: colors.primary },

  lines: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, gap: spacing.sm },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  lineName: { fontFamily: font.medium, fontSize: 13, color: colors.text },
  lineSku: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 1 },
  lineQty: { fontFamily: font.bold, fontSize: 15, color: colors.primary },
});
