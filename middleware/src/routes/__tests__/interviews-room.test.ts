// The interview room (routes/interviews/room.ts; docs/interviews-tenant-plan.md row I2.4, contract C5), mounted as
// index.ts mounts the tenant, with ConductInterview decided from the REAL seeds/roles/*/*.cedar files.
//
//   interviewer (lead)   reads the room, starts it (accepted/ready → live), ends it (live → ended)
//   interviewer (panel)  reads the room; starting or ending is refused (403)
//   interviewer, no seat / recruiter / hiring manager / admin   not found (404) on all three routes
//   another tenant's role   the tenant's usual refusal at the mount

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
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), listUsers: jest.fn(), getUser: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import type { Session } from '../../lib/session.js';

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
const OPERATOR = who('u-operator');
const PRIYA = who('u-priya', 'access');

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
});

// Wen leads Nadia's leadership round (accepted) with Hugo on the panel; Hugo leads Mateo's design round (ready), alone.
const NADIA = 'iv-n5z9f2cq';
const MATEO = 'iv-k1p5w8ra';
const roomOf = async (as: ReturnType<typeof who>, id: string) => as.get(`/interviews/${id}/room`);

describe('reading the room', () => {
  it('the lead and the panel read it, each in their own seat', async () => {
    const lead = await roomOf(WEN, NADIA);
    expect(lead.status).toBe(200);
    expect(lead.body.room).toMatchObject({ id: NADIA, seat: 'lead', lobbyName: `interviews:interview:${NADIA}`, state: 'accepted', round: { type: 'behavioural' } });
    expect(lead.body.room.seats).toEqual([{ person: { id: 'u-wen', name: 'Wen Zhao' }, seat: 'lead' }, { person: { id: 'u-hugo', name: 'Hugo Marchetti' }, seat: 'panel' }]);
    expect((await roomOf(HUGO, NADIA)).body.room.seat).toBe('panel');
    expect(lead.headers['cache-control']).toBe('no-store');
  });

  it('carries the candidate\'s name and nothing else about them', async () => {
    const text = JSON.stringify((await roomOf(HUGO, MATEO)).body);
    expect(text).not.toMatch(/@|cand-rx6tcaqj|resume|résumé|headline/i);
  });

  it.each([
    ['an interviewer without a seat', WEN, MATEO],
    ['the recruiter', GRETA, NADIA],
    ['the hiring manager', AMARA, NADIA],
    ['the admin', OPERATOR, NADIA],
    ['anyone, an interview that does not exist', WEN, 'iv-nobody'],
  ])('%s: not found', async (_label, as, id) => {
    expect((await roomOf(as, id)).status).toBe(404);
  });

  it('another tenant\'s role is refused at the mount', async () => {
    expect((await roomOf(PRIYA, NADIA)).status).toBe(403);
  });
});

describe('starting and ending', () => {
  const revisionOf = async (id: string) => (await roomOf(id === NADIA ? WEN : HUGO, id)).body.room.revision as number;

  it('the lead starts (accepted → live), then ends (live → ended, with when); each answers the interview record', async () => {
    const r1 = await revisionOf(NADIA);
    const started = await WEN.post(`/interviews/${NADIA}/start`, { revision: r1 });
    expect(started.status).toBe(200);
    expect(started.body.interview).toMatchObject({ id: NADIA, state: 'live', revision: r1 + 1 });
    expect(started.body.interview.questionsChosen).toBeDefined();
    const ended = await WEN.post(`/interviews/${NADIA}/end`, { revision: r1 + 1 });
    expect(ended.status).toBe(200);
    expect(ended.body.interview).toMatchObject({ state: 'ended', revision: r1 + 2 });
    expect((await roomOf(WEN, NADIA)).body.room.endedAt).toEqual(expect.any(String));
  });

  it('starting a live interview again, or ending an ended one, changes nothing', async () => {
    const r1 = await revisionOf(MATEO);
    await HUGO.post(`/interviews/${MATEO}/start`, { revision: r1 });
    const again = await HUGO.post(`/interviews/${MATEO}/start`, { revision: r1 + 1 });
    expect(again.status).toBe(200);
    expect(again.body.interview).toMatchObject({ state: 'live', revision: r1 + 1 });
  });

  it('a stale revision is 409 with the interview as it now is', async () => {
    const r1 = await revisionOf(NADIA);
    const res = await WEN.post(`/interviews/${NADIA}/start`, { revision: r1 + 3 });
    expect(res.status).toBe(409);
    expect(res.body.interview).toMatchObject({ id: NADIA, revision: r1, state: 'accepted' });
  });

  it('no revision is 400; ending what has not started is 409', async () => {
    expect((await WEN.post(`/interviews/${NADIA}/start`, {})).status).toBe(400);
    const res = await WEN.post(`/interviews/${NADIA}/end`, { revision: await revisionOf(NADIA) });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This interview has not started, so there is nothing to end.');
  });

  it('a panel member cannot start or end (403)', async () => {
    const r1 = await revisionOf(NADIA);
    expect((await HUGO.post(`/interviews/${NADIA}/start`, { revision: r1 })).status).toBe(403);
    expect((await HUGO.post(`/interviews/${NADIA}/end`, { revision: r1 })).status).toBe(403);
  });

  it.each([
    ['an interviewer without a seat', WEN, MATEO, 404],
    // No ConductInterview reads the room's not-found, never a 403 (lib/interviews/gate.ts).
    ['the recruiter (no ConductInterview)', GRETA, NADIA, 404],
    ['the hiring manager (no ConductInterview)', AMARA, NADIA, 404],
    ['the admin, no seat', OPERATOR, NADIA, 404],
    ['another tenant\'s role', PRIYA, NADIA, 403],
  ])('%s: refused on both writes', async (_label, as, id, status) => {
    expect((await as.post(`/interviews/${id}/start`, { revision: 1 })).status).toBe(status);
    expect((await as.post(`/interviews/${id}/end`, { revision: 1 })).status).toBe(status);
  });
});

// The round that is live now has no call yet: the lead opens the room and joins it as it is (mock/interviews.ts LIVE_INTERVIEW_ID).
describe('the seeded round that is live now', () => {
  const LIVE = 'iv-s4e8u2zk';

  it('both seats read the room: Kwame\'s technical round, live, with both seats accepted', async () => {
    for (const seat of [HUGO, WEN]) {
      const res = await roomOf(seat, LIVE);
      expect(res.status).toBe(200);
      expect(res.body.room).toMatchObject({ id: LIVE, state: 'live', lobbyName: `interviews:interview:${LIVE}`, round: { type: 'technical' } });
    }
    expect((await roomOf(HUGO, LIVE)).body.room.seats).toEqual([{ person: { id: 'u-hugo', name: 'Hugo Marchetti' }, seat: 'lead' }, { person: { id: 'u-wen', name: 'Wen Zhao' }, seat: 'panel' }]);
  });

  it('the lead may start it again with no call (nothing written); the panel may not', async () => {
    const room = (await roomOf(HUGO, LIVE)).body.room;
    const again = await HUGO.post(`/interviews/${LIVE}/start`, { revision: room.revision });
    expect(again.status).toBe(200);
    expect(again.body.interview).toMatchObject({ state: 'live', revision: room.revision });
    expect((await WEN.post(`/interviews/${LIVE}/start`, { revision: room.revision })).status).toBe(403);
  });
});
