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
    expect(erasersOf('media').map((e) => e.kind)).toEqual(['recording', 'transcript-and-minutes', 'pad-log']);
    // The coach's suggestion log is registered with the module's own (round 4 combine).
    expect(erasersOf('record').map((e) => e.kind)).toEqual(['consents', 'scorecards', 'suggestions', 'recaps', 'coach-log']);
    expect(eraserFor('suggestions')?.class).toBe('record');
    registerEraser({ kind: 'other-module', class: 'record', erase: async () => 0 });
    expect(erasersOf('record').map((e) => e.kind)).toEqual(['consents', 'scorecards', 'suggestions', 'recaps', 'coach-log', 'other-module']);
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
    expect(interviewPadLogFixture.rows()).toEqual([]);
    fixtureRegistry.resetAll('default');
  });
});
