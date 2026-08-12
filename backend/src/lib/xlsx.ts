/**
 * A read-only .xlsx reader, used for the stock bulk upload.
 *
 * Hand-written for the same reason `csv.ts` is: the job is narrow. We need the
 * cell text of one worksheet, and nothing else — no formulas, no styles, no
 * charts, no writing. The npm options for this are large, and one of them
 * parsing a hostile file is a bigger attack surface than the whole rest of the
 * API put together.
 *
 * An .xlsx is a zip of XML. Node can inflate the entries with `zlib`, so the
 * only real work is walking the zip's central directory and pulling the four
 * parts that matter: the workbook (sheet names), its relationships (sheet name
 * to file), the shared string table, and the sheet itself.
 *
 * What is deliberately not supported: encrypted workbooks (an encrypted file is
 * an OLE container, not a zip, and is rejected as unreadable), and zip64. A
 * spreadsheet big enough to need zip64 is far past the row limit anyway.
 */

import { inflateRawSync } from 'node:zlib';

/** Refuse anything implausible before allocating for it. */
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ENTRY_BYTES = 120 * 1024 * 1024;

export class XlsxError extends Error {}

/* ----------------------------------------------------------------- the zip */

interface ZipEntry {
  /** 0 = stored, 8 = deflate. Everything else we cannot read. */
  method: number;
  offset: number;
  compressedSize: number;
  uncompressedSize: number;
}

/**
 * Indexes the archive from its central directory rather than by scanning local
 * headers, because a local header may declare sizes of zero and defer them to a
 * data descriptor after the payload — which cannot be found without already
 * knowing the size.
 */
function readZip(buffer: Buffer): Map<string, ZipEntry> {
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new XlsxError('That spreadsheet is too large to read.');
  }
  // "PK\x03\x04". An .xls, a PDF renamed, or an encrypted workbook all land here.
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new XlsxError(
      "That doesn't look like an .xlsx file. If it is an older .xls, open it in Excel and use Save As → Excel Workbook (.xlsx)."
    );
  }

  // The end-of-central-directory record is last, but a zip comment may follow
  // it, so scan backwards for the signature.
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('That spreadsheet is damaged — its index is missing.');

  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);

  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) break;

    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);

    entries.set(buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength), {
      method: buffer.readUInt16LE(cursor + 10),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      uncompressedSize: buffer.readUInt32LE(cursor + 24),
      offset: buffer.readUInt32LE(cursor + 42),
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readEntry(buffer: Buffer, entry: ZipEntry): string {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new XlsxError('That spreadsheet is too large to read.');
  }

  // The local header repeats the name and extra fields, and its extra field
  // length may differ from the central directory's — so the payload offset has
  // to come from the local header, not from the entry we indexed.
  const local = entry.offset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) {
    throw new XlsxError('That spreadsheet is damaged.');
  }
  const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const body = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return body.toString('utf8');
  if (entry.method !== 8) throw new XlsxError('That spreadsheet uses an unsupported compression.');

  try {
    return inflateRawSync(body, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
  } catch {
    throw new XlsxError('That spreadsheet is damaged and could not be unpacked.');
  }
}

/* ----------------------------------------------------------------- the xml */

/**
 * The five predefined entities plus numeric references. Ampersand is unescaped
 * last: doing it first would turn a literal `&amp;lt;` into `<`.
 */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

function codePoint(value: number): string {
  return value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
}

/**
 * The text of one `<si>` (shared string) or `<is>` (inline string).
 *
 * Rich text splits a single cell's value across several `<r><t>` runs, so every
 * `<t>` is concatenated. `<rPh>` (phonetic guides on Japanese text) also
 * contains `<t>` and is dropped first, or the reading would be appended to the
 * value.
 */
function textOf(fragment: string): string {
  let out = '';
  for (const match of fragment.replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)) {
    out += decodeXml(match[1] ?? '');
  }
  return out;
}

/** `C` → 2, `AA` → 26. Zero-based. */
function columnIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const code = ref.charCodeAt(i);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

/* --------------------------------------------------------------- the sheet */

export interface XlsxSheet {
  name: string;
  /** Rows of cell text, ragged: trailing empty cells are not padded. */
  rows: string[][];
}

export interface ReadXlsxOptions {
  /** Which sheet to read. Defaults to the first one in the workbook. */
  sheet?: string;
  /** Stop after this many rows, header included. */
  maxRows?: number;
}

/**
 * Reads one worksheet out of an .xlsx as rows of strings.
 *
 * Everything comes back as text, exactly as the CSV path delivers it, so the
 * importer's number and header handling is shared rather than duplicated. Cells
 * carrying a formula yield its last cached result — which is what the person
 * who saved the file was looking at, and the only value available without
 * evaluating the formula ourselves.
 */
export function readXlsx(buffer: Buffer, options: ReadXlsxOptions = {}): XlsxSheet {
  const zip = readZip(buffer);

  const workbookPart = zip.get('xl/workbook.xml');
  if (!workbookPart) throw new XlsxError('That file is a zip, but not a spreadsheet.');
  const workbook = readEntry(buffer, workbookPart);

  /* --- which sheet, and which file is it --- */

  const sheets = [...workbook.matchAll(/<sheet\s[^>]*\/?>/g)].map((tag) => ({
    name: decodeXml(/name="([^"]*)"/.exec(tag[0])?.[1] ?? ''),
    rid: /r:id="([^"]*)"/.exec(tag[0])?.[1] ?? '',
    state: /state="([^"]*)"/.exec(tag[0])?.[1] ?? 'visible',
  }));

  const visible = sheets.filter((s) => s.state === 'visible');
  const candidates = visible.length > 0 ? visible : sheets;
  if (candidates.length === 0) throw new XlsxError('That spreadsheet has no sheets.');

  const wanted = options.sheet
    ? candidates.find((s) => s.name.trim().toLowerCase() === options.sheet?.trim().toLowerCase())
    : candidates[0];
  if (!wanted) {
    throw new XlsxError(
      `That spreadsheet has no sheet called "${options.sheet}". It has: ${candidates.map((s) => s.name).join(', ')}.`
    );
  }

  const rels = zip.get('xl/_rels/workbook.xml.rels');
  let target = '';
  if (rels) {
    const relsXml = readEntry(buffer, rels);
    for (const tag of relsXml.matchAll(/<Relationship\s[^>]*\/?>/g)) {
      if (/Id="([^"]*)"/.exec(tag[0])?.[1] !== wanted.rid) continue;
      target = decodeXml(/Target="([^"]*)"/.exec(tag[0])?.[1] ?? '');
      break;
    }
  }

  // Targets are relative to xl/ and may be written with or without a leading
  // slash or a "/xl/" prefix depending on which tool wrote the file.
  const path = target
    ? target.replace(/^\/?(xl\/)?/, 'xl/')
    : `xl/worksheets/sheet${sheets.indexOf(wanted) + 1}.xml`;

  const sheetPart = zip.get(path) ?? zip.get(path.replace(/^xl\//, ''));
  if (!sheetPart) throw new XlsxError(`Could not find the "${wanted.name}" sheet inside the file.`);

  /* --- the shared string table --- */

  const stringsPart = zip.get('xl/sharedStrings.xml');
  const shared: string[] = [];
  if (stringsPart) {
    const xml = readEntry(buffer, stringsPart);
    for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\s*\/>/g)) {
      shared.push(textOf(si[1] ?? ''));
    }
  }

  /* --- the cells --- */

  const sheetXml = readEntry(buffer, sheetPart);
  const limit = options.maxRows ?? Number.POSITIVE_INFINITY;
  const rows: string[][] = [];

  for (const rowMatch of sheetXml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>|<row[^>]*\/>/g)) {
    if (rows.length >= limit) break;

    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(
      /<c\s([^>]*?)\/>|<c\s([^>]*?)>([\s\S]*?)<\/c>/g
    )) {
      const attrs = cellMatch[1] ?? cellMatch[2] ?? '';
      const body = cellMatch[3] ?? '';
      const index = columnIndex(/r="([A-Z]+)/.exec(attrs)?.[1] ?? '');
      if (index < 0) continue;

      const type = /t="([^"]*)"/.exec(attrs)?.[1] ?? 'n';
      let value: string;

      if (type === 's') {
        // Shared string: <v> is an index into the table.
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        value = shared[Number(raw)] ?? '';
      } else if (type === 'inlineStr') {
        value = textOf(body);
      } else if (type === 'e') {
        // #REF!, #N/A and friends. Blank, so a broken formula reads as an empty
        // cell rather than as the literal text "#N/A" in a price column.
        value = '';
      } else if (type === 'b') {
        value = (/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '') === '1' ? 'TRUE' : 'FALSE';
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }

      // Gaps: a row may skip empty cells entirely, so position by reference.
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }

    // A blank spacer row is not data. Matches the CSV reader, which drops them.
    if (cells.some((c) => c.trim() !== '')) rows.push(cells);
  }

  return { name: wanted.name, rows };
}

/** True when the bytes start with a zip signature, i.e. worth trying to read. */
export function looksLikeXlsx(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
}
