import { describe, expect, it } from 'vitest';
import { A4, PdfPage, measure, renderPdf, toWinAnsi } from './pdf.js';

/**
 * The PDF writer.
 *
 * What can go wrong here and not be caught by a type is the file's structure:
 * a `/Length` that disagrees with the bytes, an offset in the cross-reference
 * table that points at the wrong object, a string literal an unescaped
 * parenthesis has ended early. A reader answers "this file is damaged" and says
 * no more, so the assertions below read the structure directly.
 */

const latin1 = (buffer: Buffer) => buffer.toString('latin1');

function page(): PdfPage {
  return new PdfPage().text(48, 60, 'Widedrop Technologies', { size: 14, weight: 'bold' });
}

describe('renderPdf', () => {
  it('produces a file a reader will accept', () => {
    const text = latin1(renderPdf([page()]));

    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages');
    expect(text).toContain('/Type /Page');
    expect(text).toContain('/BaseFont /Helvetica');
    expect(text).toContain('/BaseFont /Helvetica-Bold');
    expect(text).toContain('/MediaBox [0 0 595.28 841.89]');
  });

  it('declares a content-stream length that matches the bytes', () => {
    const text = latin1(renderPdf([page()]));

    const declared = Number(/\/Length (\d+) >>\nstream\n/.exec(text)?.[1]);
    const body = /stream\n([\s\S]*?)\nendstream/.exec(text)?.[1] ?? '';

    // A reader that trusts /Length over the endstream keyword reads garbage
    // past the end of the stream, and one that does the reverse rejects the
    // file. They have to agree.
    expect(Buffer.byteLength(body, 'latin1')).toBe(declared);
  });

  it('writes a cross-reference table whose offsets land on their objects', () => {
    const buffer = renderPdf([page()]);
    const text = latin1(buffer);

    const size = Number(/\/Size (\d+)/.exec(text)?.[1]);
    const xref = /xref\n0 \d+\n0000000000 65535 f \n([\s\S]*?)trailer/.exec(text)?.[1] ?? '';
    const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));

    expect(offsets).toHaveLength(size - 1);

    // Each offset must be the first byte of `N 0 obj`. An off-by-one here is
    // the classic way a generated PDF opens in one reader and not another.
    offsets.forEach((offset, index) => {
      const id = index + 1;
      expect(text.slice(offset, offset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
    });

    const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
  });

  it('numbers and links several pages', () => {
    const text = latin1(renderPdf([page(), page(), page()]));

    expect(text).toContain('/Count 3');
    expect(text).toContain('/Kids [3 0 R 5 0 R 7 0 R]');
    // Every page points back at the same Pages node.
    expect([...text.matchAll(/\/Parent 2 0 R/g)]).toHaveLength(3);
  });

  it('is byte-identical when the same content is rendered again', () => {
    // The property the whole approach exists for: a payslip rendered a year
    // apart is the same file, so `sourceDigest` means something.
    const first = renderPdf([page()]);
    const second = renderPdf([page()]);
    expect(first.equals(second)).toBe(true);
    // And there is no creation date to differ.
    expect(latin1(first)).not.toContain('/CreationDate');
  });

  it('refuses to write a file with no pages', () => {
    expect(() => renderPdf([])).toThrow(/at least one page/);
  });
});

describe('text', () => {
  it('escapes what would end a string literal early', () => {
    const text = latin1(renderPdf([new PdfPage().text(10, 10, 'Basic (50% of CTC) \\ adjusted')]));

    // Unescaped, the `)` would close the literal and `50% of CTC` onwards
    // would be read as operators.
    expect(text).toContain('(Basic \\(50% of CTC\\) \\\\ adjusted) Tj');
  });

  it('keeps a rupee amount readable without embedding a font', () => {
    // WinAnsiEncoding has no rupee sign. Dropping it would leave a bare
    // number; this says what the number is.
    expect(toWinAnsi('₹1,23,456.00')).toBe('INR 1,23,456.00');
  });

  it('keeps an en dash and a curly quote legible', () => {
    expect(toWinAnsi('Jun – Aug 2026')).toBe('Jun - Aug 2026');
    expect(toWinAnsi('the employee’s pay')).toBe("the employee's pay");
    expect(toWinAnsi('—')).toBe('-');
  });

  it('replaces anything the encoding cannot carry', () => {
    expect(toWinAnsi('वेतन')).toBe('????');
    // Latin-1 accented characters survive, because WinAnsi has them.
    expect(toWinAnsi('José Müller')).toBe('José Müller');
  });

  it('measures a string so it can be right-aligned', () => {
    // Helvetica digits are 556/1000 em, so five of them at 10pt is 27.8pt.
    expect(measure('12345', 10)).toBeCloseTo(27.8, 5);
    // Bold is wider for most letters and the same for digits.
    expect(measure('Net pay', 10, 'bold')).toBeGreaterThan(measure('Net pay', 10, 'regular'));
    expect(measure('', 10)).toBe(0);
  });

  it('places right-aligned text left of the anchor by its own width', () => {
    const value = 'INR 1,23,456.00';
    const width = measure(value, 9);
    const text = latin1(
      renderPdf([new PdfPage().text(500, 100, value, { size: 9, align: 'right' })]),
    );

    const placed = Number(/1 0 0 1 ([\d.]+) [\d.]+ Tm/.exec(text)?.[1]);
    expect(placed).toBeCloseTo(500 - width, 1);
  });

  it('measures the page from the top, because that is how a page is read', () => {
    const text = latin1(renderPdf([new PdfPage().text(48, 60, 'x')]));
    const baseline = Number(/1 0 0 1 [\d.]+ ([\d.]+) Tm/.exec(text)?.[1]);
    expect(baseline).toBeCloseTo(A4.height - 60, 1);
  });
});

describe('rules and bands', () => {
  it('draws a rule at the requested distance from the top', () => {
    const text = latin1(renderPdf([new PdfPage().rule(48, 100, 547)]));
    const at = A4.height - 100;
    expect(text).toContain(`${at.toFixed(2).replace(/\.?0+$/, '')} m`);
    expect(text).toContain(' l S Q');
  });

  it('draws a band below its top edge, not above it', () => {
    const text = latin1(renderPdf([new PdfPage().band(48, 100, 400, 20)]));
    // A band declared at y=100 with height 20 occupies 100..120 from the top,
    // which is 721.89..741.89 from the bottom.
    expect(text).toContain(`${(A4.height - 120).toFixed(2)} 400 20 re f`);
  });

  it('fills a band with grey using the one-component operator', () => {
    const text = latin1(renderPdf([new PdfPage().band(48, 100, 400, 20, 0.9)]));

    // `0.9 rg` is malformed — rg takes three components — so a reader ignores
    // it and fills with the default, which is black. The band then hides
    // whatever is drawn on it, and nothing says so until somebody opens the
    // file. It has to be `g`.
    expect(text).toContain('0.9 g ');
    expect(text).not.toMatch(/[\d.]+ rg/);
  });
});
