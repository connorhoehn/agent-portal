// POST /api/observability/invocations/:invocationId/replay — offline.
//
// WHY THIS FILE EXISTS. Replay went on 500ing in `dev:mock` long after every
// library beneath it had an offline path, because all three of its blockers
// were in the HANDLER: a bare `exec` source lookup, `getRuntimeArn`'s
// `ListAgentRuntimes`, and a raw `InvokeAgentRuntimeCommand`. Rule 4's write
// scan reports leaves in `src/lib/**` and `src/providers/**` and excludes
// `exec` everywhere as transport, so none of the three was ever on its list —
// the budget said the route was fine for as long as it was broken, and it does
// not move now that it is not. A static scan that cannot see this route is
// exactly why the route needs a test that ISSUES the request.
//
// So every assertion below is about behaviour a scan cannot make: that a real
// seeded invocation replays end to end, that the trace it produces is a real
// trace another route can read back by id, and — the half that matters more —
// that the two rules this pipeline exists to enforce still refuse it. A replay
// that always succeeds would be worse than the 500 it replaces.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    accountId: '',
    auth: { policyStoreId: '', sessionSigningSecretArn: '' },
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
  },
}));

// The gate is recorded, not exercised: `requireAction('ManageCanary')` is the
// subject of the authz suites, and Cedar's seed files are unreadable under
// jest's CJS transform anyway. Pinning WHICH action guards replay still
// matters — replay re-invokes an agent, so it must not ride the observability
// read tier that member/sme hold.
const gateCalls: string[] = [];
jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateCalls.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { invocationsRouter, getRuntimeArn } from '../invocations.js';
import { errorHandler } from '../../lib/async-handler.js';
import { agentcore } from '../../providers/index.js';
import { mockRuntimeArn } from '../../lib/devbox-arn.js';
import { agentFleet } from '../../mock/agent-statuses.js';
import {
  sinkSamplingConfig,
  sinkTraceById,
  sinkTraces,
} from '../../mock/trace-sink.js';
import { fixtureRegistry, freezeClock, unfreezeClock } from '../../mock/core/index.js';

// A source row every seeded corpus carries — `mock/invocations.ts` names the
// tail's ids `mock-inv-<n>`, and `mock-inv-0` is the row `GET /search` returns
// first. Not a uuid, deliberately: the id shape check is the live path's, and
// applying it offline is what made this route 404 every id it could serve.
const SOURCE_ID = 'mock-inv-0';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let restoreClock: () => void;
beforeEach(() => {
  // Frozen so the replay's stopwatch is a stable 0 rather than a racy 1 — the
  // handler times the mock invoke with `clock.now()` for exactly this reason.
  restoreClock = freezeClock('2026-09-08T15:20:00.000Z');
  fixtureRegistry.resetAll('default');
});
afterEach(() => {
  jest.restoreAllMocks();
  restoreClock();
  unfreezeClock();
  fixtureRegistry.resetAll('default');
});

/**
 * An empty fleet, the way the floor actually offers one.
 *
 * NOT `agentFleet.reset('empty')`: `Fixture.reset(scenario)` clears that
 * scenario's cached materialization, it does not switch the fixture into it —
 * only the registry (or the control plane's per-fixture pin) does that. And
 * `resetAll('empty')` would empty the trace corpus too, so the replay would
 * 404 on its source row before it ever reached the runtime lookup. Emptying the
 * live array is the documented way a mock mutates a fixture; `resetAll`
 * in `afterEach` puts it back.
 */
function emptyFleet(): void {
  agentFleet.rows().length = 0;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  // A fleet-wide role: this file is about replay, not trace scope
  // (invocations-scope.test.ts owns who may read which trace).
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub: 'u-operator', role: 'org-leader', tenant: 'orgiq', grants: {}, iat: 0 };
    next();
  });
  app.use('/api/observability/invocations', invocationsRouter);
  app.use(errorHandler);
  return app;
}

describe('POST /:invocationId/replay — offline', () => {
  it('is gated on ManageCanary, not the observability read tier', () => {
    expect(gateCalls).toContain('ManageCanary');
  });

  it('replays a seeded invocation and writes a real trace to the sink', async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/observability/invocations/${SOURCE_ID}/replay`)
      .send({});

    expect(res.status).toBe(200);
    // A fresh uuid, not the source id — this is a new invocation, and the sink
    // mints the id because the caller has none.
    expect(res.body.invocationId).toMatch(UUID_RE);
    expect(res.body.invocationId).not.toBe(SOURCE_ID);
    expect(res.body.agentId).toBe('orgiq-supervisor');
    expect(res.body.parentInvocationId).toBe(SOURCE_ID);
    expect(typeof res.body.response).toBe('string');
    expect(res.body.response.length).toBeGreaterThan(0);
    expect(res.body.durationMs).toBe(0);
    expect(res.body.persisted).toBe(true);
    expect(res.body.notPersisted).toBeUndefined();

    // The trace is a TRACE, not a response body: it is in the same fixture
    // `POST /harness/trace` writes to, keyed by the id the reply returned, and
    // it points back at the source so the trace tree shows the replay branch.
    const row = sinkTraceById(res.body.invocationId);
    expect(row).not.toBeNull();
    expect(row!.agent_id).toBe('orgiq-supervisor');
    expect(row!.response_snippet.length).toBeGreaterThan(0);
  });

  it('admits that a non-uuid source id cannot be linked as a parent', async () => {
    // `parent_invocation_id` is a uuid column and `processTrace` drops anything
    // that is not one. The seeded corpus is keyed `mock-inv-<n>`, so the row
    // persists with a NULL parent and the replay does NOT show up as a child in
    // the trace tree. The response says `parentInvocationId: 'mock-inv-0'`
    // because that IS what was replayed — `parentLinked` is what stops that
    // being read as a link the stored row does not have.
    const app = buildApp();
    const res = await request(app)
      .post(`/api/observability/invocations/${SOURCE_ID}/replay`)
      .send({});

    expect(res.body.parentInvocationId).toBe(SOURCE_ID);
    expect(res.body.parentLinked).toBe(false);
    expect(sinkTraceById(res.body.invocationId)!.parent_invocation_id).toBeNull();
  });

  it('says the answer came from the offline corpus rather than a runtime', async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/observability/invocations/${SOURCE_ID}/replay`)
      .send({});

    // The one thing about an offline replay that is NOT real. Everything else
    // on the response — the source row, the transport, the sink — is; the
    // answer is one of the fleet's canned ones, and a caller reading
    // `response` would otherwise take it for the deployed agent's.
    expect(res.body.degraded).toBe(true);
    expect(res.body.error).toContain('mock/responses.ts');
  });

  it('replays the override prompt when one is supplied', async () => {
    const app = buildApp();
    const spy = jest.spyOn(agentcore, 'invokeAgent');
    await request(app)
      .post(`/api/observability/invocations/${SOURCE_ID}/replay`)
      .send({ newPrompt: 'Who knows Kubernetes best?' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1].message).toBe('Who knows Kubernetes best?');
  });

  it('404s an id no corpus serves, without inventing a source row', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/observability/invocations/not-a-real-invocation/replay')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invocation_not_found');
    expect(sinkTraces.rows()).toHaveLength(0);
  });

  it('503s when the fleet carries no runtime for the source agent', async () => {
    // The runtime-missing path stays reachable offline because the mock ARN is
    // gated on the fleet fixture, not returned unconditionally. Asking for an
    // empty fleet is how an auditor stands in front of it.
    emptyFleet();
    const app = buildApp();
    const res = await request(app)
      .post(`/api/observability/invocations/${SOURCE_ID}/replay`)
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('replay_runtime_unavailable');
    expect(sinkTraces.rows()).toHaveLength(0);
  });

  it('resolves the runtime through the shared -MOCK ARN seam', async () => {
    // One spelling of "a runtime that was never deployed", shared with
    // lib/devbox-arn.ts rather than a second one written here.
    await expect(getRuntimeArn('orgiq-supervisor'))
      .resolves.toBe(mockRuntimeArn('orgiq_supervisor'));
    emptyFleet();
    await expect(getRuntimeArn('orgiq-supervisor')).resolves.toBeNull();
  });

  it('still honours the sampling die, and says so', async () => {
    // `trace-sink-sampling` empty means `decideSampling` falls back to its
    // hard-coded 0.1 — the rate that made this lab's observability pages look
    // broken. A replay that persisted anyway would be a replay that had opted
    // out of the pipeline it claims to exercise.
    sinkSamplingConfig.rows().length = 0;
    jest.spyOn(Math, 'random').mockReturnValue(0.9);
    const app = buildApp();
    const res = await request(app)
      .post(`/api/observability/invocations/${SOURCE_ID}/replay`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(false);
    expect(res.body.notPersisted).toContain('sampling');
    expect(sinkTraces.rows()).toHaveLength(0);
  });

  it('still drops a phantom bundle, and says so', async () => {
    // An agent that answers nothing at all is the write-side phantom guard's
    // whole case: no model, no response, no tokens, no tool calls, no
    // guardrail signal, no memory events. The route reports the drop instead
    // of handing back an invocationId that names no row.
    jest.spyOn(agentcore, 'invokeAgent').mockResolvedValue({ text: '', toolCalls: [] });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/observability/invocations/${SOURCE_ID}/replay`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(false);
    expect(res.body.notPersisted).toContain('phantom');
    expect(sinkTraces.rows()).toHaveLength(0);
  });

  it('leaves the first row standing when the same replay is repeated', async () => {
    // Two replays are two invocations, each with its own id — the ON CONFLICT
    // rule is about a retried bundle, not about a second replay.
    const app = buildApp();
    const a = await request(app).post(`/api/observability/invocations/${SOURCE_ID}/replay`).send({});
    const b = await request(app).post(`/api/observability/invocations/${SOURCE_ID}/replay`).send({});

    expect(a.body.invocationId).not.toBe(b.body.invocationId);
    expect(sinkTraces.rows()).toHaveLength(2);

    // And the control plane's reset is what puts the world back.
    fixtureRegistry.resetAll('default');
    expect(sinkTraces.rows()).toHaveLength(0);
    expect(sinkTraceById(a.body.invocationId)).toBeNull();
  });
});
