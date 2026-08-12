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

/** Lowercase, fold separators to underscores, drop everything else. */
function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s.\-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Turns a header cell into a canonical key: lowercased, trimmed, and with
 * spaces, hyphens and dots folded to underscores. `Selling Price (K)` and
 * `selling_price` are the same column as far as an import is concerned.
 */
export function normaliseHeader(header: string): string {
  return slug(header.replace(/\(.*?\)/g, ''));
}

/**
 * The same key with the bracketed part kept: `Cost (USD)` → `cost_usd`.
 *
 * Dropping the brackets is right for a unit that restates the column (`Selling
 * Price (K)`), and wrong when it is the only thing telling two columns apart —
 * a sheet carrying both `COST (USD)` and `COST` collapses to one key, and
 * whichever comes last silently wins. Callers try the full key against their
 * alias table first, so those pairs can be separated or ignored by name, and
 * fall back to the stripped key when nothing claims it.
 */
export function normaliseHeaderFull(header: string): string {
  return slug(header);
}

/**
 * Resolves one header cell to the key its values will be filed under, given an
 * alias table. An alias may map to the empty string to mean "ignore this
 * column", which is how a spreadsheet's working columns are kept out of the
 * import without being mistaken for unknown ones.
 */
export function resolveHeader(header: string, aliases: Record<string, string> = {}): string {
  const full = normaliseHeaderFull(header);
  if (full in aliases) return aliases[full] as string;

  const short = normaliseHeader(header);
  if (short in aliases) return aliases[short] as string;
  return short;
}

/**
 * Reads a CSV with a header row into objects keyed by canonical header name.
 * `aliases` maps an alternative header to the canonical one, so a shop can hand
 * in the spreadsheet it already keeps instead of retyping it.
 */
export function parseCsvObjects(
  text: string,
  aliases: Record<string, string> = {}
): TableObjects {
  return tableToObjects(parseCsv(text), aliases);
}

export interface TableObjects {
  /** The resolved key of each column, in file order. Empty where ignored. */
  headers: string[];
  /** The header row exactly as written, for reporting a column back by name. */
  rawHeaders: string[];
  rows: Record<string, string>[];
}

/**
 * The same header-mapping step for a table that did not come from CSV — the
 * .xlsx reader hands over rows of strings in the same shape, and an import must
 * behave identically whichever file the operator happened to pick.
 */
export function tableToObjects(
  table: string[][],
  aliases: Record<string, string> = {}
): TableObjects {
  if (table.length === 0) return { headers: [], rawHeaders: [], rows: [] };

  const rawHeaders = (table[0] as string[]).map((h) => h.trim());
  const headers = rawHeaders.map((h) => resolveHeader(h, aliases));

  const rows = table.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((key, index) => {
      if (!key) return;
      record[key] = (cells[index] ?? '').trim();
    });
    return record;
  });

  return { headers, rawHeaders, rows };
}
