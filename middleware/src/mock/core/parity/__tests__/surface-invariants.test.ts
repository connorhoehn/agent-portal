// Cross-surface parity, driven by the table in ../invariants.ts.
//
// Replaces the "two surfaces must agree" half of the nine one-off tests
// (mock-parity, bots-run-job-parity, invocations-error-parity,
// invocations-window-parity, topology-summary-parity, and the rollup/preflight
// halves of work-items-seed-parity and agent-projects-seed-parity) with one
// loop over a declarative list.
//
// Both dev:mock flags are on together in `npm run dev:mock`, so both are on
// here — these routes are exercised the way they really run.

jest.mock('../../../../config.js', () => ({
  config: {
    mock: { aurora: true, cloudwatch: true, guardrails: false, agentcore: true },
    region: 'us-east-1',
  },
}));
jest.mock('../../../../providers/aurora.js', () => ({ exec: jest.fn() }));
// Leaf modules the invocation ring's fire-and-forget trace pipeline reaches.
// Mocked so recording live traffic (the last invariant) can't spend Bedrock
// money or await a network call; the routers themselves are the real thing.
jest.mock('../../../../lib/embedding.js', () => ({
  embedText: jest.fn(async () => null),
  toPgVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
  cosineDistance: () => 0,
  EMBEDDING_DIMENSIONS: 1024,
}));
// recordInvocation fires the observability trace pipeline and forgets it; with
// no Aurora behind the mocked `exec` that pipeline just warns on every call.
// The ring buffer — the only thing the invariant reads — is written before it.
jest.mock('../../../../lib/trace-sink.js', () => {
  const actual = jest.requireActual('../../../../lib/trace-sink.js');
  actual.traceSink.enqueue = jest.fn();
  return actual;
});
jest.mock('../../../../lib/judge.js', () => ({
  judgeResponse: jest.fn(async () => ({ score: 0.8, rationale: 'fine', usage: { inputTokens: 1, outputTokens: 1 } })),
}));
jest.mock('../../../../providers/cloudwatch.js', () => {
  const actual = jest.requireActual('../../../../providers/cloudwatch.js');
  return {
    ...actual,
    putDriftMetric: jest.fn(async () => undefined),
    putQualityMetric: jest.fn(async () => undefined),
    putSchemaMetric: jest.fn(async () => undefined),
  };
});

import express, { type Express } from 'express';
import { SURFACE_INVARIANTS, type InvariantContext } from '../invariants.js';

let cachedApp: Express | null = null;
const ctx: InvariantContext = {
  async app() {
    if (cachedApp) return cachedApp;
    const { topologyRouter } = await import('../../../../routes/topology.js');
    const { observabilityRouter } = await import('../../../../routes/observability.js');
    const { errorHandler } = await import('../../../../lib/async-handler.js');
    const app = express();
    app.use(express.json());
    app.use('/api/topology', topologyRouter);
    app.use('/api/observability', observabilityRouter);
    app.use(errorHandler);
    cachedApp = app;
    return app;
  },
};

describe('the invariant table itself', () => {
  it('names, for every rule, the original test whose lesson it carries', () => {
    const names = SURFACE_INVARIANTS.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
    for (const inv of SURFACE_INVARIANTS) {
      expect(inv.replaces.length).toBeGreaterThan(5);
      expect(inv.lesson.length).toBeGreaterThan(30);
    }
  });
});

// `describe.each` rather than one loop: a violated invariant names itself in
// the test report, and the rules run in table order (the last one deliberately
// dirties the shared invocation ring).
describe.each(SURFACE_INVARIANTS.map((i) => [i.name, i] as const))(
  'mock surface invariant: %s',
  (_name, invariant) => {
    it('holds', async () => {
      const violations = await invariant.check(ctx);
      if (violations.length > 0) {
        throw new Error(
          `\n${invariant.name}\n` +
          `  why it matters: ${invariant.lesson}\n` +
          `  carries the lesson of: ${invariant.replaces}\n\n` +
          `  ${violations.length} violation(s):\n` +
          violations.map((v) => `    ${v}`).join('\n') + '\n',
        );
      }
    });
  },
);
