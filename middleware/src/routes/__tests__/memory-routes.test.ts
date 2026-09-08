// Memory events — /api/observability/memory (routes/memory.ts).
//
// What is pinned:
//   * the auth floor: both reads are open, the manual INSERT is gated on
//     ManageCanary (it writes to the observability schema),
//   * the event wire shape and its NULLs — `resultCount: null` (never
//     recorded) has to survive as null, because 0 means "the retrieve came
//     back empty", which is the whole cold-session signal,
//   * that only the FOUR known kinds are accepted, on both the filter and the
//     insert — an unknown kind is dropped from the WHERE rather than bound,
//     and refused outright on the write,
//   * that an invalid invocationId is dropped rather than cast `::uuid`, and
//     that the INSERT substitutes a literal NULL instead of binding one,
//   * the stats rollup: errorRate guarded against a zero denominator, and
//     absent percentiles reading 0,
//   * 201 (not 200) on a successful insert, and a 500 that NAMES the failure.

const gateCalls: string[] = [];

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateCalls.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { memoryRouter } from '../memory.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

type Param = { name: string; value: Record<string, unknown> };
const paramsOf = (call: number): Param[] => (execMock.mock.calls[call]![1] ?? []) as Param[];
const sqlOf = (call: number): string => String(execMock.mock.calls[call]![0]);
const namesOf = (call: number): string[] => paramsOf(call).map((p) => p.name);
const valueOf = (call: number, name: string): Record<string, unknown> | undefined =>
  paramsOf(call).find((p) => p.name === name)?.value;

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/observability/memory', memoryRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { execMock.mockReset(); });

describe('auth floor', () => {
  it('gates only the manual insert, on ManageCanary', () => {
    expect(gateCalls).toEqual(['ManageCanary']);
  });
});

describe('GET /events', () => {
  it('maps a memory event, preserving the difference between null and 0 results', async () => {
    execMock.mockResolvedValue([{
      memory_event_id: 'me-1', invocation_id: UUID, agent_id: 'orgiq-supervisor',
      session_id: 's-1', kind: 'retrieve', memory_id: 'mem-1',
      query_text: 'who owns auth', result_count: 0, duration_ms: 41,
      retrieved_summary: null, errored: false, error_message: null,
      ts: '2026-08-20T09:00:00Z',
    }, {
      memory_event_id: 'me-2', invocation_id: null, agent_id: 'orgiq-search',
      session_id: null, kind: 'write', memory_id: null, query_text: null,
      result_count: null, duration_ms: null, retrieved_summary: null,
      errored: true, error_message: 'throttled', ts: 't',
    }]);
    const res = await request(buildApp()).get('/api/observability/memory/events');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['events']);
    expect(res.body.events[0]).toEqual({
      memoryEventId: 'me-1', invocationId: UUID, agentId: 'orgiq-supervisor',
      sessionId: 's-1', kind: 'retrieve', memoryId: 'mem-1',
      queryText: 'who owns auth', resultCount: 0, durationMs: 41,
      retrievedSummary: null, errored: false, errorMessage: null,
      ts: '2026-08-20T09:00:00Z',
    });
    // 0 is "the retrieve came back empty" (a cold session); null is "never
    // recorded". Collapsing them would fabricate cold sessions.
    expect(res.body.events[0].resultCount).toBe(0);
    expect(res.body.events[1].resultCount).toBeNull();
    expect(res.body.events[1].errored).toBe(true);
  });

  it('binds each valid filter and DROPS the invalid ones', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/memory/events?invocationId=not-a-uuid&kind=teleport');
    // Neither survived: no WHERE at all, and only the limit is bound.
    expect(sqlOf(0)).not.toMatch(/WHERE/);
    expect(namesOf(0)).toEqual(['lim']);

    execMock.mockClear();
    await request(app).get(`/api/observability/memory/events?invocationId=${UUID}&agentId=orgiq-search&kind=retrieve`);
    expect(sqlOf(0)).toMatch(/invocation_id = :iid::uuid AND agent_id = :agent AND kind = :kind/);
    expect(sqlOf(0)).not.toMatch(/orgiq-search/);
    expect(valueOf(0, 'kind')).toEqual({ stringValue: 'retrieve' });
  });

  it('accepts exactly the four known kinds as a filter', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    for (const kind of ['retrieve', 'write', 'summarize', 'expire']) {
      execMock.mockClear();
      await request(app).get(`/api/observability/memory/events?kind=${kind}`);
      expect(sqlOf(0)).toMatch(/kind = :kind/);
    }
  });

  it('clamps the limit into 1..500 with a default of 50', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/memory/events');
    await request(app).get('/api/observability/memory/events?limit=9999');
    await request(app).get('/api/observability/memory/events?limit=abc');
    expect([0, 1, 2].map((i) => valueOf(i, 'lim')!['longValue'])).toEqual([50, 500, 50]);
  });

  it('degrades to an empty list when the memory_events table is missing', async () => {
    execMock.mockRejectedValue(new Error('relation "observability.memory_events" does not exist'));
    const res = await request(buildApp()).get('/api/observability/memory/events');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [] });
  });
});

describe('GET /stats', () => {
  it('rolls up per agent with a guarded error rate and a cold-session count', async () => {
    execMock.mockResolvedValue([{
      agent_id: 'orgiq-supervisor', retrieves: '40', writes: '12',
      p50_ms: '35', p99_ms: '210', errors: '2', total: '52', cold_sessions: '3',
    }]);
    const res = await request(buildApp()).get('/api/observability/memory/stats?windowHours=6');
    expect(Object.keys(res.body).sort()).toEqual(['byAgent', 'windowHours']);
    expect(res.body.windowHours).toBe(6);
    expect(res.body.byAgent[0]).toEqual({
      agentId: 'orgiq-supervisor', retrieves: 40, writes: 12,
      p50RetrieveMs: 35, p99RetrieveMs: 210, errorRate: 2 / 52, coldSessions: 3,
    });
    // A cold session is one where every retrieve came back empty — it only
    // counts sessions that actually did a retrieve.
    expect(sqlOf(0)).toMatch(/HAVING COALESCE\(SUM\(COALESCE\(result_count, 0\)\), 0\) = 0/);
    expect(sqlOf(0)).toMatch(/session_id IS NOT NULL/);
  });

  it('answers 0 — not NaN — for an agent with no events at all', async () => {
    execMock.mockResolvedValue([{
      agent_id: 'orgiq-idle', retrieves: '0', writes: '0',
      p50_ms: null, p99_ms: null, errors: '0', total: '0', cold_sessions: '0',
    }]);
    const res = await request(buildApp()).get('/api/observability/memory/stats');
    expect(res.body.byAgent[0].errorRate).toBe(0);
    expect(res.body.byAgent[0].p50RetrieveMs).toBe(0);
  });

  it('defaults the window to 24h and caps it at 14 days', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/observability/memory/stats');
    await request(app).get('/api/observability/memory/stats?windowHours=99999');
    await request(app).get('/api/observability/memory/stats?windowHours=abc');
    expect([0, 1, 2].map((i) => valueOf(i, 'hours')!['longValue'])).toEqual([24, 24 * 14, 24]);
  });

  it('degrades to an empty rollup while echoing the window', async () => {
    execMock.mockRejectedValue(new Error('boom'));
    const res = await request(buildApp()).get('/api/observability/memory/stats?windowHours=6');
    expect(res.body).toEqual({ byAgent: [], windowHours: 6 });
  });
});

describe('POST /events', () => {
  it('400s without an agentId or with an unknown kind, naming the four', async () => {
    for (const body of [{}, { agentId: 'a' }, { agentId: 'a', kind: 'teleport' }, { kind: 'write' }]) {
      const res = await request(buildApp()).post('/api/observability/memory/events').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/retrieve\|write\|summarize\|expire/);
    }
    expect(execMock).not.toHaveBeenCalled();
  });

  it('inserts and answers 201 with the new id', async () => {
    execMock.mockResolvedValue([{ memory_event_id: 'me-9' }]);
    const res = await request(buildApp()).post('/api/observability/memory/events').send({
      agentId: '  orgiq-search  ', kind: 'retrieve', invocationId: UUID,
      sessionId: 's-1', memoryId: 'mem-1', queryText: 'q',
      resultCount: 0, durationMs: 12, errored: false,
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ memoryEventId: 'me-9' });
    expect(valueOf(0, 'agent_id')).toEqual({ stringValue: 'orgiq-search' });
    expect(sqlOf(0)).toMatch(/:iid::uuid/);
    expect(valueOf(0, 'iid')).toEqual({ stringValue: UUID });
  });

  it('writes a literal NULL — not a bound parameter — when the invocation is unknown', async () => {
    execMock.mockResolvedValue([{ memory_event_id: 'me-10' }]);
    await request(buildApp()).post('/api/observability/memory/events')
      .send({ agentId: 'orgiq-search', kind: 'write', invocationId: 'not-a-uuid' });
    expect(sqlOf(0)).not.toMatch(/:iid/);
    expect(namesOf(0)).not.toContain('iid');
    expect(sqlOf(0)).toMatch(/VALUES \(\s*NULL,/);
  });

  it('truncates an oversized retrievedSummary to 500 chars', async () => {
    execMock.mockResolvedValue([{ memory_event_id: 'me-11' }]);
    await request(buildApp()).post('/api/observability/memory/events')
      .send({ agentId: 'a', kind: 'summarize', retrievedSummary: 'z'.repeat(2000) });
    expect(String(valueOf(0, 'retrieved_summary')!['stringValue'])).toHaveLength(500);
  });

  it('drops a wrongly-typed numeric to NULL rather than binding a string', async () => {
    execMock.mockResolvedValue([{ memory_event_id: 'me-12' }]);
    await request(buildApp()).post('/api/observability/memory/events')
      .send({ agentId: 'a', kind: 'retrieve', resultCount: '5', durationMs: '9' });
    expect(valueOf(0, 'result_count')).toEqual({ isNull: true });
    expect(valueOf(0, 'duration_ms')).toEqual({ isNull: true });
  });

  it('500s with the underlying reason when the insert fails', async () => {
    execMock.mockRejectedValue(new Error('null value in column "kind" violates not-null constraint'));
    const res = await request(buildApp()).post('/api/observability/memory/events')
      .send({ agentId: 'a', kind: 'retrieve' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('insert failed');
    expect(res.body.detail).toMatch(/not-null constraint/);
  });
});
