import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Builds a real .xlsx in memory, for testing the reader.
 *
 * A committed binary fixture would be the obvious alternative, and a worse one:
 * nobody can review a diff to it, and when a test fails there is no way to see
 * what the file actually contains. This writes the four parts a spreadsheet
 * needs, so what the reader is handed is visible in the test that builds it.
 *
 * Everything goes out as an inline string. Excel itself prefers the shared
 * string table — which the reader also handles, and which `sharedStrings` below
 * switches to, so both paths are covered.
 */
export function buildXlsx(
  rows: string[][],
  options: { sheetName?: string; sharedStrings?: boolean; extraSheet?: string } = {}
): Buffer {
  const sheetName = options.sheetName ?? 'Sheet1';

  const strings: string[] = [];
  const index = new Map<string, number>();
  const intern = (value: string): number => {
    const found = index.get(value);
    if (found !== undefined) return found;
    index.set(value, strings.length);
    strings.push(value);
    return strings.length - 1;
  };

  const body = rows
    .map((cells, r) => {
      const rendered = cells
        .map((value, c) => {
          const ref = `${columnName(c)}${r + 1}`;
          if (value === '') return '';
          if (isNumeric(value)) return `<c r="${ref}"><v>${value}</v></c>`;
          return options.sharedStrings
            ? `<c r="${ref}" t="s"><v>${intern(value)}</v></c>`
            : `<c r="${ref}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${rendered}</row>`;
    })
    .join('');

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;

  const second = options.extraSheet;
  const sheetTags = [
    `<sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/>`,
    second ? `<sheet name="${esc(second)}" sheetId="2" r:id="rId2"/>` : '',
  ].join('');

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`;

  const relTags = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
    second
      ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
      : '',
  ].join('');

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relTags}</Relationships>`;

  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    ],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', rels],
    ['xl/worksheets/sheet1.xml', sheet],
  ];

  if (second) {
    files.push([
      'xl/worksheets/sheet2.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${esc(second)}</t></is></c></row></sheetData></worksheet>`,
    ]);
  }

  if (options.sharedStrings) {
    files.push([
      'xl/sharedStrings.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings
        .map((s) => `<si><t>${esc(s)}</t></si>`)
        .join('')}</sst>`,
    ]);
  }

  return zip(files);
}

function isNumeric(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value);
}

function columnName(index: number): string {
  let name = '';
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* --------------------------------------------------------------- the zip */

/** A stored-and-deflated zip: local headers, central directory, EOCD. */
function zip(files: [string, string][]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of files) {
    const raw = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, deflated);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(8, 10); // deflate
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += 30 + nameBytes.length + deflated.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}
