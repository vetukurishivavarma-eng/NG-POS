/**
 * Checks the 2026-08-16 fixes against the client's own file.
 *
 *   npx tsx scripts/verify-upload-fix.ts "C:/path/to/file.xlsx"
 *
 * 1. the mis-headed SKU column is detected and explained;
 * 2. the same file with that heading renamed imports cleanly;
 * 3. "GP On SP" is no longer offered as a shop;
 * 4. shop staff can now adjust stock, and still cannot delete.
 */

import { readFileSync } from 'node:fs';

import { tableToObjects } from '../src/lib/csv';
import {
  detectMisheadedSku,
  HEADER_ALIASES,
  KNOWN_FIELDS,
  identityOf,
} from '../src/lib/productSheet';
import { readXlsx } from '../src/lib/xlsx';
import { capabilitiesFor } from '../src/lib/capabilities';

let failures = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : `  — ${extra}`}`);
  if (!ok) failures += 1;
};

const path = process.argv[2] ?? 'C:/Users/Shiva/Downloads/Agro products with Prices_ 1 (1).xlsx';
const { rows: table } = readXlsx(readFileSync(path), { maxRows: 2000 });
const parsed = tableToObjects(table, HEADER_ALIASES);

console.log('\nThe file as uploaded');

const rows = parsed.rows.map((record) => ({
  sku: (record.sku ?? '').trim(),
  name: (record.name ?? '').trim(),
  company: (record.company ?? '').trim(),
}));

const misheaded = detectMisheadedSku(rows);
check('the SKU column is recognised as pack sizes', misheaded !== null);
check(
  'the mistake is explained with examples',
  (misheaded?.examples.length ?? 0) > 0,
  misheaded?.examples.join(', ')
);
check(
  'it knows the file would import once renamed',
  misheaded?.uniqueAsPackSize === true,
  `${misheaded?.rows} rows`
);
if (misheaded) {
  console.log(`        ${misheaded.rows} rows, ${misheaded.distinctValues} distinct values, ${misheaded.sharedValues} shared by different products`);
}

const unclaimed = parsed.rawHeaders
  .map((raw, index) => ({ raw, key: parsed.headers[index] ?? '' }))
  .filter(({ raw, key }) => raw !== '' && key !== '' && !KNOWN_FIELDS.has(key))
  .map(({ raw }) => raw);
check(
  '"GP On SP" is no longer offered as a shop column',
  !unclaimed.some((h) => h.toLowerCase().includes('gp on sp')),
  `candidates: ${unclaimed.join(', ')}`
);
check(
  'the six shops are still offered as shop columns',
  ['Katende', 'Kanakantapa', 'Chinkuli', 'Kempekete', 'Chilyabale', 'Lwimba'].every((shop) =>
    unclaimed.includes(shop)
  ),
  `candidates: ${unclaimed.join(', ')}`
);

console.log('\nThe same file with the heading renamed to PACKSIZE');

const headerIndex = table.findIndex((row) => row.some((cell) => (cell ?? '').trim() !== ''));
const renamed = table.map((row, index) =>
  index === headerIndex
    ? row.map((cell) => ((cell ?? '').trim().toLowerCase() === 'sku' ? 'PACKSIZE' : cell))
    : row
);
const second = tableToObjects(renamed, HEADER_ALIASES);

check('it no longer looks like a coded file', !second.headers.includes('sku'));
check('the pack size column is understood', second.headers.includes('pack_size'));

const identities = new Set(
  second.rows.map((record) =>
    identityOf((record.company ?? '').trim(), (record.name ?? '').trim(), (record.pack_size ?? '').trim())
  )
);
check(
  'every row is a distinct product',
  identities.size === second.rows.length,
  `${identities.size} identities for ${second.rows.length} rows`
);

const withoutQuantity = second.rows.every((record) => (record.quantity ?? '') === '');
check('the file carries no quantities, so stock is left alone', withoutQuantity);

console.log('\nWhat shop staff may now do');

const shopStaff = capabilitiesFor({ role: 'CASHIER', warehouseStaff: false, productEntryOpen: true });
const manager = capabilitiesFor({ role: 'STORE_MANAGER', warehouseStaff: false, productEntryOpen: true });
const afterWindow = capabilitiesFor({ role: 'CASHIER', warehouseStaff: false, productEntryOpen: false });

check('a shop cashier can adjust stock', shopStaff.includes('stock.adjust'));
check('a shop cashier can set prices', shopStaff.includes('pricing.write'));
check('a shop cashier can add and edit products', shopStaff.includes('products.write'));
check('a shop cashier can bulk upload', shopStaff.includes('products.import'));
check('a shop cashier CANNOT delete products', !shopStaff.includes('products.delete'));
check('a shop cashier CANNOT delete a shop', !shopStaff.includes('stores.delete'));
check('a shop cashier CANNOT void a sale', !shopStaff.includes('transactions.void'));
check('a store manager keeps everything they had', manager.includes('refunds.issue') && manager.includes('stock.adjust'));
check(
  'stock adjustment survives the product-entry window closing',
  afterWindow.includes('stock.adjust'),
  'it is a permanent grant, not part of the two-month window'
);
check(
  'adding products still stops when the window closes',
  !afterWindow.includes('products.write'),
  'unchanged from the earlier decision — raise if this should now be permanent'
);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
