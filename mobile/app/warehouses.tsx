import React, { useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { warehouses as warehousesApi } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { useCan } from '../src/store/auth';
import { useLayout } from '../src/ui/responsive';
import { colors, font, radius, shadow, spacing } from '../src/theme';
import { Badge, Button, EmptyState, Field, Icon, Loading } from '../src/ui/components';
import type { Warehouse, WarehouseStockRow } from '../src/api/types';

export default function WarehousesScreen() {
  const layout = useLayout();
  const queryClient = useQueryClient();
  const canWrite = useCan('warehouses.write');

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const list = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => warehousesApi.list(),
  });

  // Only the open warehouse's holdings are fetched — a depot list with a dozen
  // warehouses would otherwise fire a dozen requests nobody asked for.
  const stock = useQuery({
    queryKey: ['warehouse-stock', expandedId],
    enabled: Boolean(expandedId),
    queryFn: () => warehousesApi.stock(expandedId as string),
  });

  const rows = list.data ?? [];

  async function create() {
    const trimmedName = name.trim();
    const trimmedCode = code.trim().toUpperCase();
    if (!trimmedName || !trimmedCode) return;

    setBusy(true);
    try {
      const created = await warehousesApi.create(trimmedName, trimmedCode);
      void queryClient.invalidateQueries({ queryKey: ['warehouses'] });
      setName('');
      setCode('');
      setCreating(false);
      Alert.alert('Warehouse added', `${created.name} (${created.code}) is ready to hold stock.`);
    } catch (err) {
      Alert.alert("Couldn't add warehouse", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function confirmDeactivate(warehouse: Warehouse) {
    Alert.alert(
      `Deactivate ${warehouse.name}?`,
      'It stops appearing as a place to hold stock. Nothing is deleted — the holdings and its history stay on record.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate',
          style: 'destructive',
          onPress: () => void deactivate(warehouse.id),
        },
      ]
    );
  }

  async function deactivate(id: string) {
    try {
      await warehousesApi.remove(id);
      if (expandedId === id) setExpandedId(null);
      void queryClient.invalidateQueries({ queryKey: ['warehouses'] });
    } catch (err) {
      Alert.alert("Couldn't deactivate", errorMessage(err));
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.gutter,
          paddingBottom: spacing.xxl,
          gap: spacing.md,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={list.isRefetching}
            onRefresh={() => void list.refetch()}
            tintColor={colors.primary}
          />
        }
      >
        {canWrite ? (
          creating ? (
            <View style={styles.formCard}>
              <Text style={styles.formTitle}>New warehouse</Text>
              <Field
                label="Name"
                value={name}
                onChangeText={setName}
                placeholder="Lusaka Central Depot"
                autoFocus
              />
              <Field
                label="Code"
                value={code}
                // Uppercased as it is typed so the field shows exactly what the
                // server will store, rather than silently changing it on save.
                onChangeText={(v) => setCode(v.toUpperCase())}
                placeholder="LSK-01"
                autoCapitalize="characters"
                hint="A short reference, e.g. LSK-01."
              />
              <View style={styles.formActions}>
                <Button
                  label="Cancel"
                  variant="secondary"
                  style={{ flex: 1 }}
                  onPress={() => {
                    setCreating(false);
                    setName('');
                    setCode('');
                  }}
                />
                <Button
                  label="Add"
                  icon="check"
                  style={{ flex: 1 }}
                  loading={busy}
                  disabled={!name.trim() || !code.trim()}
                  onPress={() => void create()}
                />
              </View>
            </View>
          ) : (
            <Button label="New Warehouse" icon="plus" onPress={() => setCreating(true)} />
          )
        ) : null}

        {list.isLoading ? (
          <Loading label="Loading warehouses" />
        ) : list.isError ? (
          <EmptyState
            icon="cloud-off"
            title="Couldn't load warehouses"
            hint="Warehouse holdings are served live — they need a connection."
            action={
              <Button
                label="Retry"
                icon="refresh-cw"
                variant="secondary"
                onPress={() => void list.refetch()}
              />
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="archive"
            title="No warehouses yet"
            hint="A warehouse holds stock that isn't in a shop yet — bulk deliveries land here first, then get distributed to the branches."
          />
        ) : (
          rows.map((warehouse) => (
            <WarehouseCard
              key={warehouse.id}
              warehouse={warehouse}
              expanded={expandedId === warehouse.id}
              onToggle={() =>
                setExpandedId((current) => (current === warehouse.id ? null : warehouse.id))
              }
              canWrite={canWrite}
              onDeactivate={() => confirmDeactivate(warehouse)}
              stock={
                expandedId === warehouse.id
                  ? {
                      loading: stock.isLoading,
                      error: stock.isError,
                      rows: stock.data ?? [],
                    }
                  : null
              }
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function WarehouseCard({
  warehouse,
  expanded,
  onToggle,
  canWrite,
  onDeactivate,
  stock,
}: {
  warehouse: Warehouse;
  expanded: boolean;
  onToggle: () => void;
  canWrite: boolean;
  onDeactivate: () => void;
  stock: { loading: boolean; error: boolean; rows: WarehouseStockRow[] } | null;
}) {
  return (
    <View style={styles.card}>
      <Pressable
        onPress={onToggle}
        style={({ pressed }) => [styles.cardHead, pressed && { opacity: 0.7 }]}
      >
        <View style={styles.cardIcon}>
          <Icon name="archive" size={19} color={colors.accentDeep} />
        </View>

        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {warehouse.name}
          </Text>
          <Text style={styles.held}>
            {warehouse.stock_items} product{warehouse.stock_items === 1 ? '' : 's'} held
          </Text>
        </View>

        <View style={{ alignItems: 'flex-end', gap: 6 }}>
          <Badge label={warehouse.code} tone={warehouse.is_active ? 'accent' : 'neutral'} />
          {!warehouse.is_active ? <Badge label="INACTIVE" tone="danger" /> : null}
        </View>

        <Icon
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={18}
          color={colors.textFaint}
        />
      </Pressable>

      {expanded ? (
        <View style={styles.holdings}>
          {stock?.loading ? (
            <Loading label="Loading holdings" />
          ) : stock?.error ? (
            <Text style={styles.holdingsNote}>Couldn't load what this warehouse is holding.</Text>
          ) : (stock?.rows.length ?? 0) === 0 ? (
            <Text style={styles.holdingsNote}>
              Nothing is held here yet. Stock received into this warehouse will be listed.
            </Text>
          ) : (
            stock?.rows.map((row, index) => (
              <View key={row.product_id} style={[styles.holding, index > 0 && styles.holdingDivider]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.holdingName} numberOfLines={1}>
                    {row.product?.name ?? 'Unknown product'}
                  </Text>
                  <Text style={styles.holdingSku} numberOfLines={1}>
                    {row.product?.sku ?? '—'}
                  </Text>
                </View>
                <Text style={styles.holdingQty}>{row.quantity}</Text>
              </View>
            ))
          )}

          {canWrite && warehouse.is_active ? (
            <Button
              label="Deactivate Warehouse"
              icon="slash"
              variant="secondary"
              onPress={onDeactivate}
              style={{ marginTop: spacing.sm }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  formCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadow.card,
  },
  formTitle: { fontFamily: font.bold, fontSize: 16, color: colors.text },
  formActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    ...shadow.card,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  cardIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontFamily: font.bold, fontSize: 15, color: colors.text },
  held: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted, marginTop: 2 },

  holdings: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surfaceSunken,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  holdingsNote: {
    fontFamily: font.regular,
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 18,
    paddingVertical: spacing.sm,
  },
  holding: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  holdingDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  holdingName: { fontFamily: font.semibold, fontSize: 13, color: colors.text },
  holdingSku: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 1 },
  holdingQty: { fontFamily: font.extrabold, fontSize: 17, color: colors.accentDeep },
});
