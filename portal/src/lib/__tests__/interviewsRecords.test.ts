// Consent records and the export, portal side (lib/interviewsRecords.ts, rows I6.1 and I6.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consentsPath, exportPath, noticeLabel, readsConsents, yesNo } from '../interviewsRecords.ts';

test('the paths carry the encoded id', () => {
  assert.ok(consentsPath('a b').endsWith('/candidates/a%20b/consents'));
  assert.ok(exportPath('iv-1').endsWith('/interviews/iv-1/milo-export'));
});

test('three roles read the section; the interviewer does not', () => {
  assert.deepEqual(['recruiter', 'admin', 'hiring-manager', 'interviewer', 'guest'].map(readsConsents), [true, true, true, false, false]);
});

test('answers read yes or no and the notice names its day', () => {
  assert.equal(yesNo(true), 'Yes');
  assert.equal(yesNo(false), 'No');
  assert.equal(noticeLabel('2026-11-16.1'), 'Notice of 16 Nov 2026');
  assert.equal(noticeLabel('odd'), 'odd');
  assert.equal(noticeLabel(null), '—');
});

// Lane H5 (OWED O-162, O-165).
test('an unanswered round reads as a dash, and an older notice names its own day', () => {
  // The Notice column of a round nobody answered shows the dash (ProfileConsents renders noticeLabel(null) only for an
  // answered row; an unanswered row shows the library's dash, which the walk reads on the page).
  assert.equal(noticeLabel(null), '—');
  assert.equal(noticeLabel(''), '—');
  // A notice given before today's text: the profile still names the day it was given; the export says textKept false.
  assert.equal(noticeLabel('2025-03-01.2'), 'Notice of 1 Mar 2025');
  assert.equal(noticeLabel('2026-11-16'), 'Notice of 16 Nov 2026');
});

test('the line when the download fails: the server\'s sentence, a plain fallback, or the connection line', async () => {
  const { downloadExport } = await import('../interviewsRecords.ts');
  const real = globalThis.fetch;
  const asked: string[] = [];
  try {
    globalThis.fetch = (async (url: string) => { asked.push(String(url)); return new Response(JSON.stringify({ error: 'There is no interview here that you can open.' }), { status: 404 }); }) as typeof fetch;
    assert.deepEqual(await downloadExport('iv-1'), { ok: false, error: 'There is no interview here that you can open.' });
    assert.ok(asked[0]!.endsWith('/interviews/iv-1/milo-export'));
    globalThis.fetch = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch;
    assert.deepEqual(await downloadExport('iv-1'), { ok: false, error: 'The export could not be made. Try again.' });
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    const offline = await downloadExport('iv-1');
    assert.deepEqual(offline, { ok: false, error: 'The export could not be made. Check the connection and try again.' });
    // No line names a status code, an id or a setting.
    for (const out of [offline]) assert.doesNotMatch(out.ok ? '' : out.error, /\d{3}|iv-|TypeError/);
  } finally {
    globalThis.fetch = real;
  }
});
