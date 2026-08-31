import { Alert } from 'react-native';

import { organizations } from '../api/endpoints';
import { formatKwacha } from '../theme';
import { buildDayReport, buildReceipt, type DayReportInput } from './receipt';
import { printBlockedReason, sendToPrinter, usePrinter } from './printer';
import { shareHtmlAsPdf } from './pdf';
import { dayReportHtml, type DayReportPdfData } from './dayReport';
import { orderReportHtml, type OrderReportData } from './orderReport';
import {
  buildTransferNote,
  transferNoteHtml,
  type TransferNoteData,
} from './transferNote';
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

/* ---------------------------------------------------------- transfer notes */

/**
 * Both ways of printing a transfer, offered together.
 *
 * The Bluetooth option is shown even when it can't run, because the reason it
 * can't (Bluetooth off, no printer paired, Expo Go) is worth telling someone
 * who is standing at a till expecting paper — quietly hiding the button would
 * leave them with no idea what to fix.
 */
export function offerTransferPrint(data: TransferNoteData) {
  Alert.alert(
    `Transfer ${data.reference}`,
    'Print the transfer note for the driver and the receiving shop.',
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Save as PDF', onPress: () => void shareTransferPdf(data) },
      { text: 'Print on Bluetooth', onPress: () => void printTransferNote(data) },
    ]
  );
}

/** Thermal roll, over the till's paired Bluetooth printer. */
export async function printTransferNote(data: TransferNoteData): Promise<void> {
  const blocked = printBlockedReason();
  if (blocked) {
    Alert.alert(
      "Can't print",
      `${blocked}\n\nSet up a printer under More → Receipt Printer, or save the note as a PDF instead.`
    );
    return;
  }

  const config = usePrinter.getState().config;
  if (!config) return; // Unreachable: printBlockedReason() already covers it.

  try {
    await sendToPrinter(
      buildTransferNote(data, {
        organizationName: await organizationName(data.from_store ?? 'NG POS'),
        width: config.width,
      }),
      config.address
    );
  } catch (err) {
    Alert.alert('Print failed', err instanceof Error ? err.message : 'The printer did not respond.');
  }
}

/** A4 PDF, out through the share sheet — WhatsApp, email, Drive, or a real printer. */
export async function shareTransferPdf(data: TransferNoteData): Promise<void> {
  try {
    const html = transferNoteHtml(data, {
      organizationName: await organizationName(data.from_store ?? 'NG POS'),
    });
    const { uri, shared } = await shareHtmlAsPdf(
      html,
      `Transfer-${data.reference}`,
      `Transfer ${data.reference}`
    );
    if (!shared) Alert.alert('PDF saved', `The transfer note was saved to ${uri}`);
  } catch (err) {
    Alert.alert(
      "Couldn't make the PDF",
      err instanceof Error ? err.message : 'The transfer note could not be rendered.'
    );
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

/** A4 PDF of the consolidated day report, out through the share sheet. */
export async function shareDayReportPdf(data: DayReportPdfData): Promise<void> {
  try {
    const html = dayReportHtml(data, {
      organizationName: await organizationName(data.store.name),
    });
    const { uri, shared } = await shareHtmlAsPdf(
      html,
      `Day-Report-${data.store.name}-${data.report.date}`,
      `Day report — ${data.report.date}`
    );
    if (!shared) Alert.alert('PDF saved', `The day report was saved to ${uri}`);
  } catch (err) {
    Alert.alert(
      "Couldn't make the PDF",
      err instanceof Error ? err.message : 'The day report could not be rendered.'
    );
  }
}

/** A4 PDF of the reorder list, out through the share sheet. */
export async function shareOrderReportPdf(data: OrderReportData): Promise<void> {
  try {
    const html = orderReportHtml(data, {
      organizationName: await organizationName(data.storeName),
    });
    const { uri, shared } = await shareHtmlAsPdf(
      html,
      `Order-List-${data.storeName}-${data.months}m`,
      `Order list — last ${data.months} month${data.months === 1 ? '' : 's'}`
    );
    if (!shared) Alert.alert('PDF saved', `The order list was saved to ${uri}`);
  } catch (err) {
    Alert.alert(
      "Couldn't make the PDF",
      err instanceof Error ? err.message : 'The order list could not be rendered.'
    );
  }
}
