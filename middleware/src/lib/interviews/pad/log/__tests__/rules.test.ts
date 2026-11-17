// The pad log's rules (lib/interviews/pad/log/rules.ts; decision 12, row I4.3; contract U3).
import {
  MAX_EVENTS_PER_INTERVIEW, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOTS_PER_INTERVIEW, capPost, checkPadEvent, checkPadPost, type PadEventIn,
} from '../rules.js';

const AT = '2026-11-17T10:00:00.000Z';
const edit = { kind: 'edit', clientAt: AT, from: 3, inserted: 5, deleted: 1, length: 90 };

describe('one event', () => {
  it('keeps an edit as counts only and drops every unknown or unused field', () => {
    expect(checkPadEvent({ ...edit, typed: 'secret', lines: 2, via: 'paste', language: 'go', questionId: 'q-1', who: 'u-x', at: 'later', seq: 9 }))
      .toEqual({ kind: 'edit', clientAt: AT, from: 3, inserted: 5, deleted: 1, length: 90 });
  });

  it('refuses text on anything but a snapshot', () => {
    expect(checkPadEvent({ ...edit, text: 'def f():' })).toBeNull();
    expect(checkPadEvent({ kind: 'paste', clientAt: AT, from: 0, inserted: 4, lines: 1, via: 'paste', text: 'abcd' })).toBeNull();
  });

  it('keeps a paste with its counts and how it came in', () => {
    expect(checkPadEvent({ kind: 'paste', clientAt: AT, from: 0, inserted: 120, lines: 4, via: 'drop', length: 300 }))
      .toEqual({ kind: 'paste', clientAt: AT, from: 0, inserted: 120, lines: 4, via: 'drop', length: 300 });
    expect(checkPadEvent({ kind: 'paste', clientAt: AT, from: 0, inserted: 120, lines: 4, via: 'typed' })).toBeNull();
    expect(checkPadEvent({ kind: 'paste', clientAt: AT, from: 0, inserted: 120, via: 'paste' })).toBeNull();
  });

  it('keeps a snapshot\'s text up to 64 KB as UTF-8', () => {
    expect(checkPadEvent({ kind: 'snapshot', clientAt: AT, text: 'x = 1\n', language: 'python' })).toEqual({ kind: 'snapshot', clientAt: AT, text: 'x = 1\n', language: 'python' });
    expect(checkPadEvent({ kind: 'snapshot', clientAt: AT, text: 'a'.repeat(MAX_SNAPSHOT_BYTES) })).not.toBeNull();
    expect(checkPadEvent({ kind: 'snapshot', clientAt: AT, text: 'a'.repeat(MAX_SNAPSHOT_BYTES + 1) })).toBeNull();
    expect(checkPadEvent({ kind: 'snapshot', clientAt: AT, text: 'é'.repeat(MAX_SNAPSHOT_BYTES / 2 + 1) })).toBeNull();
    expect(checkPadEvent({ kind: 'snapshot', clientAt: AT })).toBeNull();
    expect(checkPadEvent({ kind: 'snapshot', clientAt: AT, text: '' })).toEqual({ kind: 'snapshot', clientAt: AT, text: '' });
  });

  it('keeps a language and an insert', () => {
    expect(checkPadEvent({ kind: 'language', clientAt: AT, language: 'cpp' })).toEqual({ kind: 'language', clientAt: AT, language: 'cpp' });
    expect(checkPadEvent({ kind: 'language', clientAt: AT })).toBeNull();
    expect(checkPadEvent({ kind: 'language', clientAt: AT, language: 'Python 3!' })).toBeNull();
    expect(checkPadEvent({ kind: 'insert', clientAt: AT, questionId: 'q-be-ratelimit', from: 0, inserted: 140, length: 140, language: 'python' }))
      .toEqual({ kind: 'insert', clientAt: AT, questionId: 'q-be-ratelimit', from: 0, inserted: 140, length: 140, language: 'python' });
    expect(checkPadEvent({ kind: 'insert', clientAt: AT })).toBeNull();
  });

  it('refuses numbers that are not non-negative integers, a bad kind and a bad client time', () => {
    for (const bad of [-1, 1.5, '3', null, Number.NaN, Infinity, 1e9]) expect([bad, checkPadEvent({ ...edit, from: bad })]).toEqual([bad, null]);
    expect(checkPadEvent({ ...edit, kind: 'cursor' })).toBeNull();
    expect(checkPadEvent({ ...edit, clientAt: 'yesterday' })).toBeNull();
    expect(checkPadEvent({ ...edit, clientAt: undefined })).toBeNull();
    expect(checkPadEvent({ ...edit, clientAt: '2026-11-17T10:00:00+01:00' })).toMatchObject({ clientAt: '2026-11-17T09:00:00.000Z' });
    expect(checkPadEvent(null)).toBeNull();
    expect(checkPadEvent([edit])).toBeNull();
  });
});

describe('a post', () => {
  it('takes 1 to 50 good events and refuses the whole post for one bad one', () => {
    expect(checkPadPost({ events: [edit] })).toHaveLength(1);
    expect(checkPadPost({ events: Array(50).fill(edit) })).toHaveLength(50);
    expect(checkPadPost({ events: Array(51).fill(edit) })).toBeNull();
    expect(checkPadPost({ events: [] })).toBeNull();
    expect(checkPadPost({ events: [edit, { ...edit, text: 'x' }] })).toBeNull();
    expect(checkPadPost({})).toBeNull();
    expect(checkPadPost(null)).toBeNull();
    expect(checkPadPost({ events: 'edit' })).toBeNull();
  });
});

describe('the interview\'s caps', () => {
  const e = (kind: PadEventIn['kind']): PadEventIn => (kind === 'snapshot' ? { kind, clientAt: AT, text: 'x' } : { kind: 'edit', clientAt: AT, from: 0, inserted: 1, deleted: 0, length: 1 });
  it('keeps everything under the caps', () => {
    expect(capPost([e('edit'), e('snapshot')], { events: 0, snapshots: 0 })).toHaveLength(2);
  });
  it('drops snapshots past 400 and keeps the edits beside them', () => {
    const kept = capPost([e('snapshot'), e('edit'), e('snapshot')], { events: 500, snapshots: MAX_SNAPSHOTS_PER_INTERVIEW - 1 });
    expect(kept.map((k) => k.kind)).toEqual(['snapshot', 'edit']);
  });
  it('drops everything past 20,000 events', () => {
    expect(capPost([e('edit'), e('edit'), e('edit')], { events: MAX_EVENTS_PER_INTERVIEW - 2, snapshots: 0 })).toHaveLength(2);
    expect(capPost([e('edit')], { events: MAX_EVENTS_PER_INTERVIEW, snapshots: 0 })).toEqual([]);
  });
});
