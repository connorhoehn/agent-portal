// The DE-42 box-action gate (lib/agent-actions.ts requireBoxAction) as
// routes/devbox.ts mounts it on POST /:sessionId/command, /shell-url (shell)
// and /task (task), in open mode over the REAL Cedar seeds, plus the
// /api/devbox tenant floor index.ts adds. devbox.test.ts passes this gate
// through so it can test the routes' own behaviour; this suite tests the gate.
//
// The split keeps every role's effective permissions (DE-42 decision taken by
// default): hr-admin keeps shell and task, so its rows here PASS; the spec's
// proposal to take them away is an open user decision.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '' }, cognito: {}, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));
const members = new Map<string, Set<string>>();
jest.mock('../../lib/initiative-scope.js', () => ({
  ORG_WIDE_INITIATIVE_ROLES: ['org-leader', 'hr-admin', 'admin'],
  stewardsInitiative: jest.fn(async (s: { sub: string; role: string } | null, id: string) =>
    !!s && (['org-leader', 'hr-admin', 'admin'].includes(s.role) || !!members.get(s.sub)?.has(id))),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { requireBoxAction } from '../../lib/agent-actions.js';
import { requireTenant } from '../../lib/authz.js';
import { registerBox, _resetFleet } from '../../lib/devbox-fleet.js';

const SID = 'devbox-0123456789abcdef0123456789abcdef';

function app(session: Record<string, unknown>) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as unknown as { session: unknown }).session = session; next(); });
  const r = express.Router();
  const ok = (_req: express.Request, res: express.Response) => { res.json({ ok: true }); };
  r.post('/:sessionId/command', requireBoxAction('OpenDevboxShell'), ok);
  r.post('/:sessionId/shell-url', requireBoxAction('OpenDevboxShell'), ok);
  r.post('/:sessionId/task', requireBoxAction('RunDevboxTask'), ok);
  a.use('/api/devbox', requireTenant('orgiq'), r);
  return a;
}
const who = (sub: string, role: string, tenant = 'orgiq') => ({ sub, role, tenant });
const ROUTES = ['command', 'shell-url', 'task'];

beforeEach(() => { _resetFleet(); members.clear(); });
afterAll(() => _resetFleet());

describe('DE-42 box actions', () => {
  it('member gets 403 on shell and task, naming the action', async () => {
    registerBox({ sessionId: SID, ownerId: 'u-mel', projectId: 'p-obs' });
    for (const r of ROUTES) {
      const res = await request(app(who('u-mel', 'member'))).post(`/api/devbox/${SID}/${r}`).send({});
      expect(res.status).toBe(403);
      expect(res.body.action).toBe(r === 'task' ? 'RunDevboxTask' : 'OpenDevboxShell');
    }
  });

  it('an sme on a box of an initiative they are not on (and not its owner) gets 403 NOT_ON_INITIATIVE, in open mode', async () => {
    registerBox({ sessionId: SID, ownerId: 'u-other', projectId: 'p-obs' });
    for (const r of ROUTES) {
      const res = await request(app(who('u-eli', 'sme'))).post(`/api/devbox/${SID}/${r}`).send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_ON_INITIATIVE');
    }
  });

  it('an sme on the initiative, or owning the box, passes', async () => {
    registerBox({ sessionId: SID, ownerId: 'u-other', projectId: 'p-obs' });
    members.set('u-eli', new Set(['p-obs']));
    for (const r of ROUTES) expect((await request(app(who('u-eli', 'sme'))).post(`/api/devbox/${SID}/${r}`).send({})).status).toBe(200);
    _resetFleet();
    registerBox({ sessionId: SID, ownerId: 'u-eli' });
    for (const r of ROUTES) expect((await request(app(who('u-eli', 'sme'))).post(`/api/devbox/${SID}/${r}`).send({})).status).toBe(200);
  });

  it('hr-admin keeps shell and task (the split removes nothing a role had)', async () => {
    registerBox({ sessionId: SID, ownerId: 'u-other', projectId: 'p-obs' });
    for (const r of ROUTES) expect((await request(app(who('u-hr', 'hr-admin'))).post(`/api/devbox/${SID}/${r}`).send({})).status).toBe(200);
  });

  it('a social participant and an assessment assessor get 403 at the orgiq tenant floor', async () => {
    registerBox({ sessionId: SID, ownerId: 'u-p', projectId: 'p-obs' });
    for (const s of [who('u-p', 'participant', 'social'), who('u-a', 'assessor', 'assessment')]) {
      for (const r of ROUTES) {
        const res = await request(app(s)).post(`/api/devbox/${SID}/${r}`).send({});
        expect(res.status).toBe(403);
        expect(res.body.requiredTenant).toBe('orgiq');
      }
    }
  });
});
