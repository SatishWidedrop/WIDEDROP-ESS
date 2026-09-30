/**
 * A very small PDF writer.
 *
 * Enough for a payslip and a letter: text in two weights, horizontal rules,
 * filled bands, and right-aligned figures. Not a typesetting engine and not
 * trying to be one.
 *
 * ── Why this is hand-written ─────────────────────────────────────────
 * Because a payslip has to be reproducible. The system's claim is that the
 * same inputs produce the same output, and every payslip carries a
 * `sourceDigest` saying so; a document library that stamps a creation date, or
 * whose next minor version lays text out a hair differently, quietly breaks
 * that. Here the bytes are a function of the data and nothing else — render the
 * same payslip twice, a year apart, and the files are identical.
 *
 * It also means no font to embed, license or keep patched: Helvetica and
 * Helvetica-Bold are two of the fourteen standard faces every PDF reader
 * carries, so the file stays a few kilobytes and needs nothing from the system
 * it opens on.
 *
 * ── What that costs ──────────────────────────────────────────────────
 * The standard fonts use WinAnsiEncoding, which has no rupee sign. The portal
 * writes `₹1,23,456`; a document written here says `INR 1,23,456.00`, which is
 * what a payslip or a bank statement says anyway. Gaining one glyph is not
 * worth embedding a font for.
 */

const PAGE = { width: 595.28, height: 841.89 } as const; // A4, in points.

export const A4 = PAGE;

export type FontWeight = 'regular' | 'bold';

interface Op {
  /** Rendered into the content stream in the order they were added. */
  render(): string;
}

export interface TextOptions {
  size?: number;
  weight?: FontWeight;
  /** 0 is black, 1 is white. */
  grey?: number;
  /** `left` by default. `right` and `centre` measure the string first. */
  align?: 'left' | 'right' | 'centre';
}

export class PdfPage {
  private readonly ops: Op[] = [];

  /**
   * Draw text with its baseline at `y`, measured from the top of the page.
   *
   * Top-down because every caller thinks in rows down a page, and PDF's own
   * origin is the bottom-left corner. Converting once here beats every call
   * site subtracting from 842.
   */
  text(x: number, y: number, value: string, options: TextOptions = {}): this {
    const size = options.size ?? 9;
    const weight = options.weight ?? 'regular';
    const grey = options.grey ?? 0;
    const align = options.align ?? 'left';

    const text = toWinAnsi(value);
    const width = measure(text, size, weight);
    const left = align === 'right' ? x - width : align === 'centre' ? x - width / 2 : x;
    const baseline = PAGE.height - y;

    const font = weight === 'bold' ? '/F2' : '/F1';
    this.ops.push({
      render: () =>
        `q ${num(grey)} g BT ${font} ${num(size)} Tf ` +
        `1 0 0 1 ${num(left)} ${num(baseline)} Tm (${escapeText(text)}) Tj ET Q`,
    });
    return this;
  }

  /** A horizontal rule. */
  rule(x1: number, y: number, x2: number, options: { grey?: number; width?: number } = {}): this {
    const grey = options.grey ?? 0.8;
    const lineWidth = options.width ?? 0.5;
    const at = PAGE.height - y;
    this.ops.push({
      render: () =>
        `q ${num(grey)} G ${num(lineWidth)} w ${num(x1)} ${num(at)} m ${num(x2)} ${num(at)} l S Q`,
    });
    return this;
  }

  /**
   * A filled band, for a table header or a total row.
   *
   * `g`, not `rg`: the non-stroking colour operators are `g` for one grey
   * component and `rg` for three. Given one operand, `rg` is malformed, the
   * reader ignores it, and the fill stays the default — which is black, so the
   * band swallows the text drawn on it. That is not a subtle failure, but it is
   * invisible until somebody opens the file.
   */
  band(x: number, y: number, width: number, height: number, grey = 0.94): this {
    const bottom = PAGE.height - y - height;
    this.ops.push({
      render: () => `q ${num(grey)} g ${num(x)} ${num(bottom)} ${num(width)} ${num(height)} re f Q`,
    });
    return this;
  }

  /** The content stream. */
  toContentStream(): string {
    return this.ops.map((op) => op.render()).join('\n');
  }
}

/**
 * Assemble the pages into a file.
 *
 * Objects are numbered in a fixed order and the cross-reference table is built
 * from the byte offsets of what was actually written, so the output is exact
 * rather than approximately right.
 */
export function renderPdf(pages: PdfPage[]): Buffer {
  if (pages.length === 0) throw new Error('A PDF needs at least one page');

  const FIRST_PAGE_OBJECT = 3;
  const pageIds = pages.map((_, index) => FIRST_PAGE_OBJECT + index * 2);
  const contentIds = pageIds.map((id) => id + 1);
  const fontRegularId = FIRST_PAGE_OBJECT + pages.length * 2;
  const fontBoldId = fontRegularId + 1;

  const objects: string[] = [];
  const push = (id: number, body: string) => {
    objects[id] = body;
  };

  push(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  push(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] ` +
      `/Count ${pages.length} >>`,
  );

  pages.forEach((page, index) => {
    const content = page.toContentStream();
    push(
      pageIds[index]!,
      `<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${num(PAGE.width)} ${num(PAGE.height)}] ` +
        `/Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> ` +
        `/Contents ${contentIds[index]} 0 R >>`,
    );
    // Byte length, not character length: the stream is Latin-1 and a /Length
    // that disagrees with the bytes makes readers refuse the file.
    push(
      contentIds[index]!,
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    );
  });

  push(
    fontRegularId,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
  );
  push(
    fontBoldId,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
  );

  // No /Info dictionary. It would be the one part of the file that is not a
  // function of the data — a creation date changes on every render, and this
  // file has to be byte-identical when the same payslip is rendered again.
  const header = '%PDF-1.4\n';
  const chunks: Buffer[] = [Buffer.from(header, 'latin1')];
  const offsets: number[] = [];
  let position = Buffer.byteLength(header, 'latin1');

  for (let id = 1; id < objects.length; id += 1) {
    const body = objects[id];
    if (body === undefined) throw new Error(`Object ${id} was never written`);
    const serialised = `${id} 0 obj\n${body}\nendobj\n`;
    offsets[id] = position;
    const buffer = Buffer.from(serialised, 'latin1');
    chunks.push(buffer);
    position += buffer.byteLength;
  }

  const size = objects.length;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

/**
 * Reduce a string to what WinAnsiEncoding can carry.
 *
 * The few characters this project actually produces outside Latin-1 are
 * handled by name rather than dropped, because `Jan–Mar` losing its dash reads
 * as a typo and `₹` losing its sign reads as a missing number.
 */
export function toWinAnsi(value: string): string {
  return (
    value
      .replace(/\u20B9/g, 'INR ')
      .replace(/[\u2014\u2013]/g, '-')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2026/g, '...')
      .replace(/\u00A0/g, ' ')
      // Anything still outside the encoding becomes a question mark rather
      // than a byte the reader will render as something surprising.
      .replace(/[^\u0020-\u007E\u00A0-\u00FF]/g, '?')
  );
}

/** `(`, `)` and `\` end a string literal or escape the next byte. */
function escapeText(value: string): string {
  return value.replace(/[\\()]/g, (c) => `\\${c}`);
}

/** Width of `text` at `size`, in points. */
export function measure(text: string, size: number, weight: FontWeight = 'regular'): number {
  const widths = weight === 'bold' ? BOLD_WIDTHS : REGULAR_WIDTHS;
  let total = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    total += (code >= 32 && code <= 126 ? widths[code - 32]! : DEFAULT_WIDTH) / 1000;
  }
  return total * size;
}

/**
 * Format a number for the content stream.
 *
 * Fixed to two decimals and stripped of a trailing zero run, so the same
 * coordinate always serialises to the same bytes — `12` rather than sometimes
 * `12` and sometimes `12.000000000000002`.
 */
function num(value: number): string {
  const fixed = value.toFixed(2);
  return fixed.replace(/\.?0+$/, '') || '0';
}

/**
 * Advance widths from the Adobe AFM metrics for Helvetica and Helvetica-Bold,
 * characters 32 to 126, in units of 1/1000 em.
 *
 * Needed because a payslip's figures are right-aligned, which means measuring
 * the string before placing it. The standard fourteen fonts have fixed,
 * published metrics; these are them.
 */
const DEFAULT_WIDTH = 556;

const REGULAR_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
