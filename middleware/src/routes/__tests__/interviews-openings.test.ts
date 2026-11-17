// The openings writes (routes/interviews/openings.ts; docs/interviews-tenant-plan.md row I1.3, decision 2), mounted
// as index.ts mounts the tenant: `requireTenant('interviews')`, the server flag, ViewInterviews, then the openings
// router with ManageCandidates decided from the REAL seeds/roles/*/*.cedar files (read off disk below).
//
//   recruiter       creates an opening, edits its details, replaces its kit
//   hiring-manager  reads their own opening and its kit; every write refused (403)
//   interviewer     reads the kit of an opening they have a round on; every write refused (403)
//   anyone else     the tenant's usual refusal at the mount, or not-found for a row outside their scope
//
// The checks run in one order, and these tests walk it: authority (403) → the row (404) → the input (400, one
// sentence per field) → the compare-and-set (409 when someone saved first) → the record as the read shapes it.

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
import type { OpeningKit } from '../../lib/interviews/types.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
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

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
});

const kitOf = async (id: string): Promise<{ kit: OpeningKit; revision: number }> => {
  const o = (await GRETA.get(`/openings/${id}`)).body.opening;
  return { kit: { rounds: o.rounds, competencies: o.competencies, questions: o.questions }, revision: o.revision };
};
const DETAILS = { title: 'Data Engineer', level: 'Senior', team: 'Analytics', location: 'Lisbon or remote in Europe', hiringManagerId: 'u-amara', state: 'open', budgetCapUsd: null };

describe('the recruiter writes', () => {
  it('replaces a kit: adds a question, and the read shows it with the revision bumped', async () => {
    const { kit, revision } = await kitOf('op-backend');
    expect(revision).toBe(1);
    kit.questions.push({ id: 'q-new-cache', prompt: 'Design a cache in front of the card-token lookup.', followUps: ['What do you do on a miss storm?'], competencyId: 'system-design', roundType: 'technical' });
    const res = await GRETA.put('/openings/op-backend/kit', { revision, kit });
    expect(res.status).toBe(200);
    expect(res.body.opening).toMatchObject({ id: 'op-backend', revision: 2, kitSize: { competencies: 5, questions: { technical: 5, behavioural: 2 } } });
    expect(res.headers['cache-control']).toBe('no-store');
    const again = await GRETA.get('/openings/op-backend');
    expect(again.body.opening.questions.map((q: { id: string }) => q.id)).toContain('q-new-cache');
    expect((await GRETA.get('/openings')).body.items.find((o: { id: string }) => o.id === 'op-backend').kitSize.questions.technical).toBe(5);
  });

  it('reorders the questions and edits a follow-up: the order saved is the order read', async () => {
    const { kit, revision } = await kitOf('op-em');
    kit.questions.reverse();
    kit.questions[0]!.followUps = ['Which team first?'];
    expect((await GRETA.put('/openings/op-em/kit', { revision, kit })).status).toBe(200);
    const o = (await GRETA.get('/openings/op-em')).body.opening;
    expect(o.questions.map((q: { id: string }) => q.id)).toEqual(kit.questions.map((q) => q.id));
    expect(o.questions[0].followUps).toEqual(['Which team first?']);
  });

  it('edits the details, leaving the kit', async () => {
    const res = await GRETA.put('/openings/op-ios/details', { revision: 1, ...DETAILS, title: 'iOS Engineer', team: 'Mobile Checkout' });
    expect(res.status).toBe(200);
    expect(res.body.opening).toMatchObject({ title: 'iOS Engineer', hiringManager: { id: 'u-amara', name: 'Amara Okafor' }, revision: 2 });
    expect(res.body.opening.rounds.map((r: { name: string }) => r.name)).toEqual(['Coding', 'Working together']);
  });

  it('creates an opening with an empty kit, owned by the recruiter, and lists it', async () => {
    const res = await GRETA.post('/openings', DETAILS);
    expect(res.status).toBe(201);
    expect(res.body.opening).toMatchObject({ id: 'op-data-engineer', title: 'Data Engineer', recruiter: { name: 'Greta Lindqvist' }, revision: 1, rounds: [], competencies: [], questions: [] });
    expect((await GRETA.get('/openings')).body.items[0].title).toBe('Data Engineer');
    expect((await GRETA.post('/openings', DETAILS)).body.opening.id).toBe('op-data-engineer-2');
  });

  it('names the hiring managers the details form may choose from', async () => {
    const res = await GRETA.get('/hiring-managers');
    expect(res.body).toEqual({ items: [{ id: 'u-amara', name: 'Amara Okafor' }] });
  });

  it('the cross-tenant admin passes, break-glass', async () => {
    const { kit, revision } = await kitOf('op-ios');
    expect((await who('u-operator', 'orgiq', 'admin').put('/openings/op-ios/kit', { revision, kit })).status).toBe(200);
  });
});

describe('the input is checked: 400, one plain sentence per field, nothing written', () => {
  it('a kit with problems names each on its path', async () => {
    const { kit, revision } = await kitOf('op-backend');
    kit.questions.push({ id: 'q-empty', prompt: '', followUps: [], competencyId: 'leadership', roundType: 'behavioural', starter: { python: 'pass\n' } });
    const res = await GRETA.put('/openings/op-backend/kit', { revision, kit });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'The kit was not saved: 3 things need fixing.',
      fields: [
        { path: 'questions.6.prompt', message: 'Question 7 needs the words the interviewer will ask.' },
        { path: 'questions.6.competencyId', message: 'Question 7 needs a competency from this kit to gather evidence for.' },
        { path: 'questions.6.starter', message: 'Question 7 is for a behavioural round, which has no code pad, so it cannot carry starter code.' },
      ],
    });
    expect((await kitOf('op-backend')).revision).toBe(1);
  });

  it('removing what an interview or a scorecard points at is refused', async () => {
    const { kit, revision } = await kitOf('op-em');
    kit.rounds = kit.rounds.filter((r) => r.id !== 'rd-leadership');
    kit.questions = kit.questions.filter((q) => q.roundType === 'technical');
    const res = await GRETA.put('/openings/op-em/kit', { revision, kit });
    expect(res.status).toBe(400);
    expect(res.body.fields.map((f: { message: string }) => f.message)).toEqual(expect.arrayContaining([
      'The "Leadership" round has interviews on it, so it stays in the kit.',
    ]));
  });

  it('details with problems, and a write without the revision it was made against', async () => {
    const res = await GRETA.put('/openings/op-ios/details', { revision: 1, ...DETAILS, title: '', hiringManagerId: 'u-hugo' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'The details were not saved: 2 things need fixing.', fields: [
      { path: 'title', message: 'Give the opening a title.' },
      { path: 'hiringManagerId', message: 'Choose a hiring manager from the list, or leave it unnamed for now.' },
    ] });
    const old = await GRETA.put('/openings/op-ios/kit', { kit: (await kitOf('op-ios')).kit });
    expect(old.status).toBe(400);
    expect(old.body.error).toBe('This page is out of date. Reload it and make the change again.');
    expect((await GRETA.post('/openings', { ...DETAILS, level: '' })).body.error).toBe('The opening was not saved: one thing needs fixing.');
  });
});

describe('two editors: the second save against an old revision is refused (409), nothing overwritten', () => {
  it('says someone else saved first and gives the revision now saved', async () => {
    const first = await kitOf('op-ios');
    const second = await kitOf('op-ios');
    first.kit.competencies[0]!.name = 'Problem solving under pressure';
    expect((await GRETA.put('/openings/op-ios/kit', first)).status).toBe(200);
    second.kit.competencies[0]!.name = 'Debugging';
    const res = await GRETA.put('/openings/op-ios/kit', second);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.stringMatching(/^Someone else saved this opening while you were editing\./), revision: 2 });
    expect((await GRETA.get('/openings/op-ios')).body.opening.competencies[0].name).toBe('Problem solving under pressure');
  });
});

describe('everyone else: the writes are the recruiter\'s (decision 2)', () => {
  it('the hiring manager reads their own opening and its kit, and every write is refused (403, ManageCandidates)', async () => {
    const own = await AMARA.get('/openings/op-em');
    expect(own.status).toBe(200);
    expect(own.body.opening.questions.length).toBeGreaterThan(0);
    const { kit } = await kitOf('op-em');
    for (const res of [
      await AMARA.put('/openings/op-em/kit', { revision: 1, kit }),
      await AMARA.put('/openings/op-em/details', { revision: 1, ...DETAILS }),
      await AMARA.post('/openings', DETAILS),
      await AMARA.get('/hiring-managers'),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ action: 'ManageCandidates' });
    }
    expect((await AMARA.get('/openings/op-ios')).status).toBe(404);
  });

  it('an interviewer reads the kit of an opening they have a round on, never another, and cannot write', async () => {
    // Wen leads iOS and Engineering Manager rounds; Hugo has no iOS round.
    expect((await WEN.get('/openings/op-ios')).body.opening.competencies.map((c: { name: string }) => c.name)).toContain('Swift and SwiftUI');
    expect((await HUGO.get('/openings/op-ios')).status).toBe(404);
    const { kit } = await kitOf('op-ios');
    expect((await WEN.put('/openings/op-ios/kit', { revision: 1, kit })).status).toBe(403);
    expect((await HUGO.put('/openings/op-ios/kit', { revision: 1, kit })).status).toBe(403);
    expect((await kitOf('op-ios')).revision).toBe(1);
  });

  it('the opening record carries its spending cap only to those who may read the opening\'s money', async () => {
    expect((await GRETA.put('/openings/op-ios/details', { revision: 1, ...DETAILS, budgetCapUsd: 50 })).status).toBe(200);
    const cap = async (w: ReturnType<typeof who>) => (await w.get('/openings/op-ios')).body.opening;
    expect((await cap(GRETA)).budgetCapUsd).toBe(50);
    expect((await cap(AMARA)).budgetCapUsd).toBe(50);
    expect((await cap(who('u-operator', 'orgiq', 'admin'))).budgetCapUsd).toBe(50);
    const wen = await cap(WEN);
    expect(wen.competencies.length).toBeGreaterThan(0);
    expect('budgetCapUsd' in wen).toBe(false);
  });

  it('the recruiter writing an opening that does not exist: 404, before the input is read', async () => {
    const res = await GRETA.put('/openings/op-nowhere/kit', { revision: 1, kit: {} });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('There is no opening here that you can open.');
  });

  it('another tenant\'s admin role: refused at the mount; standing in interviews: refused by Cedar', async () => {
    const { kit } = await kitOf('op-ios');
    const mount = await who('u-priya', 'access').put('/openings/op-ios/kit', { revision: 1, kit });
    expect(mount.status).toBe(403);
    expect(mount.body).toMatchObject({ requiredTenant: 'interviews' });
    const cedar = await who('u-priya', 'interviews', 'access-admin').put('/openings/op-ios/kit', { revision: 1, kit });
    expect(cedar.status).toBe(403);
    expect((await kitOf('op-ios')).revision).toBe(1);
  });

  it('with the server flag off the writes are the ordinary not-found', async () => {
    process.env['INTERVIEWS_ENABLED'] = 'false';
    expect((await GRETA.put('/openings/op-ios/kit', { revision: 1, kit: {} })).status).toBe(404);
    expect((await GRETA.post('/openings', DETAILS)).status).toBe(404);
  });
});
