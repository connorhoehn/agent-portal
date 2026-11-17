// The recording eraser's client for contract D5 and the registry's contract D6 (lib/interviews/retention/erasers.ts, registry.ts).
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { SERVICE_AUTH_HEADER, verifyEnvelope } from '@connorhoehn/service-runtime';
import { recordingEraser, recordingServiceUrl } from '../erasers.js';
import { EraserSkipped, eraserFor, erasersOf, registerEraser, unregisterEraser } from '../registry.js';
import '../service.js';

const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('the recording eraser (D5)', () => {
  it('has nothing to call where no platform-api is configured', async () => {
    await expect(recordingEraser({ env: {} }).erase(['iv-1'])).rejects.toBeInstanceOf(EraserSkipped);
    expect(recordingServiceUrl({ SOCIAL_PLATFORM_INTERNAL_URL: 'http://a/', PLATFORM_API_URL: 'http://b' })).toBe('http://a');
  });
  it('signs the body with the service secret under the gateway\'s service id, one call per interview, and sums what was erased', async () => {
    const seen: unknown[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as object;
      const header = (init.headers as Record<string, string>)[SERVICE_AUTH_HEADER]!;
      seen.push([body, verifyEnvelope(header, { secret: 's', allowedServices: ['bff'], payload: body }).ok]);
      return new Response(JSON.stringify({ erased: 2 }), { status: 200 });
    }) as unknown as typeof fetch;
    const e = recordingEraser({ env: { PLATFORM_API_URL: 'http://p', SERVICE_AUTH_SECRET: 's', WORK_GRAPH_GATEWAY_SERVICE_ID: 'bff' }, fetch: f });
    expect(await e.erase(['iv-1', 'iv-2'])).toBe(4);
    expect(seen).toEqual([[{ lobbyName: 'interviews:interview:iv-1' }, true], [{ lobbyName: 'interviews:interview:iv-2' }, true]]);
  });
  it('fails (to be retried) on a refusal, or a configured URL without the secret', async () => {
    await expect(recordingEraser({ env: { PLATFORM_API_URL: 'http://p', SERVICE_AUTH_SECRET: 's' }, fetch: answer(400, { error: 'x' }) }).erase(['iv-1'])).rejects.toThrow(/400/);
    await expect(recordingEraser({ env: { PLATFORM_API_URL: 'http://p' }, fetch: answer(200, { erased: 1 }) }).erase(['iv-1'])).rejects.toThrow(/SERVICE_AUTH_SECRET/);
  });
});

describe('the registry (D6)', () => {
  afterEach(() => unregisterEraser('other-module'));
  it('holds this module\'s own erasers, takes another module\'s, and refuses a malformed one', () => {
    expect(erasersOf('media').map((e) => e.kind)).toEqual(['recording', 'transcript-and-minutes', 'pad-log', 'runs']);
    expect(eraserFor('runs')?.class).toBe('media');
    // The coach's suggestion log is registered with the module's own (round 4 combine).
    expect(erasersOf('record').map((e) => e.kind)).toEqual(['consents', 'scorecards', 'suggestions', 'recaps', 'coach-log', 'said-log']);
    expect(eraserFor('suggestions')?.class).toBe('record');
    registerEraser({ kind: 'other-module', class: 'record', erase: async () => 0 });
    expect(erasersOf('record').map((e) => e.kind)).toEqual(['consents', 'scorecards', 'suggestions', 'recaps', 'coach-log', 'said-log', 'other-module']);
    expect(() => registerEraser({ kind: '', class: 'media', erase: async () => 0 })).toThrow(TypeError);
    expect(() => registerEraser({ kind: 'x', class: 'other' as 'media', erase: async () => 0 })).toThrow(TypeError);
  });
});

describe('the pad log\'s eraser (row I4.3; decision 17)', () => {
  it('is media, and removes the interviews\' pad events and nothing else', async () => {
    const { interviewPadLogFixture } = await import('../../../../mock/interviews-pad-log.js');
    const { fixtureRegistry } = await import('../../../../mock/core/index.js');
    fixtureRegistry.resetAll('default');
    const eraser = eraserFor('pad-log')!;
    expect(eraser.class).toBe('media');
    const seeded = interviewPadLogFixture.rows().filter((r) => r.interviewId === 'iv-j6x2d9sb').length;
    expect(seeded).toBeGreaterThan(0);
    expect(await eraser.erase(['iv-f2b6t5zh'])).toBe(0);
    expect(await eraser.erase(['iv-j6x2d9sb'])).toBe(seeded);
    expect(interviewPadLogFixture.rows().some((r) => r.interviewId === 'iv-j6x2d9sb')).toBe(false);
    expect(interviewPadLogFixture.rows().length).toBeGreaterThan(0);
    fixtureRegistry.resetAll('default');
  });
});

// Lane H5 (OWED O-269): the said log (`interview_said_log`, lib/interviews/speak) is a decision record. Only its eraser is
// the real one here; every other kind is a counting stand-in, so the test reads which class ran when.
describe('the said log\'s eraser (row I3.5; decision 17)', () => {
  const END_MS = Date.parse('2026-01-10T15:00:00.000Z');
  const DAY = 86_400_000;
  const saidRow = (interviewId: string, id: string) => ({
    id, interviewId, callId: null, kind: 'question' as const, source: 'kit' as const, questionId: 'q-1', suggestionId: null,
    text: 'Walk me through the limiter.', askedBy: 'u-lead', saidAt: '2026-01-10T14:10:00.000Z', spoken: true,
  });
  const iv = (id: string, state: string) => ({
    id, applicationId: 'app-x', roundId: 'rd', type: 'technical', leadId: 'u-lead', panelIds: [], scheduledAt: '2026-01-10T14:00:00.000Z', minutes: 60,
    state, questionIds: [], assignedBy: 'u-r', assignedAt: '2026-01-01T09:00:00.000Z', callId: null,
    endedAt: state === 'ended' ? new Date(END_MS).toISOString() : null, acceptances: [], declines: [], revision: 1,
  });
  const world = {
    openings: [], scorecards: [],
    candidates: [{ id: 'cand-x', name: 'Test Person', email: 'test.person@example.test', headline: '', location: '', source: '', resumeFileId: null, notes: '', createdAt: '2026-01-01T00:00:00.000Z' }],
    applications: [{ id: 'app-x', candidateId: 'cand-x', openingId: 'op', stage: 'interviewing', appliedAt: '2026-01-01T00:00:00.000Z', history: [] }],
    interviews: [iv('iv-done', 'ended'), iv('iv-open', 'ready')],
  };
  const OTHERS = ['recording', 'transcript-and-minutes', 'pad-log', 'runs', 'consents', 'scorecards', 'suggestions', 'recaps', 'coach-log'];

  let saved: import('../registry.js').Eraser[] = [];
  let ran: string[] = [];
  beforeEach(async () => {
    const { MemorySaidStore, setSaidStore } = await import('../../speak/index.js');
    const { setDeletionStore } = await import('../store.js');
    setSaidStore(new MemorySaidStore());
    setDeletionStore(null);
    saved = OTHERS.map((k) => eraserFor(k)!).filter(Boolean);
    ran = [];
    for (const e of saved) registerEraser({ kind: e.kind, class: e.class, erase: async (ids) => { ran.push(e.kind); return ids.length; } });
  });
  afterEach(async () => {
    const { setSaidStore } = await import('../../speak/index.js');
    const { setDeletionStore } = await import('../store.js');
    for (const e of saved) registerEraser(e);
    setSaidStore(null);
    setDeletionStore(null);
  });

  const deps = (nowMs: number) => ({
    now: () => nowMs, load: async () => world as never, enabled: () => true, periods: () => ({ mediaDays: 90, recordYears: 4, deletionDays: 30 }),
    removeResume: async () => false, revokeInvite: async () => false, ringOverdue: async () => 0,
    records: () => ({ eraseConsents: async () => 0, eraseScorecards: async () => 0, redactCandidate: async () => 0, redactStageReasons: async () => 0 }),
  });

  it('is registered as a record, so the media sweep at 91 days leaves it', async () => {
    const { saidStore } = await import('../../speak/index.js');
    const { sweep } = await import('../service.js');
    expect(eraserFor('said-log')?.class).toBe('record');
    await saidStore().append(saidRow('iv-done', 'said-1'));
    expect((await sweep(deps(END_MS + 91 * DAY))).media).toBe(1);
    expect(ran).toEqual(expect.arrayContaining(['recording', 'pad-log', 'runs']));
    expect(await saidStore().list('iv-done')).toHaveLength(1);
  });

  it('runs in the record sweep just over four years after the end, for that interview only; an open one keeps its rows', async () => {
    const { saidStore } = await import('../../speak/index.js');
    const { sweep, deletionsOf } = await import('../service.js');
    await saidStore().append(saidRow('iv-done', 'said-1'));
    await saidStore().append(saidRow('iv-done', 'said-2'));
    await saidStore().append(saidRow('iv-open', 'said-3'));
    const fourYears = new Date(END_MS); fourYears.setUTCFullYear(fourYears.getUTCFullYear() + 4);
    await sweep(deps(fourYears.getTime() - 60_000));
    expect(await saidStore().list('iv-done')).toHaveLength(2);
    await sweep(deps(fourYears.getTime() + 60_000));
    expect(await saidStore().list('iv-done')).toEqual([]);
    expect(await saidStore().list('iv-open')).toHaveLength(1);
    const record = (await deletionsOf('cand-x')).find((r) => r.reason === 'record-period');
    expect(record!.removed).toContainEqual({ kind: 'said-log', count: 2 });
  });

  it('a candidate\'s deletion request runs the media erasers and keeps the said log for its record period, as it keeps the consents', async () => {
    const { saidStore } = await import('../../speak/index.js');
    const { deleteCandidateMedia } = await import('../service.js');
    await saidStore().append(saidRow('iv-done', 'said-1'));
    const { row } = await deleteCandidateMedia('cand-x', 'u-r', deps(END_MS + DAY));
    expect(row.doneAt).not.toBeNull();
    expect(ran).toEqual(expect.arrayContaining(['recording', 'transcript-and-minutes', 'pad-log', 'runs']));
    expect(ran).not.toContain('consents');
    expect(row.removed.map((r) => r.kind)).not.toContain('said-log');
    expect(await saidStore().list('iv-done')).toHaveLength(1);
  });
});
