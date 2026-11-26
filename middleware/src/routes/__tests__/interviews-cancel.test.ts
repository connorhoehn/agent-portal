// Cancel, did not take place, and withdraw (routes/interviews/cancel.ts; gap audit 2026-11-20 §1), mounted as index.ts
// mounts the tenant, with the actions decided from the REAL seeds/roles/*/*.cedar files.
//
//   recruiter     cancels a not-yet-live round; marks a live (or past-start) round not held; withdraws an application
//   lead          marks their live (or past-start) round not held
//   panel member  refused (403); interviewer without a seat, hiring manager: not found (404)
//   another tenant's role   the tenant's usual refusal at the mount (403)

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => {
  // The role → action matrix the open-mode authz derives from the Cedar seeds, read from every
  // tenant's actual files (role-registry.ts itself cannot load under jest: import.meta.url).
  const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
  const path = jest.requireActual<typeof import('node:path')>('node:path');
  const root = path.join(__dirname, '..', '..', '..', 'seeds', 'roles');
  const roles = fs.readdirSync(root, { withFileTypes: true }).filter((d: import('node:fs').Dirent) => d.isDirectory()).flatMap((d: import('node:fs').Dirent) =>
    fs.readdirSync(path.join(root, d.name)).filter((f: string) => f.endsWith('.cedar')).map((f: string) => {
      const cedar = fs.readFileSync(path.join(root, d.name, f), 'utf8').replace(/\/\/[^\n]*/g, '');
      const caps = new Set<string>();
      for (const block of cedar.split(/\bpermit\b/).slice(1)) {
        for (const m of (block.split(';')[0] ?? '').matchAll(/OrgIQ::Action::"([^"]+)"/g)) caps.add(m[1]!);
      }
      return { id: f.replace(/\.cedar$/, ''), tenant: d.name, label: '', summary: '', capabilities: [...caps] };
    }));
  return { roleRegistry: () => [...roles, { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] }] };
});
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));
jest.mock('../../lib/social-notify.js', () => ({ ...jest.requireActual('../../lib/social-notify.js'), notifyInterviewCancelled: jest.fn(async () => []) }));
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), listUsers: jest.fn(), getUser: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import type { Session } from '../../lib/session.js';
import { interviewsFixture } from '../../mock/interviews.js';
import { notifyInterviewCancelled } from '../../lib/social-notify.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
  u('u-third', 'Ola Brandt', { interviews: ['interviewer'] }),
  u('u-amara', 'Amara Okafor', { interviews: ['hiring-manager'] }),
  u('u-priya', 'Priya Venkataraman', { access: ['access-admin'] }),
  u('u-operator', 'Platform Operator', { orgiq: ['admin'], interviews: ['admin'] }),
];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const id = String(req.headers['x-user'] ?? '');
  const me = USERS.find((x) => x.id === id);
  if (me) {
    const tenant = String(req.headers['x-tenant'] ?? 'interviews');
    const role = String(req.headers['x-role'] ?? me.grants[tenant]?.[0] ?? 'none');
    req.session = { sub: id, tenant, role, grants: me.grants, iat: 0, epoch: 0 } as Session;
  }
  next();
});
app.use('/api/interviews', requireTenant('interviews'), interviewsFlagGate, interviewsRouter);
app.use(errorHandler);

const API = '/api/interviews';
const who = (id: string, tenant = 'interviews', role?: string) => {
  const set = (r: ReturnType<ReturnType<typeof request>['get']>) => { r.set('x-user', id).set('x-tenant', tenant); return role ? r.set('x-role', role) : r; };
  return {
    get: (p: string) => set(request(app).get(`${API}${p}`)),
    post: (p: string, body: unknown) => set(request(app).post(`${API}${p}`)).send(body as object),
    put: (p: string, body: unknown) => set(request(app).put(`${API}${p}`)).send(body as object),
  };
};
const GRETA = who('u-greta');
const HUGO = who('u-hugo');
const WEN = who('u-wen');
const AMARA = who('u-amara');
const PRIYA = who('u-priya', 'access');

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  (notifyInterviewCancelled as jest.Mock).mockClear();
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
});

// Wen leads Nadia's leadership round (accepted, Hugo on the panel); Hugo leads her design round (accepted). Kwame's
// coding round is live now (Hugo lead, Wen panel); his design round is assigned. Mateo's coding round is ready.
const NADIA = 'iv-n5z9f2cq';
const NADIA_DESIGN = 'iv-m8t3h6ng';
const NADIA_APP = 'app-efd7rc6g';
const LIVE = 'iv-s4e8u2zk';
const KWAME_APP = 'app-pn7v4yev';
const MATEO = 'iv-k1p5w8ra';
const HELD = 'iv-d7q4n9xe';

const row = (id: string) => interviewsFixture.rows().find((i) => i.id === id)!;
const rev = (id: string) => row(id).revision;
const flush = async () => { for (let k = 0; k < 20; k += 1) await new Promise((r) => setImmediate(r)); };

describe('cancel (the recruiter, a round not yet live)', () => {
  it('moves it to cancelled with the reason, note, who and when; the row shows it; the seats are told', async () => {
    const res = await GRETA.post(`/interviews/${NADIA}/cancel`, { revision: rev(NADIA), reason: 'interviewer_unavailable', note: 'Wen is out sick.' });
    expect(res.status).toBe(200);
    expect(res.body.interview).toMatchObject({
      id: NADIA, state: 'cancelled', bucket: 'closed',
      cancellation: { reason: 'interviewer_unavailable', label: 'Interviewer unavailable', note: 'Wen is out sick.', by: { id: 'u-greta' }, at: expect.any(String) },
    });
    await flush();
    expect(notifyInterviewCancelled).toHaveBeenCalledWith(expect.objectContaining({ interviewId: NADIA, userIds: ['u-wen', 'u-hugo'], actorId: 'u-greta', notHeld: false }));
    // The list reads it too.
    const list = await GRETA.get('/interviews');
    expect(JSON.stringify(list.body)).toContain('Interviewer unavailable');
  });

  it('frees the round: the same round is assigned again for the same application', async () => {
    await GRETA.post(`/interviews/${NADIA}/cancel`, { revision: rev(NADIA), reason: 'rescheduling' });
    const again = await GRETA.post('/interviews', { applicationId: NADIA_APP, roundId: row(NADIA).roundId, leadId: 'u-wen', panelIds: [] });
    expect(again.status).toBe(201);
    expect(again.body.interview).toMatchObject({ state: 'assigned', cancellation: null });
  });

  it('a cancelled round owes no scorecard: the seats read it as closed, never scorecard due', async () => {
    await GRETA.post(`/interviews/${NADIA}/cancel`, { revision: rev(NADIA), reason: 'rescheduling' });
    for (const as of [WEN, HUGO]) {
      const items = (await as.get('/interviews')).body.items as Array<{ id: string; bucket: string }>;
      expect(items.find((i) => i.id === NADIA)?.bucket).toBe('closed');
    }
  });

  it('a live round, a held round and an already cancelled one are 409', async () => {
    expect((await GRETA.post(`/interviews/${LIVE}/cancel`, { revision: rev(LIVE), reason: 'other' })).status).toBe(409);
    expect((await GRETA.post(`/interviews/${HELD}/cancel`, { revision: rev(HELD), reason: 'other' })).status).toBe(409);
    await GRETA.post(`/interviews/${NADIA}/cancel`, { revision: rev(NADIA), reason: 'other' });
    expect((await GRETA.post(`/interviews/${NADIA}/cancel`, { revision: rev(NADIA), reason: 'other' })).status).toBe(409);
  });

  it('a bad reason or a long note is 400; no revision is 400; a stale one is 409 and writes nothing', async () => {
    expect((await GRETA.post(`/interviews/${NADIA}/cancel`, { revision: rev(NADIA), reason: 'no_show' })).status).toBe(400);
    expect((await GRETA.post(`/interviews/${NADIA}/cancel`, { revision: rev(NADIA), reason: 'other', note: 'x'.repeat(281) })).status).toBe(400);
    expect((await GRETA.post(`/interviews/${NADIA}/cancel`, { reason: 'other' })).status).toBe(400);
    expect((await GRETA.post(`/interviews/${NADIA}/cancel`, { revision: rev(NADIA) + 4, reason: 'other' })).status).toBe(409);
    expect(row(NADIA).state).toBe('accepted');
  });

  it.each([
    ['the lead (no AssignInterviews)', WEN, 404],
    ['the hiring manager', AMARA, 404],
    ['another tenant\'s role', PRIYA, 403],
  ])('%s is refused', async (_label, as, status) => {
    expect((await as.post(`/interviews/${NADIA}/cancel`, { revision: rev(NADIA), reason: 'other' })).status).toBe(status);
    expect(row(NADIA).state).toBe('accepted');
  });

  it('an interview that does not exist is not found', async () => {
    expect((await GRETA.post('/interviews/iv-nobody/cancel', { revision: 1, reason: 'other' })).status).toBe(404);
  });
});

describe('did not take place', () => {
  it('the lead, on a live round: cancelled (no_show), the room closes, nobody owes a scorecard', async () => {
    const res = await HUGO.post(`/interviews/${LIVE}/not-held`, { revision: rev(LIVE), reason: 'no_show' });
    expect(res.status).toBe(200);
    expect(res.body.interview).toMatchObject({ state: 'cancelled', cancellation: { reason: 'no_show', label: 'Candidate did not show up' } });
    expect(row(LIVE).endedAt).toEqual(expect.any(String));
    await flush();
    expect(notifyInterviewCancelled).toHaveBeenCalledWith(expect.objectContaining({ interviewId: LIVE, userIds: ['u-hugo', 'u-wen'], actorId: 'u-hugo', notHeld: true }));
    const mine = await WEN.get('/interviews');
    const live = (mine.body.items as Array<{ id: string; bucket: string }>).find((i) => i.id === LIVE);
    expect(live?.bucket).toBe('closed');
  });

  it('the recruiter, on a live round', async () => {
    const res = await GRETA.post(`/interviews/${LIVE}/not-held`, { revision: rev(LIVE), reason: 'did_not_take_place' });
    expect(res.status).toBe(200);
    expect(res.body.interview.state).toBe('cancelled');
  });

  it('a not-yet-live round only once its start has passed', async () => {
    expect((await HUGO.post(`/interviews/${MATEO}/not-held`, { revision: rev(MATEO), reason: 'no_show' })).status).toBe(409);
    row(MATEO).scheduledAt = new Date(Date.now() - 3_600_000).toISOString();
    const res = await HUGO.post(`/interviews/${MATEO}/not-held`, { revision: rev(MATEO), reason: 'no_show' });
    expect(res.status).toBe(200);
    expect(res.body.interview.state).toBe('cancelled');
  });

  it('a held round is 409; a cancel reason is 400', async () => {
    expect((await HUGO.post(`/interviews/${HELD}/not-held`, { revision: rev(HELD), reason: 'no_show' })).status).toBe(409);
    expect((await HUGO.post(`/interviews/${LIVE}/not-held`, { revision: rev(LIVE), reason: 'rescheduling' })).status).toBe(400);
  });

  it.each([
    ['a panel member', WEN, 403],
    ['an interviewer without a seat', who('u-third'), 404],
    ['the hiring manager', AMARA, 404],
    ['another tenant\'s role', PRIYA, 403],
  ])('%s is refused', async (_label, as, status) => {
    expect((await as.post(`/interviews/${LIVE}/not-held`, { revision: rev(LIVE), reason: 'no_show' })).status).toBe(status);
    expect(row(LIVE).state).toBe('live');
  });
});

describe('withdraw (the recruiter, an application)', () => {
  const historyOf = async (id: string) => {
    const { interviewApplicationsFixture } = await import('../../mock/interviews.js');
    return interviewApplicationsFixture.rows().find((a) => a.id === id)!;
  };

  it('moves it to withdrawn and cancels its not-yet-live rounds with candidate_withdrew', async () => {
    const app = await historyOf(NADIA_APP);
    const res = await GRETA.post(`/applications/${NADIA_APP}/withdraw`, { basedOn: app.history.length });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ application: { id: NADIA_APP, stage: 'withdrawn' }, cancelled: expect.arrayContaining([NADIA, NADIA_DESIGN]) });
    expect(row(NADIA)).toMatchObject({ state: 'cancelled', cancellation: { reason: 'candidate_withdrew', by: 'u-greta' } });
    expect(row(NADIA_DESIGN).state).toBe('cancelled');
    expect((await historyOf(NADIA_APP)).stage).toBe('withdrawn');
    await flush();
    expect(notifyInterviewCancelled).toHaveBeenCalledTimes(2);
  });

  it('is refused while a round is live, twice, and on a stale read', async () => {
    const kwame = await historyOf(KWAME_APP);
    expect((await GRETA.post(`/applications/${KWAME_APP}/withdraw`, { basedOn: kwame.history.length })).status).toBe(409);
    const app = await historyOf(NADIA_APP);
    expect((await GRETA.post(`/applications/${NADIA_APP}/withdraw`, { basedOn: app.history.length + 3 })).status).toBe(409);
    expect((await GRETA.post(`/applications/${NADIA_APP}/withdraw`, { basedOn: app.history.length })).status).toBe(200);
    expect((await GRETA.post(`/applications/${NADIA_APP}/withdraw`, { basedOn: app.history.length + 1 })).status).toBe(409);
    expect((await GRETA.post(`/applications/${NADIA_APP}/withdraw`, {})).status).toBe(400);
  });

  it.each([
    ['an interviewer', WEN, 404],
    ['the hiring manager', AMARA, 404],
    ['another tenant\'s role', PRIYA, 403],
  ])('%s is refused', async (_label, as, status) => {
    const app = await historyOf(NADIA_APP);
    expect((await as.post(`/applications/${NADIA_APP}/withdraw`, { basedOn: app.history.length })).status).toBe(status);
    expect((await historyOf(NADIA_APP)).stage).toBe('interviewing');
  });

  it('an application that does not exist is not found', async () => {
    expect((await GRETA.post('/applications/app-nobody/withdraw', { basedOn: 1 })).status).toBe(404);
  });
});
