/**
 * Diagnoses a client's upload file with the importer's own reader.
 *
 *   npx tsx scripts/diagnose-upload.ts "C:/path/to/file.xlsx"
 *
 * Prints how each heading was understood, then whether the rows carry a usable
 * identity. Written for the 2026-08-16 report that a 217-row price master
 * failed with "186 lines could not be read".
 */

import { readFileSync } from 'node:fs';

import { readXlsx } from '../src/lib/xlsx';
import { tableToObjects } from '../src/lib/csv';
import { HEADER_ALIASES, KNOWN_FIELDS } from '../src/lib/productSheet';

const path = process.argv[2];
if (!path) {
  console.error('Usage: npx tsx scripts/diagnose-upload.ts "<file.xlsx>"');
  process.exit(1);
}

const { rows: table } = readXlsx(readFileSync(path), { maxRows: 2000 });
console.log(`rows read from the sheet: ${table.length}`);

const parsed = tableToObjects(table, HEADER_ALIASES);

console.log('\nHOW EACH HEADING WAS UNDERSTOOD');
parsed.rawHeaders.forEach((raw, index) => {
  if (!raw) return;
  const key = parsed.headers[index] ?? '';
  const meaning = key === '' ? '(read and discarded)' : KNOWN_FIELDS.has(key) ? key : `${key}  <- shop column?`;
  console.log(`  ${raw.padEnd(24)} -> ${meaning}`);
});

const hasSku = parsed.headers.includes('sku');
const hasName = parsed.headers.includes('name');
console.log(`\nidentity mode: ${hasSku ? 'SKU column' : hasName ? 'company + product + pack size' : 'NONE — the file would be rejected'}`);
console.log(`data rows: ${parsed.rows.length}`);

if (hasSku) {
  const bySku = new Map<string, { line: number; name: string }[]>();
  parsed.rows.forEach((row, index) => {
    const sku = (row.sku ?? '').trim().toLowerCase();
    if (!sku) return;
    const entry = { line: index + 2, name: (row.name ?? '').trim() };
    bySku.set(sku, [...(bySku.get(sku) ?? []), entry]);
  });

  const clashes = [...bySku.entries()].filter(
    ([, entries]) => new Set(entries.map((e) => e.name.toLowerCase())).size > 1
  );

  console.log(`\ndistinct values in the SKU column: ${bySku.size}`);
  console.log(`SKU values shared by DIFFERENT products: ${clashes.length}`);
  for (const [sku, entries] of clashes.slice(0, 6)) {
    console.log(`  "${sku}" is used by ${entries.length} products, e.g. ${entries.slice(0, 3).map((e) => `${e.name} (line ${e.line})`).join(', ')}`);
  }

  const rowsInvolved = clashes.reduce((total, [, entries]) => total + entries.length - 1, 0);
  console.log(`\nrows that would be rejected for this reason: ~${rowsInvolved}`);
}

/* --- what happens if that column is a pack size rather than a code --- */

console.log('\n--- THE SAME FILE WITH THE "SKU" HEADING RENAMED TO "PACKSIZE" ---');
const renamed = table.map((row, index) =>
  index === 0 ? row : row
);
const headerIndex = table.findIndex((row) => row.some((cell) => (cell ?? '').trim() !== ''));
const rebuilt = table.map((row, index) => {
  if (index !== headerIndex) return row;
  return row.map((cell) => ((cell ?? '').trim().toLowerCase() === 'sku' ? 'PACKSIZE' : cell));
});
void renamed;

const second = tableToObjects(rebuilt, HEADER_ALIASES);
const secondHasSku = second.headers.includes('sku');
console.log(`identity mode: ${secondHasSku ? 'SKU column' : 'company + product + pack size'}`);

const identities = new Map<string, number>();
second.rows.forEach((row) => {
  const key = [
    (row.company ?? '').trim().toLowerCase(),
    (row.name ?? '').trim().toLowerCase(),
    (row.pack_size ?? '').trim().toLowerCase(),
  ].join('|');
  identities.set(key, (identities.get(key) ?? 0) + 1);
});
const duplicated = [...identities.values()].filter((n) => n > 1).length;
console.log(`rows: ${second.rows.length}`);
console.log(`distinct products (company + product + pack size): ${identities.size}`);
console.log(`identities appearing more than once: ${duplicated}`);
