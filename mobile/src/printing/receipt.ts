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
 * Money as it is read, not as it is stored: `1,234.50`.
 *
 * Thousand separators are worth the two characters. A cashier checking a total
 * against the till reads `12,450.00` at a glance and has to count digits on
 * `1245000`, and 80mm paper has the room.
 */
function money(value: number): string {
  const [whole, fraction] = Math.abs(value).toFixed(2).split('.');
  const grouped = (whole as string).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}${grouped}.${fraction}`;
}

/** `12` not `12.000`, but `1.5` survives. Quantities are Decimal(12,3). */
function qty(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

/** `12 Aug 26 14:32` — short, and unambiguous about which number is the day. */
function stamp(date: Date): string {
  return `${date.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  })} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * The shop's name and address, as tightly as it can be set.
 *
 * The town and the phone share a line rather than taking one each — three
 * header lines instead of five is about 8mm of paper on every receipt printed,
 * and neither is any harder to read for sitting side by side.
 */
function header(b: EscPosBuilder, organizationName: string, store: Store): void {
  b.align('center').bold(true);
  if (organizationName.length <= b.cols / 2) {
    b.size(2).line(organizationName).size(1);
  } else {
    for (const part of wrap(organizationName, b.cols)) b.line(part);
  }
  b.line(store.name).bold(false);

  // A plain hyphen, not a middot: the printer's code page is single-byte ASCII
  // and `encodeAscii` turns anything outside it into a question mark.
  const where = [store.address?.city, store.phone ? `Tel ${store.phone}` : '']
    .filter(Boolean)
    .join(' - ');
  if (where) b.line(fit(where, b.cols));
}

/**
 * Renders a completed sale as ESC/POS bytes.
 *
 * Laid out for the roll it is going onto. At 80mm each item is one line —
 * name, quantity, unit price, amount — and at 58mm the same item takes two,
 * because 32 characters cannot hold four columns and stay readable.
 */
export function buildReceipt(tx: Transaction, opts: ReceiptOptions): string {
  const b = new EscPosBuilder(opts.width);

  header(b, opts.organizationName, opts.store);
  b.align('left').rule('=');

  // Two facts to a line wherever they are short enough to share one.
  b.columns(tx.receipt_number, stamp(new Date(tx.created_at)));
  const who = [
    tx.cashier_name ? `Served by ${tx.cashier_name}` : '',
    tx.customer_name ?? '',
  ].filter(Boolean);
  if (who.length === 1) b.line(fit(who[0] as string, b.cols));
  else if (who.length === 2) b.columns(fit(who[0] as string, 24), fit(who[1] as string, 20));

  if (tx.transaction_type !== 'sale') {
    b.bold(true).align('center').line(tx.transaction_type.replace('_', ' ').toUpperCase());
    b.bold(false).align('left');
  }

  /* ------------------------------------------------------------- the items */

  if (b.wide) {
    b.rule('-');
    b.bold(true)
      .cells('ITEM', { text: 'QTY', width: 4 }, { text: 'PRICE', width: 9 }, { text: 'AMOUNT', width: 10 })
      .bold(false);
    b.rule('-');

    for (const item of tx.items) {
      b.cells(
        item.product_name,
        { text: qty(item.quantity), width: 4 },
        { text: money(item.unit_price), width: 9 },
        { text: money(item.line_total), width: 10 }
      );
      if (item.discount_amount > 0) {
        b.cells('  less discount', { text: `-${money(item.discount_amount)}`, width: 23 });
      }
    }
  } else {
    b.rule('-');
    for (const item of tx.items) {
      b.line(fit(item.product_name, b.cols));
      b.columns(`  ${qty(item.quantity)} x ${money(item.unit_price)}`, money(item.line_total));
      if (item.discount_amount > 0) b.columns('  less discount', `-${money(item.discount_amount)}`);
    }
  }

  /* ------------------------------------------------------------ the totals */

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
    if (p.reference) b.columns('  Ref', fit(p.reference, 24));
  }

  const tendered = tx.payments.reduce((sum, p) => sum + p.amount, 0);
  if (tendered > tx.total) b.bold(true).columns('CHANGE', money(tendered - tx.total)).bold(false);

  b.rule('=');
  b.align('center');
  for (const part of wrap(opts.footer ?? 'Thank you for your business!', b.cols)) b.line(part);
  // Wrapped, not truncated: at 32 characters this is two lines, and cutting it
  // to "Goods once sold are not returnab" is worse than either.
  for (const part of wrap('Goods once sold are not returnable', b.cols)) b.line(part);

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

  b.align('center').bold(true).size(2).line('DAY REPORT').size(1);
  b.line(input.organizationName).bold(false);
  b.line(input.store.name);

  b.align('left').rule('=');
  b.columns(r.date, `Printed ${stamp(new Date())}`);
  b.columns(fit(input.cashierName, 26), `${r.transaction_count} sales`);
  b.rule('=');

  b.bold(true).line('TAKINGS BY METHOD').bold(false);
  b.columns('Cash', money(r.by_payment_method.cash));
  b.columns('Card', money(r.by_payment_method.card));
  b.columns('Mobile Money', money(r.by_payment_method.mobile));
  const tendered =
    r.by_payment_method.cash + r.by_payment_method.card + r.by_payment_method.mobile;
  b.rule('-');
  b.columns('Tendered', money(tendered));

  b.rule('=');
  b.bold(true).line('SUMMARY').bold(false);
  b.columns('Gross sales', money(r.gross_total + r.refund_total));
  b.columns('Refunds', `-${money(r.refund_total)}`);
  b.rule('-');
  b.bold(true).size(2);
  b.columns('NET', `K${money(r.gross_total)}`);
  b.size(1).bold(false);
  b.columns('of which VAT', money(r.tax_total));

  if (input.topItems?.length) {
    b.rule('=');
    b.bold(true).line('TOP ITEMS').bold(false);
    for (const item of input.topItems) {
      if (b.wide) {
        b.cells(item.name, { text: qty(item.quantity), width: 5 }, { text: money(item.total), width: 11 });
      } else {
        b.line(fit(item.name, b.cols));
        b.columns(`  x${qty(item.quantity)}`, money(item.total));
      }
    }
  }

  // Sized to the paper rather than typed out, or the rule runs off the edge.
  b.rule('=');
  for (const label of ['Cash counted', 'Signature']) {
    b.line(`${label.padEnd(14)}${'_'.repeat(Math.max(4, b.cols - 14))}`);
  }

  b.cut();
  return b.toBase64();
}

/** A short, unambiguous page to confirm a printer is wired up correctly. */
export function buildTestPage(width: PaperWidth, storeName: string): string {
  const b = new EscPosBuilder(width);
  b.align('center').bold(true).size(2).line('NG POS').size(1);
  b.line('Printer Test').bold(false);
  b.align('left').rule('=');
  b.columns('Store', fit(storeName, 24));
  b.columns('Paper', `${width === 32 ? '58mm' : '80mm'} - ${width} chars`);
  b.columns('Time', new Date().toLocaleTimeString());
  b.rule('=');
  // A full-width ruler: if the line below wraps, the paper width is set wrong.
  b.line(ruler(width));
  for (const part of wrap('ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789', b.cols)) b.line(part);
  b.bold(true).size(2).columns('TOTAL', 'K1,234.56').size(1).bold(false);
  b.rule('=');
  b.align('center').line('If nothing above wrapped,').line('the width is right.');
  b.cut();
  return b.toBase64();
}

/** `123456789012...` repeated to the exact paper width. */
function ruler(width: number): string {
  let out = '';
  for (let i = 1; i <= width; i += 1) out += String(i % 10);
  return out;
}

function fit(value: string, max: number): string {
  const limit = Math.max(1, Math.floor(max));
  return value.length <= limit ? value : value.slice(0, limit);
}

/** Wraps on words, for the one string long enough to need it. */
function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of value.split(/\s+/).filter(Boolean)) {
    if (!current) current = word.slice(0, width);
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word.slice(0, width);
    }
  }
  if (current) lines.push(current);
  return lines;
}
