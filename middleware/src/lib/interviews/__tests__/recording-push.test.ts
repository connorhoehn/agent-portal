// The consent answer pushed to platform-api's POST /internal/recordings/interview-decision (lib/interviews/recording-push.ts).
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));
jest.mock('../recording-rules.js', () => ({ decideRecording: jest.fn() }));
import { SERVICE_AUTH_HEADER, verifyEnvelope } from '@connorhoehn/service-runtime';
import { decideRecording } from '../recording-rules.js';
import { RECORDING_DECISION_PATH, pushRecordingDecision } from '../recording-push.js';

const decide = decideRecording as jest.Mock;
const ENV = { PLATFORM_API_URL: 'http://platform.test/', SERVICE_AUTH_SECRET: 's3cret' } as NodeJS.ProcessEnv;
const consented = { status: 200, body: { record: true, transcribe: false, reason: 'interview-consented' } };

const noSleep = async () => {};
beforeEach(() => decide.mockReset());

describe('pushRecordingDecision', () => {
  it('posts the BFF answer for the interview lobby, signed as aws-agentcore', async () => {
    decide.mockResolvedValue(consented);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return { ok: true } as Response; }) as unknown as typeof fetch;
    expect(await pushRecordingDecision('iv-1', { env: ENV, fetch: fetchMock, warn: jest.fn(), sleep: noSleep })).toBe(true);
    expect(decide.mock.calls[0]![0]).toBe('interviews:interview:iv-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://platform.test${RECORDING_DECISION_PATH}`);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ lobbyName: 'interviews:interview:iv-1', purpose: 'interview-decision', record: true, transcribe: false, reason: 'interview-consented' });
    const header = (calls[0]!.init.headers as Record<string, string>)[SERVICE_AUTH_HEADER]!;
    expect(verifyEnvelope(header, { secret: 's3cret', allowedServices: ['aws-agentcore'], payload: body }).ok).toBe(true);
  });

  it('never throws and warns once per failure when platform-api fails or refuses', async () => {
    decide.mockResolvedValue(consented);
    const warn = jest.fn();
    const refused = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    const down = (async () => { throw new Error('connect refused'); }) as unknown as typeof fetch;
    expect(await pushRecordingDecision('iv-1', { env: ENV, fetch: refused, warn, sleep: noSleep })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await pushRecordingDecision('iv-1', { env: ENV, fetch: down, warn, sleep: noSleep })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('retries a 503 with growing waits, then succeeds', async () => {
    decide.mockResolvedValue(consented);
    const answers = [503, 503, 200];
    const waits: number[] = [];
    const fetchMock = jest.fn(async () => { const s = answers.shift()!; return { ok: s === 200, status: s } as Response; }) as unknown as typeof fetch;
    expect(await pushRecordingDecision('iv-1', { env: ENV, fetch: fetchMock, warn: jest.fn(), sleep: async (ms) => { waits.push(ms); } })).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([500, 1000]);
  });

  it('gives up on a 503 that does not clear with one warning and no throw', async () => {
    decide.mockResolvedValue(consented);
    const warn = jest.fn();
    const fetchMock = jest.fn(async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch;
    expect(await pushRecordingDecision('iv-1', { env: ENV, fetch: fetchMock, warn, sleep: noSleep })).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not retry other refusals', async () => {
    decide.mockResolvedValue(consented);
    const fetchMock = jest.fn(async () => ({ ok: false, status: 400 }) as Response) as unknown as typeof fetch;
    await pushRecordingDecision('iv-1', { env: ENV, fetch: fetchMock, warn: jest.fn(), sleep: noSleep });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when no platform-api is configured', async () => {
    const fetchMock = jest.fn();
    expect(await pushRecordingDecision('iv-1', { env: { SERVICE_AUTH_SECRET: 's' } as NodeJS.ProcessEnv, fetch: fetchMock, warn: jest.fn(), sleep: noSleep })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('sends nothing when the interview is not in a call state', async () => {
    decide.mockResolvedValue({ status: 200, body: { record: false, transcribe: false, reason: 'interview-not-open' } });
    const fetchMock = jest.fn();
    expect(await pushRecordingDecision('iv-1', { env: ENV, fetch: fetchMock, warn: jest.fn(), sleep: noSleep })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
