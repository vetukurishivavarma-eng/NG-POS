// Run: node --experimental-strip-types scripts/csv-check.mjs
import assert from 'node:assert';
import { statementCsv } from '../src/printing/statement.ts';
const out = statementCsv({ title: 'T', subject: 'S, Ltd', meta: ['m'], columns: [{ label: 'A' }, { label: 'B' }],
  rows: [['Urea "50kg", bag', 'K1,234.50'], ['-K12.00', '1234567890123']], totals: ['Total', 'K1,222.50'], empty: '' });
assert.strictEqual(out, '\ufeffT,"S, Ltd"\r\nm\r\n\r\nA,B\r\n"Urea ""50kg"", bag",1234.50\r\n-12.00,1234567890123\r\nTotal,1222.50\r\n');
console.log('ok');
