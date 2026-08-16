/**
 * The vocabulary of a stock spreadsheet: which headings mean which field, and
 * how to give a product a code when the sheet does not carry one.
 *
 * Two shapes are accepted, because the shop keeps two kinds of file.
 *
 *   1. The SKU sheet — our own template. `sku` is the key, and a re-upload of a
 *      corrected file updates the same rows.
 *   2. The price master — the merged company/product/pack-size sheet the buyer
 *      maintains, with a landed-cost build-up and one price column per shop. It
 *      has no product codes at all; identity is COMPANY + PRODUCT + PACKSIZE.
 *
 * Everything here is about turning the second into the first without asking
 * anyone to retype a 500-line spreadsheet, which is where transcription errors
 * come from.
 */

/** The columns of our own template, in the order it writes them. */
export const SKU_TEMPLATE_COLUMNS = [
  'sku',
  'name',
  'barcode',
  'brand',
  'category',
  'unit',
  'cost_price',
  'selling_price',
  'tax_type',
  'quantity',
  'reorder_level',
] as const;

/**
 * The price master's columns, exactly as that sheet writes them. The working
 * columns are part of the file and stay in the template: the buyer builds the
 * selling price out of them, and a template that dropped them would be a
 * different document from the one they actually keep.
 */
export const PRICE_MASTER_COLUMNS = [
  'COMPANY',
  'PRODUCT',
  'PACKSIZE',
  'COST',
  'Transport & Others',
  'Landing',
  'MARK UP',
  'GP',
  'SP',
  'QTY',
] as const;

/**
 * Headings mapped to the field they fill.
 *
 * An entry mapping to the empty string means "read this column and throw it
 * away" — the price master's working and provenance columns are known parts of
 * the file, not mystery columns, and listing them keeps them out of the
 * "unrecognised" report the operator is asked to look at.
 *
 * Keys are matched against the bracket-preserving form of the heading first
 * (`cost_usd`), then the stripped form (`cost`) — see `normaliseHeaderFull`.
 */
export const HEADER_ALIASES: Record<string, string> = {
  /* --- identity --- */
  code: 'sku',
  item_code: 'sku',
  product_code: 'sku',
  stock_code: 'sku',
  product: 'name',
  product_name: 'name',
  item: 'name',
  item_name: 'name',
  bar_code: 'barcode',
  ean: 'barcode',

  /* --- the price master's identity trio --- */
  company: 'company',
  supplier: 'company',
  manufacturer: 'company',
  make: 'company',
  brand: 'company',
  packsize: 'pack_size',
  pack: 'pack_size',
  size: 'pack_size',
  pack_sizes: 'pack_size',

  /* --- classification --- */
  group: 'category',
  uom: 'unit',
  units: 'unit',

  /* --- money --- */
  cost: 'cost_price',
  buying_price: 'cost_price',
  purchase_price: 'cost_price',
  // Landing = cost + transport, i.e. what the item actually costs us delivered.
  // It wins over COST where both are filled; see `readCostPrice`.
  landing: 'landing',
  landed_cost: 'landing',
  landing_cost: 'landing',
  sp: 'selling_price',
  price: 'selling_price',
  sale_price: 'selling_price',
  retail_price: 'selling_price',
  unit_price: 'selling_price',
  selling_price: 'selling_price',
  tax: 'tax_type',
  vat: 'tax_type',

  /* --- stock --- */
  qty: 'quantity',
  stock: 'quantity',
  opening_stock: 'quantity',
  quantity_in_stock: 'quantity',
  reorder: 'reorder_level',
  re_order_level: 'reorder_level',
  reorder_point: 'reorder_level',
  min_stock: 'reorder_level',
  minimum_stock: 'reorder_level',

  /* --- read and discarded --- */
  // A second currency we do not price in. It collides with COST once the
  // brackets are stripped, so it has to be named to be kept out of the way.
  cost_usd: '',
  cost_zmw: 'cost_price',
  cost_k: 'cost_price',
  transport_others: '',
  transport: '',
  mark_up: '',
  markup: '',
  gp: '',
  gross_profit: '',
  // Margin as a percentage of the selling price. A working column like the
  // rest, but it is not caught by stripping brackets, so without this it is
  // offered to the operator as a possible shop named "GP On SP".
  gp_on_sp: '',
  gp_percent: '',
  margin: '',
  margin_percent: '',
  // Provenance from whatever merged the buyer's two spreadsheets together.
  match_status: '',
  matched_ap_name: '',
  match_score: '',
  notes: '',
  comment: '',
  comments: '',
  remarks: '',
};

/** Fields the importer understands. Anything else is a candidate shop column. */
export const KNOWN_FIELDS = new Set<string>([
  ...SKU_TEMPLATE_COLUMNS,
  'company',
  'pack_size',
  'landing',
]);

/* ------------------------------------------------------------------ naming */

/** Lowercase, collapse anything that is not a letter or digit to one space. */
export function flatten(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The identity of a row in a sheet with no product codes.
 *
 * Flattened, so `RAINBOW ` and `RAINBOW` are one company and `Zamseed` and
 * `ZAMSEED` are one company — which is the point. Those pairs are the same
 * supplier typed twice, and leaving them distinct would create the catalogue
 * twice over.
 */
export function identityOf(company: string, product: string, packSize: string): string {
  return [flatten(company), flatten(product), flatten(packSize)].join('|');
}

/** A value that reads as a pack size rather than a product code: 25g, 1kg, 1ltr, 500ml. */
const PACK_SIZE_VALUE = /^\d+(\.\d+)?\s*(g|gm|gms|kg|kgs|ml|l|lt|ltr|ltrs|litre|litres|mg|t|ton|tons|pcs|pc|pkt|pack|bag|bags|box|boxes|tab|tabs|dose|doses|units?)$/i;

export interface MisheadedSku {
  /** How many of the values look like a pack size. */
  packSizeValues: number;
  /** Values shared by rows with different product names. */
  sharedValues: number;
  distinctValues: number;
  rows: number;
  /** Whether company + product + this column would identify every row. */
  uniqueAsPackSize: boolean;
  examples: string[];
}

/**
 * Detects the mistake that stopped a real 215-row price master dead: a column
 * headed SKU that actually holds the pack size, so thirty-six different seeds
 * all share the "code" `25g`.
 *
 * Worth detecting rather than leaving to the row-by-row check, because the
 * row-by-row check is right about every row and useless about the cause — it
 * reported 186 separate failures, each asking the operator to "combine them
 * into one row", when what was needed was to change one word in the heading.
 *
 * This deliberately only reports. Silently re-reading the column as a pack size
 * would be a guess about what a file means, and a wrong guess would build the
 * whole catalogue under invented codes.
 */
export function detectMisheadedSku(
  rows: { sku: string; name: string; company: string }[]
): MisheadedSku | null {
  const populated = rows.filter((row) => row.sku.trim() !== '');
  if (populated.length < 5) return null;

  const byValue = new Map<string, Set<string>>();
  let packSizeValues = 0;

  for (const row of populated) {
    const value = row.sku.trim();
    if (PACK_SIZE_VALUE.test(value)) packSizeValues += 1;
    const names = byValue.get(value.toLowerCase()) ?? new Set<string>();
    names.add(flatten(row.name));
    byValue.set(value.toLowerCase(), names);
  }

  const shared = [...byValue.entries()].filter(([, names]) => names.size > 1);
  // Both signals have to agree: values that look like sizes, AND the same value
  // used by genuinely different products. A legitimate code column can repeat
  // (the same product listed twice) without meaning anything is wrong.
  if (packSizeValues < populated.length * 0.6 || shared.length === 0) return null;

  const identities = new Set(
    populated.map((row) => identityOf(row.company, row.name, row.sku))
  );

  return {
    packSizeValues,
    sharedValues: shared.length,
    distinctValues: byValue.size,
    rows: populated.length,
    uniqueAsPackSize: identities.size === populated.length,
    examples: shared.slice(0, 3).map(([value, names]) => `"${value}" (${names.size} different products)`),
  };
}

/**
 * A stable product code for a row that has none.
 *
 * Stable is the whole requirement: the same row in next month's spreadsheet has
 * to produce the same code, or a re-upload builds a second catalogue alongside
 * the first. So it is a pure function of the identity — no counters, no
 * timestamps, nothing read from the database.
 *
 * The company prefix is there to make the code legible on a shelf label; the
 * hash is what actually distinguishes it. Two different rows landing on the
 * same code is possible but very unlikely (32 bits over a few thousand
 * products), and it fails loudly rather than quietly: the importer already
 * rejects a file with a repeated SKU and names both lines.
 */
export function synthesiseSku(company: string, product: string, packSize: string): string {
  const prefix = flatten(company).replace(/[^a-z0-9]/g, '').slice(0, 4).toUpperCase() || 'PROD';
  const hash = fnv1a(identityOf(company, product, packSize));
  return `${prefix}-${hash.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** FNV-1a, 32-bit. Not a security hash — just a well-spread, stable one. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    // The 32-bit FNV prime, by shifts, because `hash * 16777619` loses the low
    // bits to float precision once the product passes 2^53.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The product name, from a sheet that splits it across two columns.
 *
 * The pack size is joined on because it is what distinguishes two otherwise
 * identical rows — `carrots 100g` and `carrots 25g` are different products at
 * different prices, and a catalogue holding two entries both called "Carrots"
 * is unusable at a till. Skipped when the name already ends in it, which the
 * hand-maintained rows sometimes do.
 */
export function productNameFrom(product: string, packSize: string): string {
  // Internal runs of whitespace are collapsed as well as trimmed. `Repacked
  // Urea` and `Repacked  Urea` are the same product typed twice, and the file
  // holds several such pairs; left different they become two catalogue entries.
  const name = sentenceCase(product.trim().replace(/\s+/g, ' '));
  const pack = packSize.trim().replace(/\s+/g, ' ');
  if (!pack) return name;
  if (flatten(name).endsWith(flatten(pack))) return name;
  return `${name} ${pack}`;
}

/**
 * Capitalises the first letter and nothing else.
 *
 * The sheet is typed by hand and its capitalisation is inconsistent — `carrots`
 * next to `Ideal red carrots`. Full title case would "fix" the second one into
 * something nobody wrote and would wreck product codes like `SC627`, so this
 * does the least that stops the catalogue reading as all lower case.
 */
function sentenceCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/**
 * Landed cost if the sheet worked it out, otherwise the bare cost.
 *
 * `Landing` is cost plus inbound transport, so it is the figure the margin
 * should be measured against. It is preferred over `COST` wherever it is
 * filled in, and the fallback matters because our own template has no
 * `Landing` column at all.
 */
export function readCostPrice(record: Record<string, string>): string | undefined {
  const landing = (record.landing ?? '').trim();
  return landing || record.cost_price;
}
