// Topology route tests (routes/topology.ts).
//
// One agent is one node. The graph used to disagree: it grouped on
// (agent_id, agent_name), and the same agent legitimately carries more than
// one name — its own bundle says "Supervisor", a middleware-side fallback row
// says "orgiq-supervisor". That produced two nodes for one agent, each with
// half the traffic, on a page whose entire job is showing how many agents
// there are and who calls whom.
//
// The grouping happens in SQL, so what is pinned here is the SQL: the GROUP BY
// keys, and the name-picking expression that prefers a real label over the id
// echoed back. Plus the response mapping on top of it.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
// config.ts uses import.meta (ESM-only) and this suite exercises the REAL
// (non-mock) Aurora path below, so mock.aurora must read false here — same
// pattern as agents-invoke-capability.test.ts.
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import express from 'express';
import request from '../../test-support/http.js';
import { topologyRouter } from '../topology.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/topology', topologyRouter);
app.use(errorHandler);

/** Collapse whitespace so assertions read against the SQL's shape, not its
 *  indentation. */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

let nodeSql = '';
let edgeSql = '';

beforeEach(() => {
  jest.clearAllMocks();
  nodeSql = '';
  edgeSql = '';
  execMock.mockImplementation(async (sql: string) => {
    if (/JOIN win c/.test(sql)) {
      edgeSql = flat(sql);
      return [{
        source_agent_id: 'orgiq-supervisor', source_agent_name: 'Supervisor',
        target_agent_id: 'orgiq-search', target_agent_name: 'Search',
        call_count: 4, p50_ms: 900, p95_ms: 1800, total_cost_usd: 0.0215,
        error_count: 0,
      }];
    }
    nodeSql = flat(sql);
    return [{
      agent_id: 'orgiq-supervisor', agent_name: 'Supervisor',
      invocation_count: 5, error_count: 0,
      p50_ms: 10531, p95_ms: 12000, total_cost_usd: 0.013,
    }];
  });
});

describe('GET /api/topology/a2a — node identity', () => {
  it('groups nodes by agent_id alone, never by (agent_id, agent_name)', async () => {
    await request(app).get('/api/topology/a2a').expect(200);

    expect(nodeSql).toContain('GROUP BY agent_id');
    // The exact shape that split the supervisor in two.
    expect(nodeSql).not.toContain('GROUP BY agent_id, agent_name');
  });

  it('picks a display name, preferring one that is not the id echoed back', async () => {
    await request(app).get('/api/topology/a2a').expect(200);

    // "Supervisor" must win over "orgiq-supervisor" for agent_id
    // 'orgiq-supervisor', so the node reads as a name and not as a slug.
    expect(nodeSql).toContain('agent_name <> agent_id');
    expect(nodeSql).toContain('MIN(agent_name) FILTER');
    // And it can never render nameless.
    expect(nodeSql).toContain('MIN(agent_id)');
  });

  it('groups edges by the two agent_ids alone', async () => {
    await request(app).get('/api/topology/a2a').expect(200);

    expect(edgeSql).toContain('GROUP BY p.agent_id, c.agent_id');
    expect(edgeSql).not.toContain('GROUP BY p.agent_id, p.agent_name');
    expect(edgeSql).toContain('p.agent_name <> p.agent_id');
    expect(edgeSql).toContain('c.agent_name <> c.agent_id');
  });
});

describe('GET /api/topology/a2a — response', () => {
  it('maps one grouped row to one node and one edge', async () => {
    const res = await request(app).get('/api/topology/a2a').expect(200);

    expect(res.body.nodes).toEqual([{
      agentId: 'orgiq-supervisor', agentName: 'Supervisor',
      invocationCount: 5, errorCount: 0,
      p50Ms: 10531, p95Ms: 12000, totalCostUsd: 0.013,
    }]);
    expect(res.body.edges).toHaveLength(1);
    expect(res.body.edges[0]).toMatchObject({
      source: 'orgiq-supervisor', sourceName: 'Supervisor',
      target: 'orgiq-search', targetName: 'Search', callCount: 4,
    });
  });

  it('clamps the window and passes it as a bound parameter', async () => {
    await request(app).get('/api/topology/a2a?windowHours=99999').expect(200);

    const params = execMock.mock.calls[0]![1] as Array<{ name: string; value: { longValue: number } }>;
    expect(params.find((p) => p.name === 'hours')?.value.longValue).toBe(24 * 30);
  });

  it('degrades to an empty graph when the traces table is unavailable', async () => {
    execMock.mockRejectedValue(new Error('relation does not exist'));

    const res = await request(app).get('/api/topology/a2a').expect(200);
    expect(res.body).toMatchObject({ nodes: [], edges: [], windowHours: 24 });
  });
});
