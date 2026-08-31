import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  computeTotals,
  isBelowCost,
  maxSellable,
  PAYMENT_METHODS,
  unitPriceOf,
  useCart,
  type CartLine,
} from '../store/cart';
import { useCheckout } from '../hooks/useCheckout';
import { useLeaveGuard } from '../hooks/useLeaveGuard';
import { useSync } from '../db/sync';
import { colors, font, formatKwacha, radius, spacing, splitAmount } from '../theme';
import { Button, EmptyState, Icon, QtyStepper } from './components';

/**
 * The cart body. Rendered inside a modal on phones and docked to the right of
 * the product grid on tablets — same component, same behaviour, both places.
 */
export function CartPanel({
  onDone,
  docked = false,
  guardLeave = false,
}: {
  onDone?: () => void;
  docked?: boolean;
  /**
   * Ask before leaving with an uncharged cart. Set only where this panel owns
   * a dismissable screen (the phone cart modal) — on the tablet it is docked
   * into the Sell tab, which is never removed, so there is nothing to guard.
   */
  guardLeave?: boolean;
}) {
  const lines = useCart((s) => s.lines);
  const setQuantity = useCart((s) => s.setQuantity);
  const setPriceOverride = useCart((s) => s.setPriceOverride);
  const remove = useCart((s) => s.remove);
  const clearCart = useCart((s) => s.clear);
  const customerName = useCart((s) => s.customerName);
  const setCustomer = useCart((s) => s.setCustomer);
  const online = useSync((s) => s.online);

  const { method, setMethod, busy, complete, canComplete } = useCheckout(onDone);

  useLeaveGuard({
    hasUnsavedWork: () => guardLeave && useCart.getState().lines.length > 0,
    title: 'Leave this sale?',
    message: 'The items in the cart have not been charged yet.',
    finishLabel: 'Charge now',
    onFinish: async () => {
      if (useCart.getState().lines.some(isBelowCost)) {
        Alert.alert(
          'Fix the price first',
          'A line is priced below cost, so the sale would be rejected. Raise it, or discard the sale.'
        );
        return false;
      }
      // complete() handles its own navigation (receipt prompt, then onDone),
      // so let that flow run rather than popping the screen from here.
      await complete();
      return false;
    },
    onDiscard: () => clearCart(),
  });

  const totals = useMemo(() => computeTotals(lines), [lines]);
  const amount = splitAmount(totals.total);
  const hasBelowCostLine = lines.some(isBelowCost);

  if (lines.length === 0) {
    return (
      <View style={[styles.root, docked && styles.docked]}>
        {docked ? <PanelHeader count={0} onClear={clearCart} /> : null}
        <EmptyState icon="shopping-cart" title="Cart is empty" hint="Tap a product to add it." />
      </View>
    );
  }

  return (
    <View style={[styles.root, docked && styles.docked]}>
      {docked ? <PanelHeader count={totals.itemCount} onClear={clearCart} /> : null}

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {lines.map((line) => (
          <CartLineRow
            key={line.product.id}
            line={line}
            onQuantity={(next) => setQuantity(line.product.id, next)}
            onPrice={(next) => setPriceOverride(line.product.id, next)}
            onRemove={() => remove(line.product.id)}
          />
        ))}

        <View style={styles.customerField}>
          <Icon name="user" size={16} color={colors.textFaint} />
          <TextInput
            value={customerName}
            onChangeText={(v) => setCustomer(v)}
            placeholder="Customer name (optional)"
            placeholderTextColor={colors.textFaint}
            style={styles.customerInput}
          />
        </View>

        <View style={styles.methods}>
          {PAYMENT_METHODS.map((m) => {
            const active = m.key === method;
            const icon = m.key === 'cash' ? 'dollar-sign' : m.key === 'card' ? 'credit-card' : 'smartphone';
            return (
              <Pressable
                key={m.key}
                onPress={() => setMethod(m.key)}
                style={[styles.method, active && styles.methodActive]}
              >
                <Icon
                  name={icon as 'dollar-sign'}
                  size={18}
                  color={active ? colors.primary : colors.textMuted}
                />
                <Text style={[styles.methodText, active && styles.methodTextActive]}>{m.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.totals}>
          <SummaryRow label="Subtotal" value={formatKwacha(totals.subtotal)} />
          {totals.discount > 0 ? (
            <SummaryRow label="Discount" value={`− ${formatKwacha(totals.discount)}`} />
          ) : null}
          <SummaryRow label="VAT (16%)" value={formatKwacha(totals.tax)} />
        </View>
      </ScrollView>

      <View style={styles.footer}>
        {!online ? (
          <View style={styles.offlinePill}>
            <Icon name="wifi-off" size={13} color={colors.warning} />
            <Text style={styles.offlineText}>Offline — will sync automatically</Text>
          </View>
        ) : null}

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalAmount}>
            {amount.whole}
            <Text style={styles.totalDecimals}>{amount.decimals}</Text>
          </Text>
        </View>

        <Button
          label={`Charge ${formatKwacha(totals.total)}`}
          size="lg"
          icon="check-circle"
          onPress={complete}
          loading={busy}
          disabled={!canComplete || hasBelowCostLine}
        />
      </View>
    </View>
  );
}

/**
 * One cart line, with its own tap-to-edit selling price. Every logged-in
 * role may reprice a line here — the client asked for this to apply to admin
 * and every shop login alike, with no in-app cap; the backend floors any
 * override at the product's cost price regardless of role, and an accepted
 * override becomes the new catalogue price, so the Sell screen and the
 * product screen pick it up too.
 */
function CartLineRow({
  line,
  onQuantity,
  onPrice,
  onRemove,
}: {
  line: CartLine;
  onQuantity: (next: number) => void;
  onPrice: (next: number | undefined) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(unitPriceOf(line)));
  const belowCost = isBelowCost(line);

  const commit = () => {
    setEditing(false);
    const parsed = Number(draft.replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setDraft(String(unitPriceOf(line)));
      return;
    }
    onPrice(parsed === line.product.selling_price ? undefined : parsed);
  };

  return (
    <View style={styles.line}>
      <View style={styles.lineTop}>
        <Text style={styles.lineName} numberOfLines={2}>
          {line.product.name}
        </Text>
        <Pressable onPress={onRemove} hitSlop={10}>
          <Icon name="x" size={16} color={colors.textFaint} />
        </Pressable>
      </View>

      <View style={styles.lineBottom}>
        <QtyStepper
          value={line.quantity}
          max={maxSellable(line.product)}
          onChange={onQuantity}
        />

        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.lineTotal}>{formatKwacha(unitPriceOf(line) * line.quantity)}</Text>

          {editing ? (
            <View style={styles.priceEditRow}>
              <Text style={styles.priceEditPrefix}>K</Text>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                onBlur={commit}
                onSubmitEditing={commit}
                keyboardType="decimal-pad"
                autoFocus
                selectTextOnFocus
                style={styles.priceEditInput}
              />
            </View>
          ) : (
            <Pressable
              onPress={() => {
                setDraft(String(unitPriceOf(line)));
                setEditing(true);
              }}
              hitSlop={6}
            >
              <Text style={[styles.lineUnit, styles.lineUnitEditable]}>
                {formatKwacha(unitPriceOf(line))} each
                {line.product.tax_type === 'vat' ? ' · VAT' : ''}
                {line.priceOverride !== undefined ? ' · edited' : ''}
              </Text>
            </Pressable>
          )}
        </View>
      </View>

      {belowCost ? (
        <View style={styles.capNote}>
          <Icon name="alert-circle" size={12} color={colors.danger} />
          <Text style={[styles.capText, { color: colors.danger }]}>
            Below cost price — the sale will be rejected until this is raised.
          </Text>
        </View>
      ) : null}

      {/* The cap is only obvious once you have hit it, so say why the plus
          has stopped responding rather than leaving it looking broken. */}
      {line.quantity >= maxSellable(line.product) ? (
        <View style={styles.capNote}>
          <Icon name="alert-circle" size={12} color={colors.accentDeep} />
          <Text style={styles.capText}>
            {line.product.quantity > 0
              ? `All ${line.product.quantity} in stock are on this sale.`
              : 'This is oversold to the limit — count the shelf before selling more.'}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function PanelHeader({ count, onClear }: { count: number; onClear: () => void }) {
  return (
    <View style={styles.panelHeader}>
      <View style={styles.panelHeaderLeft}>
        <Icon name="shopping-cart" size={17} color={colors.text} />
        <Text style={styles.panelTitle}>Cart</Text>
        {count > 0 ? (
          <View style={styles.countPill}>
            <Text style={styles.countPillText}>{count}</Text>
          </View>
        ) : null}
      </View>
      {count > 0 ? (
        <Pressable onPress={onClear} hitSlop={8}>
          <Text style={styles.clearText}>Clear</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.sumRow}>
      <Text style={styles.sumLabel}>{label}</Text>
      <Text style={styles.sumValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  docked: {
    backgroundColor: colors.surface,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
  },

  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  panelHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  panelTitle: { fontFamily: font.bold, fontSize: 17, color: colors.text },
  countPill: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  countPillText: { fontFamily: font.bold, fontSize: 11, color: '#fff' },
  clearText: { fontFamily: font.semibold, fontSize: 13, color: colors.danger },

  scroll: { padding: spacing.md, gap: spacing.sm },

  line: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  lineTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  lineName: { flex: 1, fontFamily: font.semibold, fontSize: 14, color: colors.text, lineHeight: 19 },
  lineBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  capNote: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  capText: { fontFamily: font.medium, fontSize: 11, color: colors.accentDeep },

  lineTotal: { fontFamily: font.bold, fontSize: 15, color: colors.text },
  lineUnit: { fontFamily: font.regular, fontSize: 11, color: colors.textMuted, marginTop: 1 },
  lineUnitEditable: { textDecorationLine: 'underline', textDecorationStyle: 'dotted' },

  priceEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 1,
    borderBottomWidth: 1,
    borderBottomColor: colors.primary,
  },
  priceEditPrefix: { fontFamily: font.medium, fontSize: 11, color: colors.textMuted, marginRight: 2 },
  priceEditInput: {
    fontFamily: font.semibold,
    fontSize: 12,
    color: colors.text,
    minWidth: 48,
    padding: 0,
    textAlign: 'right',
  },

  customerField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 48,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs,
  },
  customerInput: { flex: 1, fontFamily: font.medium, fontSize: 14, color: colors.text },

  methods: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  method: {
    flex: 1,
    height: 62,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  methodActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  methodText: { fontFamily: font.semibold, fontSize: 12, color: colors.textMuted },
  methodTextActive: { color: colors.primary },

  totals: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 6,
    marginTop: spacing.xs,
  },
  sumRow: { flexDirection: 'row', justifyContent: 'space-between' },
  sumLabel: { fontFamily: font.regular, fontSize: 13, color: colors.textMuted },
  sumValue: { fontFamily: font.semibold, fontSize: 13, color: colors.text },

  footer: {
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  offlinePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.warningSoft,
    paddingVertical: 7,
    borderRadius: radius.pill,
  },
  offlineText: { fontFamily: font.semibold, fontSize: 11, color: colors.warning },

  totalRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  totalLabel: {
    fontFamily: font.semibold,
    fontSize: 12,
    color: colors.textFaint,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  totalAmount: { fontFamily: font.extrabold, fontSize: 28, color: colors.text, letterSpacing: -0.8 },
  totalDecimals: { fontFamily: font.bold, fontSize: 18, color: colors.textMuted },
});
