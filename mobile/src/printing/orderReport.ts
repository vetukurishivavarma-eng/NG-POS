import { formatKwacha } from '../theme';

export interface OrderReportLine {
  name: string;
  brand?: string | null;
  quantity: number;
  value: number;
}

export interface OrderReportData {
  storeName: string;
  /** Window length in whole months. */
  months: number;
  preparedBy: string;
  lines: OrderReportLine[];
}

interface OrderReportOptions {
  organizationName: string;
}

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const qty = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * The reorder list as an A4 page: what sold over the last N months and how
 * much, so it can be sent to a supplier or worked into a purchase order. It is
 * a demand history, not a stock instruction — the person ordering still decides
 * the quantity against what is on the shelf.
 */
export function orderReportHtml(data: OrderReportData, opts: OrderReportOptions): string {
  const totalUnits = data.lines.reduce((sum, l) => sum + l.quantity, 0);
  const totalValue = data.lines.reduce((sum, l) => sum + l.value, 0);
  const money = (n: number) => esc(formatKwacha(n));
  const window = `${data.months} month${data.months === 1 ? '' : 's'}`;

  const rows = data.lines
    .map(
      (l, index) => `
        <tr>
          <td class="num">${index + 1}</td>
          <td>
            <div class="name">${esc(l.name)}</div>
            ${l.brand ? `<div class="brand">${esc(l.brand)}</div>` : ''}
          </td>
          <td class="qty">${esc(qty(l.quantity))}</td>
          <td class="amt">${money(l.value)}</td>
          <td class="order"></td>
        </tr>`
    )
    .join('');

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Order list &middot; last ${esc(window)}</title>
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

      .lead { margin: 14px 0 2px; font-size: 10.5px; color: #6A7A72; }

      table { width: 100%; border-collapse: collapse; margin-top: 10px; }
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
      .brand { color: #6A7A72; font-size: 10px; margin-top: 1px; }
      th.qty, td.qty { width: 74px; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
      th.amt, td.amt { width: 96px; text-align: right; font-variant-numeric: tabular-nums; color: #6A7A72; }
      th.order, td.order { width: 96px; border-left: 1px solid #E5DFD4; }
      tfoot td { padding: 9px 8px; font-weight: 800; border-top: 1.5px solid #16261F; }

      .foot { margin-top: 20px; padding-top: 8px; border-top: 1px solid #E5DFD4; font-size: 9px; color: #6A7A72; }
    </style>
  </head>
  <body>
    <div class="head">
      <div>
        <div class="org">${esc(opts.organizationName)}</div>
        <div class="doc">Order List &middot; ${esc(data.storeName)}</div>
      </div>
      <div class="refbox">
        <div class="label">Sold in the last</div>
        <div class="ref">${esc(window)}</div>
        <div class="meta">Prepared by ${esc(data.preparedBy)}<br/>${esc(new Date().toLocaleDateString())}</div>
      </div>
    </div>

    <div class="lead">
      Quantities below are what was sold over the last ${esc(window)}. Set the
      order quantity against current stock in the last column.
    </div>

    <table>
      <thead>
        <tr>
          <th class="num">#</th>
          <th>Product</th>
          <th class="qty">Sold</th>
          <th class="amt">Value</th>
          <th class="order">Order qty</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td class="num"></td><td>Nothing was sold in this window.</td><td class="qty"></td><td class="amt"></td><td class="order"></td></tr>'}
      </tbody>
      <tfoot>
        <tr>
          <td></td>
          <td>${data.lines.length} product${data.lines.length === 1 ? '' : 's'}</td>
          <td class="qty">${esc(qty(totalUnits))}</td>
          <td class="amt">${money(totalValue)}</td>
          <td class="order"></td>
        </tr>
      </tfoot>
    </table>

    <div class="foot">Generated ${esc(new Date().toLocaleString())} &middot; a sales history, not a stock count.</div>
  </body>
</html>`;
}
