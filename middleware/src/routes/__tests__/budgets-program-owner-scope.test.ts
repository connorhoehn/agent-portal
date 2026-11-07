// A program owner allocates only within the initiatives they own
// (docs/next-steps.md §9 item 8a; lib/budget-scope.ts). Every initiative
// budget write (allocation, run limits, delete) and every sprint-envelope
// write (create, re-allocate, revoke) asks; org-leader and hr-admin are
// org-wide and never narrowed. Cedar is modelled by the program-owner forbid:
// ManageBudgets is denied when `ownsInitiative` is false.

const cedarAsked: Array<{ role: string; attrs: unknown }> = [];

jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  isAllowed: async (s: { role: string }, action: string, attrs?: { ownsInitiative?: boolean }) => {
    cedarAsked.push({ role: s.role, attrs });
    return !(action === 'ManageBudgets' && s.role === 'program-owner' && attrs?.ownsInitiative === false);
  },
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../lib/initiative-scope.js', () => ({
  // The caller's person owns p-owned only.
  ownsInitiative: jest.fn(async (_s: unknown, id: string) => id === 'p-owned'),
}));
jest.mock('../../providers/budgets.js', () => ({
  listBudgets: jest.fn(), orgSummary: jest.fn(), listGrants: jest.fn(),
  initiativeExists: jest.fn(async () => true),
  upsertAllocation: jest.fn(async (id: string, allocatedUsd: number) => ({ orgProjectId: id, allocatedUsd })),
  deleteAllocation: jest.fn(async () => true),
  getBudget: jest.fn(async () => null),
  periodsSupported: jest.fn(async () => true),
}));
jest.mock('../../providers/run-limits.js', () => ({
  upsertRunLimit: jest.fn(async () => undefined),
  getRunLimit: jest.fn(async () => null),
  scopeUsage: jest.fn(async () => ({ running: 0, runsToday: 0, usdLastHour: 0 })),
}));
jest.mock('../../providers/sprints.js', () => ({
  getSprint: jest.fn(async (id: string) => ({ id, orgProjectId: id === 'spr-owned' ? 'p-owned' : 'p-other' })),
  personExists: jest.fn(async () => true),
}));
jest.mock('../../providers/grants.js', () => ({
  updateGrant: jest.fn(async (id: string) => ({ id, orgProjectId: id === 'bg-owned' ? 'p-owned' : 'p-other' })),
  revokeGrant: jest.fn(async () => true),
  listGrantsForSprint: jest.fn(),
  getGrant: jest.fn(async (id: string) => ({ id, orgProjectId: id === 'bg-owned' ? 'p-owned' : 'p-other', allocatedUsd: 10, hardCapUsd: null })),
}));
jest.mock('../../lib/grant-envelope.js', () => ({
  grantEnvelope: jest.fn(async (g: { orgProjectId: string }) => ({ id: 'bg-new', orgProjectId: g.orgProjectId })),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { budgetsRouter } from '../budgets.js';
import { grantsRouter } from '../grants.js';
import { errorHandler } from '../../lib/async-handler.js';
import { upsertAllocation, deleteAllocation } from '../../providers/budgets.js';
import { upsertRunLimit } from '../../providers/run-limits.js';
import { updateGrant, revokeGrant } from '../../providers/grants.js';
import { grantEnvelope } from '../../lib/grant-envelope.js';

function app(role: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { sub: `u-${role}`, role, tenant: 'orgiq' }; next(); });
  a.use('/api/budgets', budgetsRouter);
  a.use('/api/grants', grantsRouter);
  a.use(errorHandler);
  return a;
}

// Every budget write on an initiative, as [label, request] against that initiative.
const WRITES: Array<[string, (a: express.Express, p: 'owned' | 'other') => ReturnType<ReturnType<typeof request>['put']>]> = [
  ['PUT allocation', (a, p) => request(a).put(`/api/budgets/p-${p}`).send({ allocatedUsd: 100 })],
  ['PUT run limits', (a, p) => request(a).put(`/api/budgets/p-${p}/limits`).send({ maxConcurrent: 2 })],
  ['DELETE allocation', (a, p) => request(a).delete(`/api/budgets/p-${p}`)],
  ['POST envelope', (a, p) => request(a).post('/api/grants').send({ initiativeId: `p-${p}`, sprintId: `spr-${p}`, granteePersonId: 'p-008', amountUsd: 5 })],
  ['PATCH envelope', (a, p) => request(a).patch(`/api/grants/bg-${p}`).send({ amountUsd: 7 })],
  ['DELETE envelope', (a, p) => request(a).delete(`/api/grants/bg-${p}`)],
];
const written = () => [upsertAllocation, upsertRunLimit, deleteAllocation, grantEnvelope, updateGrant, revokeGrant]
  .reduce((n, m) => n + (m as jest.Mock).mock.calls.length, 0);

beforeEach(() => { jest.clearAllMocks(); cedarAsked.length = 0; });

describe('program-owner budget writes are scoped to the initiatives they own', () => {
  it.each(WRITES)('%s on an initiative they own goes through, and Cedar is asked with ownsInitiative: true', async (_l, send) => {
    const res = await send(app('program-owner'), 'owned');
    expect(res.status).toBeLessThan(300);
    expect(written()).toBe(1);
    expect(cedarAsked).toEqual([{ role: 'program-owner', attrs: { ownsInitiative: true } }]);
  });

  it.each(WRITES)('%s on an initiative they do not own is 403 NOT_INITIATIVE_OWNER and writes nothing', async (_l, send) => {
    const res = await send(app('program-owner'), 'other');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'NOT_INITIATIVE_OWNER', action: 'ManageBudgets', initiativeId: 'p-other' });
    expect(written()).toBe(0);
  });

  it.each(['org-leader', 'hr-admin', 'admin'])('%s is org-wide: writes on any initiative, no ownership asked', async (role) => {
    for (const [, send] of WRITES) expect((await send(app(role), 'other')).status).toBeLessThan(300);
    expect(written()).toBe(WRITES.length);
    expect(cedarAsked).toEqual([]);
  });
});
