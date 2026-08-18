import { describe, expect, it } from 'vitest';

import { normaliseHeader, normaliseHeaderFull, resolveHeader, tableToObjects } from '../../src/lib/csv.js';
import {
  formatSheetDate,
  HEADER_ALIASES,
  identityOf,
  parseSheetDate,
  parseShopColumn,
  productNameFrom,
  readCostPrice,
  shopPriceColumn,
  shopStockColumn,
  synthesiseSku,
} from '../../src/lib/productSheet.js';

/** The price master's header row, exactly as the buyer's file writes it. */
const PRICE_MASTER_HEADERS = [
  'COMPANY',
  'PRODUCT',
  'PACKSIZE',
  'MATCH STATUS',
  'MATCHED AP NAME',
  'MATCH SCORE',
  'COST (USD)',
  'COST',
  'Transport & Others',
  'Landing',
  'MARK UP',
  'GP',
  'SP',
  'QTY',
  'Katende',
  'Kanakantapa',
  'Chinkuli',
  'Kempekete',
  'Chilyabale',
  'Lwimba',
];

const CARROT_ROW = [
  'STARKE AYRES', 'carrots', '100g', 'Review - check pack size', 'Carrot nantes (100g)', '70',
  '', '201.6', '3', '205', '0.15', '31', '236', '15',
  '235', '245', '245', '245', '250', '250',
];

describe('header resolution', () => {
  it('separates COST (USD) from COST instead of collapsing both to one key', () => {
    // Both strip to `cost`; only the bracket-preserving form tells them apart.
    expect(normaliseHeader('COST (USD)')).toBe('cost');
    expect(normaliseHeader('COST')).toBe('cost');
    expect(normaliseHeaderFull('COST (USD)')).toBe('cost_usd');

    expect(resolveHeader('COST (USD)', HEADER_ALIASES)).toBe('');
    expect(resolveHeader('COST', HEADER_ALIASES)).toBe('cost_price');
  });

  it('still ignores a bracketed unit that only restates the column', () => {
    expect(resolveHeader('Selling Price (K)', HEADER_ALIASES)).toBe('selling_price');
    expect(resolveHeader('Cost Price (ZMW)', HEADER_ALIASES)).toBe('cost_price');
  });

  it('reads the price master into the fields the importer expects', () => {
    const { rows } = tableToObjects([PRICE_MASTER_HEADERS, CARROT_ROW], HEADER_ALIASES);
    const row = rows[0] as Record<string, string>;

    expect(row.company).toBe('STARKE AYRES');
    expect(row.name).toBe('carrots');
    expect(row.pack_size).toBe('100g');
    expect(row.selling_price).toBe('236');
    expect(row.quantity).toBe('15');
    expect(row.landing).toBe('205');
    expect(row.cost_price).toBe('201.6');

    // Provenance and working columns are read and thrown away, not left to be
    // reported to the operator as mystery columns.
    expect(row).not.toHaveProperty('match_status');
    expect(row).not.toHaveProperty('match_score');
    expect(row).not.toHaveProperty('mark_up');
    expect(row).not.toHaveProperty('gp');
  });

  it('leaves the shop columns under their own keys', () => {
    const { rows } = tableToObjects([PRICE_MASTER_HEADERS, CARROT_ROW], HEADER_ALIASES);
    const row = rows[0] as Record<string, string>;

    expect(row.katende).toBe('235');
    expect(row.chilyabale).toBe('250');
  });

  it('keeps the raw headings so a column can be named back to the operator', () => {
    const { rawHeaders } = tableToObjects([PRICE_MASTER_HEADERS, CARROT_ROW], HEADER_ALIASES);
    expect(rawHeaders[14]).toBe('Katende');
  });
});

describe('cost price', () => {
  it('prefers the landed cost over the bare cost', () => {
    expect(readCostPrice({ landing: '205', cost_price: '201.6' })).toBe('205');
  });

  it('falls back to cost when there is no landing column at all', () => {
    // Our own template has no Landing column, and must keep working.
    expect(readCostPrice({ cost_price: '320.00' })).toBe('320.00');
    expect(readCostPrice({ landing: '', cost_price: '320.00' })).toBe('320.00');
  });
});

describe('synthesised product codes', () => {
  it('is stable across runs, so a re-upload updates rather than duplicates', () => {
    const first = synthesiseSku('STARKE AYRES', 'carrots', '100g');
    const second = synthesiseSku('STARKE AYRES', 'carrots', '100g');
    expect(first).toBe(second);
    expect(first).toMatch(/^STAR-[0-9A-F]{8}$/);
  });

  it('separates the same product in different pack sizes', () => {
    expect(synthesiseSku('STARKE AYRES', 'carrots', '100g')).not.toBe(
      synthesiseSku('STARKE AYRES', 'carrots', '25g')
    );
  });

  it('treats a stray trailing space or a case change as the same supplier', () => {
    // `RAINBOW ` / `RAINBOW` and `Zamseed` / `ZAMSEED` are both in the real
    // file; left distinct they would build the catalogue twice.
    expect(synthesiseSku('RAINBOW ', 'Fighter', '1ltr')).toBe(
      synthesiseSku('RAINBOW', 'Fighter', '1ltr')
    );
    expect(synthesiseSku('Zamseed', '608j', '2kg')).toBe(synthesiseSku('ZAMSEED', '608j', '2kg'));
  });

  it('falls back to a readable prefix when the company is blank', () => {
    expect(synthesiseSku('', 'Tent', '5*6m')).toMatch(/^PROD-[0-9A-F]{8}$/);
  });

  it('builds the identity from all three columns', () => {
    expect(identityOf('SEED-CO', 'Maize Seed SC627', '10kg')).toBe('seed co|maize seed sc627|10kg');
  });
});

describe('product names', () => {
  it('joins the pack size on, because it is what tells two rows apart', () => {
    expect(productNameFrom('carrots', '100g')).toBe('Carrots 100g');
    expect(productNameFrom('carrots', '25g')).toBe('Carrots 25g');
  });

  it('capitalises the first letter and leaves the rest of the typing alone', () => {
    expect(productNameFrom('Ideal red carrots', '25g')).toBe('Ideal red carrots 25g');
    expect(productNameFrom('mult-k', '2kg')).toBe('Mult-k 2kg');
  });

  it('does not repeat a pack size the name already ends with', () => {
    expect(productNameFrom('Maize Seed SC627 10kg', '10kg')).toBe('Maize Seed SC627 10kg');
  });

  it('copes with a missing pack size', () => {
    expect(productNameFrom('Land slide', '')).toBe('Land slide');
    expect(productNameFrom('Macro source D.compound', '50kg ')).toBe('Macro source D.compound 50kg');
  });
});

/*
 * Two columns per shop, which is what turned thirteen uploads into one. The
 * suffix says which of the two it is; everything before it has to match a shop
 * the organisation actually has, and that match is the caller's job.
 */
describe('a column named for a shop', () => {
  it('reads a closing stock column and a price column apart', () => {
    expect(parseShopColumn('Lusaka Closing Stock')).toEqual({ shop: 'lusaka', kind: 'stock' });
    expect(parseShopColumn('Lusaka SP Per Stock')).toEqual({ shop: 'lusaka', kind: 'price' });
  });

  it('strips the longest suffix, not the first one that fits', () => {
    // "Closing Stock" ends in "Stock". Taking the short one would leave a shop
    // called "Lusaka Closing", which matches nothing and is silently dropped.
    expect(parseShopColumn('Lusaka Closing Stock')?.shop).toBe('lusaka');
  });

  it('reads a bare shop name as its price, the way older files meant it', () => {
    expect(parseShopColumn('Katende')).toEqual({ shop: 'katende', kind: 'price' });
  });

  it('keeps a two-word shop name together', () => {
    expect(parseShopColumn('Katende East Closing Stock')?.shop).toBe('katende east');
    expect(parseShopColumn('Katende East SP Per Stock')?.shop).toBe('katende east');
  });

  it('round-trips the headings the downloads write', () => {
    for (const name of ['Lusaka', 'Katende East', 'Chinkuli']) {
      expect(parseShopColumn(shopStockColumn(name))).toEqual({
        shop: name.toLowerCase(),
        kind: 'stock',
      });
      expect(parseShopColumn(shopPriceColumn(name))).toEqual({
        shop: name.toLowerCase(),
        kind: 'price',
      });
    }
  });

  it('gives nothing back for an empty heading', () => {
    expect(parseShopColumn('   ')).toBeNull();
  });
});

/*
 * The expiry column. A date typed by a person, printed on a packet, or handed
 * over by Excel as a serial number — all of them arrive in this one field.
 */
describe('expiry dates', () => {
  it('reads the shape both downloads write', () => {
    expect(parseSheetDate('2027-07-15')?.toISOString()).toBe('2027-07-15T00:00:00.000Z');
  });

  it('reads day first, because that is how the shops write it', () => {
    expect(parseSheetDate('03/04/2027')?.toISOString()).toBe('2027-04-03T00:00:00.000Z');
  });

  it('takes the only possible reading when one number is over twelve', () => {
    expect(parseSheetDate('07/15/2027')?.toISOString()).toBe('2027-07-15T00:00:00.000Z');
  });

  it('reads a month with no day as the end of that month, as a packet means it', () => {
    expect(parseSheetDate('07/2027')?.toISOString()).toBe('2027-07-31T00:00:00.000Z');
    expect(parseSheetDate('Jul 2027')?.toISOString()).toBe('2027-07-31T00:00:00.000Z');
  });

  it('reads a two-digit year as this century', () => {
    expect(parseSheetDate('15-JUL-27')?.toISOString()).toBe('2027-07-15T00:00:00.000Z');
  });

  it("reads Excel's serial number, which is what an .xlsx date cell holds", () => {
    // 46583 = 2027-07-15 in Excel's own reckoning.
    expect(parseSheetDate('46583')?.toISOString()).toBe('2027-07-15T00:00:00.000Z');
  });

  it('says nothing for an empty cell, and refuses one it cannot read', () => {
    expect(parseSheetDate('')).toBeNull();
    expect(parseSheetDate('   ')).toBeNull();
    // Not a guess: importing "soon" as a date would put a fiction on a label.
    expect(parseSheetDate('soon')).toBeUndefined();
    expect(parseSheetDate('31/02/2027')).toBeUndefined();
  });

  it('writes back what it reads', () => {
    expect(formatSheetDate(parseSheetDate('15/07/2027') as Date)).toBe('2027-07-15');
    expect(formatSheetDate(null)).toBe('');
  });
});

