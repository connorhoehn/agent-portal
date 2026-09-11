// Canary — /api/observability/canary (routes/canary.ts). The A/B prompt
// experiment: the weighted ask, the live event stream, and the four control
// mutations.
//
// What is pinned:
//   * the auth floor. This router is mounted ABOVE the ViewObservability gate
//     so the landing page can read /prompts and /events unauthenticated — so
//     every mutation has to carry its OWN `ManageCanary` gate, and there are
//     exactly four of them,
//   * the HALT contract, which is the safety property of the whole feature: a
//     halted experiment forces every ask onto version A (the baseline)
//     regardless of the stored weight, and halting sets the weight to 0 too,
//   * that the judge is FIRE-AND-FORGET and never runs on a failed or empty
//     stream — a judge score for a response that never arrived would be a
//     fabricated data point,
//   * the wire frames the timeline consumes: a `meta` frame naming the picked
//     version before any delta, `delta` frames, and an `invocation_complete`
//     carrying the latency and a bounded preview,
//   * `/prompts` degrading to bare ARNs when GetPrompt is refused, rather
//     than failing the page,
//   * the weight validation boundary (an integer 0..100, nothing else) and
//     that a manual override is stamped so the controller stops touching it,
//   * `/start` clamping its initial weight into 1..50 and CLEARING the halt.

const gateActions: string[] = [];

// `mock` is all false on purpose: everything pinned below is the REAL path —
// the ConverseStream against the picked ARN, the GetPrompt behind /prompts,
// and the degradations when either is refused. The offline branches this
// router grew (a declared subject answer, a template resolved from the offline
// library) are covered in `src/mock/__tests__/canary-offline.test.ts`, where
// the fixtures and the clock are. Omitting the key entirely, which this mock
// did until the branches landed, is not "mock off" — it is a TypeError on the
// first `config.mock.agentcore` read.
jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: false, agentcore: false, guardrails: false, cloudwatch: false },
    canary: { name: 'orgiq-canary', judgeArn: 'arn:judge' },
  },
}));
jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateActions.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));

const converseSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class { send(cmd: unknown) { return converseSend(cmd); } },
  ConverseStreamCommand: class { constructor(public readonly input: unknown) {} },
}));
const agentSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send(cmd: unknown) { return agentSend(cmd); } },
  GetPromptCommand: class { constructor(public readonly input: unknown) {} },
}));

jest.mock('../../lib/sse.js', () => ({
  initSSE: (res: { writeHead: (n: number, h: Record<string, string>) => void }) =>
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }),
  writeSSE: (res: { writableEnded: boolean; write: (s: string) => void }, data: unknown) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  },
  endSSE: (res: { writableEnded: boolean; end: () => void }) => { if (!res.writableEnded) res.end(); },
}));
jest.mock('../../lib/canary-broker.js', () => ({
  canaryBroker: { publish: jest.fn(), replay: jest.fn(), subscribe: jest.fn() },
}));
jest.mock('../../lib/canary-router.js', () => ({ pickVersion: jest.fn() }));
jest.mock('../../lib/weight-cache.js', () => ({
  getWeightB: jest.fn(), setWeightB: jest.fn(), getControl: jest.fn(), setControl: jest.fn(),
  getSubjectAArn: jest.fn(), getSubjectBArn: jest.fn(), setSubjectArns: jest.fn(),
}));
jest.mock('../../lib/canary-local-controller.js', () => ({ resetLocalController: jest.fn() }));
jest.mock('../../lib/canary-judge.js', () => ({ fireJudge: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { canaryRouter } from '../canary.js';
import { errorHandler } from '../../lib/async-handler.js';
import { canaryBroker } from '../../lib/canary-broker.js';
import { pickVersion } from '../../lib/canary-router.js';
import {
  getWeightB, setWeightB, getControl, setControl,
  getSubjectAArn, getSubjectBArn, setSubjectArns,
} from '../../lib/weight-cache.js';
import { resetLocalController } from '../../lib/canary-local-controller.js';
import { fireJudge } from '../../lib/canary-judge.js';

const m = <T,>(fn: T): jest.Mock => fn as unknown as jest.Mock;
const broker = canaryBroker as unknown as { publish: jest.Mock; replay: jest.Mock; subscribe: jest.Mock };
const published = () => broker.publish.mock.calls.map((c) => c[0] as Record<string, unknown>);

const BASE = '/api/observability/canary';
const ASK = { person_name: 'Nora Vance', topic: 'auth', summary: 'who owns it' };

function stream(chunks: string[]) {
  converseSend.mockResolvedValue({
    stream: (async function* gen() {
      for (const text of chunks) yield { contentBlockDelta: { delta: { text } } };
    })(),
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(BASE, canaryRouter);
  app.use(errorHandler);
  return app;
}

const settle = (ms = 20) => new Promise((r) => { setTimeout(r, ms); });

beforeEach(() => {
  jest.clearAllMocks();
  m(getWeightB).mockResolvedValue(20);
  m(getControl).mockResolvedValue({ halted: false });
  m(getSubjectAArn).mockResolvedValue('arn:a');
  m(getSubjectBArn).mockResolvedValue('arn:b');
  m(pickVersion).mockReturnValue('B');
  broker.replay.mockReturnValue([]);
  broker.subscribe.mockReturnValue(() => {});
});

describe('auth floor', () => {
  it('carries exactly four ManageCanary gates — the reads are deliberately open', () => {
    // The router is mounted above ViewObservability so the landing page works
    // unauthenticated; every mutation therefore needs its own gate.
    expect(gateActions).toEqual(['ManageCanary', 'ManageCanary', 'ManageCanary', 'ManageCanary']);
  });
});

describe('POST /ask', () => {
  it('400s a missing field before invoking any model', async () => {
    const app = buildApp();
    for (const body of [{}, { person_name: 'n' }, { person_name: 'n', topic: 't' }]) {
      const res = await request(app).post('/api/observability/canary/ask').send(body);
      expect(res.status).toBe(400);
    }
    expect(converseSend).not.toHaveBeenCalled();
  });

  it('names the picked version in a meta frame BEFORE any delta', async () => {
    stream(['hello ', 'world']);
    const res = await request(buildApp()).post('/api/observability/canary/ask').send(ASK);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const frames = res.text.trim().split('\n\n')
      .map((l) => JSON.parse(l.replace(/^data: /, '')) as Record<string, unknown>);
    expect(frames[0]!['type']).toBe('meta');
    expect(frames[0]!['version']).toBe('B');
    expect(frames[0]!['weight_b']).toBe(20);
    expect(frames[1]).toEqual({ type: 'delta', text: 'hello ' });
    const complete = frames.at(-1)!;
    expect(complete['type']).toBe('invocation_complete');
    expect(complete['response_preview']).toBe('hello world');
    expect(typeof complete['latency_ms']).toBe('number');
  });

  it('invokes the ARN OF THE PICKED VERSION, with the ask as prompt variables', async () => {
    stream(['x']);
    await request(buildApp()).post('/api/observability/canary/ask').send(ASK);
    const input = (converseSend.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input['modelId']).toBe('arn:b');
    expect(input['promptVariables']).toEqual({
      person_name: { text: 'Nora Vance' }, topic: { text: 'auth' }, summary: { text: 'who owns it' },
    });
  });

  it('FORCES version A while the experiment is halted, whatever the weight says', async () => {
    // The safety property: a halted canary must not route anyone onto B.
    m(getControl).mockResolvedValue({ halted: true });
    m(getWeightB).mockResolvedValue(100);
    stream(['x']);
    await request(buildApp()).post('/api/observability/canary/ask').send(ASK);
    expect(pickVersion).not.toHaveBeenCalled();
    expect((converseSend.mock.calls[0]![0] as { input: { modelId: string } }).input.modelId).toBe('arn:a');
    expect(published()[0]!['version_label']).toBe('A');
  });

  it('500s — before opening a stream — when the picked subject has no ARN', async () => {
    m(getSubjectBArn).mockResolvedValue('');
    const res = await request(buildApp()).post('/api/observability/canary/ask').send(ASK);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Canary subject B ARN not configured/);
    expect(converseSend).not.toHaveBeenCalled();
  });

  it('reports a stream failure in-band and does NOT judge a response that never arrived', async () => {
    converseSend.mockRejectedValue(new Error('ThrottlingException'));
    const res = await request(buildApp()).post('/api/observability/canary/ask').send(ASK);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/"type":"error"/);
    expect(res.text).toMatch(/ThrottlingException/);
    // The invocation still completes on the timeline — the operator needs to
    // see the failed attempt — but nothing is scored.
    expect(res.text).toMatch(/"type":"invocation_complete"/);
    await settle();
    expect(fireJudge).not.toHaveBeenCalled();
  });

  it('does not judge an EMPTY response either', async () => {
    stream([]);
    await request(buildApp()).post('/api/observability/canary/ask').send(ASK);
    await settle();
    expect(fireJudge).not.toHaveBeenCalled();
  });

  it('fires the judge AFTER the stream closes, with the version it actually ran', async () => {
    stream(['grounded answer']);
    await request(buildApp()).post('/api/observability/canary/ask').send(ASK);
    await settle();
    expect(fireJudge).toHaveBeenCalledTimes(1);
    expect(m(fireJudge).mock.calls[0]![0]).toMatchObject({
      question: 'auth — Nora Vance', personName: 'Nora Vance', topic: 'auth',
      response: 'grounded answer', versionLabel: 'B', versionArn: 'arn:b',
      canaryName: 'orgiq-canary',
    });
  });

  it('publishes started and complete against the SAME request id', async () => {
    stream(['x']);
    await request(buildApp()).post('/api/observability/canary/ask').send(ASK);
    const [started, complete] = published();
    expect(started!['type']).toBe('invocation_started');
    expect(complete!['type']).toBe('invocation_complete');
    expect(complete!['request_id']).toBe(started!['request_id']);
  });
});

describe('GET /events', () => {
  it('REPLAYS the buffer on connect so a fresh tab catches up, then subscribes', async () => {
    broker.replay.mockReturnValue([
      { type: 'weight_changed', weight_b: 20, source: 'controller', ts: 't' },
    ]);
    const pending = request(buildApp()).get('/api/observability/canary/events');
    pending.then(() => undefined, () => undefined);
    await settle(60);
    expect(broker.replay).toHaveBeenCalled();
    expect(broker.subscribe).toHaveBeenCalled();
    pending.abort();
    await settle(40);
  });

  it('unsubscribes when the client goes away', async () => {
    const unsubscribe = jest.fn();
    broker.subscribe.mockReturnValue(unsubscribe);
    const pending = request(buildApp()).get('/api/observability/canary/events');
    pending.then(() => undefined, () => undefined);
    await settle(60);
    pending.abort();
    await settle(60);
    expect(unsubscribe).toHaveBeenCalled();
  });
});

describe('GET /prompts', () => {
  it('returns both subjects with their templates and the judge ARN', async () => {
    agentSend.mockImplementation((cmd: { input: { promptIdentifier: string } }) => Promise.resolve({
      defaultVariant: 'v1',
      variants: [{ name: 'v1', templateConfiguration: { text: { text: `template for ${cmd.input.promptIdentifier}` } } }],
    }));
    const res = await request(buildApp()).get('/api/observability/canary/prompts');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['judge', 'subject_a', 'subject_b']);
    expect(res.body.subject_a).toEqual({ arn: 'arn:a', label: 'A', template: 'template for arn:a' });
    expect(res.body.subject_b.label).toBe('B');
    expect(res.body.judge).toEqual({ arn: 'arn:judge' });
  });

  it('degrades to the bare ARN when GetPrompt is refused, rather than failing the page', async () => {
    agentSend.mockRejectedValue(new Error('AccessDeniedException'));
    const res = await request(buildApp()).get('/api/observability/canary/prompts');
    expect(res.status).toBe(200);
    expect(res.body.subject_a).toEqual({ arn: 'arn:a', label: 'A' });
    expect(res.body.subject_a.template).toBeUndefined();
  });

  it('does not call GetPrompt at all for an unconfigured subject', async () => {
    m(getSubjectBArn).mockResolvedValue('');
    agentSend.mockResolvedValue({ variants: [] });
    const res = await request(buildApp()).get('/api/observability/canary/prompts');
    expect(res.body.subject_b).toEqual({ arn: '', label: 'B' });
    expect(agentSend).toHaveBeenCalledTimes(1);
  });
});

describe('GET /weight', () => {
  it('returns the weight beside the control state the page needs to read it', async () => {
    m(getControl).mockResolvedValue({ halted: true, manual_override_until: '2026-08-20T09:10:00Z' });
    const res = await request(buildApp()).get('/api/observability/canary/weight');
    expect(res.status).toBe(200);
    expect(res.body.weight_b).toBe(20);
    // A weight of 20 means nothing without knowing the experiment is halted.
    expect(res.body.control.halted).toBe(true);
  });
});

describe('PUT /weight', () => {
  it('refuses anything that is not an integer 0..100', async () => {
    const app = buildApp();
    for (const weight_b of [undefined, -1, 101, 12.5, 'abc', null, {}]) {
      const res = await request(app).put('/api/observability/canary/weight').send({ weight_b });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/integer between 0 and 100/);
    }
    expect(setWeightB).not.toHaveBeenCalled();
  });

  it('accepts a numeric STRING, and the 0 and 100 boundaries', async () => {
    const app = buildApp();
    for (const weight_b of [0, 100, '35']) {
      const res = await request(app).put('/api/observability/canary/weight').send({ weight_b });
      expect(res.status).toBe(200);
    }
    expect(m(setWeightB).mock.calls.map((c) => c[0])).toEqual([0, 100, 35]);
  });

  it('stamps a manual override so the controller stops moving the weight', async () => {
    const res = await request(buildApp()).put('/api/observability/canary/weight').send({ weight_b: 35 });
    expect(res.body).toEqual({ ok: true, weight_b: 35 });
    expect(setWeightB).toHaveBeenCalledWith(35, 'manual');
    const until = (m(setControl).mock.calls[0]![0] as { manual_override_until: string }).manual_override_until;
    expect(Date.parse(until)).toBeGreaterThan(Date.now());
    // Roughly ten minutes out — the documented override window.
    expect(Date.parse(until) - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
    expect(published()[0]).toMatchObject({ type: 'weight_changed', weight_b: 35, source: 'manual' });
  });
});

describe('POST /halt', () => {
  it('zeroes the weight AND sets halted — both, or the stop is not a stop', async () => {
    const res = await request(buildApp()).post('/api/observability/canary/halt').send({});
    expect(res.body).toEqual({ ok: true });
    expect(setWeightB).toHaveBeenCalledWith(0, 'halt');
    expect(setControl).toHaveBeenCalledWith({ halted: true });
    expect(published()[0]).toMatchObject({ type: 'weight_changed', weight_b: 0, source: 'halt' });
  });
});

describe('POST /start', () => {
  it('requires both subject ARNs', async () => {
    const app = buildApp();
    expect((await request(app).post('/api/observability/canary/start').send({})).status).toBe(400);
    const noB = await request(app).post('/api/observability/canary/start').send({ subject_a_arn: 'arn:a' });
    expect(noB.status).toBe(400);
    expect(noB.body.error).toMatch(/subject_b_arn is required/);
    expect(setSubjectArns).not.toHaveBeenCalled();
  });

  it('clamps the initial weight into 1..50 and defaults it to 10', async () => {
    const app = buildApp();
    const body = { subject_a_arn: ' arn:a ', subject_b_arn: 'arn:b' };
    await request(app).post('/api/observability/canary/start').send(body);
    await request(app).post('/api/observability/canary/start').send({ ...body, initial_weight_b: 0 });
    await request(app).post('/api/observability/canary/start').send({ ...body, initial_weight_b: 99 });
    await request(app).post('/api/observability/canary/start').send({ ...body, initial_weight_b: 'abc' });
    expect(m(setWeightB).mock.calls.map((c) => c[0])).toEqual([10, 1, 50, 10]);
    expect(m(setSubjectArns).mock.calls[0]).toEqual(['arn:a', 'arn:b']);
  });

  it('CLEARS the halt and both timers, and resets the local controller', async () => {
    const res = await request(buildApp()).post('/api/observability/canary/start')
      .send({ subject_a_arn: 'arn:a', subject_b_arn: 'arn:b', initial_weight_b: 25 });
    expect(res.body).toEqual({ ok: true, subject_a_arn: 'arn:a', subject_b_arn: 'arn:b', weight_b: 25 });
    expect(setControl).toHaveBeenCalledWith({ halted: false, manual_override_until: '', cooldown_until: '' });
    expect(resetLocalController).toHaveBeenCalledWith(25);
  });
});

describe('POST /reset', () => {
  it('returns to A-only WITHOUT leaving the experiment halted', async () => {
    // Reset is not halt: weight 0 means everyone is on A, but the experiment
    // can be restarted without first clearing a stop flag.
    const res = await request(buildApp()).post('/api/observability/canary/reset').send({});
    expect(res.body).toEqual({ ok: true });
    expect(setWeightB).toHaveBeenCalledWith(0, 'halt');
    expect(setControl).toHaveBeenCalledWith({ halted: false });
    expect(resetLocalController).toHaveBeenCalledWith(0);
  });
});
