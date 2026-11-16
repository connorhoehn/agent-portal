// /api/interviews (routes/interviews.ts) — the interviews tenant's phase 0 reads and its permission
// matrix (docs/interviews-tenant-plan.md, decision 2; rows I0.3 to I0.5), mounted as index.ts mounts it:
// `requireTenant('interviews')`, the server flag, then ViewInterviews decided from the REAL
// seeds/roles/*/*.cedar files (read off disk below, never a typed list), over the registered fixtures.
//
//   recruiter       reads everything in the tenant
//   interviewer     reads only the interviews assigned to them, and through them that candidate and opening
//   hiring-manager  reads only their own openings and what hangs off them
//   anyone else     the tenant's usual refusal: 403 at the mount for another tenant's session, 403 from
//                   Cedar for a role without ViewInterviews, 401 (or the demo fallback's 403) with no session
// A row outside the viewer's scope does not exist (404), so ids cannot be probed.

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

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
  u('u-amara', 'Amara Okafor', { interviews: ['hiring-manager'] }),
  u('u-theo', 'Theo Chang', { orgiq: ['member'], social: ['participant'] }),
  u('u-rhea', 'Rhea Castellanos', { access: ['requester'] }),
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

const as = (id: string, tenant = 'interviews', role?: string) => (path: string) => {
  const r = request(app).get(path).set('x-user', id).set('x-tenant', tenant);
  return role ? r.set('x-role', role) : r;
};
const GRETA = as('u-greta');
const HUGO = as('u-hugo');
const WEN = as('u-wen');
const AMARA = as('u-amara');

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
});

describe('the recruiter reads everything in the tenant', () => {
  it('GET /candidates: twelve rows with opening, stage, next interview and last result, names not ids', async () => {
    const res = await GRETA('/api/interviews/candidates');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(12);
    const mateo = res.body.items.find((r: { candidate: { name: string } }) => r.candidate.name === 'Mateo Álvarez');
    expect(mateo).toMatchObject({ opening: { title: 'Senior Backend Engineer' }, stage: 'interviewing',
      nextInterview: { roundName: 'System design', lead: { name: 'Hugo Marchetti' } }, lastResult: { recommendation: 'yes', roundName: 'Coding' } });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /openings, /openings/:id, /interviews, /interviews/:id and /candidates/:id', async () => {
    expect((await GRETA('/api/interviews/openings')).body.items.map((o: { title: string }) => o.title))
      .toEqual(['Engineering Manager', 'iOS Engineer', 'Senior Backend Engineer']);
    const ios = await GRETA('/api/interviews/openings/op-ios');
    expect(ios.status).toBe(200);
    expect(ios.body.opening).toMatchObject({ title: 'iOS Engineer', hiringManager: null, recruiter: { name: 'Greta Lindqvist' } });
    expect(ios.body.opening.competencies.map((c: { name: string }) => c.name)).toContain('Swift and SwiftUI');
    expect((await GRETA('/api/interviews/interviews')).body.items).toHaveLength(11);
    const aiko = await GRETA('/api/interviews/interviews/iv-aiko-coding');
    expect(aiko.body.interview).toMatchObject({ candidate: { name: 'Aiko Tanaka' }, lead: { name: 'Wen Zhao' }, state: 'ready', seat: null });
    const ingrid = await GRETA('/api/interviews/candidates/cand-ingrid');
    expect(ingrid.body.candidate.applications[0].interviews.map((i: { id: string }) => i.id).sort()).toEqual(['iv-ingrid-coding', 'iv-ingrid-together']);
  });

  it('an id that does not exist is a 404', async () => {
    for (const p of ['/api/interviews/openings/op-nope', '/api/interviews/candidates/cand-nope', '/api/interviews/interviews/iv-nope']) {
      expect((await GRETA(p)).status).toBe(404);
    }
  });
});

describe('an interviewer reads only the interviews assigned to them', () => {
  it('GET /interviews: Hugo\'s six, with his desk buckets; none of Wen\'s alone', async () => {
    const res = await HUGO('/api/interviews/interviews');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id).sort();
    expect(ids).toEqual(['iv-ingrid-coding', 'iv-kwame-coding', 'iv-mateo-coding', 'iv-mateo-design', 'iv-nadia-design', 'iv-nadia-leadership']);
    expect(res.body.items.find((i: { id: string }) => i.id === 'iv-kwame-coding').bucket).toBe('to-accept');
  });

  it('cannot open another interviewer\'s interview, or its candidate or opening, by id', async () => {
    expect((await HUGO('/api/interviews/interviews/iv-aiko-coding')).status).toBe(404);
    expect((await HUGO('/api/interviews/candidates/cand-aiko')).status).toBe(404);
    expect((await HUGO('/api/interviews/openings/op-ios')).status).toBe(404);
    expect((await WEN('/api/interviews/interviews/iv-mateo-design')).status).toBe(404);
  });

  it('opens their own interview, and through it the candidate and the opening', async () => {
    const own = await HUGO('/api/interviews/interviews/iv-mateo-design');
    expect(own.status).toBe(200);
    expect(own.body.interview).toMatchObject({ seat: 'lead', questionsChosen: [{ id: 'q-be-ledger' }] });
    expect((await HUGO('/api/interviews/candidates/cand-mateo')).status).toBe(200);
    expect((await HUGO('/api/interviews/openings/op-backend')).status).toBe(200);
  });

  it('sees only their own scorecards: Wen\'s card on Ingrid is not in Hugo\'s read of her', async () => {
    const res = await HUGO('/api/interviews/candidates');
    const ingrid = res.body.items.find((r: { candidate: { name: string } }) => r.candidate.name === 'Ingrid Solberg');
    expect(ingrid.lastResult).toMatchObject({ roundName: 'Coding', interviewer: { name: 'Hugo Marchetti' } });
    const rec = await HUGO('/api/interviews/interviews/iv-ingrid-coding');
    expect(rec.body.interview.scorecards.map((s: { interviewer: { name: string } }) => s.interviewer.name)).toEqual(['Hugo Marchetti']);
  });
});

describe('a hiring manager reads only their own openings and what hangs off them', () => {
  it('GET /openings: Amara\'s two, with candidates by stage', async () => {
    const res = await AMARA('/api/interviews/openings');
    expect(res.body.items.map((o: { title: string }) => o.title)).toEqual(['Engineering Manager', 'Senior Backend Engineer']);
    expect(res.body.items.find((o: { id: string }) => o.id === 'op-backend').byStage).toEqual({ interviewing: 2, debrief: 1, screening: 1, rejected: 1 });
  });

  it('never the opening that is not theirs, nor its candidates or interviews', async () => {
    expect((await AMARA('/api/interviews/openings/op-ios')).status).toBe(404);
    expect((await AMARA('/api/interviews/candidates/cand-aiko')).status).toBe(404);
    expect((await AMARA('/api/interviews/interviews/iv-ravi-coding')).status).toBe(404);
    const names = (await AMARA('/api/interviews/candidates')).body.items.map((r: { candidate: { name: string } }) => r.candidate.name);
    expect(names).toHaveLength(8);
    expect(names).not.toContain('Ravi Menon');
  });
});

describe('everyone else gets the tenant\'s usual refusal', () => {
  it.each([
    ['a Work member in Work', 'u-theo', 'orgiq', undefined],
    ['an Access requester in Access', 'u-rhea', 'access', undefined],
    ['an Access admin in Access', 'u-priya', 'access', undefined],
  ])('%s: 403 at the mount, naming the tenant it needs', async (_label, id, tenant, role) => {
    for (const p of ['/api/interviews/candidates', '/api/interviews/openings', '/api/interviews/interviews', '/api/interviews/interviews/iv-mateo-design']) {
      const res = await as(id, tenant, role)(p);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ requiredTenant: 'interviews' });
    }
  });

  it('a session standing in interviews with another tenant\'s role: 403 from Cedar (no ViewInterviews)', async () => {
    const res = await as('u-theo', 'interviews', 'member')('/api/interviews/candidates');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ action: 'ViewInterviews' });
  });

  it('no session: refused (401, or 403 when the demo fallback stands in a Work session), never a row', async () => {
    const res = await request(app).get('/api/interviews/candidates');
    expect([401, 403]).toContain(res.status);
    expect(res.body.items).toBeUndefined();
  });

  it('the cross-tenant admin passes, break-glass, and reads everything', async () => {
    const res = await as('u-operator', 'orgiq', 'admin')('/api/interviews/candidates');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(12);
  });
});

describe('the server flag', () => {
  it('INTERVIEWS_ENABLED=false turns every route into the ordinary not-found', async () => {
    process.env['INTERVIEWS_ENABLED'] = 'false';
    expect((await GRETA('/api/interviews/candidates')).status).toBe(404);
    expect((await GRETA('/api/interviews/openings/op-backend')).status).toBe(404);
  });

  it('unset, it follows the mock world (on here); `true` keeps it on', async () => {
    expect((await GRETA('/api/interviews/openings')).status).toBe(200);
    process.env['INTERVIEWS_ENABLED'] = 'true';
    expect((await GRETA('/api/interviews/openings')).status).toBe(200);
  });
});
