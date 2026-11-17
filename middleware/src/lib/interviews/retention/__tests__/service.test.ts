// Retention as a feature (lib/interviews/retention/service.ts; docs/interviews-tenant-plan.md decision 17, row I6.3):
// the sweep on a clock, and a candidate's deletion request over the mock world.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true }, meetingAssistant: { enabled: true } } }));
import { SERVICE_AUTH_HEADER, verifyEnvelope } from '@connorhoehn/service-runtime';
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewConsentsFixture } from '../../../../mock/interviews-consents.js';
import { interviewCandidatesFixture, interviewScorecardsFixture } from '../../../../mock/interviews.js';
import { MemoryAssistantStore } from '../../../meeting-assistant/store.js';
import type { AssistantRecord } from '../../../meeting-assistant/types.js';
import { inviteStore, setInviteStore } from '../../invite/store.js';
import { MemoryResumeBytes } from '../../resume/bytes-store.js';
import { MemoryResumeRows } from '../../resume/row-store.js';
import { resumeBytes, resumeRows, setResumeStores } from '../../resume/service.js';
import type { Interview, InterviewsWorld } from '../../types.js';
import { callWordsEraser, recordingEraser } from '../erasers.js';
import { DEFAULT_PERIODS } from '../periods.js';
import { registerEraser, unregisterEraser } from '../registry.js';
import { DAY_MS, addYears } from '../rules.js';
import { MAX_ROWS_PER_RUN, deleteCandidateMedia, deletionsOf, sweep, type RetentionDeps } from '../service.js';
import { setDeletionStore } from '../store.js';

afterEach(() => { fixtureRegistry.resetAll('default'); setDeletionStore(null); setInviteStore(null); unregisterEraser('suggestions'); });

// ── the sweep on a clock, over a small world of its own ─────────────────────

const END = Date.parse('2026-01-10T15:00:00.000Z');
const ivAt = (id: string, over: Partial<Interview> = {}): Interview => ({
  id, applicationId: 'app-x', roundId: 'rd', type: 'technical', leadId: 'u-lead', panelIds: [], scheduledAt: '2026-01-10T14:00:00.000Z', minutes: 60,
  state: 'ended', questionIds: [], assignedBy: 'u-r', assignedAt: '2026-01-01T09:00:00.000Z', callId: null,
  endedAt: new Date(END).toISOString(), acceptances: [], declines: [], revision: 1, ...over,
});
const worldOf = (interviews: Interview[]): InterviewsWorld => ({
  openings: [], scorecards: [],
  candidates: [{ id: 'cand-x', name: 'Test Person', email: 'test.person@example.test', headline: 'h', location: 'l', source: 's', resumeFileId: null, notes: 'n', createdAt: '2026-01-01T00:00:00.000Z' }],
  applications: [{ id: 'app-x', candidateId: 'cand-x', openingId: 'op', stage: 'interviewing', appliedAt: '2026-01-01T00:00:00.000Z', history: [] }],
  interviews,
} as unknown as InterviewsWorld);

interface Calls { [kind: string]: string[][] }
function fakes(fail: Set<string> = new Set()): Calls {
  const calls: Calls = {};
  const fake = (kind: string, cls: 'media' | 'record') => registerEraser({
    kind, class: cls,
    erase: async (ids) => { (calls[kind] ??= []).push([...ids]); if (fail.has(kind)) throw new Error('down: secret detail'); return ids.length; },
  });
  fake('recording', 'media'); fake('transcript-and-minutes', 'media'); fake('consents', 'record'); fake('scorecards', 'record'); fake('suggestions', 'record');
  return calls;
}

function clockDeps(world: InterviewsWorld, at: { now: number }, extra: Partial<RetentionDeps> = {}): Partial<RetentionDeps> & { removed: string[]; redacted: string[] } {
  const removed: string[] = [];
  const redacted: string[] = [];
  let n = 0;
  return {
    now: () => at.now, load: async () => world, enabled: () => true, periods: () => ({ ...DEFAULT_PERIODS }), newId: () => `del-${(n += 1)}`,
    removeResume: async (c) => { removed.push(c); return true; },
    records: () => ({ eraseConsents: async () => 0, eraseScorecards: async () => 0, redactCandidate: async (c) => { redacted.push(c); return 1; }, redactStageReasons: async () => 0 }),
    removed, redacted, ...extra,
  };
}

describe('the sweep', () => {
  it('leaves media at 89 days and erases it at 91, one log row for the interview, once', async () => {
    const calls = fakes();
    const at = { now: END + 89 * DAY_MS };
    const d = clockDeps(worldOf([ivAt('iv-a')]), at);
    expect(await sweep(d)).toEqual({ retried: 0, media: 0, records: 0 });
    expect(calls['recording']).toBeUndefined();
    at.now = END + 91 * DAY_MS;
    expect(await sweep(d)).toEqual({ retried: 0, media: 1, records: 0 });
    expect(calls['recording']).toEqual([['iv-a']]);
    expect(calls['transcript-and-minutes']).toEqual([['iv-a']]);
    expect(calls['consents']).toBeUndefined();
    const [row] = await deletionsOf('cand-x');
    expect(row).toMatchObject({ reason: 'media-period', interviewIds: ['iv-a'], requestedBy: null, left: [], attempts: 1,
      removed: [{ kind: 'recording', count: 1 }, { kind: 'transcript-and-minutes', count: 1 }] });
    expect(row!.doneAt).toBe(new Date(at.now).toISOString());
    at.now += DAY_MS;
    expect(await sweep(d)).toEqual({ retried: 0, media: 0, records: 0 });
    expect(await deletionsOf('cand-x')).toHaveLength(1);
  });

  it('leaves decision records just under four years and erases them just over, with the coach\'s log and the candidate\'s own details', async () => {
    const calls = fakes();
    const at = { now: addYears(END, 4) - 60_000 };
    const d = clockDeps(worldOf([ivAt('iv-a')]), at);
    await sweep(d);
    expect(calls['consents']).toBeUndefined();
    at.now = addYears(END, 4) + 60_000;
    expect((await sweep(d)).records).toBe(1);
    expect(calls['consents']).toEqual([['iv-a']]);
    expect(calls['scorecards']).toEqual([['iv-a']]);
    expect(calls['suggestions']).toEqual([['iv-a']]);
    expect(d.removed).toEqual(['cand-x']);
    expect(d.redacted).toEqual(['cand-x']);
    const record = (await deletionsOf('cand-x')).find((r) => r.reason === 'record-period');
    expect(record!.removed.map((r) => r.kind)).toEqual(['consents', 'scorecards', 'suggestions', 'resume', 'contact-details']);
  });

  it('keeps the candidate\'s own details while another of their interviews is still within its period', async () => {
    fakes();
    const at = { now: addYears(END, 4) + DAY_MS };
    const d = clockDeps(worldOf([ivAt('iv-a'), ivAt('iv-b', { endedAt: '2027-06-01T00:00:00.000Z' })]), at);
    await sweep(d);
    expect(d.removed).toEqual([]);
    expect(d.redacted).toEqual([]);
  });

  it('never touches an open interview, whatever its age', async () => {
    const calls = fakes();
    const d = clockDeps(worldOf([ivAt('iv-open', { state: 'ready', endedAt: null, scheduledAt: '2020-01-01T00:00:00.000Z' })]), { now: END + 3650 * DAY_MS });
    expect(await sweep(d)).toEqual({ retried: 0, media: 0, records: 0 });
    expect(Object.keys(calls)).toEqual([]);
  });

  it('logs a failing eraser by kind, keeps the row open, and the next sweep retries only that kind', async () => {
    const fail = new Set(['recording']);
    const calls = fakes(fail);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const at = { now: END + 91 * DAY_MS };
    const d = clockDeps(worldOf([ivAt('iv-a')]), at);
    await sweep(d);
    let [row] = await deletionsOf('cand-x');
    expect(row).toMatchObject({ doneAt: null, left: [{ kind: 'recording', why: 'failed', retry: true }], removed: [{ kind: 'transcript-and-minutes', count: 1 }] });
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/secret detail/);
    fail.clear();
    at.now += 3_600_000;
    expect(await sweep(d)).toEqual({ retried: 1, media: 0, records: 0 });
    [row] = await deletionsOf('cand-x');
    expect(row).toMatchObject({ left: [], attempts: 2, removed: [{ kind: 'transcript-and-minutes', count: 1 }, { kind: 'recording', count: 1 }] });
    expect(row!.doneAt).not.toBeNull();
    expect(calls['transcript-and-minutes']).toHaveLength(1);
    expect(calls['recording']).toHaveLength(2);
    warn.mockRestore();
  });

  it('does nothing while the flag is off, and never throws when the world cannot be read', async () => {
    const calls = fakes();
    expect(await sweep({ ...clockDeps(worldOf([ivAt('iv-a')]), { now: END + 400 * DAY_MS }), enabled: () => false })).toEqual({ retried: 0, media: 0, records: 0 });
    expect(Object.keys(calls)).toEqual([]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(sweep({ ...clockDeps(worldOf([]), { now: END }), load: async () => { throw new Error('db down'); } })).resolves.toEqual({ retried: 0, media: 0, records: 0 });
    warn.mockRestore();
  });

  it('touches at most MAX_ROWS_PER_RUN rows a run; the next run takes the rest', async () => {
    fakes();
    const many = Array.from({ length: MAX_ROWS_PER_RUN + 5 }, (_, i) => ivAt(`iv-${String(i).padStart(3, '0')}`));
    const at = { now: END + 91 * DAY_MS };
    const d = clockDeps(worldOf(many), at);
    expect((await sweep(d)).media).toBe(MAX_ROWS_PER_RUN);
    expect((await sweep(d)).media).toBe(5);
  });
});

// ── a candidate's deletion request, over the mock world ─────────────────────

const LOBBY = 'interviews:interview:iv-j6x2d9sb';
const NOW = Date.now();
const call = (over: Partial<AssistantRecord> = {}): AssistantRecord => ({
  callId: 'call-mateo', tenant: 'interviews', lobby: LOBBY, initiativeId: null, state: 'listening', invitedBy: 'u-hugo', invitedAt: NOW - 3 * DAY_MS, pausedBy: null,
  leftAt: null, leftBy: null, acked: [], attendees: ['u-hugo'], presentAtInvite: [], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], ...over,
});

async function heldCall(store: MemoryAssistantStore, leave = true) {
  await store.create(call());
  await store.appendLine({ callId: 'call-mateo', userId: 'u-hugo', participantId: 'p', speakerName: 'H', text: 'Tell me about a rate limiter.', at: NOW - 3 * DAY_MS + 1000, captionId: 'c1' });
  await store.putMinutes({ callId: 'call-mateo', tenant: 'interviews', lobby: LOBBY, initiativeId: null, callName: 'Coding', startedAt: 1, endedAt: 2, invitedBy: 'u-hugo', attendees: ['u-hugo'],
    summary: 's', decisions: [], actionItems: [], topics: [], lineCount: 1, truncated: false, writer: 'scripted', createdAt: NOW - 3 * DAY_MS });
  if (leave) await store.transition('call-mateo', { from: ['listening'], to: 'left', by: 'u-hugo', at: NOW - 3 * DAY_MS + 3_600_000 });
}

function recordingFetch(answer: (lobby: string) => number) {
  const sent: { url: string; lobby: string; verified: boolean }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { lobbyName: string };
    const header = (init.headers as Record<string, string>)[SERVICE_AUTH_HEADER]!;
    sent.push({ url, lobby: body.lobbyName, verified: verifyEnvelope(header, { secret: 'test-secret', allowedServices: ['realtime-examples'], payload: body }).ok });
    return new Response(JSON.stringify({ erased: answer(body.lobbyName) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, sent };
}

describe('a candidate\'s deletion request', () => {
  let assistant: MemoryAssistantStore;
  const ENV = { PLATFORM_API_URL: 'http://platform.test/', SERVICE_AUTH_SECRET: 'test-secret' };
  const deps: Partial<RetentionDeps> = { now: () => NOW, enabled: () => true };

  beforeEach(async () => {
    assistant = new MemoryAssistantStore();
    setResumeStores({ rows: new MemoryResumeRows(), bytes: new MemoryResumeBytes() });
    registerEraser(callWordsEraser({ store: () => assistant, eraseCall: (s, id, by, at) => s.tombstoneMinutes(id, by, at), now: () => NOW }));
  });
  afterEach(() => setResumeStores({ rows: null, bytes: null }));

  it('erases the media now, revokes the live link, removes the résumé, takes the contact details out, and logs it', async () => {
    const rec = recordingFetch((lobby) => (lobby === LOBBY ? 1 : 0));
    registerEraser(recordingEraser({ env: ENV, fetch: rec.f }));
    await heldCall(assistant);
    await inviteStore().issueInvite({ interviewId: 'iv-k1p5w8ra', tokenHash: 'b'.repeat(64), issuedBy: 'u-greta', issuedAt: new Date(NOW - DAY_MS).toISOString(), expiresAt: new Date(NOW + 9 * DAY_MS).toISOString() });
    const resume = (await resumeRows().get('cand-mateo'))!;
    expect(await resumeBytes().get(resume.storageKey)).not.toBeNull();

    const { row, created } = await deleteCandidateMedia('cand-mateo', 'u-greta', deps);
    expect(created).toBe(true);
    expect(row).toMatchObject({ reason: 'request', requestedBy: 'u-greta', left: [], attempts: 1 });
    expect(row.interviewIds.sort()).toEqual(['iv-j6x2d9sb', 'iv-k1p5w8ra']);
    expect(row.removed).toEqual([
      { kind: 'recording', count: 1 }, { kind: 'transcript-and-minutes', count: 1 }, { kind: 'pad-log', count: 12 }, { kind: 'runs', count: 2 }, { kind: 'invite', count: 1 }, { kind: 'resume', count: 1 }, { kind: 'contact-details', count: 1 },
      { kind: 'stage-reasons', count: 1 },
    ]);
    expect(row.doneAt).toBe(new Date(NOW).toISOString());
    expect(Date.parse(row.dueBy) - NOW).toBe(30 * DAY_MS);

    // The media is gone.
    expect(rec.sent.map((s) => [s.url, s.lobby, s.verified]).sort()).toEqual([
      ['http://platform.test/internal/recordings/erase', 'interviews:interview:iv-j6x2d9sb', true],
      ['http://platform.test/internal/recordings/erase', 'interviews:interview:iv-k1p5w8ra', true],
    ]);
    expect(await assistant.lines('call-mateo', 0, 10)).toEqual([]);
    // Everything the meeting assistant's own age sweep would remove: the minutes (and their tombstone), turns, actions and the record.
    expect(await assistant.getMinutes('call-mateo')).toBeNull();
    expect(await assistant.get('call-mateo')).toBeNull();
    expect(await assistant.listTurns('call-mateo')).toEqual([]);
    expect(await resumeRows().get('cand-mateo')).toBeNull();
    expect(await resumeBytes().get(resume.storageKey)).toBeNull();
    expect((await inviteStore().latestInvite('iv-k1p5w8ra'))?.revokedBy).toBe('u-greta');

    // The records stay, without the contact details; the log names none of them.
    expect(interviewConsentsFixture.rows().some((c) => c.interviewId === 'iv-j6x2d9sb')).toBe(true);
    expect(interviewScorecardsFixture.rows().some((s) => s.interviewId === 'iv-j6x2d9sb')).toBe(true);
    const cand = interviewCandidatesFixture.rows().find((c) => c.id === 'cand-mateo')!;
    expect(cand).toMatchObject({ name: 'Name removed', email: '', headline: '', location: '', notes: '', source: 'Careers page' });
    const logged = JSON.stringify(await deletionsOf('cand-mateo'));
    expect(logged).not.toMatch(/Mateo Álvarez|Álvarez|mail\.example|Madrid|\.pdf|rate limiter|ride-hailing/);

    // A second request changes nothing.
    const again = await deleteCandidateMedia('cand-mateo', 'u-greta', deps);
    expect(again).toEqual({ row, created: false });
    expect(rec.sent).toHaveLength(2);
    expect(await deletionsOf('cand-mateo')).toHaveLength(1);
  });

  it('records that there was nothing to call where no recording service is configured, and still finishes', async () => {
    registerEraser(recordingEraser({ env: {} }));
    const { row } = await deleteCandidateMedia('cand-ravi', 'u-greta', deps);
    expect(row.left).toEqual([{ kind: 'recording', why: 'no-service', retry: false }]);
    expect(row.doneAt).not.toBeNull();
  });

  it('leaves a running call for the next sweep, which finishes the request once the call is over', async () => {
    registerEraser(recordingEraser({ env: {} }));
    await heldCall(assistant, false);
    const first = await deleteCandidateMedia('cand-mateo', 'u-greta', deps);
    expect(first.row.doneAt).toBeNull();
    expect(first.row.left).toContainEqual({ kind: 'transcript-and-minutes', why: 'call-running', retry: true });
    expect((await assistant.lines('call-mateo', 0, 10))).toHaveLength(1);
    await assistant.transition('call-mateo', { from: ['listening'], to: 'left', by: 'u-hugo', at: NOW });
    expect((await sweep(deps)).retried).toBe(1);
    const [row] = await deletionsOf('cand-mateo');
    expect(row!.doneAt).not.toBeNull();
    expect(row!.removed).toContainEqual({ kind: 'transcript-and-minutes', count: 1 });
    expect(await assistant.lines('call-mateo', 0, 10)).toEqual([]);
  });
});
