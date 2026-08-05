import { EscPosBuilder, type PaperWidth } from './escpos';
import type { DailyReport, Store, Transaction } from '../api/types';

export interface ReceiptOptions {
  organizationName: string;
  store: Store;
  width: PaperWidth;
  footer?: string;
  openDrawer?: boolean;
}

/**
 * Renders a completed sale as ESC/POS bytes, laid out to match the web app's
 * printed receipt: header, itemised body, totals, payment, footer.
 */
export function buildReceipt(tx: Transaction, opts: ReceiptOptions): string {
  const b = new EscPosBuilder(opts.width);
  const money = (n: number) => n.toFixed(2);

  b.align('center').bold(true).size(2).line(opts.organizationName).size(1);
  b.line(opts.store.name);
  if (opts.store.address?.city) b.line(opts.store.address.city);
  if (opts.store.phone) b.line(`Tel: ${opts.store.phone}`);
  b.bold(false).feed(1);

  b.align('left').rule('=');
  b.columns('Receipt', tx.receipt_number);
  b.columns('Date', new Date(tx.created_at).toLocaleString());
  b.columns('Cashier', tx.cashier_name ?? '');
  if (tx.customer_name) b.columns('Customer', tx.customer_name);
  if (tx.transaction_type !== 'sale') {
    b.bold(true).align('center').line(tx.transaction_type.replace('_', ' ').toUpperCase());
    b.bold(false).align('left');
  }
  b.rule('=');

  for (const item of tx.items) {
    b.line(truncate(item.product_name, opts.width));
    const qtyLabel = `  ${item.quantity} x ${money(item.unit_price)}`;
    b.columns(qtyLabel, money(item.line_total));
    if (item.discount_amount > 0) {
      b.columns('  Discount', `-${money(item.discount_amount)}`);
    }
  }

  b.rule('-');
  b.columns('Subtotal', money(tx.subtotal));
  if (tx.discount_amount > 0) b.columns('Discount', `-${money(tx.discount_amount)}`);
  if (tx.tax_amount > 0) b.columns('VAT 16%', money(tx.tax_amount));

  b.bold(true).size(2);
  b.columns('TOTAL', `K${money(tx.total)}`);
  b.size(1).bold(false);

  b.rule('-');
  for (const p of tx.payments) {
    b.columns(p.method.toUpperCase(), money(p.amount));
    if (p.reference) b.columns('  Ref', p.reference);
  }

  b.feed(1).align('center');
  b.line(opts.footer ?? 'Thank you for your business!');
  b.line('Goods once sold are not returnable');
  b.feed(1);

  if (opts.openDrawer) b.openDrawer();
  b.cut();

  return b.toBase64();
}

export interface DayReportInput {
  organizationName: string;
  store: Store;
  width: PaperWidth;
  report: DailyReport;
  /** Who closed the session — a Z-report is worthless without a name on it. */
  cashierName: string;
  /** Best sellers of the day, already sorted. Optional: needs the full day's rows. */
  topItems?: { name: string; quantity: number; total: number }[];
}

/**
 * The end-of-day Z-report. Printed once when a session is closed and kept with
 * the cash, so it has to reconcile on its own: takings by payment method, what
 * went back out as refunds, and the VAT inside the total.
 */
export function buildDayReport(input: DayReportInput): string {
  const { report: r } = input;
  const b = new EscPosBuilder(input.width);
  const money = (n: number) => n.toFixed(2);

  b.align('center').bold(true).size(2).line('DAY REPORT').size(1);
  b.line(input.organizationName).bold(false);
  b.line(input.store.name);
  b.feed(1);

  b.align('left').rule('=');
  b.columns('Date', r.date);
  b.columns('Printed', new Date().toLocaleString());
  b.columns('Cashier', truncate(input.cashierName, input.width - 10));
  b.columns('Transactions', String(r.transaction_count));
  b.rule('=');

  b.bold(true).line('TAKINGS BY METHOD').bold(false);
  b.columns('Cash', money(r.by_payment_method.cash));
  b.columns('Card', money(r.by_payment_method.card));
  b.columns('Mobile Money', money(r.by_payment_method.mobile));
  const tendered =
    r.by_payment_method.cash + r.by_payment_method.card + r.by_payment_method.mobile;
  b.rule('-');
  b.columns('Tendered', money(tendered));

  b.feed(1).bold(true).line('SUMMARY').bold(false);
  b.columns('Gross sales', money(r.gross_total + r.refund_total));
  b.columns('Refunds', `-${money(r.refund_total)}`);
  b.rule('-');
  b.bold(true).size(2);
  b.columns('NET', `K${money(r.gross_total)}`);
  b.size(1).bold(false);
  b.columns('of which VAT', money(r.tax_total));

  if (input.topItems?.length) {
    b.feed(1).bold(true).line('TOP ITEMS').bold(false);
    for (const item of input.topItems) {
      b.line(truncate(item.name, input.width));
      b.columns(`  x${item.quantity}`, money(item.total));
    }
  }

  b.feed(1).rule('=');
  b.align('center').line('Cash counted: ______________');
  b.feed(1).line('Signature: _________________');
  b.feed(1);

  b.cut();
  return b.toBase64();
}

/** A short, unambiguous page to confirm a printer is wired up correctly. */
export function buildTestPage(width: PaperWidth, storeName: string): string {
  const b = new EscPosBuilder(width);
  b.align('center').bold(true).size(2).line('NG POS').size(1);
  b.line('Printer Test').bold(false).feed(1);
  b.align('left').rule('=');
  b.columns('Store', truncate(storeName, 20));
  b.columns('Paper', `${width === 32 ? '58mm' : '80mm'}`);
  b.columns('Time', new Date().toLocaleTimeString());
  b.rule('=');
  b.line('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  b.line('0123456789 K1,234.56');
  b.feed(1).align('center').line('If this is readable,').line('printing works.');
  b.cut();
  return b.toBase64();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
