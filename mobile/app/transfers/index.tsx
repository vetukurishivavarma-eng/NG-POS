import React, { useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { transfers as transfersApi } from '../../src/api/endpoints';
import { useCan } from '../../src/store/auth';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, radius, shadow, spacing } from '../../src/theme';
import { Badge, Button, EmptyState, Icon, Loading } from '../../src/ui/components';
import type { Transfer } from '../../src/api/types';

export default function TransfersScreen() {
  const layout = useLayout();
  const canCreate = useCan('transfers.create');

  const query = useQuery({
    queryKey: ['transfers'],
    queryFn: () => transfersApi.list(),
  });

  const rows = query.data ?? [];

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
              title="No stock has been transferred yet"
              hint="Moving stock between two shops records a transfer here, with every line it moved."
            />
          }
          renderItem={({ item }) => <TransferCard transfer={item} />}
        />
      )}
    </SafeAreaView>
  );
}

function TransferCard({ transfer }: { transfer: Transfer }) {
  const [open, setOpen] = useState(false);

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

  lines: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm, gap: spacing.sm },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  lineName: { fontFamily: font.medium, fontSize: 13, color: colors.text },
  lineSku: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 1 },
  lineQty: { fontFamily: font.bold, fontSize: 15, color: colors.primary },
});
