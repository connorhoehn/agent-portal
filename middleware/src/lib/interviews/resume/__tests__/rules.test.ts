import { RESUME_MAX_BYTES, checkResumeBytes, cleanFileName, inlineDisposition, isPdfBytes, resumeStorageKey, sha256Hex } from '../rules.js';
import { buildSimplePdf } from '../../../../mock/interviews-resumes.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1');

describe('a PDF is decided by its first bytes', () => {
  it('accepts the magic and nothing else', () => {
    expect(isPdfBytes(PDF)).toBe(true);
    expect(isPdfBytes(buildSimplePdf(['A', 'b']))).toBe(true);
    expect(isPdfBytes(Buffer.from('MZ\x90\x00 pretending.pdf'))).toBe(false);
    expect(isPdfBytes(Buffer.from('  %PDF-1.4'))).toBe(false);
    expect(isPdfBytes(Buffer.from('%PDF'))).toBe(false);
    expect(isPdfBytes(Buffer.alloc(0))).toBe(false);
  });

  it('refuses empty, over the limit and not a PDF, each with a plain sentence', () => {
    expect(checkResumeBytes(Buffer.alloc(0))).toMatchObject({ ok: false, status: 400 });
    expect(checkResumeBytes(Buffer.from('<html></html>'))).toMatchObject({ ok: false, status: 415, error: 'Only PDF files can be attached as a résumé.' });
    const big = Buffer.alloc(RESUME_MAX_BYTES + 1, 0x20);
    PDF.copy(big);
    expect(checkResumeBytes(big)).toMatchObject({ ok: false, status: 413 });
    const edge = Buffer.alloc(RESUME_MAX_BYTES, 0x20);
    PDF.copy(edge);
    expect(checkResumeBytes(edge)).toEqual({ ok: true });
    expect(checkResumeBytes(PDF)).toEqual({ ok: true });
  });

  it('the limit is 10 MB', () => { expect(RESUME_MAX_BYTES).toBe(10 * 1024 * 1024); });
});

describe('the name shown', () => {
  it.each([
    ['Ingrid Solberg CV.pdf', 'Ingrid Solberg CV.pdf'],
    ['cv', 'cv.pdf'],
    ['CV.PDF', 'CV.pdf'],
    ['../../etc/passwd', 'passwd.pdf'],
    ['C:\\Users\\me\\Documents\\resume.pdf', 'resume.pdf'],
    ['a/b/c.pdf', 'c.pdf'],
    ['bad\u0000name\r\n.pdf', 'badname.pdf'],
    ['gp\u202efdp.exe', 'gpfdp.exe.pdf'],
    ['', 'resume.pdf'],
    ['   ', 'resume.pdf'],
    ['...pdf', 'pdf.pdf'],
    ['.hidden.pdf', 'hidden.pdf'],
    ['%E2%80%A6%20r%C3%A9sum%C3%A9.pdf', '… résumé.pdf'],
    ['%zz.pdf', '%zz.pdf'],
  ])('%j becomes %j', (raw, shown) => { expect(cleanFileName(raw)).toBe(shown); });

  it('is never longer than 120 characters, and still ends .pdf', () => {
    const name = cleanFileName(`${'x'.repeat(300)}.pdf`);
    expect(name).toHaveLength(120);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('a value that is not text becomes the plain default', () => {
    expect(cleanFileName(undefined)).toBe('resume.pdf');
    expect(cleanFileName(['a.pdf'])).toBe('resume.pdf');
  });

  it('is encoded safely in the disposition header', () => {
    const header = inlineDisposition('A "quoted" résumé; (x).pdf');
    expect(header.startsWith('inline; filename="A _quoted_ r_sum__ _x_.pdf"')).toBe(true);
    expect(header).toContain("filename*=UTF-8''A%20%22quoted%22%20r%C3%A9sum%C3%A9%3B%20%28x%29.pdf");
    expect(header).not.toMatch(/[\r\n]/);
  });
});

describe('the storage key is made from ids', () => {
  it('has the documented shape', () => { expect(resumeStorageKey('cand-rx6tcaqj', 'rf-1')).toBe('interviews/resumes/cand-rx6tcaqj/rf-1.pdf'); });
  it.each([['../x', 'rf-1'], ['cand-1', 'a/b'], ['', 'rf-1'], ['cand-1', ''], ['cand 1', 'rf-1'], ['cand-1', 'rf-1.pdf']])('refuses %j / %j', (c, f) => {
    expect(() => resumeStorageKey(c, f)).toThrow();
  });
});

it('hashes with SHA-256', () => { expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); });
