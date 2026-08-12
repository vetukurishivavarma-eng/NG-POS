/**
 * Minimal ESC/POS command builder.
 *
 * Everything is assembled as raw bytes and handed to the native module base64
 * encoded, because control codes (0x1B, 0x1D, 0x00) do not survive being
 * treated as a JS string.
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export type Align = 'left' | 'center' | 'right';

/** Characters per line at Font A. 58mm paper fits 32, 80mm fits 48. */
export type PaperWidth = 32 | 48;

/** A fixed-width, right-aligned cell in a `cells()` row. */
export interface Cell {
  text: string;
  width: number;
  align?: Align;
}

export class EscPosBuilder {
  private bytes: number[] = [];

  /**
   * The current character multiplier, tracked because it changes how many
   * characters fit on a line. Every layout helper divides by it — without that,
   * a double-width `TOTAL` row is padded to the full 48 characters, occupies 96
   * character cells the paper does not have, and wraps onto a second line.
   */
  private scale: 1 | 2 | 3 | 4 = 1;

  constructor(readonly width: PaperWidth = 48) {
    this.raw(ESC, 0x40); // Initialise: clears any state left by the last job.
  }

  /** Characters that actually fit on a line at the current size. */
  get cols(): number {
    return Math.max(1, Math.floor(this.width / this.scale));
  }

  /** True for 80mm paper, where a three-column item row fits. */
  get wide(): boolean {
    return this.width >= 48;
  }

  raw(...values: number[]): this {
    this.bytes.push(...values);
    return this;
  }

  align(mode: Align): this {
    const n = mode === 'center' ? 1 : mode === 'right' ? 2 : 0;
    return this.raw(ESC, 0x61, n);
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  /** Multiplies character width/height, 1–4. */
  size(scale: 1 | 2 | 3 | 4): this {
    this.scale = scale;
    const n = (scale - 1) * 0x10 + (scale - 1);
    return this.raw(GS, 0x21, n);
  }

  text(value: string): this {
    for (const byte of encodeAscii(value)) this.bytes.push(byte);
    return this;
  }

  line(value = ''): this {
    return this.text(value).raw(LF);
  }

  /** `Label............1,234.00` — the workhorse of a receipt body. */
  columns(left: string, right: string): this {
    const width = this.cols;
    const gap = Math.max(1, width - left.length - right.length);
    if (left.length + right.length + 1 > width) {
      // Too long for one line: give the label its own line, right-align the value.
      return this.line(left).line(right.padStart(width));
    }
    return this.line(left + ' '.repeat(gap) + right);
  }

  /**
   * A flexible left cell followed by fixed-width ones — `NAME  QTY  PRICE  AMT`.
   *
   * This is what 80mm paper buys: at 32 characters an itemised line has to be
   * split across two rows, and at 48 the whole thing fits on one, so a ten-line
   * sale is ten lines of paper rather than twenty.
   *
   * The left cell is truncated rather than wrapped, because a receipt column
   * that reflows stops lining up with the ones above it.
   */
  cells(left: string, ...right: Cell[]): this {
    const fixed = right.reduce((sum, c) => sum + c.width + 1, 0);
    const room = Math.max(1, this.cols - fixed);

    const parts = [left.length > room ? left.slice(0, room) : left.padEnd(room)];
    for (const cell of right) {
      const text = cell.text.length > cell.width ? cell.text.slice(0, cell.width) : cell.text;
      parts.push(cell.align === 'left' ? text.padEnd(cell.width) : text.padStart(cell.width));
    }
    return this.line(parts.join(' ').trimEnd());
  }

  rule(char = '-'): this {
    return this.line(char.repeat(this.cols));
  }

  feed(lines = 1): this {
    for (let i = 0; i < lines; i += 1) this.bytes.push(LF);
    return this;
  }

  /**
   * Full cut, after the shortest feed that clears the cutter.
   *
   * Two lines, not three: the cutter sits about that far past the print head,
   * so anything more is blank paper thrown away on every single receipt.
   */
  cut(): this {
    return this.feed(2).raw(GS, 0x56, 0x00);
  }

  /** Opens a cash drawer wired to the printer's RJ11 kick port. */
  openDrawer(): this {
    return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa);
  }

  toBase64(): string {
    return bytesToBase64(Uint8Array.from(this.bytes));
  }
}

/**
 * ESC/POS printers default to a single-byte code page. Anything outside ASCII
 * prints as garbage, so transliterate what we can and drop the rest.
 */
function encodeAscii(value: string): number[] {
  const out: number[] = [];
  for (const char of value.normalize('NFKD')) {
    const code = char.charCodeAt(0);
    if (code === 0x2018 || code === 0x2019) out.push(0x27); // curly → straight quote
    else if (code === 0x201c || code === 0x201d) out.push(0x22);
    else if (code === 0x2013 || code === 0x2014) out.push(0x2d); // dash
    else if (code < 0x80) out.push(code);
    else if (code > 0x300 && code < 0x370) continue; // combining marks from NFKD
    else out.push(0x3f); // '?'
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** React Native has no Buffer, so encode by hand. */
function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64[b2 & 0x3f];
  }
  return out;
}
