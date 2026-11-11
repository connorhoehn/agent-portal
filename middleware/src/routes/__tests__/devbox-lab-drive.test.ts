// src/routes/__tests__/devbox-lab-drive.test.ts
//
// The lab's drive (11 Nov 2026). The `/api/devbox` mount lets every role that
// directs agent work READ the fleet, and asks routes/devbox.ts's
// devboxWriteAction before any write: OperateDevbox for start, rename, stop
// and remove; the route's own RunDevboxTask gate for handing work; ManageDevbox
// for everything else. This suite mounts the router the way index.ts does —
// the real readForRolesElseAction and requireTenant, over the REAL Cedar seeds
// in open mode — and pins who gets through to what.
//
// devbox.test.ts mounts the router bare and tests the routes' own behaviour;
// agent-actions-routes.test.ts tests the box-action gate the task route
// carries. Here those route-level gates answer with a sentinel status, so the
// suite can tell "the mount let this through to the route's own gate" from
// "the mount refused it".

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '' }, cognito: {}, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));
jest.mock('../../lib/initiative-scope.js', () => ({
  ORG_WIDE_INITIATIVE_ROLES: ['org-leader', 'hr-admin', 'admin'],
  stewardsInitiative: jest.fn(async () => true),
}));
const mockAsked: string[] = [];
type Res = { status: (n: number) => { json: (b: unknown) => void } };
jest.mock('../../lib/agent-actions.js', () => ({
  requireBoxAction: (action: string) => (_req: unknown, res: Res) => {
    mockAsked.push(action);
    res.status(418).json({ ownGate: action });
  },
  requireAgentCapability: (action: string) => (_req: unknown, res: Res) => {
    mockAsked.push(action);
    res.status(418).json({ ownGate: action });
  },
}));
jest.mock('../../providers/spend-ledger.js', () => ({
  recordSpend: jest.fn(async () => undefined),
  getBoxSpend: jest.fn(async () => new Map()), spendLedgerMode: () => 'off', ledgerIsFixture: () => false,
}));
jest.mock('../../lib/spend-holds.js', () => ({
  reserveSpend: jest.fn(async (i: { initiativeId: string | null }) => ({ kind: 'held', holdId: null, initiativeId: i.initiativeId, grantId: null, amountUsd: 0 })),
  forecastP75ForModel: jest.fn(async () => ({ costUsdP75: 0.5 })),
  HOLD_GRACE_MS: 300_000,
  meterForHold: jest.fn(async () => null),
}));
jest.mock('../../providers/spend-holds.js', () => ({ releaseHold: jest.fn(async () => undefined), bindHoldSource: jest.fn(async () => undefined) }));

import express from 'express';
import request from '../../test-support/http.js';
import { devboxRouter, devboxWriteAction, _internal } from '../devbox.js';
import { readForRolesElseAction, requireTenant } from '../../lib/authz.js';
import { registerBox, _resetFleet, getBox } from '../../lib/devbox-fleet.js';
import { type Session } from '../../lib/session.js';

const SID = 'devbox-0123456789abcdef0123456789abcdef';
const READ_TIER = ['org-leader', 'hr-admin', 'program-owner'] as const;

function app(session: Partial<Session> | null) {
  const a = express();
  a.use(express.json());
  if (session) {
    a.use((req, _res, next) => {
      req.session = { sub: 'u-test', role: 'member', tenant: 'orgiq', grants: {}, iat: 0, ...session } as Session;
      next();
    });
  }
  // The composition index.ts mounts, minus nothing.
  a.use('/api/devbox', requireTenant('orgiq'), readForRolesElseAction([...READ_TIER], devboxWriteAction), devboxRouter);
  return a;
}

const as = (role: string, sub = `u-${role}`) => app({ sub, role: role as Session['role'] });

beforeAll(() => {
  // Offline: the runtime is a fake ARN and a stop needs no AWS call.
  process.env['MOCK_AGENTCORE'] = 'true';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _internal.setDataClient({ send: jest.fn(async () => ({})) } as any);
});
afterAll(() => {
  delete process.env['MOCK_AGENTCORE'];
  _internal.setDataClient(null);
});
beforeEach(() => { _resetFleet(); mockAsked.length = 0; });

// ─── The table, against the router's own routes ─────────────────────────────

describe('devboxWriteAction names the gate for every write the router has', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean> } };

  function writes(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const layer of (devboxRouter as unknown as { stack: Layer[] }).stack) {
      if (!layer.route) continue;
      for (const m of Object.keys(layer.route.methods)) {
        const method = m.toUpperCase();
        if (method === 'GET') continue;
        const path = layer.route.path.replace(':sessionId', SID).replace(':boxId', 'b1');
        out[`${method} ${layer.route.path}`] = devboxWriteAction({ method, path });
      }
    }
    return out;
  }

  it('OperateDevbox for the lab drive, the route\'s own gate for the task, ManageDevbox for the rest', () => {
    expect(writes()).toEqual({
      'POST /sessions': 'OperateDevbox',
      'POST /boxes': 'OperateDevbox',
      'PATCH /boxes/:boxId': 'OperateDevbox',
      'DELETE /boxes/:boxId': 'OperateDevbox',
      'DELETE /:sessionId': 'OperateDevbox',
      'POST /:sessionId/task': null,
      'POST /:sessionId/command': 'ManageDevbox',
      'POST /:sessionId/shell-url': 'ManageDevbox',
    });
  });

  it('a write the table does not name is ManageDevbox — the table can only widen a route by naming it', () => {
    expect(devboxWriteAction({ method: 'POST', path: '/codebases' })).toBe('ManageDevbox');
    expect(devboxWriteAction({ method: 'PUT', path: '/boxes' })).toBe('ManageDevbox');
    expect(devboxWriteAction({ method: 'POST', path: `/${SID}/task/again` })).toBe('ManageDevbox');
    expect(devboxWriteAction({ method: 'DELETE', path: `/${SID}/task` })).toBe('ManageDevbox');
  });
});

// ─── Who gets through the mount ─────────────────────────────────────────────

describe('the read tier is unchanged', () => {
  it.each(READ_TIER)('%s reads the fleet without ManageDevbox', async (role) => {
    expect((await request(as(role)).get('/api/devbox/boxes')).status).toBe(200);
  });

  it('a member is refused the fleet (no ManageDevbox), and nobody reads without a session', async () => {
    const res = await request(as('member')).get('/api/devbox/boxes');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ action: 'ManageDevbox' });
    // requireTenant answers the sessionless caller before the read tier is consulted.
    expect([401, 403]).toContain((await request(app(null)).get('/api/devbox/boxes')).status);
    expect([401, 403]).toContain((await request(app(null)).post('/api/devbox/boxes').send({ label: 'x' })).status);
  });
});

describe('org-leader drives the lab', () => {
  it('starts, renames, stops and removes a computer', async () => {
    const leader = as('org-leader');

    const minted = await request(leader).post('/api/devbox/sessions').send({});
    expect(minted.status).toBe(201);
    expect(String(minted.body.sessionId).length).toBeGreaterThanOrEqual(33);

    const made = await request(leader).post('/api/devbox/boxes').send({ label: 'Lab A', sessionId: SID });
    expect([200, 201]).toContain(made.status);
    const id = String(made.body.id ?? made.body.box?.id);
    expect(getBox(id)).not.toBeNull();

    const renamed = await request(leader).patch(`/api/devbox/boxes/${id}`).send({ label: 'Lab B' });
    expect(renamed.status).toBe(200);
    expect(getBox(id)?.label).toBe('Lab B');

    const stopped = await request(leader).delete(`/api/devbox/${SID}`);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ stopped: true, sessionId: SID });

    const removed = await request(leader).delete(`/api/devbox/boxes/${id}`);
    expect(removed.status).toBe(200);
    expect(getBox(id)).toBeNull();
  });

  it('hands work through the task route\'s own RunDevboxTask gate, which the mount no longer fronts with ManageDevbox', async () => {
    registerBox({ sessionId: SID, ownerId: 'u-org-leader' });
    const res = await request(as('org-leader')).post(`/api/devbox/${SID}/task`).send({ prompt: 'look around' });
    expect(res.status).toBe(418);
    expect(res.body).toEqual({ ownGate: 'RunDevboxTask' });
    expect(mockAsked).toEqual(['RunDevboxTask']);
  });

  it('still cannot reach the shell: the command and shell-url routes stay behind ManageDevbox at the mount', async () => {
    registerBox({ sessionId: SID, ownerId: 'u-org-leader' });
    for (const path of [`/api/devbox/${SID}/command`, `/api/devbox/${SID}/shell-url`]) {
      const res = await request(as('org-leader')).post(path).send({ command: 'ls' });
      expect([path, res.status]).toEqual([path, 403]);
      expect(res.body).toMatchObject({ action: 'ManageDevbox' });
    }
    expect(mockAsked).toEqual([]);
  });
});

describe('the roles that held ManageDevbox lost nothing', () => {
  it.each(['sme', 'hr-admin', 'admin'])('%s starts a computer and reaches the shell\'s own gate', async (role) => {
    const made = await request(as(role)).post('/api/devbox/boxes').send({ label: 'Lab', sessionId: SID });
    expect([role, [200, 201].includes(made.status)]).toEqual([role, true]);
    const shell = await request(as(role)).post(`/api/devbox/${SID}/command`).send({ command: 'ls' });
    expect([role, shell.status, shell.body]).toEqual([role, 418, { ownGate: 'OpenDevboxShell' }]);
  });
});

describe('program-owner and member stay on the read tier', () => {
  const WRITES: Array<[string, string, string]> = [
    ['POST', '/api/devbox/sessions', 'OperateDevbox'],
    ['POST', '/api/devbox/boxes', 'OperateDevbox'],
    ['PATCH', '/api/devbox/boxes/b1', 'OperateDevbox'],
    ['DELETE', '/api/devbox/boxes/b1', 'OperateDevbox'],
    ['DELETE', `/api/devbox/${SID}`, 'OperateDevbox'],
    ['POST', `/api/devbox/${SID}/command`, 'ManageDevbox'],
  ];

  const send = (role: string, method: string, path: string) => {
    const r = request(as(role));
    const req = method === 'POST' ? r.post(path) : method === 'PATCH' ? r.patch(path) : r.delete(path);
    return req.send({ label: 'x', command: 'ls' });
  };

  it.each(['program-owner', 'member'])('%s is refused every lab write by the action it lacks', async (role) => {
    registerBox({ id: 'b1', sessionId: SID });
    for (const [method, path, action] of WRITES) {
      const res = await send(role, method, path);
      expect([role, method, path, res.status]).toEqual([role, method, path, 403]);
      expect(res.body).toMatchObject({ action });
    }
    // The task route is the one write the mount lets through to its own gate.
    const task = await request(as(role)).post(`/api/devbox/${SID}/task`).send({ prompt: 'x' });
    expect(task.status).toBe(418);
    expect(mockAsked).toEqual(['RunDevboxTask']);
  });
});
