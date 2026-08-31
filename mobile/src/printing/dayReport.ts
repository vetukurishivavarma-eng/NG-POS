import { formatKwacha } from '../theme';
import type { DailyReport, Store } from '../api/types';

/** One product's contribution to the day, already aggregated across every sale. */
export interface DayReportProduct {
  name: string;
  sku?: string;
  quantity: number;
  total: number;
}

export interface DayReportPdfData {
  store: Store;
  report: DailyReport;
  cashierName: string;
  /** Every product sold on the day, sorted by the caller (usually by value). */
  products: DayReportProduct[];
}

interface DayReportPdfOptions {
  organizationName: string;
}

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const qty = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

function formatWhen(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * The consolidated end-of-day report as an A4 page, for PDF/share — the shop
 * keeps a paper Z-report from the thermal printer, this is the copy that gets
 * sent to the office. Same figures, plus the full product-by-product breakdown
 * the receipt paper has no room for.
 */
export function dayReportHtml(data: DayReportPdfData, opts: DayReportPdfOptions): string {
  const r = data.report;
  const tendered =
    r.by_payment_method.cash + r.by_payment_method.card + r.by_payment_method.mobile;
  const soldUnits = data.products.reduce((sum, p) => sum + p.quantity, 0);
  const soldValue = data.products.reduce((sum, p) => sum + p.total, 0);

  const rows = data.products
    .map(
      (p, index) => `
        <tr>
          <td class="num">${index + 1}</td>
          <td>
            <div class="name">${esc(p.name)}</div>
            ${p.sku ? `<div class="sku">${esc(p.sku)}</div>` : ''}
          </td>
          <td class="qty">${esc(qty(p.quantity))}</td>
          <td class="amt">${esc(formatKwacha(p.total))}</td>
        </tr>`
    )
    .join('');

  const money = (n: number) => esc(formatKwacha(n));

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Day report ${esc(r.date)}</title>
    <style>
      @page { size: A4; margin: 14mm 13mm; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        color: #16261F;
        font-size: 11.5px;
        line-height: 1.45;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; }
      .org { font-size: 21px; font-weight: 800; color: #0F5F47; letter-spacing: -0.2px; }
      .doc { margin-top: 2px; font-size: 11px; font-weight: 700; letter-spacing: 1.6px; text-transform: uppercase; color: #6A7A72; }
      .refbox { min-width: 200px; border: 1.5px solid #0F5F47; border-radius: 6px; padding: 9px 12px; }
      .refbox .label { font-size: 8.5px; letter-spacing: 1.3px; text-transform: uppercase; color: #6A7A72; font-weight: 700; }
      .refbox .ref { font-size: 15px; font-weight: 800; color: #0F5F47; }
      .refbox .meta { margin-top: 5px; font-size: 10px; color: #6A7A72; }

      .grid { display: flex; gap: 10px; margin: 16px 0 4px; }
      .cell { flex: 1; background: #F6F4EF; border: 1px solid #E5DFD4; border-radius: 6px; padding: 10px 12px; }
      .cell .label { font-size: 8.5px; letter-spacing: 1.3px; text-transform: uppercase; color: #6A7A72; font-weight: 700; }
      .cell .val { font-size: 15px; font-weight: 800; margin-top: 3px; }
      .cell.net .val { color: #0F5F47; }

      h2 { font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase; color: #6A7A72; margin: 20px 0 6px; }
      .split { display: flex; gap: 20px; }
      .money-table { width: 100%; border-collapse: collapse; }
      .money-table td { padding: 4px 0; }
      .money-table td:last-child { text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; }
      .money-table tr.sum td { border-top: 1px solid #16261F; font-weight: 800; padding-top: 6px; }

      table.items { width: 100%; border-collapse: collapse; margin-top: 6px; }
      thead { display: table-header-group; }
      tr { break-inside: avoid; }
      thead th {
        text-align: left; font-size: 8.5px; letter-spacing: 1.3px; text-transform: uppercase;
        color: #6A7A72; font-weight: 700; padding: 0 8px 6px; border-bottom: 1.5px solid #16261F;
      }
      tbody td { padding: 6px 8px; border-bottom: 1px solid #E5DFD4; vertical-align: top; }
      tbody tr:nth-child(even) td { background: #FAF9F6; }
      .num { width: 26px; color: #6A7A72; }
      .name { font-weight: 600; }
      .sku { color: #6A7A72; font-family: "SF Mono", Consolas, monospace; font-size: 10px; margin-top: 1px; }
      th.qty, td.qty { width: 70px; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
      th.amt, td.amt { width: 100px; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
      tfoot td { padding: 9px 8px; font-weight: 800; border-top: 1.5px solid #16261F; }
      tfoot .amt { color: #0F5F47; }

      .signs { display: flex; gap: 26px; margin-top: 34px; }
      .sign { flex: 1; }
      .sign .rule { border-bottom: 1px solid #16261F; height: 32px; }
      .sign .label { font-size: 9px; letter-spacing: 1.1px; text-transform: uppercase; color: #6A7A72; font-weight: 700; padding-top: 5px; }
      .foot { margin-top: 20px; padding-top: 8px; border-top: 1px solid #E5DFD4; font-size: 9px; color: #6A7A72; }
    </style>
  </head>
  <body>
    <div class="head">
      <div>
        <div class="org">${esc(opts.organizationName)}</div>
        <div class="doc">Day Report &middot; ${esc(data.store.name)}</div>
      </div>
      <div class="refbox">
        <div class="label">Trading day</div>
        <div class="ref">${esc(formatWhen(r.date))}</div>
        <div class="meta">${esc(data.cashierName)} &middot; ${r.transaction_count} sale${r.transaction_count === 1 ? '' : 's'}</div>
      </div>
    </div>

    <div class="grid">
      <div class="cell net">
        <div class="label">Net takings</div>
        <div class="val">${money(r.gross_total)}</div>
      </div>
      <div class="cell">
        <div class="label">Of which VAT</div>
        <div class="val">${money(r.tax_total)}</div>
      </div>
      <div class="cell">
        <div class="label">Refunds</div>
        <div class="val">${money(r.refund_total)}</div>
      </div>
    </div>

    <div class="split">
      <div style="flex:1">
        <h2>Takings by method</h2>
        <table class="money-table">
          <tr><td>Cash</td><td>${money(r.by_payment_method.cash)}</td></tr>
          <tr><td>Card</td><td>${money(r.by_payment_method.card)}</td></tr>
          <tr><td>Mobile money</td><td>${money(r.by_payment_method.mobile)}</td></tr>
          <tr class="sum"><td>Tendered</td><td>${money(tendered)}</td></tr>
        </table>
      </div>
      <div style="flex:1">
        <h2>Reconciliation</h2>
        <table class="money-table">
          <tr><td>Gross sales</td><td>${money(r.gross_total + r.refund_total)}</td></tr>
          <tr><td>Less refunds</td><td>-${money(r.refund_total)}</td></tr>
          <tr class="sum"><td>Net</td><td>${money(r.gross_total)}</td></tr>
        </table>
      </div>
    </div>

    <h2>Products sold (${data.products.length})</h2>
    <table class="items">
      <thead>
        <tr><th class="num">#</th><th>Product</th><th class="qty">Qty</th><th class="amt">Amount</th></tr>
      </thead>
      <tbody>
        ${rows || '<tr><td class="num"></td><td>No products sold on this day.</td><td class="qty"></td><td class="amt"></td></tr>'}
      </tbody>
      <tfoot>
        <tr><td></td><td>Total</td><td class="qty">${esc(qty(soldUnits))}</td><td class="amt">${money(soldValue)}</td></tr>
      </tfoot>
    </table>

    <div class="signs">
      <div class="sign"><div class="rule"></div><div class="label">Cash counted</div></div>
      <div class="sign"><div class="rule"></div><div class="label">Signature</div></div>
    </div>

    <div class="foot">Generated ${esc(new Date().toLocaleString())} &middot; figures exclude sales still queued offline.</div>
  </body>
</html>`;
}
