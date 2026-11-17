// Who sees an interview's money (docs/interviews-tenant-plan.md decision 18, row I0.6; lib/interviews/spend.ts):
//
//   GET /api/interviews/openings/:id/spend   the recruiter, the opening's hiring manager and the admin read its caps and
//                                            what is held, spent and left; an interviewer and a hiring manager of another
//                                            opening get the not-found; a role from another tenant is refused at the mount
//   PUT /api/interviews/openings/:id/details the recruiter sets both caps, checked in kit.ts's style
//   GET /api/spend/report|entries (Work's)   never shows the interviews source to a Work role; the cross-tenant admin sees it
//
// Mounted as index.ts mounts both, with the real Cedar seeds deciding ManageCandidates (read off disk below).

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
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), listUsers: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { listUsers, type UserInfo } from '../../providers/identity.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import type { Session } from '../../lib/session.js';
import { spendReportRouter } from '../spend-report.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { recordSpend } from '../../providers/spend-ledger.js';
import { reserveInterviewSpend } from '../../lib/interviews/spend.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
  u('u-amara', 'Amara Okafor', { interviews: ['hiring-manager'] }),
  u('u-priya', 'Priya Venkataraman', { access: ['access-admin'] }),
  u('u-operator', 'Platform Operator', { orgiq: ['admin'], interviews: ['admin'] }),
  u('u-vera', 'Vera Lindgren', { orgiq: ['org-leader'] }),
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
app.use('/api/spend', requireTenant('orgiq'), spendReportRouter);
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

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  spendHolds.reset();
  spendEntries.reset();
  delete process.env['INTERVIEWS_INTERVIEW_CAP_USD'];
});


const spendOf = async (who: ReturnType<typeof whoFn>, id: string) => who.get(`/openings/${id}/spend`);
const whoFn = who;

describe('the opening\'s money: who reads it', () => {
  it('the recruiter reads the cap with nothing spent yet', async () => {
    const r = await spendOf(GRETA, 'op-ios');
    expect(r.status).toBe(200);
    expect(r.body.spend).toEqual({
      capUsd: 100, interviewCapUsd: 8, defaultInterviewCapUsd: 10, effectiveInterviewCapUsd: 8, spentUsd: 0, heldUsd: 0, leftUsd: 100, unknownCount: 0,
    });
  });

  it('held and spent money shows, from holds and the ledger', async () => {
    const held = await reserveInterviewSpend({ interviewId: 'iv-c3k8w2ma', part: 'coach', key: 'c-1', estimateUsd: 2, expiresInMs: 60_000 });
    expect(held.ok).toBe(true);
    await recordSpend({ source: 'interviews', sourceId: 'iv:op-ios:iv-p2v7j4ye:run:r-1', initiativeId: null, boxId: null, actorId: 'u-wen', model: 'runner', costUsd: 1.5, costBasis: 'estimated' });
    expect((await spendOf(GRETA, 'op-ios')).body.spend).toMatchObject({ spentUsd: 1.5, heldUsd: 2, leftUsd: 96.5 });
  });

  it('the hiring manager reads their own opening\'s money, not another\'s', async () => {
    expect((await spendOf(AMARA, 'op-backend')).body.spend).toMatchObject({ capUsd: 150, interviewCapUsd: null, effectiveInterviewCapUsd: 10 });
    expect((await spendOf(AMARA, 'op-ios')).status).toBe(404);
  });

  it('an interviewer sees no money, even on an opening they have a round on', async () => {
    expect((await HUGO.get('/openings/op-backend')).status).toBe(200);
    const r = await spendOf(HUGO, 'op-backend');
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/Usd/);
  });

  it('the cross-tenant admin reads it; a role from another tenant is refused at the mount', async () => {
    expect((await spendOf(who('u-operator', 'orgiq', 'admin'), 'op-ios')).status).toBe(200);
    expect((await spendOf(who('u-priya', 'access'), 'op-ios')).status).toBe(403);
    expect((await spendOf(who('u-vera', 'orgiq'), 'op-ios')).status).toBe(403);
  });
});

describe('the recruiter sets the caps', () => {
  const details = async (id: string) => {
    const o = (await GRETA.get(`/openings/${id}`)).body.opening;
    return { revision: o.revision, title: o.title, level: o.level, team: o.team, location: o.location, hiringManagerId: o.hiringManager?.id ?? null, state: o.state, budgetCapUsd: o.budgetCapUsd };
  };

  it('both caps save and read back', async () => {
    const r = await GRETA.put('/openings/op-em/details', { ...(await details('op-em')), budgetCapUsd: 80, interviewCapUsd: 12.5 });
    expect(r.status).toBe(200);
    expect(r.body.opening.budgetCapUsd).toBe(80);
    expect((await spendOf(GRETA, 'op-em')).body.spend).toMatchObject({ capUsd: 80, interviewCapUsd: 12.5, effectiveInterviewCapUsd: 12.5, leftUsd: 80 });
  });

  it('a cap per interview above the opening\'s is one sentence on its field', async () => {
    const r = await GRETA.put('/openings/op-em/details', { ...(await details('op-em')), budgetCapUsd: 20, interviewCapUsd: 25 });
    expect(r.status).toBe(400);
    expect(r.body.fields).toEqual([{ path: 'interviewCapUsd', message: "The cap per interview cannot be more than the opening's spending cap." }]);
  });

  it('nobody else may set them', async () => {
    for (const w of [AMARA, HUGO]) expect((await w.put('/openings/op-em/details', { ...(await details('op-em')), budgetCapUsd: 999 })).status).toBe(403);
  });
});

describe('Work\'s spend report leaves the interviews source out', () => {
  beforeEach(async () => {
    await recordSpend({ source: 'interviews', sourceId: 'iv:op-ios:iv-c3k8w2ma:coach:c-1', initiativeId: null, boxId: null, actorId: 'u-hugo', model: 'nova', costUsd: 2.5, costBasis: 'reported' });
    await reserveInterviewSpend({ interviewId: 'iv-p2v7j4ye', part: 'listening', key: 'l-1', estimateUsd: 3, expiresInMs: 60_000 });
  });
  const vera = who('u-vera', 'orgiq');
  const admin = who('u-operator', 'orgiq', 'admin');
  const report = (w: ReturnType<typeof who>, by: string) => request(app).get(`/api/spend/report?groupBy=${by}&period=month`)
    .set('x-user', w === admin ? 'u-operator' : 'u-vera').set('x-tenant', 'orgiq').set('x-role', w === admin ? 'admin' : 'org-leader');

  it('a Work role sees no interviews group, money or entries', async () => {
    const bySource = await report(vera, 'source');
    expect(bySource.status).toBe(200);
    expect(bySource.body.groups.map((g: { key: string }) => g.key)).not.toContain('interviews');
    const byActor = await report(vera, 'actor');
    expect(byActor.body.groups.find((g: { key: string }) => g.key === 'u-hugo')).toBeUndefined();
    const entries = await request(app).get('/api/spend/entries?groupBy=source&key=interviews&period=month').set('x-user', 'u-vera').set('x-tenant', 'orgiq').set('x-role', 'org-leader');
    expect(entries.body).toMatchObject({ total: 0, entries: [] });
  });

  it('the cross-tenant admin sees it, labelled Interviews', async () => {
    const r = await report(admin, 'source');
    expect(r.body.groups.find((g: { key: string }) => g.key === 'interviews')).toMatchObject({ label: 'Interviews', knownUsd: 2.5, heldUsd: 3 });
    expect((await report(admin, 'actor')).body.groups.find((g: { key: string }) => g.key === 'u-hugo')).toMatchObject({ knownUsd: 2.5 });
  });

  it('an interviews role cannot reach Work\'s report at all', async () => {
    expect((await request(app).get('/api/spend/report?groupBy=source&period=month').set('x-user', 'u-greta').set('x-tenant', 'interviews')).status).toBe(403);
  });
});
