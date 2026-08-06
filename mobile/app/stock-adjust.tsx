import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

import { inventory as inventoryApi } from '../src/api/endpoints';
import { errorMessage } from '../src/api/client';
import { useCan } from '../src/store/auth';
import { useStoreSelection } from '../src/store/storeSelection';
import { filterCatalogue, useCatalogue } from '../src/hooks/useCatalogue';
import { useLayout } from '../src/ui/responsive';
import { colors, font, formatKwacha, radius, shadow, spacing } from '../src/theme';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  Loading,
  SectionLabel,
  Select,
} from '../src/ui/components';
import type { ProductWithStock } from '../src/api/types';

/** The two movement types a person is allowed to post; transfers are their own screen. */
type Kind = 'purchase' | 'adjustment';

/** How a correction is being typed in. See `deltaFor` — this is the whole safety story. */
type EntryMode = 'counted' | 'delta';

export default function StockAdjustScreen() {
  const store = useStoreSelection((s) => s.selected);
  const canAdjust = useCan('stock.adjust');
  const layout = useLayout();
  const queryClient = useQueryClient();
  const storeId = store?.id ?? null;

  const catalogue = useCatalogue(storeId);

  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<ProductWithStock | null>(null);
  const [kind, setKind] = useState<Kind>('purchase');
  const [mode, setMode] = useState<EntryMode>('counted');
  // "Adjust by" is reached for when something left the shelf without being sold —
  // damage, spillage, expiry, theft. Receiving has its own type, so removal is the
  // honest default; the preview shows the outcome either way.
  const [direction, setDirection] = useState<'add' | 'remove'>('remove');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [reorder, setReorder] = useState('');
  const [busy, setBusy] = useState(false);

  const results = useMemo(
    () => filterCatalogue(catalogue.data?.items ?? [], search, null),
    [catalogue.data, search]
  );

  const current = picked?.quantity ?? 0;
  const entered = parseQty(amount);
  const delta = deltaFor(kind, mode, direction, entered, current);
  const newLevel = round3(current + delta);

  const reorderValue = parseQty(reorder);
  const reorderChanged = picked != null && reorderValue != null && reorderValue !== picked.reorder_level;

  const amountInvalid = amount.trim().length > 0 && entered == null;
  const negativeResult = newLevel < 0;
  const nothingToDo = delta === 0 && !reorderChanged;
  const canSubmit = picked != null && !amountInvalid && !negativeResult && !nothingToDo && !busy;

  function pick(product: ProductWithStock) {
    setPicked(product);
    setAmount('');
    setNote('');
    setReorder(String(product.reorder_level));
    setMode('counted');
    setDirection('remove');
  }

  /** Back to step 1, keeping `kind` — a delivery is many products of the same kind. */
  function reset() {
    setPicked(null);
    setSearch('');
    setAmount('');
    setNote('');
    setReorder('');
    setMode('counted');
    setDirection('remove');
  }

  function confirmThenSubmit() {
    if (!canSubmit || !picked) return;

    // Stock appearing is recoverable; stock disappearing is what gets argued about
    // at the end of the month, so that direction gets one explicit confirmation.
    if (delta < 0) {
      Alert.alert(
        `Remove ${formatQty(-delta)} from stock?`,
        `${picked.name} goes from ${formatQty(current)} to ${formatQty(newLevel)}. The movement is recorded and cannot be deleted.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Remove', style: 'destructive', onPress: () => void submit() },
        ]
      );
      return;
    }
    void submit();
  }

  async function submit() {
    if (!picked || !storeId) return;
    const product = picked;
    setBusy(true);
    try {
      const level = await inventoryApi.adjust({
        store_id: storeId,
        product_id: product.id,
        type: kind,
        // Signed delta, never a total. Everything above exists to make that true.
        quantity: delta,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(reorderChanged ? { reorder_level: reorderValue as number } : {}),
      });

      void queryClient.invalidateQueries({ queryKey: ['catalogue', storeId] });
      void queryClient.invalidateQueries({ queryKey: ['movements', storeId] });

      reset();
      Alert.alert(
        `${product.name} updated`,
        `${formatQty(level.quantity)} now in stock at ${store?.name ?? 'this store'}.`,
        [
          { text: 'Done', style: 'cancel', onPress: () => router.back() },
          { text: 'Adjust another' },
        ]
      );
    } catch (err) {
      Alert.alert("Couldn't save the adjustment", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!store) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState icon="home" title="No store selected" hint="Choose a store from the Sell tab." />
      </SafeAreaView>
    );
  }

  if (!canAdjust) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <EmptyState
          icon="lock"
          title="Read-only for your role"
          hint="Only a store manager or an administrator can change stock levels. You can still view the stock list and the movement history."
          action={<Button label="View movements" icon="list" variant="secondary" onPress={() => router.push('/movements')} />}
        />
      </SafeAreaView>
    );
  }

  /* --------------------------------------------------------- step 1: pick one */

  if (!picked) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <View style={[styles.pickHead, { paddingHorizontal: layout.gutter }]}>
          <Text style={styles.step}>Step 1 of 2</Text>
          <Text style={styles.stepTitle}>Which product?</Text>
          <View style={styles.searchBox}>
            <Icon name="search" size={16} color={colors.textFaint} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Name, SKU or barcode"
              placeholderTextColor={colors.textFaint}
              style={styles.searchInput}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
            />
            {search.length > 0 ? (
              <Pressable onPress={() => setSearch('')} hitSlop={10}>
                <Icon name="x" size={16} color={colors.textFaint} />
              </Pressable>
            ) : null}
          </View>
        </View>

        {catalogue.isLoading ? (
          <Loading label="Loading the catalogue" />
        ) : catalogue.isError ? (
          <EmptyState
            icon="cloud-off"
            title="Couldn't load the catalogue"
            hint="Stock levels come from the server and there is no cached copy on this device yet."
            action={
              <Button
                label="Retry"
                icon="refresh-cw"
                variant="secondary"
                onPress={() => void catalogue.refetch()}
              />
            }
          />
        ) : (
          <FlashList
            data={results}
            keyExtractor={(p) => p.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingHorizontal: layout.gutter,
              paddingBottom: spacing.xxl,
            }}
            ListEmptyComponent={
              <EmptyState
                icon="package"
                title={search ? 'Nothing matches' : 'No products yet'}
                hint={search ? 'Try part of the name or the SKU.' : 'Add products before adjusting stock.'}
              />
            }
            renderItem={({ item }) => <PickRow product={item} onPress={() => pick(item)} />}
          />
        )}
      </SafeAreaView>
    );
  }

  /* ------------------------------------------------------ step 2: the numbers */

  const receiving = kind === 'purchase';
  const stale = catalogue.data?.fromCache === true;

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
        <View style={styles.hero}>
          <View style={styles.heroGlow} />
          <View style={styles.heroTop}>
            <View style={{ flex: 1 }}>
              <Text style={styles.heroName} numberOfLines={2}>
                {picked.name}
              </Text>
              <Text style={styles.heroSku} numberOfLines={1}>
                {picked.sku}
                {picked.unit ? ` · per ${picked.unit}` : ''}
              </Text>
            </View>
            <Pressable onPress={reset} hitSlop={8} style={styles.heroSwap}>
              <Icon name="repeat" size={14} color={colors.onDark} />
              <Text style={styles.heroSwapText}>Change</Text>
            </Pressable>
          </View>

          <Text style={styles.heroLabel}>In stock now</Text>
          <Text style={styles.heroQty}>{formatQty(current)}</Text>
          <Text style={styles.heroFoot}>
            {formatKwacha(picked.cost_price)} each at cost · reorder at {formatQty(picked.reorder_level)}
          </Text>
        </View>

        {stale ? (
          <View style={styles.warn}>
            <Icon name="wifi-off" size={16} color={colors.warning} />
            <Text style={styles.warnText}>
              This is the last synced level, not a live one. A correction worked out from a stale
              number will be wrong — reconnect before counting.
            </Text>
          </View>
        ) : null}

        <View style={{ gap: spacing.md }}>
          <SectionLabel>What happened</SectionLabel>
          <Select<Kind>
            value={kind}
            onChange={(next) => {
              setKind(next);
              setAmount('');
            }}
            options={[
              { value: 'purchase', label: 'Stock received' },
              { value: 'adjustment', label: 'Correction' },
            ]}
            hint={
              receiving
                ? 'A delivery arrived. Enter how many units came in.'
                : 'The shelf and the system disagree. Put the system right.'
            }
          />
        </View>

        {receiving ? (
          <View style={{ gap: spacing.md }}>
            <Field
              label="Units received"
              value={amount}
              onChangeText={(t) => setAmount(numericText(t))}
              placeholder="0"
              keyboardType="numeric"
              autoFocus
              error={amountInvalid ? 'Enter a number.' : null}
              hint="Count only what arrived today — not the total on the shelf."
            />
          </View>
        ) : (
          <View style={{ gap: spacing.md }}>
            <Select<EntryMode>
              label="How are you entering it?"
              value={mode}
              onChange={(next) => {
                setMode(next);
                setAmount('');
              }}
              options={[
                { value: 'counted', label: 'Counted total' },
                { value: 'delta', label: 'Adjust by' },
              ]}
            />

            {mode === 'counted' ? (
              <>
                <Field
                  label="Units actually on the shelf"
                  value={amount}
                  onChangeText={(t) => setAmount(numericText(t))}
                  placeholder={formatQty(current)}
                  keyboardType="numeric"
                  autoFocus
                  error={amountInvalid ? 'Enter a number.' : null}
                  hint="Type the number you counted. The difference is worked out for you."
                />
                {entered != null ? (
                  <View style={[styles.verdict, delta === 0 && styles.verdictFlat]}>
                    <Icon
                      name={delta === 0 ? 'check-circle' : delta > 0 ? 'trending-up' : 'trending-down'}
                      size={16}
                      color={delta === 0 ? colors.textMuted : delta > 0 ? colors.success : colors.danger}
                    />
                    <Text style={styles.verdictText}>{countedVerdict(delta)}</Text>
                  </View>
                ) : null}
              </>
            ) : (
              <>
                <Select<'add' | 'remove'>
                  label="Direction"
                  value={direction}
                  onChange={setDirection}
                  options={[
                    { value: 'remove', label: '− Remove' },
                    { value: 'add', label: '+ Add' },
                  ]}
                />
                <Field
                  label={direction === 'remove' ? 'Units to remove' : 'Units to add'}
                  value={amount}
                  onChangeText={(t) => setAmount(numericText(t))}
                  placeholder="0"
                  keyboardType="numeric"
                  autoFocus
                  error={amountInvalid ? 'Enter a number.' : null}
                  hint="A difference, not a total."
                />
              </>
            )}
          </View>
        )}

        <Preview
          current={current}
          delta={delta}
          newLevel={newLevel}
          costPrice={picked.cost_price}
          negative={negativeResult}
        />

        <View style={{ gap: spacing.md }}>
          <Field
            label={receiving ? 'Note (optional)' : 'Note — say what happened'}
            value={note}
            onChangeText={setNote}
            placeholder={receiving ? 'Delivery note 4471, two crates' : 'Damaged in transit, recount after audit…'}
            multiline
            hint={
              receiving
                ? undefined
                : 'A correction with no reason is impossible to defend when the figures are questioned.'
            }
          />

          <Field
            label="Reorder level (optional)"
            value={reorder}
            onChangeText={(t) => setReorder(numericText(t))}
            placeholder={String(picked.reorder_level)}
            keyboardType="numeric"
            hint={
              reorderChanged
                ? `Will change from ${formatQty(picked.reorder_level)} to ${formatQty(reorderValue as number)}.`
                : 'Left as it is unless you change it.'
            }
          />
        </View>

        <Button
          label={submitLabel(kind, delta, reorderChanged)}
          icon={receiving ? 'download' : 'edit-3'}
          variant={delta < 0 ? 'danger' : 'primary'}
          size="lg"
          loading={busy}
          disabled={!canSubmit}
          onPress={confirmThenSubmit}
        />
        {nothingToDo && !amountInvalid ? (
          <Text style={styles.blockedNote}>
            Nothing has changed yet — enter a quantity or a new reorder level.
          </Text>
        ) : null}
        <Button label="Cancel" variant="ghost" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}

/* ------------------------------------------------------------------ fragments */

function PickRow({ product, onPress }: { product: ProductWithStock; onPress: () => void }) {
  const out = product.quantity <= 0;
  const low = !out && product.quantity <= product.reorder_level;

  return (
    <Pressable style={({ pressed }) => [styles.pickRow, pressed && styles.pickRowPressed]} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <Text style={styles.pickName} numberOfLines={1}>
          {product.name}
        </Text>
        <Text style={styles.pickSku} numberOfLines={1}>
          {product.sku}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Text style={[styles.pickQty, out && { color: colors.danger }]}>{formatQty(product.quantity)}</Text>
        {out || low ? <Badge label={out ? 'Out' : 'Low'} tone={out ? 'danger' : 'warning'} dot /> : null}
      </View>
      <Icon name="chevron-right" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

/**
 * The commitment screen. Nothing is submitted that hasn't been shown here first,
 * spelled out as an equation rather than a single final number — a total and a
 * delta look identical once they're on their own.
 */
function Preview({
  current,
  delta,
  newLevel,
  costPrice,
  negative,
}: {
  current: number;
  delta: number;
  newLevel: number;
  costPrice: number;
  negative: boolean;
}) {
  const tone = delta > 0 ? colors.success : delta < 0 ? colors.danger : colors.textMuted;

  return (
    <View style={[styles.preview, negative && styles.previewBad]}>
      <Text style={styles.previewEquation}>
        {formatQty(current)} {delta < 0 ? '−' : '+'} {formatQty(Math.abs(delta))} ={' '}
        <Text style={{ color: tone }}>{formatQty(newLevel)}</Text>
      </Text>

      <View style={styles.previewRow}>
        <View style={styles.previewCell}>
          <Text style={styles.previewLabel}>Now</Text>
          <Text style={styles.previewValue}>{formatQty(current)}</Text>
        </View>
        <View style={styles.previewArrow}>
          <Icon name="arrow-right" size={16} color={colors.textFaint} />
          <Text style={[styles.previewDelta, { color: tone }]}>{signed(delta)}</Text>
        </View>
        <View style={[styles.previewCell, { alignItems: 'flex-end' }]}>
          <Text style={styles.previewLabel}>After</Text>
          <Text style={[styles.previewValue, styles.previewValueAfter, { color: tone }]}>
            {formatQty(newLevel)}
          </Text>
        </View>
      </View>

      {negative ? (
        <Text style={styles.previewError}>
          That would take the shelf below zero. If you counted what's there, switch to “Counted
          total” instead.
        </Text>
      ) : delta !== 0 ? (
        <Text style={styles.previewFoot}>
          {delta > 0 ? 'Adds' : 'Writes off'} {formatKwacha(Math.abs(delta) * costPrice)} of stock at
          cost.
        </Text>
      ) : null}
    </View>
  );
}

/* --------------------------------------------------------------------- maths */

/**
 * The one calculation that matters: the API's `quantity` is a signed delta, so a
 * counted total has to be turned into `counted − current` before it goes up.
 * Sending the total itself would silently double the stock.
 */
function deltaFor(
  kind: Kind,
  mode: EntryMode,
  direction: 'add' | 'remove',
  entered: number | null,
  current: number
): number {
  if (entered == null) return 0;
  if (kind === 'purchase') return round3(entered);
  if (mode === 'counted') return round3(entered - current);
  return round3(direction === 'remove' ? -entered : entered);
}

function countedVerdict(delta: number): string {
  if (delta === 0) return 'That matches the system exactly — nothing to correct.';
  if (delta < 0) return `That's ${formatQty(-delta)} fewer than the system thinks.`;
  return `That's ${formatQty(delta)} more than the system thinks.`;
}

function submitLabel(kind: Kind, delta: number, reorderChanged: boolean): string {
  if (delta === 0) return reorderChanged ? 'Save reorder level' : 'Nothing to save';
  if (kind === 'purchase') return `Receive ${formatQty(delta)}`;
  return delta > 0 ? `Add ${formatQty(delta)}` : `Remove ${formatQty(-delta)}`;
}

/** Blank or unparseable is `null` so "0 counted" stays distinguishable from "not typed". */
function parseQty(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Keeps the field to digits and at most one decimal point. */
function numericText(text: string): string {
  const cleaned = text.replace(/[^0-9.]/g, '');
  const dot = cleaned.indexOf('.');
  if (dot === -1) return cleaned;
  return cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, '');
}

function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

function formatQty(n: number): string {
  return String(round3(n));
}

function signed(n: number): string {
  if (n > 0) return `+${formatQty(n)}`;
  if (n < 0) return `−${formatQty(-n)}`;
  return '0';
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },

  /* step 1 */
  pickHead: { paddingTop: spacing.md, paddingBottom: spacing.sm, gap: spacing.xs },
  step: {
    fontFamily: font.semibold,
    fontSize: 11,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  stepTitle: { fontFamily: font.bold, fontSize: 22, color: colors.text, letterSpacing: -0.5 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 50,
    marginTop: spacing.sm,
  },
  searchInput: { flex: 1, fontFamily: font.medium, fontSize: 15, color: colors.text, padding: 0 },

  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
    minHeight: 64,
    ...shadow.card,
  },
  pickRowPressed: { transform: [{ scale: 0.99 }], opacity: 0.9 },
  pickName: { fontFamily: font.semibold, fontSize: 15, color: colors.text },
  pickSku: { fontFamily: font.regular, fontSize: 11, color: colors.textFaint, marginTop: 2 },
  pickQty: { fontFamily: font.extrabold, fontSize: 20, color: colors.text, letterSpacing: -0.5 },

  /* step 2 */
  hero: {
    backgroundColor: colors.primaryDeep,
    borderRadius: radius.xl,
    padding: spacing.xl,
    overflow: 'hidden',
    ...shadow.raised,
  },
  heroGlow: {
    position: 'absolute',
    top: -80,
    right: -60,
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: colors.primaryBright,
    opacity: 0.38,
  },
  heroTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  heroName: { fontFamily: font.bold, fontSize: 18, color: colors.onDark, letterSpacing: -0.4 },
  heroSku: { fontFamily: font.regular, fontSize: 12, color: colors.onDarkMuted, marginTop: 3 },
  heroSwap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.14)',
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    borderRadius: radius.pill,
  },
  heroSwapText: { fontFamily: font.semibold, fontSize: 12, color: colors.onDark },
  heroLabel: {
    fontFamily: font.medium,
    fontSize: 11,
    color: colors.onDarkMuted,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginTop: spacing.lg,
  },
  heroQty: {
    fontFamily: font.extrabold,
    fontSize: 46,
    color: colors.onDark,
    letterSpacing: -1.6,
    marginTop: 2,
  },
  heroFoot: { fontFamily: font.regular, fontSize: 11, color: colors.onDarkMuted, marginTop: 4 },

  warn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  warnText: { flex: 1, fontFamily: font.medium, fontSize: 12, color: colors.warning, lineHeight: 17 },

  verdict: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  verdictFlat: { opacity: 0.75 },
  verdictText: { flex: 1, fontFamily: font.semibold, fontSize: 13, color: colors.text, lineHeight: 18 },

  preview: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadow.card,
  },
  previewBad: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  previewEquation: {
    fontFamily: font.bold,
    fontSize: 15,
    color: colors.textMuted,
    letterSpacing: 0.2,
  },
  previewRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.md },
  previewCell: { flex: 1 },
  previewLabel: {
    fontFamily: font.semibold,
    fontSize: 10,
    color: colors.textFaint,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  previewValue: {
    fontFamily: font.bold,
    fontSize: 24,
    color: colors.textMuted,
    letterSpacing: -0.8,
    marginTop: 2,
  },
  previewValueAfter: { fontFamily: font.extrabold, fontSize: 34, letterSpacing: -1.2 },
  previewArrow: { alignItems: 'center', gap: 2, paddingBottom: 6 },
  previewDelta: { fontFamily: font.extrabold, fontSize: 14 },
  previewFoot: { fontFamily: font.regular, fontSize: 12, color: colors.textMuted },
  previewError: { fontFamily: font.medium, fontSize: 12, color: colors.danger, lineHeight: 17 },

  blockedNote: {
    fontFamily: font.regular,
    fontSize: 12,
    color: colors.textFaint,
    textAlign: 'center',
    marginTop: -spacing.sm,
  },
});
