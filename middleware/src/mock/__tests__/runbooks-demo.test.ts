// The Runbooks demo director (mock/runbooks-demo.ts) told end to end over real
// HTTP against the real runbooks router: the real accept gate (ReviewRunbook
// plus the owner rule, 409 on a stale base), the real store fixtures, and the
// real brief assembly (lib/run-brief.ts). What is stood in: config (the mock
// flags), Aurora, the role registry (the seed matrix) and the session cookie (a
// header the test app turns into the person who signed in).
//
// The proof the goal asks for: the brief the demo's SECOND dispatch is handed
// contains the version the demo's review accepted (docs/distillation-runbooks-goal.md).
jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    auth: { policyStoreId: '', sessionSigningSecretArn: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    cognito: { portalOrigin: '' },
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
  },
}));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn(async () => []) }));

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixtureRegistry } from '../core/index.js';
import { createRunbooksRouter } from '../../routes/runbooks.js';
import { errorHandler } from '../../lib/async-handler.js';
import { runbookStore } from '../../lib/runbooks/store-select.js';
import { clearAuthzCache } from '../../lib/authz.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { startRunbooksDemo, stopRunbooksDemo, resetRunbooksDemo, getRunbooksDemoState } from '../runbooks-demo.js';
import { ADDED_STEP_DO, FIRST_RUN, RUNBOOK_ID, SECOND_RUN } from '../runbooks-demo-script.js';

const PEOPLE: Record<string, { role: string }> = { 'u-vera': { role: 'org-leader' }, 'u-nora': { role: 'sme' } };

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.post('/api/session/login', (req, res) => {
    const userId = (req.body as { userId?: string }).userId ?? '';
    res.setHeader('set-cookie', ['demo-session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', `demo-session=${userId}; Path=/; HttpOnly`]);
    res.json({ sub: userId });
  });
  app.use((req, _res, next) => {
    const who = /^demo-session=(u-[a-z]+)$/.exec(req.headers.cookie ?? '')?.[1];
    const p = who ? PEOPLE[who] : undefined;
    if (who && p) (req as unknown as { session: unknown }).session = { sub: who, role: p.role, tenant: 'orgiq', grants: { orgiq: [p.role] }, iat: 0 };
    next();
  });
  app.use('/api/runbooks', createRunbooksRouter({ store: () => runbookStore() }));
  app.use(errorHandler);
  return app;
}

let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer(buildApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  resetRunbooksDemo();
  fixtureRegistry.resetAll('default');
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  fixtureRegistry.resetAll('default');
  resetRunbooksDemo();
  clearAuthzCache();
  resetRateLimits();
});

describe('the Runbooks demo director', () => {
  it('reaches done: a run proposes a step, the owner accepts it, and the next run\'s brief carries it', async () => {
    const store = runbookStore();
    const before = await store.getRunbook(RUNBOOK_ID);
    expect(before?.current_version).toBe(1);

    await startRunbooksDemo(base, { paceMs: Number(process.env['DEMO_PACE_MS'] ?? 200) });
    const s = getRunbooksDemoState();
    expect(s.errors).toEqual([]);
    expect(s.phase).toBe('done');
    expect(s.milestones).toEqual({ firstBrief: true, proposed: true, accepted: true, secondBrief: true, secondBriefCarriesAccepted: true });

    // The review is a real decision on the run's proposal, made by the owner.
    const proposal = await store.getProposal(s.proposalId!);
    expect(proposal).toMatchObject({ status: 'accepted', kind: 'edit', runbook_id: RUNBOOK_ID, base_version: 1, decided_by: 'p-002' });
    expect(proposal?.source).toMatchObject({ kind: 'run', run_ref: FIRST_RUN.runRef, dispatched_by: 'p-004' });
    expect((await store.getRunbook(RUNBOOK_ID))?.current_version).toBe(2);
    expect(s.acceptedVersion).toBe(2);

    // The first brief was frozen BEFORE the review and still says v1; the second carries v2.
    const first = await store.getBrief(FIRST_RUN.runRef);
    const second = await store.getBrief(SECOND_RUN.runRef);
    // R8: the briefs record the skill library each box synced; the procedure arrives as the skill, not in the brief.
    expect(first?.skill_library?.skills.find((k) => k.name === RUNBOOK_ID)?.version).toBe(1);
    expect(second?.skill_library?.skills.find((k) => k.name === RUNBOOK_ID)?.version).toBe(2);
    expect(second?.skill_library?.sha256).not.toBe(first?.skill_library?.sha256);
    expect(second?.markdown).not.toContain(ADDED_STEP_DO);
    const v2 = await runbookStore().getVersion(RUNBOOK_ID, 2);
    expect(v2?.markdown).toContain(ADDED_STEP_DO);
    expect(second?.sha256).not.toBe(first?.sha256);
    expect(s.second?.sha256).toBe(second?.sha256);
  });

  it('a reset puts the runbook back at v1 and forgets the story', async () => {
    await startRunbooksDemo(base, { paceMs: 0 });
    expect(getRunbooksDemoState().phase).toBe('done');
    fixtureRegistry.resetAll('default');
    resetRunbooksDemo();
    expect((await runbookStore().getRunbook(RUNBOOK_ID))?.current_version).toBe(1);
    expect(getRunbooksDemoState().phase).toBe('idle');
    expect(await runbookStore().getBrief(FIRST_RUN.runRef)).toBeNull();
  });

  it('stopping mid-story stops it where it is', async () => {
    const done = startRunbooksDemo(base, { paceMs: 300 });
    await new Promise((r) => setTimeout(r, 100));
    stopRunbooksDemo();
    await done;
    expect(getRunbooksDemoState().phase).toBe('stopped');
    expect(getRunbooksDemoState().milestones.accepted).toBe(false);
  });
});
