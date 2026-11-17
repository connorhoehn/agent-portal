// The interview record's reader (lib/interviews/record/; row I5.1, contracts E1 and E2): the four states of each part, the
// markers from a fixed log, and recordTranscript on a left call, on the seeded stand-in and on none.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
jest.mock('../../../../providers/identity.js', () => ({
  ...jest.requireActual('../../../../providers/identity.js'),
  listUsers: jest.fn(async () => [
    { id: 'u-hugo', displayName: 'Hugo Marchetti', email: null, personId: null, epoch: 0, grants: {} },
    { id: 'u-wen', displayName: 'Wen Zhao', email: null, personId: null, epoch: 0, grants: {} },
  ]),
}));

import { config } from '../../../../config.js';
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewRecordLinesFixture, interviewRecordingsFixture } from '../../../../mock/interviews-records.js';
import { MemoryAssistantStore } from '../../../meeting-assistant/store.js';
import { setAssistantStore } from '../../../meeting-assistant/store-select.js';
import type { AssistantRecord } from '../../../meeting-assistant/types.js';
import { linesFrom } from '../index.js';
import { recordMarkers } from '../markers.js';
import { partState, recordingPart, removedKinds } from '../recording.js';
import { recordTranscript } from '../transcript.js';

const mockConfig = config as unknown as { mock: { aurora: boolean } };

beforeEach(() => {
  fixtureRegistry.resetAll('default');
  mockConfig.mock.aurora = true;
  setAssistantStore(new MemoryAssistantStore());
});
afterAll(() => setAssistantStore(null));

describe('partState', () => {
  it('declined wins, then deleted, then none, else available', () => {
    expect(partState({ agreed: false, removed: true, present: true })).toBe('declined');
    expect(partState({ agreed: true, removed: true, present: true })).toBe('deleted');
    expect(partState({ agreed: true, removed: false, present: false })).toBe('none');
    expect(partState({ agreed: null, removed: false, present: false })).toBe('none');
    expect(partState({ agreed: true, removed: false, present: true })).toBe('available');
  });

  it('removedKinds reads only rows naming this interview', () => {
    const rows = [
      { interviewIds: ['iv-a', 'iv-b'], removed: [{ kind: 'recording', count: 1 }] },
      { interviewIds: ['iv-c'], removed: [{ kind: 'transcript-and-minutes', count: 3 }] },
    ];
    expect([...removedKinds(rows, 'iv-b')]).toEqual(['recording']);
    expect(removedKinds(rows, 'iv-z').size).toBe(0);
  });
});

describe('recordingPart', () => {
  const yes = { recording: true };
  it('the mock stand-in: available with its duration, nothing playable', () => {
    const r = recordingPart('iv-mateo-coding', yes, new Set());
    expect(r).toEqual({ state: 'available', playbackUrl: null, durationSeconds: 3500, standIn: true });
  });
  it('declined when the candidate said no, whatever else is there', () => {
    expect(recordingPart('iv-mateo-coding', { recording: false }, new Set(['recording'])).state).toBe('declined');
  });
  it('deleted when the log removed it', () => {
    expect(recordingPart('iv-mateo-coding', yes, new Set(['recording']))).toEqual({ state: 'deleted', playbackUrl: null, durationSeconds: null, standIn: false });
  });
  it('none when the mock world has no stand-in for the interview', () => {
    expect(recordingPart('iv-jonah-leadership', yes, new Set()).state).toBe('none');
  });
  it('outside the mock world: available on a yes (the page asks the media service), none without answers, never a URL', () => {
    expect(recordingPart('iv-x', yes, new Set(), false)).toEqual({ state: 'available', playbackUrl: null, durationSeconds: null, standIn: false });
    expect(recordingPart('iv-x', null, new Set(), false).state).toBe('none');
  });
});

describe('recordMarkers', () => {
  const start = '2026-11-10T14:00:00.000Z';
  const log = [
    { answer: 'milo-ask' as const, answeredAt: '2026-11-10T14:18:20.000Z', text: 'What happens at the reset?', dropped: null },
    { answer: 'ask' as const, answeredAt: '2026-11-10T14:05:00.000Z', text: 'How do two requests race?', dropped: null },
    { answer: 'skip' as const, answeredAt: '2026-11-10T14:06:00.000Z', text: 'Skipped one', dropped: null },
    { answer: null, answeredAt: null, text: 'Never answered', dropped: null },
    { answer: null, answeredAt: null, text: '', dropped: 'malformed' as const },
    { answer: 'ask' as const, answeredAt: '2026-11-10T13:59:00.000Z', text: 'Before the start', dropped: null },
  ];
  it('asked and Milo-asked suggestions, at their answer time, in order', () => {
    expect(recordMarkers(log, start)).toEqual([
      { kind: 'question', atMs: 5 * 60_000, label: 'How do two requests race?' },
      { kind: 'milo-asked', atMs: 18 * 60_000 + 20_000, label: 'What happens at the reset?' },
    ]);
  });
  it('nothing without a start', () => { expect(recordMarkers(log, null)).toEqual([]); });
});

describe('recordTranscript', () => {
  const NOW = Date.parse('2026-11-10T14:00:00.000Z');
  const call = (over: Partial<AssistantRecord> = {}): AssistantRecord => ({
    callId: 'call-1', tenant: 'interviews', lobby: 'interviews:interview:iv-mateo-coding', initiativeId: null, state: 'listening', invitedBy: 'u-hugo',
    invitedAt: NOW, pausedBy: null, leftAt: null, leftBy: null, acked: [], attendees: ['u-hugo'], presentAtInvite: [], requests: 0, linesStored: 0, nextSeq: 1,
    pendingRequests: [], ...over,
  });
  const line = (userId: string | null, text: string, s: number, id: string) =>
    ({ callId: 'call-1', userId, participantId: 'p', speakerName: 'raw', text, at: NOW + s * 1000, captionId: id });

  it('reads a left call found by its lobby: sides, labels, unattributed lines left out', async () => {
    const store = new MemoryAssistantStore();
    setAssistantStore(store);
    await store.create(call());
    await store.appendLine(line('u-hugo', 'Tell me about a rate limiter.', 10, 'c1'));
    await store.appendLine(line(null, 'crosstalk', 12, 'c2'));
    await store.appendLine(line('guest:inv-1', 'I would use a token bucket.', 20, 'c3'));
    await store.transition('call-1', { from: ['listening'], to: 'left', by: 'u-hugo', at: NOW + 3_600_000 });
    const t = await recordTranscript({ id: 'iv-mateo-coding', callId: null });
    expect(t).toEqual({
      callId: 'call-1', startedAt: '2026-11-10T14:00:00.000Z',
      lines: [
        { seq: 1, at: '2026-11-10T14:00:10.000Z', side: 'panel', speaker: 'Hugo Marchetti', text: 'Tell me about a rate limiter.' },
        { seq: 3, at: '2026-11-10T14:00:20.000Z', side: 'candidate', speaker: 'Mateo Álvarez', text: 'I would use a token bucket.' },
      ],
    });
    expect(linesFrom(t!, t!.startedAt).map((l) => l.atMs)).toEqual([10_000, 20_000]);
  });

  it('the seeded stand-in in the mock world when no call is stored', async () => {
    const t = await recordTranscript({ id: 'iv-ingrid-together', callId: null });
    expect(t?.lines.length).toBe(interviewRecordLinesFixture.rows().filter((l) => l.interviewId === 'iv-ingrid-together').length);
    expect(t?.startedAt).toBe(interviewRecordingsFixture.rows().find((r) => r.interviewId === 'iv-ingrid-together')!.startedAt);
    expect(new Set(t!.lines.map((l) => l.speaker))).toEqual(new Set(['Wen Zhao', 'Ingrid Solberg']));
    expect(t!.lines.some((l) => l.speaker.startsWith('guest:'))).toBe(false);
  });

  it('none: no call and no stand-in, or outside the mock world', async () => {
    expect(await recordTranscript({ id: 'iv-jonah-leadership', callId: null })).toBeNull();
    mockConfig.mock.aurora = false;
    expect(await recordTranscript({ id: 'iv-mateo-coding', callId: null })).toBeNull();
  });
});
