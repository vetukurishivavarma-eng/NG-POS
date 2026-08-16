/**
 * Checks the 2026-08-16 upload fixes against the client's own file.
 *
 *   npx tsx scripts/verify-upload-fix.ts ["C:/path/to/file.xlsx"]
 *
 * The point of the exercise: the file imports **exactly as the client sends
 * it**, with its SKU column full of pack sizes. Nothing is renamed by hand.
 */

import { readFileSync } from 'node:fs';

import { tableToObjects } from '../src/lib/csv';
import {
  detectMisheadedSku,
  HEADER_ALIASES,
  identityOf,
  KNOWN_FIELDS,
  synthesiseSku,
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
const records = parsed.rows;

console.log('\nThe client\'s file, exactly as sent');

check('it is read as a coded file at first glance', parsed.headers.includes('sku'));

const misheaded = detectMisheadedSku(
  records.map((r) => ({
    sku: (r.sku ?? '').trim(),
    name: (r.name ?? '').trim(),
    company: (r.company ?? '').trim(),
  }))
);

check('the SKU column is recognised as pack sizes', misheaded !== null);
check(
  'company + product + pack size identifies every row',
  misheaded?.uniqueAsPackSize === true,
  `${misheaded?.rows} rows, ${misheaded?.distinctValues} distinct values`
);
if (misheaded) {
  console.log(`        e.g. ${misheaded.examples.join(', ')}`);
}

/* --- the reinterpretation the route performs, applied here the same way --- */

const adopted = records.map((r) => ({ ...r, pack_size: (r.sku ?? '').trim(), sku: '' }));

const identities = new Set(
  adopted.map((r) => identityOf((r.company ?? '').trim(), (r.name ?? '').trim(), r.pack_size))
);
check(
  'every row becomes a distinct product',
  identities.size === adopted.length,
  `${identities.size} of ${adopted.length}`
);

const codes = new Set(
  adopted.map((r) => synthesiseSku((r.company ?? '').trim(), (r.name ?? '').trim(), r.pack_size))
);
check('every row gets its own generated code', codes.size === adopted.length, `${codes.size} codes`);

// The codes have to be the same next month, or a re-upload builds a second
// catalogue beside the first.
const again = new Set(
  adopted.map((r) => synthesiseSku((r.company ?? '').trim(), (r.name ?? '').trim(), r.pack_size))
);
check('the codes are stable across runs', [...codes].every((c) => again.has(c)));

console.log('\nColumns');

const unclaimed = parsed.rawHeaders
  .map((raw, index) => ({ raw, key: parsed.headers[index] ?? '' }))
  .filter(({ raw, key }) => raw !== '' && key !== '' && !KNOWN_FIELDS.has(key))
  .map(({ raw }) => raw);

check(
  '"GP On SP" is not offered as a shop',
  !unclaimed.some((h) => h.toLowerCase().includes('gp on sp')),
  `candidates: ${unclaimed.join(', ')}`
);
check(
  'all six shops are offered as price columns',
  ['Katende', 'Kanakantapa', 'Chinkuli', 'Kempekete', 'Chilyabale', 'Lwimba'].every((s) =>
    unclaimed.includes(s)
  ),
  `candidates: ${unclaimed.join(', ')}`
);
check(
  'the file carries no quantities, so stock is left alone',
  records.every((r) => (r.quantity ?? '') === '')
);

const zeroPrices = records.reduce((total, r) => {
  const shops = ['katende', 'kanakantapa', 'chinkuli', 'kempekete', 'chilyabale', 'lwimba'];
  return total + shops.filter((s) => (r[s] ?? '').trim() !== '' && Number((r[s] ?? '').replace(/,/g, '')) === 0).length;
}, 0);
check('the zero shop prices are still there to be skipped', zeroPrices > 0, `${zeroPrices} cells`);

/* --- a real code column must not be mistaken for a pack size --- */

console.log('\nA file that genuinely uses product codes');

const coded = [
  { sku: 'ABC123', name: 'Carrot nantes', company: 'Starke Ayres' },
  { sku: 'ABC124', name: 'Chinese Cabbage', company: 'Starke Ayres' },
  { sku: 'ABC125', name: 'Okra', company: 'Starke Ayres' },
  { sku: 'ABC126', name: 'Lettuce', company: 'Starke Ayres' },
  { sku: 'ABC127', name: 'Giant rape', company: 'Zamseed' },
  { sku: 'ABC128', name: 'Onion red', company: 'Zamseed' },
];
check('a proper code column is left alone', detectMisheadedSku(coded) === null);

// The same product listed twice under one code is a repeat, not a pack size.
const repeated = [...coded, { sku: 'ABC123', name: 'Carrot nantes', company: 'Starke Ayres' }];
check('a repeated row does not trigger it', detectMisheadedSku(repeated) === null);

// Codes that happen to be short and numeric are still codes.
const numericCodes = [
  { sku: '1001', name: 'Carrot nantes', company: 'Starke Ayres' },
  { sku: '1002', name: 'Chinese Cabbage', company: 'Starke Ayres' },
  { sku: '1003', name: 'Okra', company: 'Starke Ayres' },
  { sku: '1004', name: 'Lettuce', company: 'Starke Ayres' },
  { sku: '1005', name: 'Giant rape', company: 'Zamseed' },
  { sku: '1006', name: 'Onion red', company: 'Zamseed' },
];
check('numeric codes are not read as pack sizes', detectMisheadedSku(numericCodes) === null);

console.log('\nWhat shop staff may do');

const cashier = capabilitiesFor({ role: 'CASHIER', warehouseStaff: false, productEntryOpen: true });
const afterWindow = capabilitiesFor({ role: 'CASHIER', warehouseStaff: false, productEntryOpen: false });

check('a shop cashier can adjust stock', cashier.includes('stock.adjust'));
check('a shop cashier can set prices', cashier.includes('pricing.write'));
check('a shop cashier can add and edit products', cashier.includes('products.write'));
check('a shop cashier CANNOT delete products', !cashier.includes('products.delete'));
check('a shop cashier CANNOT delete a shop', !cashier.includes('stores.delete'));
check('stock adjustment outlives the product-entry window', afterWindow.includes('stock.adjust'));
check('adding products still ends with the window', !afterWindow.includes('products.write'));

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
