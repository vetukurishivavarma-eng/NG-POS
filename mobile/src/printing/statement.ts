/**
 * One A4 table layout for every downloadable statement — a supplier's invoices
 * and payments, a customer's sales, the shop-to-shop transfer list. The caller
 * supplies already-formatted cells; this only lays them out.
 */
export interface StatementData {
  /** Big heading under the organisation name, e.g. "Supplier statement". */
  title: string;
  /** Who/what it is for, e.g. the supplier's name. */
  subject: string;
  /** Small lines in the box on the right (period, phone, prepared by). */
  meta: string[];
  columns: { label: string; align?: 'right' }[];
  rows: string[][];
  /** Optional bold last row, aligned with `columns`. */
  totals?: string[];
  /** Shown when there are no rows. */
  empty: string;
}

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function statementHtml(data: StatementData, opts: { organizationName: string }): string {
  const cls = (i: number) => (data.columns[i]?.align === 'right' ? ' class="r"' : '');
  const row = (cells: string[]) => cells.map((c, i) => `<td${cls(i)}>${esc(c)}</td>`).join('');

  const body =
    data.rows.map((r) => `<tr>${row(r)}</tr>`).join('') ||
    `<tr><td colspan="${data.columns.length}">${esc(data.empty)}</td></tr>`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${esc(data.title)} &middot; ${esc(data.subject)}</title>
    <style>
      @page { size: A4; margin: 14mm 13mm; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        color: #16261F; font-size: 11px; line-height: 1.45;
        -webkit-print-color-adjust: exact; print-color-adjust: exact;
      }
      .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; }
      .org { font-size: 21px; font-weight: 800; color: #0F5F47; }
      .doc { margin-top: 2px; font-size: 11px; font-weight: 700; letter-spacing: 1.6px; text-transform: uppercase; color: #6A7A72; }
      .box { min-width: 200px; border: 1.5px solid #0F5F47; border-radius: 6px; padding: 9px 12px; }
      .box .subject { font-size: 15px; font-weight: 800; color: #0F5F47; }
      .box .meta { margin-top: 4px; font-size: 10px; color: #6A7A72; }
      table { width: 100%; border-collapse: collapse; margin-top: 16px; }
      thead { display: table-header-group; }
      tr { break-inside: avoid; }
      th {
        text-align: left; font-size: 8.5px; letter-spacing: 1.3px; text-transform: uppercase;
        color: #6A7A72; font-weight: 700; padding: 0 6px 6px; border-bottom: 1.5px solid #16261F;
      }
      td { padding: 5px 6px; border-bottom: 1px solid #E5DFD4; vertical-align: top; }
      tbody tr:nth-child(even) td { background: #FAF9F6; }
      .r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      tfoot td { font-weight: 800; border-top: 1.5px solid #16261F; border-bottom: none; padding-top: 8px; }
      .foot { margin-top: 18px; padding-top: 8px; border-top: 1px solid #E5DFD4; font-size: 9px; color: #6A7A72; }
    </style>
  </head>
  <body>
    <div class="head">
      <div>
        <div class="org">${esc(opts.organizationName)}</div>
        <div class="doc">${esc(data.title)}</div>
      </div>
      <div class="box">
        <div class="subject">${esc(data.subject)}</div>
        ${data.meta.map((m) => `<div class="meta">${esc(m)}</div>`).join('')}
      </div>
    </div>
    <table>
      <thead><tr>${data.columns.map((c, i) => `<th${cls(i)}>${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>
      ${data.totals ? `<tfoot><tr>${row(data.totals)}</tr></tfoot>` : ''}
    </table>
    <div class="foot">Generated ${esc(new Date().toLocaleString())}</div>
  </body>
</html>`;
}
