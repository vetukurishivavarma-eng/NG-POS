import { Alert } from 'react-native';

import { organizations } from '../api/endpoints';
import { formatKwacha } from '../theme';
import { buildDayReport, buildReceipt, type DayReportInput } from './receipt';
import { printBlockedReason, sendToPrinter, usePrinter } from './printer';
import type { Store, Transaction } from '../api/types';

/**
 * The organisation name sits on every printout but changes about never, so it
 * is fetched once and kept — reprints and Z-reports happen on the same flaky
 * link as everything else and shouldn't fail for a cosmetic string.
 */
let cachedOrgName: string | null = null;

async function organizationName(fallback: string): Promise<string> {
  if (cachedOrgName) return cachedOrgName;
  try {
    cachedOrgName = (await organizations.current()).name;
    return cachedOrgName;
  } catch {
    return fallback;
  }
}

/** Printing is opt-in per sale: paper costs money and many customers decline. */
export function offerReceipt(tx: Transaction, store: Store, title = 'Sale complete') {
  const body = `Receipt ${tx.receipt_number}\n${formatKwacha(tx.total)}`;

  if (printBlockedReason()) {
    Alert.alert(title, body);
    return;
  }

  Alert.alert(title, body, [
    { text: 'Done', style: 'cancel' },
    { text: 'Print Receipt', onPress: () => void printTransaction(tx, store) },
  ]);
}

export async function printTransaction(tx: Transaction, store: Store): Promise<void> {
  const config = usePrinter.getState().config;
  if (!config) {
    Alert.alert('No printer', 'Set up a receipt printer under More → Receipt Printer first.');
    return;
  }

  try {
    await sendToPrinter(
      buildReceipt(tx, {
        organizationName: await organizationName(store.name),
        store,
        width: config.width,
        // Only a cash sale should kick the drawer; a reprint or refund shouldn't.
        openDrawer: config.openDrawer && tx.transaction_type === 'sale',
      }),
      config.address
    );
  } catch (err) {
    Alert.alert('Print failed', err instanceof Error ? err.message : 'The printer did not respond.');
  }
}

export async function printDayReport(input: Omit<DayReportInput, 'organizationName' | 'width'>) {
  const config = usePrinter.getState().config;
  if (!config) {
    Alert.alert('No printer', 'Set up a receipt printer under More → Receipt Printer first.');
    return;
  }

  try {
    await sendToPrinter(
      buildDayReport({
        ...input,
        organizationName: await organizationName(input.store.name),
        width: config.width,
      }),
      config.address
    );
  } catch (err) {
    Alert.alert('Print failed', err instanceof Error ? err.message : 'The printer did not respond.');
  }
}
