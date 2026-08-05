import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';

import { stores as storesApi } from '../src/api/endpoints';
import { useStoreSelection } from '../src/store/storeSelection';
import { useCart } from '../src/store/cart';
import { colors, font, radius, shadow, spacing } from '../src/theme';
import { Badge, EmptyState, Icon, Loading } from '../src/ui/components';

export default function StorePicker() {
  const selected = useStoreSelection((s) => s.selected);
  const select = useStoreSelection((s) => s.select);
  const cartLines = useCart((s) => s.lines);
  const clearCart = useCart((s) => s.clear);
  const [search, setSearch] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['stores'],
    queryFn: storesApi.list,
  });

  async function choose(storeId: string) {
    const store = data?.find((s) => s.id === storeId);
    if (!store) return;
    // Prices and stock are per-store, so a cart can't survive a store switch.
    if (cartLines.length > 0 && store.id !== selected?.id) clearCart();
    await select(store);
    router.back();
  }

  if (isLoading) return <Loading label="Loading stores" />;
  if (isError) {
    return (
      <EmptyState
        icon="cloud-off"
        title="Couldn't load stores"
        hint="Check your connection and try again."
      />
    );
  }

  const active = (data ?? []).filter((s) => s.is_active);
  const visible = search.trim()
    ? active.filter((s) =>
        `${s.name} ${s.code}`.toLowerCase().includes(search.trim().toLowerCase())
      )
    : active;

  return (
    <View style={styles.root}>
      <View style={styles.searchField}>
        <Icon name="search" size={16} color={colors.textFaint} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Find a store"
          placeholderTextColor={colors.textFaint}
          style={styles.searchInput}
        />
      </View>

      <FlatList
        contentContainerStyle={{ padding: spacing.md, paddingTop: 0 }}
        data={visible}
        keyExtractor={(s) => s.id}
        ListEmptyComponent={<EmptyState icon="search" title="No matching stores" />}
        renderItem={({ item }) => {
          const isCurrent = item.id === selected?.id;
          return (
            <Pressable
              onPress={() => choose(item.id)}
              style={({ pressed }) => [
                styles.row,
                isCurrent && styles.rowActive,
                pressed && { opacity: 0.85 },
              ]}
            >
              <View style={[styles.mark, isCurrent && styles.markActive]}>
                <Text style={[styles.markText, isCurrent && styles.markTextActive]}>
                  {item.name.charAt(0).toUpperCase()}
                </Text>
              </View>

              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.code}>{item.code}</Text>
                {item.address?.city ? (
                  <View style={styles.cityRow}>
                    <Icon name="map-pin" size={11} color={colors.textFaint} />
                    <Text style={styles.city}>{item.address.city}</Text>
                  </View>
                ) : null}
              </View>

              {isCurrent ? (
                <Badge label="Current" tone="success" dot />
              ) : (
                <Icon name="chevron-right" size={18} color={colors.textFaint} />
              )}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },

  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 46,
    margin: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  searchInput: { flex: 1, fontFamily: font.medium, fontSize: 14, color: colors.text },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    ...shadow.card,
  },
  rowActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },

  mark: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markActive: { backgroundColor: colors.primary },
  markText: { fontFamily: font.bold, fontSize: 18, color: colors.textMuted },
  markTextActive: { color: '#fff' },

  name: { fontFamily: font.semibold, fontSize: 15, color: colors.text },
  code: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 1 },
  cityRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  city: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted },
});
