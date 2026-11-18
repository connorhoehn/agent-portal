// The notice's versions (E4 #45): every version ever shown keeps its text, the last one is current, and a published
// version's words never change (a change is a new version, so older answers keep pointing at what they were shown).
import { createHash } from 'node:crypto';
import { CONSENT_NOTICE, NOTICE_VERSIONS, noticeOfVersion, type ConsentNotice } from '../notice.js';

const digest = (n: ConsentNotice) => createHash('sha256').update(JSON.stringify([n.title, n.paragraphs])).digest('hex');

/** The text of every published version, by its digest. Append a line for a new version; never edit one. */
const PUBLISHED: Record<string, string> = {
  '2026-11-16.1': 'bb106b65b78cd069dec83776376a92f18aeab6dc557a7041629b868baa8c0e89',
};

describe('the consent notice versions', () => {
  it('the current notice is the last version, and the versions are unique and in order', () => {
    expect(CONSENT_NOTICE).toBe(NOTICE_VERSIONS[NOTICE_VERSIONS.length - 1]);
    const ids = NOTICE_VERSIONS.map((n) => n.version);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) expect(id).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it('no published version\'s words have changed, and none was removed', () => {
    expect(Object.fromEntries(NOTICE_VERSIONS.map((n) => [n.version, digest(n)]))).toEqual(PUBLISHED);
  });

  it('finds the notice an answer was given under, an older one included; a version never shown is null', () => {
    const older: ConsentNotice = { version: '2026-01-01.1', title: 'Older', paragraphs: ['Older words.'] };
    expect(noticeOfVersion(CONSENT_NOTICE.version)).toBe(CONSENT_NOTICE);
    expect(noticeOfVersion('2026-01-01.1', [older, CONSENT_NOTICE])).toBe(older);
    expect(noticeOfVersion('2025-03-01.2')).toBeNull();
  });
});
