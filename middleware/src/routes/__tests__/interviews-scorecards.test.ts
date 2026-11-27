// The scorecard (routes/interviews/scorecards.ts; docs/interviews-tenant-plan.md row I5.3, contract D8), mounted as
// index.ts mounts the tenant, with ConductInterview decided from the REAL seeds/roles/*/*.cedar files.
//
//   interviewer (lead, panel)   reads their own and the kit; submits once the round has ended; corrects with a reason
//   interviewer (panel)         reads the others' only once their own is in (scope.ts othersRevealed)
//   recruiter, hiring manager   read every submission as it arrives; submitting is refused at the action (403)
//   another round's interviewer, another opening's hiring manager   not found (404)
//   another tenant's role       the tenant's usual refusal at the mount

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
import { interviewScorecardsFixture, interviewsFixture } from '../../mock/interviews.js';
import { setCoachModelFactory, ScriptedCoachModel } from '../../lib/interviews/coach/index.js';
import { setRecapDeps } from '../../lib/interviews/recap/index.js';
import type { Session } from '../../lib/session.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
  u('u-third', 'Ola Brandt', { interviews: ['interviewer'] }),
  u('u-amara', 'Amara Okafor', { interviews: ['hiring-manager'] }),
  u('u-other-hm', 'Sol Ferreira', { interviews: ['hiring-manager'] }),
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
const OTHER_HM = who('u-other-hm');
const OPERATOR = who('u-operator');
const PRIYA = who('u-priya', 'access');

// Nadia's leadership round has ended here: Wen leads, Hugo sits on the panel. Hugo's design round for Nadia is
// cancelled in this world so that the leadership round is the only one he owes (see the last block for the other case).
const NADIA = 'iv-n5z9f2cq';
const JONAH = 'iv-g9r1y8lp';
const MATEO_DESIGN = 'iv-k1p5w8ra';

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  for (const i of interviewsFixture.rows()) {
    if (i.id === NADIA) { i.state = 'ended'; i.endedAt = '2026-11-16T10:00:00.000Z'; }
    if (i.id === 'iv-m8t3h6ng') i.state = 'cancelled';
  }
});

type Who = ReturnType<typeof who>;
const read = async (as: Who, id: string) => as.get(`/interviews/${id}/scorecard`);
/** A complete scorecard for the round's kit, as the page would send it. */
async function complete(as: Who, id: string, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const page = (await read(as, id)).body.scorecard;
  return {
    ratings: page.competencies.map((c: { id: string }, n: number) => ({ competencyId: c.id, rating: (n % 4) + 1, note: n === 0 ? 'Named the trade-off.' : '' })),
    recommendation: 'yes', summary: 'Clear examples throughout.', basedOn: page.mine?.version ?? 0, ...over,
  };
}
const submit = async (as: Who, id: string, over: Record<string, unknown> = {}) => as.post(`/interviews/${id}/scorecard`, await complete(as, id, over));

describe('reading the scorecard', () => {
  it('the lead reads the competencies with their anchors and may submit once it has ended', async () => {
    const res = await read(WEN, NADIA);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.scorecard).toMatchObject({ interview: { id: NADIA, seat: 'lead', state: 'ended' }, mine: null, canSubmit: true, refusal: null, othersHidden: true, others: [] });
    expect(res.body.scorecard.competencies[0]).toEqual(expect.objectContaining({ lookFor: expect.any(String), anchors: expect.objectContaining({ 1: expect.any(String), 4: expect.any(String) }) }));
    expect(res.body.scorecard.limits).toEqual({ noteChars: 2000, summaryChars: 4000, reasonChars: 1000 });
  });

  it('before the round has ended nobody may submit, and the page says why', async () => {
    const res = await read(HUGO, MATEO_DESIGN);
    expect(res.body.scorecard).toMatchObject({ canSubmit: false, refusal: 'You can fill in the scorecard once the interview has ended.' });
    expect((await HUGO.post(`/interviews/${MATEO_DESIGN}/scorecard`, await complete(HUGO, MATEO_DESIGN))).status).toBe(409);
  });

  it('says whether the page shows Milo\'s recommendation: off unless the setting is on (ledger C-9)', async () => {
    const was = process.env.INTERVIEWS_MILO_RECOMMENDATION;
    try {
      delete process.env.INTERVIEWS_MILO_RECOMMENDATION;
      expect((await read(WEN, NADIA)).body.scorecard.miloRecommends).toBe(false);
      process.env.INTERVIEWS_MILO_RECOMMENDATION = 'on';
      expect((await read(WEN, NADIA)).body.scorecard.miloRecommends).toBe(true);
    } finally { if (was === undefined) delete process.env.INTERVIEWS_MILO_RECOMMENDATION; else process.env.INTERVIEWS_MILO_RECOMMENDATION = was; }
  });

  it('never carries the candidate\'s consent answers or contact details', async () => {
    await submit(WEN, NADIA);
    const text = JSON.stringify((await read(GRETA, NADIA)).body);
    expect(text).not.toMatch(/consent|@|recording|transcript/i);
  });

  it.each([
    ['an interviewer of another round', HUGO, JONAH],
    ['another opening\'s hiring manager', OTHER_HM, NADIA],
    ['anyone, an interview that does not exist', WEN, 'iv-nobody'],
  ])('%s: not found', async (_label, as, id) => {
    expect((await read(as, id)).status).toBe(404);
  });

  it('another tenant\'s role is refused at the mount', async () => {
    expect((await read(PRIYA, NADIA)).status).toBe(403);
  });
});

describe('submitting', () => {
  it('the lead submits; it reads back as their own, version 1', async () => {
    const res = await submit(WEN, NADIA);
    expect(res.status).toBe(201);
    expect(res.body.scorecard.mine).toMatchObject({ interviewer: { id: 'u-wen', name: 'Wen Zhao' }, version: 1, recommendation: 'yes', correctionReason: null, earlier: [] });
    expect(res.body.scorecard.mine.ratings[0]).toMatchObject({ note: 'Named the trade-off.', competency: expect.any(String) });
  });

  it('an incomplete scorecard is 400 with the field', async () => {
    const body = await complete(WEN, NADIA);
    const res = await WEN.post(`/interviews/${NADIA}/scorecard`, { ...body, ratings: (body['ratings'] as unknown[]).slice(1) });
    expect(res.status).toBe(400);
    expect(res.body.fields[0].field).toMatch(/^ratings\./);
  });

  it('nobody submits for someone else: a body naming an author is refused, and the author is always the signed-in person', async () => {
    const res = await WEN.post(`/interviews/${NADIA}/scorecard`, { ...(await complete(WEN, NADIA)), interviewerId: 'u-hugo' });
    expect(res.status).toBe(400);
    expect((await read(HUGO, NADIA)).body.scorecard.mine).toBeNull();
  });

  it('a submitted scorecard is corrected only as a new version with a reason, against the latest', async () => {
    await submit(WEN, NADIA);
    expect((await submit(WEN, NADIA, { basedOn: 1 })).status).toBe(400);
    expect((await submit(WEN, NADIA, { basedOn: 0 })).status).toBe(409);
    const fixed = await submit(WEN, NADIA, { basedOn: 1, reason: 'I mixed up two of my notes.', recommendation: 'strong-yes' });
    expect(fixed.status).toBe(201);
    expect(fixed.body.scorecard.mine).toMatchObject({ version: 2, recommendation: 'strong-yes', correctionReason: 'I mixed up two of my notes.' });
    expect(fixed.body.scorecard.mine.earlier).toEqual([expect.objectContaining({ version: 1, recommendation: 'yes', correctionReason: null })]);
    const stale = await submit(WEN, NADIA, { basedOn: 1, reason: 'Again.' });
    expect(stale.status).toBe(409);
    expect(stale.body.scorecard.mine.version).toBe(2);
  });

  it.each([
    ['the recruiter (no ConductInterview)', GRETA, 403],
    ['the hiring manager (no ConductInterview)', AMARA, 403],
    ['the admin, no seat', OPERATOR, 404],
    ['an interviewer of another round', HUGO, 404],
    ['another tenant\'s role', PRIYA, 403],
  ])('%s: refused', async (_label, as, status) => {
    const id = as === HUGO ? JONAH : NADIA;
    expect((await as.post(`/interviews/${id}/scorecard`, await complete(WEN, id))).status).toBe(status);
  });
});

describe('others hidden until yours is in', () => {
  it('a panel member reads no one else\'s before their own is in, and the lead\'s after', async () => {
    await submit(WEN, NADIA);
    const before = (await read(HUGO, NADIA)).body.scorecard;
    expect(before).toMatchObject({ interview: { seat: 'panel' }, othersHidden: true, others: [] });
    await submit(HUGO, NADIA);
    const after = (await read(HUGO, NADIA)).body.scorecard;
    expect(after.othersHidden).toBe(false);
    expect(after.others.map((s: { interviewer: { id: string }; round: string }) => [s.interviewer.id, s.round])).toEqual([['u-wen', expect.any(String)]]);
  });

  it('every reader learns who leads the round, so a page can tell the lead\'s scorecard from a panelist\'s', async () => {
    for (const as of [WEN, HUGO, GRETA, AMARA]) expect((await read(as, NADIA)).body.scorecard.interview.leadId).toBe('u-wen');
  });

  it('the recruiter and the opening\'s hiring manager read each submission as it arrives', async () => {
    await submit(WEN, NADIA);
    for (const as of [GRETA, AMARA]) {
      const page = (await read(as, NADIA)).body.scorecard;
      expect(page).toMatchObject({ interview: { seat: null }, mine: null, canSubmit: false, othersHidden: false });
      expect(page.others.map((s: { interviewer: { id: string } }) => s.interviewer.id)).toEqual(['u-wen']);
    }
  });

  it('the interview moves to scored when every seated person\'s is in, and not before', async () => {
    await submit(WEN, NADIA);
    expect((await read(WEN, NADIA)).body.scorecard.interview.state).toBe('ended');
    await submit(HUGO, NADIA);
    expect((await read(WEN, NADIA)).body.scorecard.interview.state).toBe('scored');
    // A correction while scored is still allowed.
    expect((await submit(HUGO, NADIA, { basedOn: 1, reason: 'Typo in the summary.' })).status).toBe(201);
  });

  it('a round of the same candidate still to run keeps the others hidden', async () => {
    for (const i of interviewsFixture.rows()) if (i.id === 'iv-m8t3h6ng') i.state = 'accepted';
    await submit(WEN, NADIA);
    await submit(HUGO, NADIA);
    expect((await read(HUGO, NADIA)).body.scorecard).toMatchObject({ othersHidden: true, others: [] });
  });
});

describe('changed after the recap is the server\'s fact (row I5.2, E3)', () => {
  // The recap itself is written by the scripted stand-in over no transcript here: what matters is the stored open.
  beforeAll(() => { setCoachModelFactory(() => new ScriptedCoachModel()); setRecapDeps({ transcript: async () => null }); });
  afterAll(() => { setCoachModelFactory(null); setRecapDeps(null); });
  const openWith = async (as: Who, id: string) => {
    const body = await complete(as, id);
    return as.post(`/interviews/${id}/recap/open`, { ratings: (body.ratings as Array<{ competencyId: string; rating: number }>).map(({ competencyId, rating }) => ({ competencyId, rating })) });
  };
  const stored = (author: string) => interviewScorecardsFixture.rows().filter((c) => c.interviewId === NADIA && c.interviewerId === author).sort((a, b) => a.version - b.version);

  it('unchanged ratings after the open: false', async () => {
    expect((await openWith(WEN, NADIA)).status).toBe(200);
    expect((await submit(WEN, NADIA)).status).toBe(201);
    expect(stored('u-wen').map((c) => c.changedAfterRecap)).toEqual([false]);
  });

  it('a rating changed after the open: true, whatever the request says', async () => {
    await openWith(WEN, NADIA);
    const body = await complete(WEN, NADIA);
    const ratings = (body.ratings as Array<{ rating: number }>).map((r, n) => (n === 0 ? { ...r, rating: r.rating === 4 ? 1 : r.rating + 1 } : r));
    expect((await WEN.post(`/interviews/${NADIA}/scorecard`, { ...body, ratings })).status).toBe(201);
    expect(stored('u-wen').map((c) => c.changedAfterRecap)).toEqual([true]);
    // The request cannot carry its own answer.
    expect((await WEN.post(`/interviews/${NADIA}/scorecard`, { ...body, basedOn: 1, reason: 'Fix.', changedAfterRecap: false })).status).toBe(400);
  });

  it('never opened: false; a correction compares against the same stored open', async () => {
    expect((await submit(HUGO, NADIA)).status).toBe(201);
    expect(stored('u-hugo').map((c) => c.changedAfterRecap)).toEqual([false]);
    await openWith(WEN, NADIA);
    await submit(WEN, NADIA);
    const body = await complete(WEN, NADIA, { basedOn: 1, reason: 'Second thoughts on the first competency.' });
    const ratings = (body.ratings as Array<{ rating: number }>).map((r, n) => (n === 0 ? { ...r, rating: r.rating === 4 ? 1 : r.rating + 1 } : r));
    expect((await WEN.post(`/interviews/${NADIA}/scorecard`, { ...body, ratings })).status).toBe(201);
    expect(stored('u-wen').map((c) => c.changedAfterRecap)).toEqual([false, true]);
  });
});
