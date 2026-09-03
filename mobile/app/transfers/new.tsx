import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  inventory as inventoryApi,
  purchases as purchasesApi,
  stores as storesApi,
  transfers as transfersApi,
} from '../../src/api/endpoints';
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
import type { Store, SupplierInvoice, Transfer } from '../../src/api/types';

/** One product being moved. `quantity` stays a string so the field can be empty mid-edit. */
interface Line {
  product_id: string;
  name: string;
  sku: string;
  /** Units at the source store. Meaningless until a source is chosen — updated then. */
  available: number;
  quantity: string;
}

interface SeedEntry {
  product_id: string | null;
  name: string;
  quantity: number;
}

/** A "load these into the basket" request from a document (invoice / transfer). */
interface PendingSeed {
  from_store_id: string;
  to_store_id?: string;
  entries: SeedEntry[];
  label: string;
  note?: string;
  /** Set for a "pass on" seed — the transfer this stock arrived on. */
  source_transfer_id?: string;
}

const MAX_RESULTS = 25;

export default function NewTransferScreen() {
  const layout = useLayout();
  const queryClient = useQueryClient();
  const user = useAuth((s) => s.user);
  const selectedStore = useStoreSelection((s) => s.selected);
  const canCreate = useCan('transfers.create');
  // The chain-wide stock breakdown under each line is for an administrator
  // deciding what to move; a shop login only ever sees its own shelf.
  const isAdmin = roleLevel(user) === 'admin';

  // The route is chosen *after* the basket now, so it starts empty for anyone
  // who has a choice to make.
  const [fromStoreId, setFromStoreId] = useState('');
  const [toStoreId, setToStoreId] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [loader, setLoader] = useState<null | 'invoice' | 'order' | 'passon'>(null);
  const [originLabel, setOriginLabel] = useState<string | null>(null);
  const [seedNote, setSeedNote] = useState<string | null>(null);
  const [seedTick, setSeedTick] = useState(0);
  // The transfer this stock arrived on, when the basket was built by "passing
  // on" a received transfer. Sent with the new transfer so the note shows the
  // chain.
  const [sourceTransferId, setSourceTransferId] = useState<string | null>(null);

  // Opened against a source document — a recorded delivery (`?invoice=`), an
  // earlier transfer to repeat (`?repeat=`), or one to pass on (`?passon=`).
  const params = useLocalSearchParams<{ invoice?: string; repeat?: string; passon?: string }>();
  const invoiceId = typeof params.invoice === 'string' ? params.invoice : undefined;
  const repeatId = typeof params.repeat === 'string' ? params.repeat : undefined;
  const passOnId = typeof params.passon === 'string' ? params.passon : undefined;
  const deepLinkSeededRef = useRef(false);
  const pendingSeedRef = useRef<PendingSeed | null>(null);

  const originInvoiceQuery = useQuery({
    queryKey: ['purchase', invoiceId],
    queryFn: () => purchasesApi.get(invoiceId as string),
    enabled: Boolean(invoiceId),
  });
  const transfersListQuery = useQuery({
    queryKey: ['transfers'],
    queryFn: () => transfersApi.list(),
    enabled:
      Boolean(repeatId) || Boolean(passOnId) || loader === 'order' || loader === 'passon',
  });

  const storesQuery = useQuery({ queryKey: ['stores'], queryFn: storesApi.list });
  // Two lists on purpose. `/stores` narrows to the shops this person works at,
  // which is what may be sent *from*; the directory is every shop in the
  // organisation, which is what may be sent *to*.
  const directoryQuery = useQuery({ queryKey: ['store-directory'], queryFn: storesApi.directory });

  const allStores = useMemo(() => storesQuery.data ?? [], [storesQuery.data]);
  const directory = useMemo(() => directoryQuery.data ?? [], [directoryQuery.data]);

  // The backend runs `assertStoreAccess` on the source, so offer only the stores
  // that can actually be a source.
  const sourceStores = useMemo(() => {
    if (roleLevel(user) === 'admin') return allStores;
    const assigned = user?.assigned_stores;
    if (!assigned || assigned.length === 0) return allStores;
    return allStores.filter((s) => assigned.includes(s.id));
  }, [allStores, user]);
  const sourceIsFixed = sourceStores.length === 1;

  // Browse the source store's catalogue once it's chosen; before that, the store
  // the user is standing in, just so there is a product list to pick from.
  const browseStoreId = fromStoreId || selectedStore?.id || null;
  const catalogue = useCatalogue(browseStoreId);
  const items = useMemo(() => catalogue.data?.items ?? [], [catalogue.data]);

  const fromStore = allStores.find((s) => s.id === fromStoreId) ?? null;
  const toStore = directory.find((s) => s.id === toStoreId) ?? null;

  // Recent deliveries, for the "From an invoice" loader. Scoped to the source
  // store once picked, otherwise the store the user is standing in.
  const invoiceListStoreId = fromStoreId || selectedStore?.id || undefined;
  const invoicesQuery = useQuery({
    queryKey: ['transfer-source-invoices', invoiceListStoreId ?? 'any'],
    queryFn: () =>
      purchasesApi.list({ ...(invoiceListStoreId ? { store_id: invoiceListStoreId } : {}), limit: 30 }),
    enabled: loader === 'invoice',
  });

  const results = useMemo(() => {
    const needle = search.trim();
    if (!needle) return [];
    return filterCatalogue(items, needle, null).slice(0, MAX_RESULTS);
  }, [items, search]);

  // "Pass on" offers transfers that *landed here* — their destination is the
  // shop we would be sending from — so the stock they brought in can be moved
  // onward.
  const passOnCandidates = useMemo(() => {
    const here = fromStoreId || selectedStore?.id;
    if (!here) return [];
    return (transfersListQuery.data ?? []).filter((t) => t.to_store_id === here).slice(0, 30);
  }, [transfersListQuery.data, fromStoreId, selectedStore?.id]);

  const checkStock = Boolean(fromStoreId);
  const totalUnits = lines.reduce((sum, l) => sum + (parseQuantity(l.quantity) ?? 0), 0);
  const problems = lines.map((l) => lineProblem(l, fromStore, checkStock));
  const ready =
    Boolean(fromStoreId) &&
    Boolean(toStoreId) &&
    fromStoreId !== toStoreId &&
    lines.length > 0 &&
    problems.every((p) => p === null);

  /* --------------------------------------------------------- source pinning */

  // A single-shop user has no source to choose — pin it. No line clearing: the
  // whole point of this screen's order is that the basket outlives the route.
  useEffect(() => {
    if (!sourceIsFixed) return;
    const only = sourceStores[0];
    if (!only || only.id === fromStoreId) return;
    setFromStoreId(only.id);
    setToStoreId((current) => (current === only.id ? '' : current));
  }, [sourceIsFixed, sourceStores, fromStoreId]);

  // Re-read every line's headroom from the chosen source store's stock. Lines
  // added while browsing another store's list, or loaded from a document,
  // carry the wrong "available" until this runs.
  useEffect(() => {
    if (!fromStoreId || browseStoreId !== fromStoreId) return;
    const data = catalogue.data;
    if (!data) return;
    const byId = new Map(data.items.map((p) => [p.id, p.quantity]));
    setLines((current) => {
      let changed = false;
      const next = current.map((l) => {
        const avail = byId.get(l.product_id) ?? 0;
        if (avail === l.available) return l;
        changed = true;
        return { ...l, available: avail };
      });
      return changed ? next : current;
    });
  }, [fromStoreId, browseStoreId, catalogue.data]);

  /* ------------------------------------------------------- document seeding */

  // A deep link (?invoice= / ?repeat=) becomes a seed request once its source
  // document has loaded. Runs once.
  useEffect(() => {
    if (deepLinkSeededRef.current) return;
    if (invoiceId) {
      const inv = originInvoiceQuery.data;
      if (!inv) return;
      deepLinkSeededRef.current = true;
      requestSeed({
        from_store_id: inv.store_id,
        entries: inv.items.map((it) => ({
          product_id: it.product_id,
          name: it.product_name,
          quantity: it.quantity,
        })),
        label: `Delivery ${inv.invoice_number} · ${inv.supplier_name}`,
        note: 'Quantities are what the invoice says arrived — check them against the shelf.',
      });
    } else if (repeatId) {
      const t = (transfersListQuery.data ?? []).find((x) => x.id === repeatId);
      if (!t) return;
      deepLinkSeededRef.current = true;
      requestSeed({
        from_store_id: t.from_store_id,
        to_store_id: t.to_store_id,
        entries: t.items.map((it) => ({
          product_id: it.product_id,
          name: it.product_name,
          quantity: it.quantity,
        })),
        label: `Transfer ${t.reference}`,
        note: 'Quantities are from that transfer — check them against the shelf.',
      });
    } else if (passOnId) {
      const t = (transfersListQuery.data ?? []).find((x) => x.id === passOnId);
      if (!t) return;
      deepLinkSeededRef.current = true;
      requestSeed(passOnSeed(t));
    }
  }, [invoiceId, repeatId, passOnId, originInvoiceQuery.data, transfersListQuery.data]);

  // Process a pending seed: point the source store at where the goods are, wait
  // for its catalogue, then add the lines.
  useEffect(() => {
    const seed = pendingSeedRef.current;
    if (!seed) return;

    if (fromStoreId !== seed.from_store_id) {
      const allowed =
        roleLevel(user) === 'admin' || sourceStores.some((s) => s.id === seed.from_store_id);
      if (!allowed) {
        pendingSeedRef.current = null;
        setOriginLabel(seed.label);
        setSourceTransferId(null);
        setSeedNote('That stock is at a shop you cannot send from, so nothing was loaded.');
        return;
      }
      setFromStoreId(seed.from_store_id);
      if (seed.to_store_id && seed.to_store_id !== seed.from_store_id) {
        setToStoreId(seed.to_store_id);
      }
      return; // wait for that store's catalogue, then this effect re-runs
    }

    if (browseStoreId !== fromStoreId || !catalogue.data) return;

    pendingSeedRef.current = null;
    setOriginLabel(seed.label);
    setSourceTransferId(seed.source_transfer_id ?? null);
    const r = addLinesFromSource(seed.entries);

    const parts: string[] = [];
    if (r.added === 0) parts.push('None of those products are stocked at the source.');
    if (r.notStocked.length > 0) parts.push(`Skipped (not stocked there): ${r.notStocked.join(', ')}.`);
    if (r.alreadyOn > 0) parts.push(`${r.alreadyOn} were already on the transfer.`);
    if (r.added > 0 && seed.note) parts.push(seed.note);
    setSeedNote(parts.join(' ') || null);
  }, [seedTick, fromStoreId, browseStoreId, catalogue.data, sourceStores, user]);

  function requestSeed(seed: PendingSeed) {
    pendingSeedRef.current = seed;
    setSeedTick((t) => t + 1);
  }

  /* ---------------------------------------------------------------- actions */

  function changeSource(next: string) {
    if (next === fromStoreId) return;
    setFromStoreId(next);
    if (next === toStoreId) setToStoreId('');
    setLoader(null);
    // The basket stays, but it was not built from this store's stock or this
    // document, so drop the "loaded from" story.
    setOriginLabel(null);
    setSeedNote(null);
    setSourceTransferId(null);
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

  /**
   * Core of "load from a document": turns a list of (product, quantity) rows
   * into transfer lines, keeping only what the source store stocks and skipping
   * anything already on the transfer.
   */
  function addLinesFromSource(
    entries: SeedEntry[]
  ): { added: number; alreadyOn: number; notStocked: string[] } {
    const catalogueById = new Map(items.map((p) => [p.id, p]));
    const onTransfer = new Set(lines.map((l) => l.product_id));
    const toAdd: Line[] = [];
    const notStocked: string[] = [];
    let alreadyOn = 0;

    for (const entry of entries) {
      if (!entry.product_id || entry.quantity <= 0) continue;
      const product = catalogueById.get(entry.product_id);
      if (!product) {
        notStocked.push(entry.name);
        continue;
      }
      if (onTransfer.has(entry.product_id) || toAdd.some((l) => l.product_id === entry.product_id)) {
        alreadyOn += 1;
        continue;
      }
      toAdd.push({
        product_id: product.id,
        name: product.name,
        sku: product.sku,
        available: product.quantity,
        quantity: String(Math.max(1, Math.round(entry.quantity))),
      });
    }

    if (toAdd.length > 0) setLines((current) => [...current, ...toAdd]);
    return { added: toAdd.length, alreadyOn, notStocked };
  }

  function pickInvoice(invoice: SupplierInvoice) {
    setLoader(null);
    setSearch('');
    requestSeed({
      from_store_id: invoice.store_id,
      entries: invoice.items.map((it) => ({
        product_id: it.product_id,
        name: it.product_name,
        quantity: it.quantity,
      })),
      label: `Delivery ${invoice.invoice_number} · ${invoice.supplier_name}`,
      note: 'Quantities are what the invoice says arrived — check them against the shelf.',
    });
  }

  function pickOrder(transfer: Transfer) {
    setLoader(null);
    setSearch('');
    requestSeed({
      from_store_id: transfer.from_store_id,
      to_store_id: transfer.to_store_id,
      entries: transfer.items.map((it) => ({
        product_id: it.product_id,
        name: it.product_name,
        quantity: it.quantity,
      })),
      label: `Transfer ${transfer.reference}`,
      note: 'Quantities are from that transfer — check them against the shelf.',
    });
  }

  function pickPassOn(transfer: Transfer) {
    setLoader(null);
    setSearch('');
    requestSeed(passOnSeed(transfer));
  }

  function setQuantity(productId: string, value: string) {
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
        // Only clamp to the shelf once we know which shelf.
        const capped = checkStock ? Math.min(l.available, next) : next;
        return { ...l, quantity: String(Math.max(1, capped)) };
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
        ...(sourceTransferId ? { source_transfer_id: sourceTransferId } : {}),
      });

      void queryClient.invalidateQueries({ queryKey: ['transfers'] });
      void queryClient.invalidateQueries({ queryKey: ['catalogue'] });

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

  /* ----------------------------------------------------------------- guards */

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

  const sourceOptions = warehouseFirst(sourceStores as Store[])
    .filter((s) => s.id !== toStoreId)
    .map((s) => ({ value: s.id, label: placeLabel(s) }));

  const destinationOptions = warehouseFirst(directory.filter((s) => s.id !== fromStoreId)).map(
    (s) => ({ value: s.id, label: placeLabel(s) })
  );

  const catalogueLoading = catalogue.isLoading && items.length === 0;
  const catalogueError = catalogue.isError && items.length === 0;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: layout.gutter, paddingBottom: spacing.xxl, gap: spacing.lg }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {originLabel ? (
          <View style={styles.originCard}>
            <Icon name="corner-up-right" size={16} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.originLabel}>Loaded from</Text>
              <Text style={styles.originValue} numberOfLines={2}>
                {originLabel}
              </Text>
              {seedNote ? <Text style={styles.originNote}>{seedNote}</Text> : null}
            </View>
          </View>
        ) : null}

        {/* ========================================= 1 · WHAT TO MOVE ===== */}
        <View style={{ gap: spacing.sm }}>
          <View style={styles.addHead}>
            <Text style={styles.sectionLabel}>1 · What to move</Text>
            <View style={styles.loaderBtns}>
              <Pressable
                onPress={() => setLoader((v) => (v === 'invoice' ? null : 'invoice'))}
                hitSlop={6}
                style={styles.loaderBtn}
              >
                <Icon
                  name={loader === 'invoice' ? 'x' : 'file-text'}
                  size={13}
                  color={colors.primary}
                />
                <Text style={styles.loaderBtnText}>
                  {loader === 'invoice' ? 'Close' : 'From an invoice'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setLoader((v) => (v === 'order' ? null : 'order'))}
                hitSlop={6}
                style={styles.loaderBtn}
              >
                <Icon name={loader === 'order' ? 'x' : 'repeat'} size={13} color={colors.primary} />
                <Text style={styles.loaderBtnText}>
                  {loader === 'order' ? 'Close' : 'From an order'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setLoader((v) => (v === 'passon' ? null : 'passon'))}
                hitSlop={6}
                style={styles.loaderBtn}
              >
                <Icon
                  name={loader === 'passon' ? 'x' : 'corner-up-right'}
                  size={13}
                  color={colors.primary}
                />
                <Text style={styles.loaderBtnText}>
                  {loader === 'passon' ? 'Close' : 'Pass on'}
                </Text>
              </Pressable>
            </View>
          </View>

          {loader === 'invoice' ? (
            <View style={styles.docPanel}>
              {invoicesQuery.isLoading ? (
                <Loading label="Loading recent deliveries" />
              ) : invoicesQuery.isError ? (
                <Pressable onPress={() => void invoicesQuery.refetch()}>
                  <Text style={styles.noResults}>Couldn’t load invoices. Tap to retry.</Text>
                </Pressable>
              ) : (invoicesQuery.data ?? []).length === 0 ? (
                <Text style={styles.noResults}>No deliveries have been recorded yet.</Text>
              ) : (
                (invoicesQuery.data ?? []).map((invoice, index) => (
                  <Pressable
                    key={invoice.id}
                    onPress={() => pickInvoice(invoice)}
                    style={({ pressed }) => [
                      styles.docRow,
                      index > 0 && styles.resultDivider,
                      pressed && { backgroundColor: colors.surfaceSunken },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.resultName} numberOfLines={1}>
                        {invoice.invoice_number} · {invoice.supplier_name}
                      </Text>
                      <Text style={styles.resultSku} numberOfLines={1}>
                        {invoice.store_name} ·{' '}
                        {new Date(invoice.invoice_date).toLocaleDateString()} ·{' '}
                        {invoice.items.length} product{invoice.items.length === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <Icon name="download" size={18} color={colors.primary} />
                  </Pressable>
                ))
              )}
            </View>
          ) : null}

          {loader === 'order' ? (
            <View style={styles.docPanel}>
              {transfersListQuery.isLoading ? (
                <Loading label="Loading transfers" />
              ) : transfersListQuery.isError ? (
                <Pressable onPress={() => void transfersListQuery.refetch()}>
                  <Text style={styles.noResults}>Couldn’t load transfers. Tap to retry.</Text>
                </Pressable>
              ) : (transfersListQuery.data ?? []).length === 0 ? (
                <Text style={styles.noResults}>No transfers have been made yet.</Text>
              ) : (
                (transfersListQuery.data ?? []).slice(0, 30).map((transfer, index) => {
                  const units = transfer.items.reduce((sum, i) => sum + i.quantity, 0);
                  return (
                    <Pressable
                      key={transfer.id}
                      onPress={() => pickOrder(transfer)}
                      style={({ pressed }) => [
                        styles.docRow,
                        index > 0 && styles.resultDivider,
                        pressed && { backgroundColor: colors.surfaceSunken },
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.resultName} numberOfLines={1}>
                          {transfer.reference}
                        </Text>
                        <Text style={styles.resultSku} numberOfLines={1}>
                          {(transfer.from_store ?? '—')} → {(transfer.to_store ?? '—')} ·{' '}
                          {transfer.items.length} product{transfer.items.length === 1 ? '' : 's'} ·{' '}
                          {units} unit{units === 1 ? '' : 's'}
                        </Text>
                      </View>
                      <Icon name="download" size={18} color={colors.primary} />
                    </Pressable>
                  );
                })
              )}
            </View>
          ) : null}

          {loader === 'passon' ? (
            <View style={styles.docPanel}>
              {transfersListQuery.isLoading ? (
                <Loading label="Loading transfers" />
              ) : transfersListQuery.isError ? (
                <Pressable onPress={() => void transfersListQuery.refetch()}>
                  <Text style={styles.noResults}>Couldn’t load transfers. Tap to retry.</Text>
                </Pressable>
              ) : passOnCandidates.length === 0 ? (
                <Text style={styles.noResults}>
                  No transfers have arrived at{' '}
                  {(fromStore ?? selectedStore)?.name ?? 'this shop'} to pass on.
                </Text>
              ) : (
                passOnCandidates.map((transfer, index) => {
                  const units = transfer.items.reduce((sum, i) => sum + i.quantity, 0);
                  return (
                    <Pressable
                      key={transfer.id}
                      onPress={() => pickPassOn(transfer)}
                      style={({ pressed }) => [
                        styles.docRow,
                        index > 0 && styles.resultDivider,
                        pressed && { backgroundColor: colors.surfaceSunken },
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.resultName} numberOfLines={1}>
                          {transfer.reference}
                        </Text>
                        <Text style={styles.resultSku} numberOfLines={1}>
                          from {transfer.from_store ?? '—'} ·{' '}
                          {transfer.items.length} product{transfer.items.length === 1 ? '' : 's'} ·{' '}
                          {units} unit{units === 1 ? '' : 's'}
                        </Text>
                      </View>
                      <Icon name="corner-up-right" size={18} color={colors.primary} />
                    </Pressable>
                  );
                })
              )}
            </View>
          ) : null}

          {!browseStoreId ? (
            <Text style={styles.noResults}>
              Pick your shop from the Sell tab first, so there is a product list here.
            </Text>
          ) : (
            <>
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

              {catalogueLoading ? (
                <Text style={styles.noResults}>Loading products…</Text>
              ) : catalogueError ? (
                <Pressable onPress={() => void catalogue.refetch()}>
                  <Text style={styles.noResults}>Couldn’t load products. Tap to retry.</Text>
                </Pressable>
              ) : items.length === 0 ? (
                <Text style={styles.noResults}>
                  {(fromStore ?? selectedStore)?.name ?? 'This store'} has no products stocked.
                </Text>
              ) : search.trim().length > 0 ? (
                results.length === 0 ? (
                  <Text style={styles.noResults}>Nothing matches “{search.trim()}”.</Text>
                ) : (
                  <View style={styles.resultCard}>
                    {results.map((product, index) => {
                      const added = lines.some((l) => l.product_id === product.id);
                      return (
                        <Pressable
                          key={product.id}
                          onPress={() => addProduct(product.id)}
                          disabled={added}
                          style={({ pressed }) => [
                            styles.result,
                            index > 0 && styles.resultDivider,
                            pressed && !added && { backgroundColor: colors.surfaceSunken },
                            added && { opacity: 0.45 },
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
                            <Text style={styles.resultQty}>{product.quantity}</Text>
                            <Text style={styles.resultQtyLabel}>
                              {fromStoreId ? 'available' : 'in this list'}
                            </Text>
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

              {catalogue.data?.fromCache ? (
                <View style={styles.staleNote}>
                  <Icon name="wifi-off" size={15} color={colors.warning} />
                  <Text style={styles.staleText}>
                    Showing the last synced stock levels. The server checks the real quantities when
                    you send.
                  </Text>
                </View>
              ) : null}
            </>
          )}
        </View>

        {/* ---- basket ---- */}
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
                Search above and tap a product, or load a whole list from an invoice or an order.
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
                        {line.sku}
                        {checkStock ? ` · ${line.available} available` : ''}
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

                    {checkStock ? (
                      <Pressable
                        onPress={() => setQuantity(line.product_id, String(line.available))}
                        hitSlop={6}
                      >
                        <Text style={styles.sendAll}>Send all {line.available}</Text>
                      </Pressable>
                    ) : null}
                  </View>

                  {problem ? <Text style={styles.lineError}>{problem}</Text> : null}

                  {isAdmin ? (
                    <StockAcrossShops productId={line.product_id} sourceStoreId={fromStoreId} />
                  ) : null}
                </View>
              );
            })
          )}
        </View>

        {/* ========================================= 2 · FROM AND TO ===== */}
        <View style={{ gap: spacing.sm }}>
          <Text style={styles.sectionLabel}>2 · From and to</Text>
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
                  fromStoreId
                    ? undefined
                    : 'Where the stock is leaving from — each line is checked against its stock.'
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
        </View>

        <Field
          label="Notes (optional)"
          value={notes}
          onChangeText={setNotes}
          placeholder="Restocking the branch after the weekend…"
          multiline
        />

        <View style={{ gap: spacing.sm }}>
          {lines.length > 0 ? (
            <View style={styles.atomicNote}>
              <Icon name="shield" size={15} color={colors.primary} />
              <Text style={styles.atomicText}>
                {lines.length > 1
                  ? `All ${lines.length} lines move in one server transaction — either the whole transfer goes through, or nothing does.`
                  : 'Both sides of every line move in one server transaction — either the whole transfer goes through, or nothing does.'}
              </Text>
            </View>
          ) : null}

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
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * The same product's stock at every shop, with the chain-wide total, shown
 * under a basket line so an administrator can see where it actually sits
 * before deciding how much to move. Admin-only — the endpoint 403s otherwise.
 */
function StockAcrossShops({
  productId,
  sourceStoreId,
}: {
  productId: string;
  sourceStoreId: string;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['stock-by-product', productId],
    queryFn: () => inventoryApi.byProduct(productId),
    enabled: open,
    staleTime: 30_000,
  });

  const rows = query.data?.stores ?? [];

  return (
    <View style={styles.spread}>
      <Pressable style={styles.spreadHead} onPress={() => setOpen((v) => !v)} hitSlop={6}>
        <Icon name="bar-chart-2" size={14} color={colors.primary} />
        <Text style={styles.spreadHeadText}>
          {query.data
            ? `${query.data.total_quantity} in stock across all shops`
            : 'Stock across all shops'}
        </Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textFaint} />
      </Pressable>

      {open ? (
        query.isLoading ? (
          <Text style={styles.spreadMuted}>Loading…</Text>
        ) : query.isError ? (
          <Pressable onPress={() => void query.refetch()}>
            <Text style={styles.spreadMuted}>Couldn't load. Tap to retry.</Text>
          </Pressable>
        ) : (
          <View style={{ gap: 2 }}>
            {rows.map((r) => {
              const isSource = r.store_id === sourceStoreId;
              return (
                <View key={r.store_id} style={styles.spreadRow}>
                  <Icon
                    name={r.is_warehouse ? 'package' : 'home'}
                    size={12}
                    color={colors.textFaint}
                  />
                  <Text
                    style={[styles.spreadStore, isSource && styles.spreadStoreSource]}
                    numberOfLines={1}
                  >
                    {r.store_name}
                    {isSource ? ' · sending from' : ''}
                  </Text>
                  <Text
                    style={[
                      styles.spreadQty,
                      r.quantity <= 0 && { color: colors.danger },
                      isSource && styles.spreadStoreSource,
                    ]}
                  >
                    {r.quantity}
                  </Text>
                </View>
              );
            })}
          </View>
        )
      ) : null}
    </View>
  );
}

/**
 * "Pass on" a received transfer: the stock is now at that transfer's
 * destination, so *that* becomes the source. The onward shop is left blank for
 * the user to choose, and the quantities come across as received — the user
 * lowers each line to what is actually being sent on.
 */
function passOnSeed(transfer: Transfer): PendingSeed {
  return {
    from_store_id: transfer.to_store_id,
    entries: transfer.items.map((it) => ({
      product_id: it.product_id,
      name: it.product_name,
      quantity: it.quantity,
    })),
    label: `Pass on from ${transfer.reference}`,
    note: 'Quantities are what arrived on that transfer — lower each line to what you are sending on.',
    source_transfer_id: transfer.id,
  };
}

function parseQuantity(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * The server rejects the entire transfer if any single line is short, so every
 * line is checked here and named with the shortfall. Availability is only
 * checked once a source store is chosen — before that a quantity is just a
 * quantity.
 */
function lineProblem(line: Line, fromStore: Store | null, checkStock: boolean): string | null {
  const quantity = parseQuantity(line.quantity);
  if (quantity === null || quantity <= 0) return 'Enter how many units to move.';
  if (checkStock && quantity > line.available) {
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

  originCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.primarySoft,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  originLabel: {
    fontFamily: font.semibold,
    fontSize: 10,
    color: colors.primary,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  originValue: { fontFamily: font.bold, fontSize: 14, color: colors.text, marginTop: 2 },
  originNote: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 4, lineHeight: 15 },

  addHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  loaderBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  loaderBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  loaderBtnText: { fontFamily: font.semibold, fontSize: 12, color: colors.primary },

  docPanel: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },

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

  spread: {
    marginTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  spreadHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  spreadHeadText: { flex: 1, fontFamily: font.semibold, fontSize: 12, color: colors.primary },
  spreadMuted: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted, paddingVertical: 2 },
  spreadRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: 2 },
  spreadStore: { flex: 1, fontFamily: font.regular, fontSize: 12, color: colors.textMuted },
  spreadStoreSource: { fontFamily: font.bold, color: colors.text },
  spreadQty: { fontFamily: font.bold, fontSize: 13, color: colors.text, minWidth: 32, textAlign: 'right' },
});
