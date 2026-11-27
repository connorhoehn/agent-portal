// The download route's three formats, checked the same way for every tenant's
// decks: the PowerPoint file (the default), the PDF (one page per slide plus
// the Sources slide) and the slide images (a zip of one PNG per slide).

import JSZip from 'jszip';
import type { Test } from 'supertest';

/** supertest's parser for a binary body. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const binary = (res: any, cb: (err: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/** Pages in a PDF, from its bytes: page objects (`/Type /Page`, not `/Pages`). pdfkit writes no object streams, so the dictionaries are plain text. */
export function pdfPageCount(bytes: Buffer): number {
  return (bytes.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

/**
 * Asserts the three formats of one revision. `get(query)` issues the GET for
 * `…/file` with `query` appended ('' or '?format=…'); `slides` is the deck's
 * own slide count (the Sources slide is added here).
 */
export async function expectDeckExports(get: (query: string) => Test, slides: number): Promise<void> {
  const pages = slides + 1;

  const pptx = await get('').buffer(true).parse(binary);
  expect(pptx.status).toBe(200);
  expect(pptx.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.presentationml.presentation');
  expect(pptx.headers['content-disposition']).toMatch(/^attachment; filename="[a-z0-9-]+-v\d+\.pptx"$/);
  expect(pptx.headers['cache-control']).toBe('private, no-store');
  const deck = await JSZip.loadAsync(pptx.body as Buffer);
  expect(await deck.file('[Content_Types].xml')!.async('string')).toContain('presentationml.presentation.main+xml');
  expect(Object.keys(deck.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(pages);
  const pptxName = /filename="(.+)\.pptx"/.exec(pptx.headers['content-disposition'] as string)![1]!;

  const pdf = await get('?format=pdf').buffer(true).parse(binary);
  expect(pdf.status).toBe(200);
  expect(pdf.headers['content-type']).toBe('application/pdf');
  expect(pdf.headers['content-disposition']).toBe(`attachment; filename="${pptxName}.pdf"`);
  expect(pdf.headers['cache-control']).toBe('private, no-store');
  expect((pdf.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(pdfPageCount(pdf.body as Buffer)).toBe(pages);

  const png = await get('?format=png').buffer(true).parse(binary);
  expect(png.status).toBe(200);
  expect(png.headers['content-type']).toBe('application/zip');
  expect(png.headers['content-disposition']).toBe(`attachment; filename="${pptxName}-slides.zip"`);
  expect(png.headers['cache-control']).toBe('private, no-store');
  const images = await JSZip.loadAsync(png.body as Buffer);
  const names = Object.keys(images.files).sort();
  expect(names).toEqual(Array.from({ length: pages }, (_, i) => `slide-${String(i + 1).padStart(2, '0')}.png`));
  const first = await images.file(names[0]!)!.async('nodebuffer');
  expect(first.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(first.readUInt32BE(16)).toBe(1920); // IHDR width

  const unknown = await get('?format=docx');
  expect(unknown.status).toBe(400);
  expect(unknown.body.error).toMatch(/^The format must be one of pptx, pdf, png/);
}
