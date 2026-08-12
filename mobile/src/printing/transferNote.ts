import { EscPosBuilder, type PaperWidth } from './escpos';
import type { TransferItem } from '../api/types';

/**
 * What a transfer note needs to print.
 *
 * A `Transfer` from the API satisfies this as-is, and so does a literal built
 * on the spot right after `POST /transfers` — that response carries only the
 * reference, so the screen that made the transfer already knows the rest.
 */
export interface TransferNoteData {
  reference: string;
  from_store: string | null;
  to_store: string | null;
  status: string;
  created_at: string;
  items: TransferItem[];
  notes?: string;
  /** Who keyed it in. Known only when we have just made the transfer. */
  issued_by?: string | null;
}

export interface TransferNoteOptions {
  organizationName: string;
}

/**
 * The same document, rendered two ways.
 *
 * A transfer note is what travels with the goods: the driver carries it, the
 * receiving shop checks the lines against what came off the van and signs it.
 * So both renderings carry the same figures *and* the same signature blocks —
 * an unsigned note is just a printout.
 */

/* -------------------------------------------------------------- thermal roll */

export function buildTransferNote(
  data: TransferNoteData,
  opts: TransferNoteOptions & { width: PaperWidth }
): string {
  const b = new EscPosBuilder(opts.width);
  const w = opts.width;

  // Double-width characters fit half a line. A long org name drops to single
  // width rather than being cut — the shop's own name is not the place to
  // save two characters.
  b.align('center').bold(true);
  if (opts.organizationName.length <= w / 2) {
    b.size(2).line(opts.organizationName).size(1);
  } else {
    for (const line of wrap(opts.organizationName, w)) b.line(line);
  }
  b.line('STOCK TRANSFER NOTE');
  b.bold(false);

  b.align('left').rule('=');
  b.columns(data.reference, formatWhen(data.created_at));
  b.columns(data.status.replace(/_/g, ' ').toUpperCase(), data.issued_by ? fit(data.issued_by, 24) : '');

  // The route is the whole point of the document. On 80mm it fits on one line;
  // on 58mm it needs two, and it still gets them.
  b.rule('-');
  const from = data.from_store ?? 'Unknown store';
  const to = data.to_store ?? 'Unknown store';
  b.bold(true);
  if (b.wide) b.columns(`FROM ${fit(from, 18)}`, `TO ${fit(to, 18)}`);
  else {
    b.line(`FROM ${fit(from, w - 5)}`);
    b.line(`TO   ${fit(to, w - 5)}`);
  }
  b.bold(false);
  b.rule('=');

  if (b.wide) {
    b.bold(true).cells('ITEM', { text: 'SKU', width: 14 }, { text: 'QTY', width: 6 }).bold(false);
    b.rule('-');
    for (const item of data.items) {
      b.cells(
        item.product_name,
        { text: item.sku, width: 14 },
        { text: qty(item.quantity), width: 6 }
      );
    }
  } else {
    b.bold(true).columns('ITEM', 'QTY').bold(false);
    b.rule('-');
    for (const item of data.items) {
      // Names wrap rather than truncate: the tail of an agro-vet product name is
      // the pack size ("... 500ml", "... 50kg"), and a transfer note that loses it
      // can't be checked against what actually came off the van.
      for (const line of wrap(item.product_name, w)) b.line(line);
      b.columns(`  ${fit(item.sku, w - 10)}`, qty(item.quantity));
    }
  }

  b.rule('-');
  const units = data.items.reduce((sum, i) => sum + i.quantity, 0);
  b.bold(true)
    .columns(`${data.items.length} product${data.items.length === 1 ? '' : 's'}`, `${qty(units)} units`)
    .bold(false);
  b.rule('=');

  if (data.notes?.trim()) {
    b.bold(true).line('NOTES').bold(false);
    for (const line of wrap(data.notes.trim(), w)) b.line(line);
    b.rule('-');
  }

  // Two signatures: the note is only evidence once both ends have signed it.
  // Side by side on 80mm, which is where the paper saving actually shows.
  b.feed(1);
  if (b.wide) {
    b.columns('_'.repeat(22), '_'.repeat(22));
    b.columns('Issued by'.padEnd(22), 'Received by'.padEnd(22));
    b.feed(1);
    b.columns('_'.repeat(22), '_'.repeat(22));
    b.columns('Date'.padEnd(22), 'Date'.padEnd(22));
  } else {
    for (const label of ['Issued by', 'Received by', 'Date']) {
      b.line('_'.repeat(w));
      b.line(label);
    }
  }

  b.align('center').line('Check every line before signing.');
  b.cut();

  return b.toBase64();
}

/* ------------------------------------------------------------------- A4 page */

/**
 * An A4 delivery note for the PDF. Everything is inline: the renderer is a
 * bare WebView with no network and no access to the app's bundled fonts, so a
 * linked stylesheet or a web font would silently come out unstyled.
 */
export function transferNoteHtml(data: TransferNoteData, opts: TransferNoteOptions): string {
  const units = data.items.reduce((sum, i) => sum + i.quantity, 0);
  const rows = data.items
    .map(
      (item, index) => `
        <tr>
          <td class="num">${index + 1}</td>
          <td>
            <div class="name">${esc(item.product_name)}</div>
          </td>
          <td class="sku">${esc(item.sku)}</td>
          <td class="qty">${esc(qty(item.quantity))}</td>
        </tr>`
    )
    .join('');

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Transfer ${esc(data.reference)}</title>
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

      .refbox { min-width: 176px; border: 1.5px solid #0F5F47; border-radius: 6px; padding: 9px 12px; }
      .refbox .label { font-size: 8.5px; letter-spacing: 1.3px; text-transform: uppercase; color: #6A7A72; font-weight: 700; }
      .refbox .ref { font-size: 17px; font-weight: 800; color: #0F5F47; letter-spacing: 0.5px; }
      .refbox .meta { margin-top: 5px; font-size: 10px; color: #6A7A72; }
      .status { display: inline-block; margin-top: 6px; padding: 2px 8px; border-radius: 999px; background: #E2EFE9; color: #0A4433; font-size: 9px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }

      .route { display: flex; align-items: stretch; gap: 10px; margin: 16px 0 4px; }
      .side { flex: 1; background: #F6F4EF; border: 1px solid #E5DFD4; border-radius: 6px; padding: 10px 12px; }
      .side .label { font-size: 8.5px; letter-spacing: 1.3px; text-transform: uppercase; color: #6A7A72; font-weight: 700; }
      .side .store { font-size: 14px; font-weight: 700; margin-top: 2px; }
      .arrow { display: flex; align-items: center; color: #0F5F47; font-size: 17px; font-weight: 700; }

      table { width: 100%; border-collapse: collapse; margin-top: 16px; }
      /* A 60-line transfer runs onto a second sheet: repeat the header there,
         and never split a product row or the signatures across the break. */
      thead { display: table-header-group; }
      tr { break-inside: avoid; }
      .signs, .notes { break-inside: avoid; }
      thead th {
        text-align: left; font-size: 8.5px; letter-spacing: 1.3px; text-transform: uppercase;
        color: #6A7A72; font-weight: 700; padding: 0 8px 6px; border-bottom: 1.5px solid #16261F;
      }
      tbody td { padding: 7px 8px; border-bottom: 1px solid #E5DFD4; vertical-align: top; }
      tbody tr:nth-child(even) td { background: #FAF9F6; }
      .num { width: 26px; color: #6A7A72; }
      .name { font-weight: 600; }
      .sku { width: 122px; color: #6A7A72; font-family: "SF Mono", Consolas, monospace; font-size: 10.5px; }
      .qty, th.qty { width: 74px; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
      tfoot td { padding: 9px 8px; font-weight: 700; border-top: 1.5px solid #16261F; }
      tfoot .total { font-size: 14px; color: #0F5F47; }

      .notes { margin-top: 16px; border-left: 3px solid #DFA02C; background: #FBF0D9; padding: 9px 12px; border-radius: 0 4px 4px 0; }
      .notes .label { font-size: 8.5px; letter-spacing: 1.3px; text-transform: uppercase; color: #B77F16; font-weight: 700; }

      .signs { display: flex; gap: 26px; margin-top: 30px; }
      .sign { flex: 1; }
      .sign .rule { border-bottom: 1px solid #16261F; height: 34px; }
      .sign .label { font-size: 9px; letter-spacing: 1.1px; text-transform: uppercase; color: #6A7A72; font-weight: 700; padding-top: 5px; }
      .sign .hint { font-size: 9px; color: #6A7A72; }

      .foot { margin-top: 22px; padding-top: 8px; border-top: 1px solid #E5DFD4; font-size: 9px; color: #6A7A72; display: flex; justify-content: space-between; gap: 12px; }
    </style>
  </head>
  <body>
    <div class="head">
      <div>
        <div class="org">${esc(opts.organizationName)}</div>
        <div class="doc">Stock Transfer Note</div>
      </div>
      <div class="refbox">
        <div class="label">Reference</div>
        <div class="ref">${esc(data.reference)}</div>
        <div class="meta">${esc(formatWhen(data.created_at))}</div>
        <div class="status">${esc(data.status.replace(/_/g, ' '))}</div>
      </div>
    </div>

    <div class="route">
      <div class="side">
        <div class="label">From</div>
        <div class="store">${esc(data.from_store ?? 'Unknown store')}</div>
      </div>
      <div class="arrow">&#8594;</div>
      <div class="side">
        <div class="label">To</div>
        <div class="store">${esc(data.to_store ?? 'Unknown store')}</div>
      </div>
    </div>

    <table>
      <thead>
        <tr><th class="num">#</th><th>Product</th><th>SKU</th><th class="qty">Qty</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="2">${data.items.length} product${data.items.length === 1 ? '' : 's'}</td>
          <td class="qty">Total</td>
          <td class="qty total">${esc(qty(units))}</td>
        </tr>
      </tfoot>
    </table>

    ${
      data.notes?.trim()
        ? `<div class="notes"><div class="label">Notes</div><div>${esc(data.notes.trim())}</div></div>`
        : ''
    }

    <div class="signs">
      <div class="sign">
        <div class="rule"></div>
        <div class="label">Issued by</div>
        <div class="hint">${data.issued_by ? esc(data.issued_by) : 'Name, signature &amp; date'}</div>
      </div>
      <div class="sign">
        <div class="rule"></div>
        <div class="label">Received by</div>
        <div class="hint">Name, signature &amp; date</div>
      </div>
    </div>

    <div class="foot">
      <span>Check every line against the goods before signing.</span>
      <span>NG POS &middot; printed ${esc(formatWhen(new Date().toISOString()))}</span>
    </div>
  </body>
</html>`;
}

/* ------------------------------------------------------------------- helpers */

/** Quantities are Decimal(12,3) on the server; whole units shouldn't print as `12.000`. */
function qty(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Hard truncation, no ellipsis: `…` survives NFKD in `encodeAscii` as three
 * dots, so an ellipsis silently makes the line two characters *longer* than
 * the paper and the printer wraps it into a ragged extra line.
 */
function fit(value: string, max: number): string {
  const limit = Math.max(1, Math.floor(max));
  return value.length <= limit ? value : value.slice(0, limit);
}

/** Notes are free text and the roll is 32 characters wide, so wrap on words. */
function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!current) current = word.slice(0, width);
      else if (current.length + 1 + word.length <= width) current += ` ${word}`;
      else {
        lines.push(current);
        current = word.slice(0, width);
      }
    }
    lines.push(current);
  }
  return lines;
}

/** Product names and notes are user data going into markup. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
