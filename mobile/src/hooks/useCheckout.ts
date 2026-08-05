import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { computeTotals, lineToTransactionItem, useCart } from '../store/cart';
import { useStoreSelection } from '../store/storeSelection';
import { useSync } from '../db/sync';
import { transactions as txApi } from '../api/endpoints';
import { errorMessage, isNetworkError } from '../api/client';
import { decrementCachedStock, queueTransaction } from '../db';
import { offerReceipt } from '../printing/print';
import { formatKwacha } from '../theme';
import { newClientReference } from '../api/types';
import type { PaymentMethod, TransactionDraft } from '../api/types';

/**
 * One checkout implementation shared by the phone cart modal and the tablet's
 * docked cart panel, so the two can never drift apart.
 */
export function useCheckout(onDone?: () => void) {
  const store = useStoreSelection((s) => s.selected);
  const queryClient = useQueryClient();
  const lines = useCart((s) => s.lines);
  const clear = useCart((s) => s.clear);
  const customerName = useCart((s) => s.customerName);

  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [busy, setBusy] = useState(false);

  const complete = useCallback(async () => {
    if (!store || lines.length === 0) return;
    setBusy(true);

    const totals = computeTotals(lines);
    const draft: TransactionDraft = {
      store_id: store.id,
      transaction_type: 'sale',
      // Generated once here, before any send attempt, so the key survives into
      // the offline queue and every later retry carries the same one.
      client_reference: newClientReference(),
      items: lines.map(lineToTransactionItem),
      subtotal: totals.subtotal,
      discount_amount: totals.discount,
      tax_amount: totals.tax,
      total: totals.total,
      payments: [{ method, amount: totals.total, reference: null }],
      customer_name: customerName.trim() || null,
      customer_phone: null,
      notes: '',
    };

    try {
      const tx = await txApi.create(draft);
      clear();
      void queryClient.invalidateQueries({ queryKey: ['catalogue', store.id] });
      onDone?.();
      offerReceipt(tx, store);
    } catch (err) {
      if (isNetworkError(err)) {
        // Queue it. The server assigns the receipt number on sync, so we
        // deliberately never invent one here.
        await queueTransaction(draft);
        await decrementCachedStock(
          store.id,
          draft.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity }))
        );
        await useSync.getState().refreshPendingCount(store.id);
        clear();
        void queryClient.invalidateQueries({ queryKey: ['catalogue', store.id] });
        onDone?.();
        Alert.alert(
          'Saved offline',
          `${formatKwacha(draft.total)} recorded. It will be sent — and get its receipt number — as soon as you're back online.`
        );
      } else {
        Alert.alert('Sale failed', errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }, [store, lines, method, customerName, clear, queryClient, onDone]);

  return { method, setMethod, busy, complete, canComplete: Boolean(store) && lines.length > 0 };
}
