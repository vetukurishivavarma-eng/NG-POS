import { describe, expect, it } from 'vitest';

import { looksLikeXlsx, readXlsx, XlsxError } from '../../src/lib/xlsx.js';
import { buildXlsx } from '../helpers/xlsx.js';

describe('xlsx reader', () => {
  it('reads a sheet of inline strings and numbers', () => {
    const file = buildXlsx([
      ['COMPANY', 'PRODUCT', 'SP'],
      ['STARKE AYRES', 'carrots', '236'],
    ]);

    expect(readXlsx(file).rows).toEqual([
      ['COMPANY', 'PRODUCT', 'SP'],
      ['STARKE AYRES', 'carrots', '236'],
    ]);
  });

  it('reads the shared string table Excel actually writes', () => {
    const file = buildXlsx(
      [
        ['COMPANY', 'PRODUCT'],
        ['OSHO', 'Kolopa'],
        ['OSHO', 'Athens'],
      ],
      { sharedStrings: true }
    );

    expect(readXlsx(file).rows[2]).toEqual(['OSHO', 'Athens']);
  });

  it('decodes the entities a heading like "Transport & Others" arrives as', () => {
    const file = buildXlsx([['Transport & Others', 'A "quoted" bit']]);
    expect(readXlsx(file).rows[0]).toEqual(['Transport & Others', 'A "quoted" bit']);
  });

  it('positions cells by reference, so a skipped blank does not shift a row', () => {
    // A row that omits its empty cells entirely is normal in a real workbook;
    // read positionally, every later column lands one place to the left.
    const file = buildXlsx([
      ['a', 'b', 'c', 'd'],
      ['1', '', '', '4'],
    ]);
    expect(readXlsx(file).rows[1]).toEqual(['1', '', '', '4']);
  });

  it('drops blank spacer rows, as the csv reader does', () => {
    const file = buildXlsx([['a'], [''], ['b']]);
    expect(readXlsx(file).rows).toEqual([['a'], ['b']]);
  });

  it('takes the first sheet by default and a named one on request', () => {
    const file = buildXlsx([['first']], { sheetName: 'Merged Master', extraSheet: 'Legend' });

    expect(readXlsx(file).name).toBe('Merged Master');
    expect(readXlsx(file, { sheet: 'legend' }).rows[0]).toEqual(['Legend']);
  });

  it('names the sheets it does have when asked for one it does not', () => {
    const file = buildXlsx([['x']], { sheetName: 'Merged Master' });
    expect(() => readXlsx(file, { sheet: 'Prices' })).toThrow(/Merged Master/);
  });

  it('stops at maxRows', () => {
    const file = buildXlsx([['a'], ['b'], ['c'], ['d']]);
    expect(readXlsx(file, { maxRows: 2 }).rows).toHaveLength(2);
  });

  it('rejects a file that is not a workbook, and says what to do about it', () => {
    expect(() => readXlsx(Buffer.from('sku,name\nA-1,Feed\n'))).toThrow(XlsxError);
    expect(() => readXlsx(Buffer.from('sku,name\nA-1,Feed\n'))).toThrow(/\.xlsx/);
  });

  it('rejects a zip that is not a spreadsheet', () => {
    const notASheet = buildXlsx([['a']]);
    // Corrupt the workbook part's name in both the local header and the
    // directory so the entry can no longer be found.
    const broken = Buffer.from(
      notASheet.toString('latin1').replaceAll('xl/workbook.xml', 'xl/workbooc.xml'),
      'latin1'
    );
    expect(() => readXlsx(broken)).toThrow(/not a spreadsheet/);
  });

  it('recognises a workbook by its signature', () => {
    expect(looksLikeXlsx(buildXlsx([['a']]))).toBe(true);
    expect(looksLikeXlsx(Buffer.from('sku,name'))).toBe(false);
  });
});
