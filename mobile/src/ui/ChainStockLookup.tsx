import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { inventory as inventoryApi, products as productsApi } from '../api/endpoints';
import type { Product } from '../api/types';
import { colors, font, radius, shadow, spacing } from '../theme';
import { Field, Icon } from './components';

/**
 * Search a product, then see what every shop is holding.
 *
 * Quantities only — no price, no cost, no movement history — and the endpoint
 * behind it is scoped to the caller's own organisation. That is what makes it
 * safe to hand to a cashier: until now the only way to answer "how many does
 * Katende have?" from behind a till was to ring Katende.
 *
 * Renders the search and the table and nothing else. The heading above it is
 * the caller's, because the same control reads differently on the bulk-upload
 * screen ("this is not part of the upload") and on its own screen.
 */
export function ChainStockLookup() {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState<Product | null>(null);

  // Tills run on patchy connections; a request per keystroke is the wrong way
  // to spend one. Long enough to finish typing a word, short enough to feel live.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 300);
    return () => clearTimeout(t);
  }, [term]);

  const results = useQuery({
    queryKey: ['stock-lookup-search', debounced],
    queryFn: () => productsApi.list({ search: debounced, limit: 20 }),
    // Two characters is where the result list stops being the whole catalogue.
    enabled: debounced.length >= 2 && picked == null,
    staleTime: 30_000,
  });

  const stock = useQuery({
    queryKey: ['stock-by-product', picked?.id],
    queryFn: () => inventoryApi.byProduct(picked!.id),
    enabled: picked != null,
    staleTime: 30_000,
  });

  const rows = stock.data?.stores ?? [];

  return (
    <View style={{ gap: spacing.md }}>
      {picked ? (
        <Pressable style={styles.picked} onPress={() => setPicked(null)}>
          <View style={{ flex: 1 }}>
            <Text style={styles.pickedName} numberOfLines={1}>
              {picked.name}
            </Text>
            <Text style={styles.pickedMeta} numberOfLines={1}>
              {[picked.brand, picked.sku].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <Icon name="x" size={16} color={colors.textFaint} />
        </Pressable>
      ) : (
        <Field
          label="Product"
          value={term}
          onChangeText={setTerm}
          placeholder="Name, brand or code"
          autoCapitalize="none"
        />
      )}

      {picked == null && debounced.length >= 2 ? (
        results.isLoading ? (
          <ActivityIndicator color={colors.primary} />
        ) : results.isError ? (
          <Pressable onPress={() => void results.refetch()}>
            <Text style={styles.muted}>Couldn&rsquo;t search. Tap to retry.</Text>
          </Pressable>
        ) : (results.data ?? []).length === 0 ? (
          <Text style={styles.muted}>Nothing matches &ldquo;{debounced}&rdquo;.</Text>
        ) : (
          <View style={styles.results}>
            {(results.data ?? []).map((p) => (
              <Pressable
                key={p.id}
                style={styles.result}
                onPress={() => {
                  setPicked(p);
                  setTerm('');
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.resultName} numberOfLines={1}>
                    {p.name}
                  </Text>
                  <Text style={styles.resultMeta} numberOfLines={1}>
                    {[p.brand, p.sku].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Icon name="chevron-right" size={16} color={colors.textFaint} />
              </Pressable>
            ))}
          </View>
        )
      ) : null}

      {picked != null ? (
        stock.isLoading ? (
          <ActivityIndicator color={colors.primary} />
        ) : stock.isError ? (
          <Pressable onPress={() => void stock.refetch()}>
            <Text style={styles.muted}>Couldn&rsquo;t load stock. Tap to retry.</Text>
          </Pressable>
        ) : (
          <View style={styles.table}>
            <View style={[styles.row, styles.headRow]}>
              <Text style={styles.headCell}>Shop</Text>
              <Text style={[styles.headCell, styles.qtyCell]}>Closing stock</Text>
            </View>
            {rows.map((r) => (
              <View key={r.store_id} style={styles.row}>
                <Icon name={r.is_warehouse ? 'package' : 'home'} size={13} color={colors.textFaint} />
                <Text style={styles.store} numberOfLines={1}>
                  {r.store_name}
                </Text>
                <Text
                  style={[
                    styles.qty,
                    styles.qtyCell,
                    // A shelf at or below zero is the number someone is looking
                    // for, so it should not read like every other row.
                    r.quantity <= 0 && { color: colors.danger },
                  ]}
                >
                  {r.quantity}
                </Text>
              </View>
            ))}
            <View style={[styles.row, styles.totalRow]}>
              <Text style={styles.totalLabel}>All shops</Text>
              <Text style={[styles.totalValue, styles.qtyCell]}>
                {stock.data?.total_quantity ?? 0}
              </Text>
            </View>
          </View>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  muted: { fontFamily: font.regular, fontSize: 12, color: colors.textFaint },
  results: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  resultName: { fontFamily: font.semibold, fontSize: 13, color: colors.text },
  resultMeta: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 1 },
  picked: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primarySoft,
    borderRadius: radius.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  pickedName: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  pickedMeta: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 1 },
  table: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    ...shadow.card,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headRow: { backgroundColor: colors.canvas },
  headCell: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 1,
    color: colors.textFaint,
  },
  store: { flex: 1, fontFamily: font.regular, fontSize: 13, color: colors.text },
  qty: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  /** Right-aligned and non-flexing, so every number lines up under the heading. */
  qtyCell: { flex: 0, minWidth: 92, textAlign: 'right' },
  totalRow: { borderBottomWidth: 0, backgroundColor: colors.canvas },
  totalLabel: { flex: 1, fontFamily: font.semibold, fontSize: 13, color: colors.text },
  totalValue: { fontFamily: font.bold, fontSize: 15, color: colors.text },
});
