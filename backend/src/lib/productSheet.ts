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
 * The columns of the one sheet the app now hands out, before the shop columns.
 *
 * There used to be two shapes to choose between when downloading — our coded
 * template and the buyer's price master — and choosing wrong was silent: the
 * price list had no stock in it, so a shop that wanted to send its counts back
 * had picked the other file an hour earlier. One shape removes the choice. Both
 * downloads write these columns and then two per shop; see `shopColumnNames`.
 *
 * `SKU` leads and is blank on the template. It is not there to be typed — a
 * code is worked out from COMPANY + PRODUCT + PACKSIZE for any row that leaves
 * it empty — it is there so the *current list* carries the codes the catalogue
 * already has, and comes back matching them instead of building a second
 * catalogue beside the first under synthesised ones.
 *
 * The price master's working columns (Landing, MARK UP, GP, Transport) are not
 * written: they are the buyer's arithmetic, and we have no figure to put in
 * them. They are still read on the way in, so his own sheet imports unchanged.
 */
export const SHEET_COLUMNS = [
  'SKU',
  'COMPANY',
  'PRODUCT',
  'PACKSIZE',
  'CHEMICAL NAME',
  'EXPIRY DATE',
  'CATEGORY',
  'UNIT',
  'TAX',
] as const;

/**
 * The buying price, which is the owner's column and nobody else's.
 *
 * Separate from the list above because it is the one heading that comes and
 * goes with the account. It used to be written blank for a shop, to keep every
 * account's file identical — but a column the person holding the sheet can
 * never see and never fill is not consistency, it is a question they have to
 * ask. Their file simply does not have it.
 */
export const COST_COLUMNS = ['COST', 'TRANSPORT COST'] as const;

/**
 * The product columns for an account, before the shop columns.
 *
 * There is deliberately no chain-wide selling price here. There was, called
 * `SP`, and it sat two columns away from "<shop> SP Per Stock" looking like the
 * same thing written twice — the reasonable question being which of the two the
 * till actually charges. Now only the shops carry prices, and the fallback a
 * product needs for a shop that has not priced it is worked out from them
 * rather than typed a second time. `SP` is still *read*, so the buyer's own
 * price master imports unchanged; it is no longer *written*.
 */
export function sheetColumns(showCosts: boolean): string[] {
  return showCosts ? [...SHEET_COLUMNS, ...COST_COLUMNS] : [...SHEET_COLUMNS];
}

/** What a shop's two columns are called, in the order they are written. */
export function shopStockColumn(shopName: string): string {
  return `${shopName} Closing Stock`;
}

export function shopPriceColumn(shopName: string): string {
  return `${shopName} SP Per Stock`;
}

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

  /* --- what is in the tin, and how long it lasts --- */
  chemical: 'chemical_name',
  chemical_name: 'chemical_name',
  active_ingredient: 'chemical_name',
  ingredient: 'chemical_name',
  ingredients: 'chemical_name',
  composition: 'chemical_name',
  generic_name: 'chemical_name',
  expiry: 'expiry_date',
  expiry_date: 'expiry_date',
  expires: 'expiry_date',
  expires_on: 'expiry_date',
  exp: 'expiry_date',
  exp_date: 'expiry_date',
  expiration: 'expiry_date',
  expiration_date: 'expiry_date',
  best_before: 'expiry_date',
  use_by: 'expiry_date',

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
  transport_others: 'transport_cost',
  transport: 'transport_cost',
  transport_cost: 'transport_cost',
  freight: 'transport_cost',
  carriage: 'transport_cost',
  delivery_cost: 'transport_cost',
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
  'chemical_name',
  'expiry_date',
  'transport_cost',
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

/**
 * What the item costs delivered, from however the sheet chose to say it.
 *
 * Three spellings of one figure. The buyer's price master works out `Landing`
 * itself, so where that column is filled it is taken as final — it is his
 * arithmetic and we should not redo it. Our own sheet has no Landing column
 * and instead writes the two halves, so they are added.
 *
 * Transport with no buying price beside it leaves the landed cost unstated
 * rather than making transport the whole of it: a row that fills one cost cell
 * and not the other is half-finished, and half-finished is not the same as
 * "this product costs three kwacha".
 */
export function landedCost(
  landing: number | null,
  cost: number | null,
  transport: number | null
): number | null {
  if (landing !== null) return landing;
  if (cost === null) return null;
  return Math.round((cost + (transport ?? 0)) * 100) / 100;
}

/* -------------------------------------------------- a column named for a shop */

export type ShopColumnKind = 'stock' | 'price';

/**
 * What the two suffixes are called, in every spelling a hand-typed sheet uses.
 *
 * Matched longest first, which is the whole reason they are sorted: "Lusaka
 * Closing Stock" ends in "stock" as well as in "closing stock", and stripping
 * the short one would leave a shop called "Lusaka Closing".
 */
const SHOP_COLUMN_SUFFIXES: readonly (readonly [string, ShopColumnKind])[] = (
  [
    ['closing stock', 'stock'],
    ['closing balance', 'stock'],
    ['closing quantity', 'stock'],
    ['closing qty', 'stock'],
    ['closing', 'stock'],
    ['stock on hand', 'stock'],
    ['on hand', 'stock'],
    ['stock qty', 'stock'],
    ['stock', 'stock'],
    ['quantity', 'stock'],
    ['qty', 'stock'],
    ['sp per stock', 'price'],
    ['sp per unit', 'price'],
    ['sp per item', 'price'],
    ['selling price', 'price'],
    ['sale price', 'price'],
    ['unit price', 'price'],
    ['retail price', 'price'],
    ['price', 'price'],
    ['rate', 'price'],
    ['sp', 'price'],
  ] as const
)
  .slice()
  .sort((a, b) => b[0].length - a[0].length);

export interface ShopColumnName {
  /** The heading with its suffix taken off, flattened for matching. */
  shop: string;
  kind: ShopColumnKind;
}

/**
 * Reads "Lusaka Closing Stock" as Lusaka's shelf and "Lusaka SP Per Stock" as
 * Lusaka's price.
 *
 * A bare shop name is a price, which is not a guess: that is what the columns
 * meant in every sheet uploaded before the stock column existed, and a file
 * kept from then must keep meaning what it did.
 *
 * Nothing here knows the shops. The caller matches `shop` against the
 * organisation's own list, so a heading that strips to something that is not a
 * shop is reported as unrecognised rather than acted on.
 */
export function parseShopColumn(header: string): ShopColumnName | null {
  const flat = flatten(header);
  if (!flat) return null;

  for (const [suffix, kind] of SHOP_COLUMN_SUFFIXES) {
    if (!flat.endsWith(` ${suffix}`)) continue;
    const shop = flat.slice(0, -(suffix.length + 1)).trim();
    if (shop) return { shop, kind };
  }

  return { shop: flat, kind: 'price' };
}

/* ------------------------------------------------------------ expiry dates */

const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

/** Midnight UTC, so a date column cannot drift a day either way on the way in. */
function utcDate(year: number, month: number, day: number): Date | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31 February, which rolls forward silently otherwise.
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : undefined;
}

/** A two-digit year on a packet is this century: `07/27` is 2027, not 1927. */
function fullYear(value: number): number {
  return value >= 100 ? value : 2000 + value;
}

/** The last day of a month, for an expiry printed as "07/2027" with no day. */
function endOfMonth(year: number, month: number): Date | undefined {
  if (month < 1 || month > 12) return undefined;
  return new Date(Date.UTC(year, month, 0));
}

/**
 * An expiry date as it is actually written: on a packet, in Excel, or by hand.
 *
 * Returns `null` for an empty cell and `undefined` for one that could not be
 * read — the caller turns the second into a row error rather than importing a
 * product whose expiry is a guess.
 *
 * Day comes before month where both could be either, because the shops are in
 * Zambia and write 03/04/2027 as the third of April. Where the second number is
 * over twelve the file has said which way round it is, and that wins.
 */
export function parseSheetDate(raw: string | undefined | null): Date | null | undefined {
  const text = (raw ?? '').trim();
  if (!text) return null;

  // Excel hands a date cell over as a serial number: days since 1899-12-30.
  // Floored at 1000 (Sept 1902) so a quantity typed into the wrong column is
  // not read as a date, and capped at 2958465 (31 Dec 9999), Excel's own limit.
  if (/^\d{4,7}$/.test(text)) {
    const serial = Number(text);
    if (serial >= 1000 && serial <= 2958465) {
      return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    }
    return undefined;
  }

  // 2027-07-15, and what Excel writes when it exports a date cell to CSV.
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(text);
  if (iso) return utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // 15/07/2027, 15-7-27.
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(text);
  if (dmy) {
    let day = Number(dmy[1]);
    let month = Number(dmy[2]);
    // Only one reading is possible once a component is over twelve.
    if (day > 12 && month <= 12) {
      /* already day-first */
    } else if (month > 12 && day <= 12) {
      [day, month] = [month, day];
    }
    return utcDate(fullYear(Number(dmy[3])), month, day);
  }

  // 07/2027, 7-27: a month with no day, which is how a packet is printed.
  const my = /^(\d{1,2})[-/.](\d{2,4})$/.exec(text);
  if (my) return endOfMonth(fullYear(Number(my[2])), Number(my[1]));

  // Jul 2027, JUL-27, July 2027.
  const named = /^([A-Za-z]{3,})[\s\-/.]+(\d{2,4})$/.exec(text);
  if (named) {
    const month = MONTHS.indexOf((named[1] as string).slice(0, 3).toLowerCase()) + 1;
    return month ? endOfMonth(fullYear(Number(named[2])), month) : undefined;
  }

  // 15 Jul 2027, 15-JUL-2027.
  const dNamedY = /^(\d{1,2})[\s\-/.]+([A-Za-z]{3,})[\s\-/.]+(\d{2,4})$/.exec(text);
  if (dNamedY) {
    const month = MONTHS.indexOf((dNamedY[2] as string).slice(0, 3).toLowerCase()) + 1;
    return month ? utcDate(fullYear(Number(dNamedY[3])), month, Number(dNamedY[1])) : undefined;
  }

  return undefined;
}

/** A stored expiry as the sheet writes it back out: 2027-07-15. */
export function formatSheetDate(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : '';
}
