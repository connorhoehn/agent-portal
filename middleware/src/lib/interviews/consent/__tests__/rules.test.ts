// The consent rules (lib/interviews/consent/rules.ts; docs/interviews-tenant-plan.md decision 5, row I2.3).
import { CONSENT_NOTICE } from '../notice.js';
import { checkAnswers, consentsChangeable, partsOff, stampAnswers } from '../rules.js';
import { INTERVIEW_STATES } from '../../types.js';

const V = CONSENT_NOTICE.version;
const yes = { noticeVersion: V, recording: true, transcription: true, milo: true };

describe('checkAnswers', () => {
  it('takes three real yes-or-no answers under the current notice', () => {
    expect(checkAnswers(yes, V, 'ready', null)).toEqual({ ok: true, noticeVersion: V, answers: { recording: true, transcription: true, milo: true }, miloForcedOff: false });
    expect(checkAnswers({ ...yes, recording: false, transcription: false, milo: false }, V, 'assigned', null))
      .toEqual({ ok: true, noticeVersion: V, answers: { recording: false, transcription: false, milo: false }, miloForcedOff: false });
  });

  it('requires all three answers and never defaults or coerces one to yes', () => {
    for (const body of [
      { noticeVersion: V }, { ...yes, milo: undefined }, { ...yes, recording: null }, { ...yes, recording: 'yes' },
      { ...yes, transcription: 1 }, { ...yes, milo: 'true' }, null, 'yes', [],
    ]) {
      const got = checkAnswers(body, V, 'ready', null);
      expect(got.ok ? 'accepted' : got.reason).toBe(body && typeof body === 'object' && !Array.isArray(body) && 'noticeVersion' in body ? 'incomplete' : 'stale-notice');
    }
  });

  it('stores Milo as declined when the transcript is declined, whatever was sent, and says so', () => {
    expect(checkAnswers({ ...yes, transcription: false }, V, 'ready', null))
      .toEqual({ ok: true, noticeVersion: V, answers: { recording: true, transcription: false, milo: false }, miloForcedOff: true });
    expect(checkAnswers({ ...yes, transcription: true, milo: false }, V, 'ready', null))
      .toMatchObject({ ok: true, answers: { milo: false }, miloForcedOff: false });
  });

  it('refuses an answer given under another notice version', () => {
    expect(checkAnswers({ ...yes, noticeVersion: 'older' }, V, 'ready', null)).toEqual({ ok: false, reason: 'stale-notice' });
    expect(checkAnswers({ ...yes, noticeVersion: undefined }, V, 'ready', null)).toEqual({ ok: false, reason: 'stale-notice' });
  });

  it('allows answers until the call starts, never after', () => {
    const open = INTERVIEW_STATES.filter((s) => consentsChangeable(s));
    expect(open).toEqual(['assigned', 'accepted', 'ready']);
    for (const s of ['live', 'ended', 'scored', 'reviewed', 'declined', 'cancelled'] as const) {
      expect(checkAnswers(yes, V, s, { noticeVersion: V })).toEqual({ ok: false, reason: 'closed' });
    }
  });

  it('takes a first answer while live (U7), never a change, and nothing once ended', () => {
    const ok = checkAnswers(yes, V, 'live', null);
    expect(ok.ok).toBe(true);
    // Answers under an older notice are not answers to the current one: the candidate answers afresh.
    expect(checkAnswers(yes, V, 'live', { noticeVersion: 'older' }).ok).toBe(true);
    expect(checkAnswers(yes, V, 'live', { noticeVersion: V })).toEqual({ ok: false, reason: 'closed' });
    for (const s of ['ended', 'scored', 'reviewed', 'declined', 'cancelled'] as const) {
      expect(checkAnswers(yes, V, s, null)).toEqual({ ok: false, reason: 'closed' });
    }
    // The other checks still run on a first answer.
    expect(checkAnswers({ ...yes, noticeVersion: 'older' }, V, 'live', null)).toEqual({ ok: false, reason: 'stale-notice' });
    expect(checkAnswers({ ...yes, milo: 'yes' }, V, 'live', null)).toEqual({ ok: false, reason: 'incomplete' });
  });
});

describe('partsOff', () => {
  it('lists every part when nothing is answered, and the declined parts otherwise', () => {
    expect(partsOff(null)).toEqual(['recording', 'transcription', 'milo']);
    expect(partsOff({ recording: true, transcription: true, milo: true })).toEqual([]);
    expect(partsOff({ recording: false, transcription: true, milo: false })).toEqual(['recording', 'milo']);
  });
});

describe('stampAnswers', () => {
  it('gives each answer its own time: a changed answer gets the new time, an unchanged one keeps its own', () => {
    const first = stampAnswers({ recording: true, transcription: true, milo: true }, null, 't1');
    expect(first).toEqual({ recording: { value: true, at: 't1' }, transcription: { value: true, at: 't1' }, milo: { value: true, at: 't1' } });
    const second = stampAnswers({ recording: false, transcription: true, milo: true }, first, 't2');
    expect(second).toEqual({ recording: { value: false, at: 't2' }, transcription: { value: true, at: 't1' }, milo: { value: true, at: 't1' } });
  });
});

describe('the notice', () => {
  it('has a version, a title and plain paragraphs covering every point decision 5 and 17 ask for', () => {
    expect(V).toMatch(/\S/);
    const text = CONSENT_NOTICE.paragraphs.join(' ');
    for (const point of [/record/i, /transcript/i, /Milo/, /90 days/, /four years/, /say no/i, /delet/i, /until the interview starts/i]) expect(text).toMatch(point);
    expect(text).not.toMatch(/assistant|Nova|Bedrock|Amazon|OpenAI|Polly/);
  });
});
