// The résumé helpers (lib/interviewsResume.ts, row I1.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESUME_MAX_BYTES, fileNameHeader, precheck, resumeFilePath, sizeLabel } from '../interviewsResume.ts';

test('a size reads the way a person says it', () => {
  assert.equal(sizeLabel(0), '0 B');
  assert.equal(sizeLabel(900), '900 B');
  assert.equal(sizeLabel(812 * 1024), '812 KB');
  assert.equal(sizeLabel(1.4 * 1024 * 1024), '1.4 MB');
  assert.equal(sizeLabel(-1), '—');
});

test('the name travels percent-encoded', () => {
  assert.equal(fileNameHeader('Zoë Ng résumé.pdf'), 'Zo%C3%AB%20Ng%20r%C3%A9sum%C3%A9.pdf');
  assert.equal(decodeURIComponent(fileNameHeader('a/b #1.pdf')), 'a/b #1.pdf');
});

test('the pre-check says what the server would say', () => {
  assert.equal(precheck({ name: 'cv.pdf', type: 'application/pdf', size: 1000 }), null);
  assert.equal(precheck({ name: 'cv.PDF', type: '', size: 1000 }), null);
  assert.match(precheck({ name: 'cv.docx', type: 'application/msword', size: 1000 }) ?? '', /Only PDF/);
  assert.match(precheck({ name: 'cv.pdf', type: 'application/pdf', size: 0 }) ?? '', /empty/);
  assert.match(precheck({ name: 'cv.pdf', type: 'application/pdf', size: RESUME_MAX_BYTES + 1 }) ?? '', /larger than 10 MB/);
  assert.equal(precheck({ name: 'cv.pdf', type: 'application/pdf', size: RESUME_MAX_BYTES }), null);
});

test('the file lives under the candidate', () => {
  assert.equal(resumeFilePath('c 1'), '/api/interviews/candidates/c%201/resume/file');
});
