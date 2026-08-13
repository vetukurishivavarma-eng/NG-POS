import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { stores as storesApi, transfers as transfersApi } from '../../src/api/endpoints';
import { errorMessage } from '../../src/api/client';
import { printTransferNote, shareTransferPdf } from '../../src/printing/print';
import type { TransferNoteData } from '../../src/printing/transferNote';
import { filterCatalogue, useCatalogue } from '../../src/hooks/useCatalogue';
import { useAuth, useCan, roleLevel } from '../../src/store/auth';
import { isWarehouse, placeLabel, warehouseFirst } from '../../src/store/place';
import { useStoreSelection } from '../../src/store/storeSelection';
import { useLayout } from '../../src/ui/responsive';
import { colors, font, radius, shadow, spacing } from '../../src/theme';
import { Badge, Button, EmptyState, Field, Icon, Loading, Select } from '../../src/ui/components';
import type { Store } from '../../src/api/types';

/** One product being moved. `quantity` stays a string so the field can be empty mid-edit. */
interface Line {
  product_id: string;
  name: string;
  sku: string;
  /** Units at the source store when the catalogue was read. */
  available: number;
  quantity: string;
}

const MAX_RESULTS = 25;

export default function NewTransferScreen() {
  const layout = useLayout();
  const queryClient = useQueryClient();
  const user = useAuth((s) => s.user);
  const selectedStore = useStoreSelection((s) => s.selected);
  const canCreate = useCan('transfers.create');

  const [fromStoreId, setFromStoreId] = useState(selectedStore?.id ?? '');
  const [toStoreId, setToStoreId] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const storesQuery = useQuery({ queryKey: ['stores'], queryFn: storesApi.list });
  // Two lists on purpose. `/stores` narrows to the shops this person works at,
  // which is what may be sent *from*; the directory is every shop in the
  // organisation, which is what may be sent *to*. Using the narrow one for both
  // left anyone assigned to a single shop with nowhere to transfer.
  const directoryQuery = useQuery({ queryKey: ['store-directory'], queryFn: storesApi.directory });
  const catalogue = useCatalogue(fromStoreId || null);

  const allStores = useMemo(() => storesQuery.data ?? [], [storesQuery.data]);
  const directory = useMemo(() => directoryQuery.data ?? [], [directoryQuery.data]);

  // The backend runs `assertStoreAccess` on the source, so a manager posting from
  // a store they aren't assigned to gets a 403 after building the whole basket.
  // Offer only the stores that can actually be a source.
  const sourceStores = useMemo(() => {
    if (roleLevel(user) === 'admin') return allStores;
    const assigned = user?.assigned_stores;
    if (!assigned || assigned.length === 0) return allStores;
    return allStores.filter((s) => assigned.includes(s.id));
  }, [allStores, user]);

  /**
   * A shop can only send its own stock, so for anyone who runs one shop the
   * source is not a question — it is where they are standing. Showing them a
   * picker with a single entry invites them to wonder what the other answer
   * was, and leaves the screen unusable until they tap the only option.
   */
  const sourceIsFixed = sourceStores.length === 1;

  // Pinned rather than merely defaulted, so switching shops elsewhere in the
  // app cannot leave this screen pointed at one the user can no longer send
  // from. Set directly rather than through `changeSource`, which asks before
  // discarding a basket — there is nothing to discard on the way in, and a
  // confirmation nobody asked for would be the first thing on screen.
  useEffect(() => {
    if (!sourceIsFixed) return;
    const only = sourceStores[0];
    if (!only || only.id === fromStoreId) return;
    setFromStoreId(only.id);
    setLines([]);
    setSearch('');
    setToStoreId((current) => (current === only.id ? '' : current));
  }, [sourceIsFixed, sourceStores, fromStoreId]);

  const fromStore = allStores.find((s) => s.id === fromStoreId) ?? selectedStore ?? null;
  // From the directory, not `allStores`: the destination is by definition a
  // shop this person may not be assigned to, so it is not in the narrow list.
  const toStore = directory.find((s) => s.id === toStoreId) ?? null;

  const items = catalogue.data?.items ?? [];

  const results = useMemo(() => {
    const needle = search.trim();
    if (!needle) return [];
    return filterCatalogue(items, needle, null).slice(0, MAX_RESULTS);
  }, [items, search]);

  const totalUnits = lines.reduce((sum, l) => sum + (parseQuantity(l.quantity) ?? 0), 0);
  const problems = lines.map((l) => lineProblem(l, fromStore));
  const ready =
    Boolean(fromStoreId) &&
    Boolean(toStoreId) &&
    fromStoreId !== toStoreId &&
    lines.length > 0 &&
    problems.every((p) => p === null);

  function changeSource(next: string) {
    if (next === fromStoreId) return;

    const apply = () => {
      setFromStoreId(next);
      // Availability is per-store, so every line's headroom is now meaningless.
      setLines([]);
      setSearch('');
      if (next === toStoreId) setToStoreId('');
    };

    if (lines.length === 0) {
      apply();
      return;
    }
    Alert.alert(
      'Change source store?',
      'Stock levels are different at each shop, so the items already added will be cleared.',
      [
        { text: 'Keep building', style: 'cancel' },
        { text: 'Change', style: 'destructive', onPress: apply },
      ]
    );
  }

  function addProduct(productId: string) {
    const product = items.find((p) => p.id === productId);
    if (!product) return;
    if (lines.some((l) => l.product_id === productId)) {
      Alert.alert('Already added', `${product.name} is already on this transfer.`);
      return;
    }
    setLines((current) => [
      ...current,
      {
        product_id: product.id,
        name: product.name,
        sku: product.sku,
        available: product.quantity,
        quantity: '1',
      },
    ]);
    setSearch('');
  }

  function setQuantity(productId: string, value: string) {
    // Digits only: a transfer moves whole units, and the numeric keypad on
    // Android still offers a decimal separator.
    const clean = value.replace(/[^0-9]/g, '');
    setLines((current) =>
      current.map((l) => (l.product_id === productId ? { ...l, quantity: clean } : l))
    );
  }

  function step(productId: string, delta: number) {
    setLines((current) =>
      current.map((l) => {
        if (l.product_id !== productId) return l;
        const next = (parseQuantity(l.quantity) ?? 0) + delta;
        return { ...l, quantity: String(Math.max(1, Math.min(l.available, next))) };
      })
    );
  }

  function removeLine(productId: string) {
    setLines((current) => current.filter((l) => l.product_id !== productId));
  }

  async function submit() {
    if (!ready || !fromStore || !toStore) return;
    setBusy(true);
    try {
      const result = await transfersApi.create({
        from_store_id: fromStoreId,
        to_store_id: toStoreId,
        items: lines.map((l) => ({
          product_id: l.product_id,
          quantity: parseQuantity(l.quantity) ?? 0,
        })),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });

      void queryClient.invalidateQueries({ queryKey: ['transfers'] });
      // Stock moved at both ends, so neither store's catalogue is current.
      void queryClient.invalidateQueries({ queryKey: ['catalogue'] });

      // The POST answers with the reference only, so the note is assembled from
      // what this screen already knows. `created_at` is the device clock rather
      // than the server's — a reprint from the history list carries the exact
      // server time, and the two are seconds apart.
      const note: TransferNoteData = {
        reference: result.reference,
        from_store: fromStore.name,
        to_store: toStore.name,
        status: result.status,
        created_at: new Date().toISOString(),
        notes: notes.trim() || undefined,
        issued_by: user?.full_name ?? null,
        items: lines.map((l) => ({
          product_id: l.product_id,
          product_name: l.name,
          sku: l.sku,
          quantity: parseQuantity(l.quantity) ?? 0,
        })),
      };

      router.back();
      Alert.alert(
        'Transfer sent',
        `${result.reference}\n\n${lines.length} product${lines.length === 1 ? '' : 's'} · ${totalUnits} unit${
          totalUnits === 1 ? '' : 's'
        } moved from ${fromStore.name} to ${toStore.name}.`,
        [
          { text: 'Done', style: 'cancel' },
          { text: 'Save as PDF', onPress: () => void shareTransferPdf(note) },
          { text: 'Print', onPress: () => void printTransferNote(note) },
        ]
      );
    } catch (err) {
      Alert.alert('Transfer failed', errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!canCreate) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="lock"
          title="Not permitted"
          hint="Stock transfers can only be created by a store manager or an administrator."
        />
      </SafeAreaView>
    );
  }

  if (storesQuery.isLoading || directoryQuery.isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <Loading label="Loading stores" />
      </SafeAreaView>
    );
  }

  // Counted against the organisation, not against this person's own shops.
  // Someone assigned to one shop has one entry in `allStores` and is still
  // perfectly able to send stock to the other five.
  if (directory.length < 2) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="home"
          title="Nowhere to transfer to"
          hint="A transfer moves stock between two shops, so this organisation needs at least two."
        />
      </SafeAreaView>
    );
  }

  const sourceOptions = warehouseFirst(sourceStores as Store[]).map((s) => ({
    value: s.id,
    label: placeLabel(s),
  }));

  // Warehouse first, and labelled. Stock going out to the shops and stock coming
  // back to the warehouse are the two transfers this business actually makes, so
  // the warehouse is the entry being looked for in both directions — and a list
  // of six bare shop names gives somebody no way to tell which one it is.
  const destinationOptions = warehouseFirst(
    // Same-to-same is rejected by the server; don't let the UI build it.
    directory.filter((s) => s.id !== fromStoreId)
  ).map((s) => ({ value: s.id, label: placeLabel(s) }));

  const catalogueReady = !catalogue.isLoading && !catalogue.isError && items.length > 0;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.gutter,
          paddingBottom: spacing.xxl,
          gap: spacing.lg,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.routeCard}>
          {sourceIsFixed ? (
            <View>
              <Text style={styles.fixedLabel}>Send from</Text>
              <View style={styles.fixedStore}>
                <Icon
                  name={isWarehouse(fromStore) ? 'package' : 'home'}
                  size={16}
                  color={colors.primary}
                />
                <Text style={styles.fixedStoreName} numberOfLines={1}>
                  {fromStore ? placeLabel(fromStore) : (sourceStores[0]?.name ?? 'Your shop')}
                </Text>
                <Icon name="lock" size={13} color={colors.textFaint} />
              </View>
              <Text style={styles.fixedHint}>
                {isWarehouse(fromStore)
                  ? 'Sending out from the warehouse. Any shop in the organisation can receive it.'
                  : 'Stock can only leave the shop you work at.'}
              </Text>
            </View>
          ) : (
            <Select
              label="Send from"
              value={fromStoreId}
              options={sourceOptions}
              onChange={changeSource}
              hint={
                sourceStores.length < allStores.length
                  ? 'Only the stores you are assigned to can send stock.'
                  : undefined
              }
            />
          )}

          <View style={styles.routeArrowRow}>
            <View style={styles.routeArrowLine} />
            <View style={styles.routeArrowBubble}>
              <Icon name="arrow-down" size={15} color={colors.primary} />
            </View>
            <View style={styles.routeArrowLine} />
          </View>

          <Select
            label="Send to"
            value={toStoreId}
            options={destinationOptions}
            onChange={setToStoreId}
            hint={
              toStoreId
                ? undefined
                : isWarehouse(fromStore)
                  ? 'Pick the shop receiving the stock.'
                  : 'Any shop, or the warehouse — stock moves both ways.'
            }
          />
        </View>

        {!fromStoreId ? (
          <EmptyState
            icon="home"
            title="Choose a source store"
            hint="Pick the shop the stock is leaving and its available quantities load here."
          />
        ) : catalogue.isLoading ? (
          <Loading label={`Loading stock at ${fromStore?.name ?? 'the source store'}`} />
        ) : catalogue.isError ? (
          <EmptyState
            icon="cloud-off"
            title="Couldn't load the source stock"
            hint="Available quantities come from the server — building a transfer needs a connection."
            action={
              <Button
                label="Retry"
                icon="refresh-cw"
                variant="secondary"
                onPress={() => void catalogue.refetch()}
              />
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon="package"
            title="Nothing to send"
            hint={`${fromStore?.name ?? 'This store'} has no products stocked, so there is nothing to move.`}
          />
        ) : (
          <>
            {catalogue.data?.fromCache ? (
              <View style={styles.staleNote}>
                <Icon name="wifi-off" size={15} color={colors.warning} />
                <Text style={styles.staleText}>
                  Showing the last synced stock levels. The server checks the real quantities when
                  you send.
                </Text>
              </View>
            ) : null}

            <View style={{ gap: spacing.sm }}>
              <Text style={styles.sectionLabel}>Add products</Text>
              <View style={styles.searchBox}>
                <Icon name="search" size={16} color={colors.textFaint} />
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search by name, SKU or barcode"
                  placeholderTextColor={colors.textFaint}
                  style={styles.searchInput}
                  autoCorrect={false}
                />
                {search.length > 0 ? (
                  <Pressable onPress={() => setSearch('')} hitSlop={8}>
                    <Icon name="x" size={16} color={colors.textFaint} />
                  </Pressable>
                ) : null}
              </View>

              {search.trim().length > 0 ? (
                results.length === 0 ? (
                  <Text style={styles.noResults}>
                    Nothing at {fromStore?.name ?? 'this store'} matches “{search.trim()}”.
                  </Text>
                ) : (
                  <View style={styles.resultCard}>
                    {results.map((product, index) => {
                      const added = lines.some((l) => l.product_id === product.id);
                      const out = product.quantity <= 0;
                      return (
                        <Pressable
                          key={product.id}
                          onPress={() => addProduct(product.id)}
                          disabled={out || added}
                          style={({ pressed }) => [
                            styles.result,
                            index > 0 && styles.resultDivider,
                            pressed && !out && !added && { backgroundColor: colors.surfaceSunken },
                            (out || added) && { opacity: 0.45 },
                          ]}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.resultName} numberOfLines={1}>
                              {product.name}
                            </Text>
                            <Text style={styles.resultSku} numberOfLines={1}>
                              {product.sku}
                            </Text>
                          </View>
                          <View style={{ alignItems: 'flex-end', gap: 3 }}>
                            <Text style={[styles.resultQty, out && { color: colors.danger }]}>
                              {product.quantity}
                            </Text>
                            <Text style={styles.resultQtyLabel}>available</Text>
                          </View>
                          <Icon
                            name={added ? 'check' : 'plus-circle'}
                            size={20}
                            color={added ? colors.success : colors.primary}
                          />
                        </Pressable>
                      );
                    })}
                  </View>
                )
              ) : null}
            </View>

            <View style={{ gap: spacing.sm }}>
              <View style={styles.basketHead}>
                <Text style={styles.sectionLabel}>Items to move</Text>
                {lines.length > 0 ? (
                  <Badge
                    label={`${lines.length} line${lines.length === 1 ? '' : 's'} · ${totalUnits} unit${
                      totalUnits === 1 ? '' : 's'
                    }`}
                    tone="accent"
                  />
                ) : null}
              </View>

              {lines.length === 0 ? (
                <View style={styles.basketEmpty}>
                  <Icon name="package" size={18} color={colors.textFaint} />
                  <Text style={styles.basketEmptyText}>
                    Search above and tap a product to put it on this transfer.
                  </Text>
                </View>
              ) : (
                lines.map((line, index) => {
                  const problem = problems[index];
                  return (
                    <View key={line.product_id} style={[styles.line, problem && styles.lineBad]}>
                      <View style={styles.lineTop}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.lineName} numberOfLines={2}>
                            {line.name}
                          </Text>
                          <Text style={styles.lineSku} numberOfLines={1}>
                            {line.sku} · {line.available} available
                          </Text>
                        </View>
                        <Pressable onPress={() => removeLine(line.product_id)} hitSlop={10}>
                          <Icon name="x" size={18} color={colors.textFaint} />
                        </Pressable>
                      </View>

                      <View style={styles.lineBottom}>
                        <View style={styles.stepper}>
                          <Pressable
                            style={styles.stepBtn}
                            onPress={() => step(line.product_id, -1)}
                            hitSlop={6}
                          >
                            <Icon name="minus" size={15} color={colors.text} />
                          </Pressable>
                          <TextInput
                            value={line.quantity}
                            onChangeText={(v) => setQuantity(line.product_id, v)}
                            keyboardType="number-pad"
                            selectTextOnFocus
                            style={styles.qtyInput}
                          />
                          <Pressable
                            style={styles.stepBtn}
                            onPress={() => step(line.product_id, 1)}
                            hitSlop={6}
                          >
                            <Icon name="plus" size={15} color={colors.text} />
                          </Pressable>
                        </View>

                        <Pressable
                          onPress={() => setQuantity(line.product_id, String(line.available))}
                          hitSlop={6}
                        >
                          <Text style={styles.sendAll}>Send all {line.available}</Text>
                        </Pressable>
                      </View>

                      {problem ? <Text style={styles.lineError}>{problem}</Text> : null}
                    </View>
                  );
                })
              )}
            </View>

            <Field
              label="Notes (optional)"
              value={notes}
              onChangeText={setNotes}
              placeholder="Restocking the branch after the weekend…"
              multiline
            />
          </>
        )}

        {catalogueReady ? (
          <View style={{ gap: spacing.sm }}>
            <View style={styles.atomicNote}>
              <Icon name="shield" size={15} color={colors.primary} />
              <Text style={styles.atomicText}>
                {lines.length > 1
                  ? `All ${lines.length} lines move in one server transaction — either the whole transfer goes through, or nothing does.`
                  : 'Both sides of every line move in one server transaction — either the whole transfer goes through, or nothing does.'}
              </Text>
            </View>

            <Button
              label={busy ? 'Sending' : 'Send Transfer'}
              icon="send"
              size="lg"
              loading={busy}
              disabled={!ready}
              onPress={() => void submit()}
            />
            <Button label="Cancel" variant="ghost" onPress={() => router.back()} />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function parseQuantity(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * The server rejects the entire transfer if any single line is short, so every
 * line is checked here and named with the shortfall — discovering it after a
 * twenty-line basket has been built is the failure mode worth designing against.
 */
function lineProblem(line: Line, fromStore: Store | null): string | null {
  const quantity = parseQuantity(line.quantity);
  if (quantity === null || quantity <= 0) return 'Enter how many units to move.';
  if (quantity > line.available) {
    return `Only ${line.available} in stock at ${fromStore?.name ?? 'the source store'}.`;
  }
  return null;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  sectionLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },

  fixedLabel: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: spacing.xs,
  },
  fixedStore: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 11,
  },
  fixedStoreName: { flex: 1, fontFamily: font.bold, fontSize: 15, color: colors.primary },
  fixedHint: {
    fontFamily: font.regular,
    fontSize: 11,
    color: colors.textFaint,
    marginTop: spacing.xs,
  },

  routeCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadow.card,
  },
  routeArrowRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  routeArrowLine: { flex: 1, height: 1, backgroundColor: colors.border },
  routeArrowBubble: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },

  staleNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  staleText: { flex: 1, fontFamily: font.medium, fontSize: 12, color: colors.warning, lineHeight: 17 },

  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 48,
  },
  searchInput: { flex: 1, fontFamily: font.medium, fontSize: 15, color: colors.text, padding: 0 },
  noResults: { fontFamily: font.regular, fontSize: 13, color: colors.textMuted, paddingHorizontal: 2 },

  resultCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  resultDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  resultName: { fontFamily: font.semibold, fontSize: 14, color: colors.text },
  resultSku: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 2 },
  resultQty: { fontFamily: font.bold, fontSize: 16, color: colors.text },
  resultQtyLabel: {
    fontFamily: font.regular,
    fontSize: 9,
    color: colors.textFaint,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },

  basketHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  basketEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  basketEmptyText: { flex: 1, fontFamily: font.regular, fontSize: 13, color: colors.textMuted, lineHeight: 18 },

  line: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  lineBad: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  lineTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  lineName: { flex: 1, fontFamily: font.semibold, fontSize: 14, color: colors.text, lineHeight: 19 },
  lineSku: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 2 },
  lineBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  lineError: { fontFamily: font.semibold, fontSize: 12, color: colors.danger },

  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.pill,
    padding: 3,
    gap: 2,
  },
  stepBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyInput: {
    minWidth: 54,
    height: 34,
    textAlign: 'center',
    fontFamily: font.bold,
    fontSize: 16,
    color: colors.text,
    padding: 0,
  },
  sendAll: { fontFamily: font.semibold, fontSize: 12, color: colors.primary },

  atomicNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  atomicText: { flex: 1, fontFamily: font.medium, fontSize: 12, color: colors.primaryDeep, lineHeight: 17 },
});
