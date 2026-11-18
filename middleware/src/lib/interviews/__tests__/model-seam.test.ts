// O-182 (row I6.4, lane H5b): the four small Bedrock callers (the coach, Milo's private questions, the recap and the
// question plan) share one seam. These pins were written against the four separate copies BEFORE the fold and must stay
// green after it: each caller's request body (hashed, its fence token aside), its default timeout, its failure codes
// and what each failure books, the one line it logs (the error's name, never the request), and the client's one retry.
import { createHash } from 'node:crypto';

jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
const mockClientSend = jest.fn();
const mockClientCtor = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => {
  const actual = jest.requireActual('@aws-sdk/client-bedrock-runtime');
  return { ...actual, BedrockRuntimeClient: jest.fn().mockImplementation((cfg: unknown) => { mockClientCtor(cfg); return { send: mockClientSend }; }) };
});

import type { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { BedrockCoachModel } from '../coach/model.js';
import { BedrockMiloModel } from '../milo-notes/model.js';
import { BedrockRecapModel } from '../recap/model.js';
import { BedrockPlanModel } from '../plan/model.js';
import type { PlanInput } from '../plan/prompt.js';
import { FIXED_INPUT as COACH_INPUT } from '../coach/__tests__/fixed-input.js';
import { FIXED_ASK } from '../milo-notes/__tests__/fixed-input.js';
import { FIXED_INPUT as RECAP_INPUT } from '../recap/__tests__/fixed-input.js';

const KIT: PlanInput = {
  roundType: 'technical',
  minutes: 45,
  competencies: [{ id: 'c1', name: 'Problem solving', lookFor: 'Breaks it down.' }],
  questions: [{ id: 'q1', prompt: 'Walk me through a hard bug.', competencyId: 'c1' }],
};

const MODEL = 'amazon.nova-pro-v1:0';
const OK = { output: { message: { role: 'assistant', content: [{ text: 'ANSWER' }] } }, usage: { inputTokens: 11, outputTokens: 7 } };

type Caller = 'coach' | 'milo' | 'recap' | 'plan';
type SendFn = (cmd: ConverseCommand, opts: { abortSignal: AbortSignal }) => Promise<unknown>;
function call(which: Caller, send?: SendFn, timeoutMs?: number) {
  const opts = { modelId: MODEL, ...(send ? { send: send as never } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
  switch (which) {
    case 'coach': return new BedrockCoachModel(opts).suggest(COACH_INPUT);
    case 'milo': return new BedrockMiloModel(opts).ask(FIXED_ASK);
    case 'recap': return new BedrockRecapModel(opts).write(RECAP_INPUT);
    case 'plan': return new BedrockPlanModel(new BedrockMiloModel(opts)).draft(KIT);
  }
}

const bodyHash = (cmd: ConverseCommand): string =>
  createHash('sha256').update(JSON.stringify(cmd.input).replace(/untrusted-[0-9a-f]{32}/g, 'untrusted-tok')).digest('hex');

// Taken from the four separate callers before the fold (main 6a9a1d6b).
const PINNED_BODY: Record<Caller, string> = {
  coach: 'f46ba9a8693e9fc17da408b06e283b848ca3f65e8dd9a3c15c51d27be9134f38',
  milo: 'dd1eee6db4d09b67b2aab9cc9fb7ed32671cdd4a74d018eebeaf073252686e62',
  recap: 'e83462fc8834a300f1f254060f7cd9d098755568426b1c697ff4e15fd0dfb246',
  plan: '912751dcaf1bf7c6c70401aa4bd7988cf316f31fa4179b65a4e6c7dd001bdf78',
};
const LABEL: Record<Caller, string> = { coach: 'coach', milo: 'milo', recap: 'recap', plan: 'milo' };
const TIMEOUT_MS: Record<Caller, number> = { coach: 10_000, milo: 10_000, recap: 30_000, plan: 10_000 };
const CALLERS: Caller[] = ['coach', 'milo', 'recap', 'plan'];
const named = (name: string) => Object.assign(new Error('the request quoted: secret words'), { name });

let warn: jest.SpyInstance;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { warn.mockRestore(); jest.useRealTimers(); });

describe.each(CALLERS)('the %s caller through the seam', (which) => {
  it('sends its request body unchanged (its fence token aside) and returns the text and the usage', async () => {
    const sent: ConverseCommand[] = [];
    const out = await call(which, async (cmd) => { sent.push(cmd); return OK; });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.modelId).toBe(MODEL);
    expect(bodyHash(sent[0]!)).toBe(PINNED_BODY[which]);
    expect(out).toEqual({ raw: 'ANSWER', code: 'ok', sent: true, usage: { inputTokens: 11, outputTokens: 7 } });
  });

  it('reads no usage it cannot count, and an empty answer as null', async () => {
    expect(await call(which, async () => ({ output: { message: { role: 'assistant', content: [] } }, usage: { inputTokens: 'x' } }))).toEqual({ raw: null, code: 'ok', sent: true, usage: null });
  });

  it('turns a server failure into a code that books spend, and logs one line with the error\'s name only', async () => {
    expect(await call(which, async () => { throw named('InternalServerException'); })).toEqual({ raw: null, code: 'error', sent: true, usage: null });
    expect(warn.mock.calls).toEqual([[`[interviews] ${LABEL[which]} call failed`, 'InternalServerException']]);
  });

  it('a refusal books spend only where it did before the fold (the coach alone books none)', async () => {
    const out = await call(which, async () => { throw named('AccessDeniedException'); });
    expect(out).toEqual({ raw: null, code: 'error', sent: which !== 'coach', usage: null });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret words/);
  });

  it(`times out as a code at its own default timeout`, async () => {
    jest.useFakeTimers();
    let aborted = false;
    const p = call(which, (_cmd, opts) => new Promise((_r, reject) => opts.abortSignal.addEventListener('abort', () => { aborted = true; reject(named('AbortError')); })));
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS[which] - 1);
    expect(aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ raw: null, code: 'timeout', sent: true, usage: null });
    expect(warn.mock.calls).toEqual([[`[interviews] ${LABEL[which]} call failed`, 'timeout']]);
  });

  it('with no send given, goes through a Bedrock client for the region with one retry at most', async () => {
    mockClientSend.mockResolvedValueOnce(OK);
    expect((await call(which)).raw).toBe('ANSWER');
    expect(mockClientSend).toHaveBeenCalledTimes(1);
    for (const [cfg] of mockClientCtor.mock.calls) expect(cfg).toEqual({ region: 'us-east-1', maxAttempts: 2 });
    mockClientSend.mockClear();
  });
});
