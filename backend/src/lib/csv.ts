/**
 * A small RFC 4180 reader, used for the stock bulk upload.
 *
 * Hand-written rather than pulled from npm because the whole job is one screen
 * of code and the failure modes matter more than the features: a spreadsheet
 * exported from Excel arrives with a UTF-8 BOM, CRLF endings, and quoted fields
 * containing commas and doubled quotes. Everything else — type coercion, header
 * mapping, streaming — belongs to the caller, not here.
 */

/** Splits CSV text into rows of raw cell strings. Blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  // Excel writes a BOM. Left in place it becomes part of the first header name,
  // so "sku" silently stops matching and every row looks like it has no SKU.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // A trailing newline would otherwise add a row of one empty cell.
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const ch = input[i] as string;

    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // CRLF and a lone CR both end the row.
      endRow();
      i += input[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Turns a header cell into a canonical key: lowercased, trimmed, and with
 * spaces, hyphens and dots folded to underscores. `Selling Price (K)` and
 * `selling_price` are the same column as far as an import is concerned.
 */
export function normaliseHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .trim()
    .replace(/[\s.\-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Reads a CSV with a header row into objects keyed by canonical header name.
 * `aliases` maps an alternative header to the canonical one, so a shop can hand
 * in the spreadsheet it already keeps instead of retyping it.
 */
export function parseCsvObjects(
  text: string,
  aliases: Record<string, string> = {}
): { headers: string[]; rows: Record<string, string>[] } {
  const table = parseCsv(text);
  if (table.length === 0) return { headers: [], rows: [] };

  const headers = (table[0] as string[]).map((h) => {
    const key = normaliseHeader(h);
    return aliases[key] ?? key;
  });

  const rows = table.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((key, index) => {
      if (!key) return;
      record[key] = (cells[index] ?? '').trim();
    });
    return record;
  });

  return { headers, rows };
}
