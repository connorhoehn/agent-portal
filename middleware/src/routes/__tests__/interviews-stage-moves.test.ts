// The recruiter's stage moves (routes/interviews/stage-moves.ts; gap audit 2026-11-20 §2), mounted as index.ts mounts
// the tenant, with the actions decided from the REAL seeds/roles/*/*.cedar files. Also the debrief's reason line when
// there is no decision control (lib/interviews/debrief/view.ts noDecision).
//
//   recruiter, admin        start screening, mark hired, offer declined, reopen
//   interviewer, hiring manager   not found (404): neither holds ManageCandidates
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
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), listUsers: jest.fn(), getUser: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import type { Session } from '../../lib/session.js';
import { interviewApplicationsFixture } from '../../mock/interviews.js';

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
const WEN = who('u-wen');
const AMARA = who('u-amara');
const OPERATOR = who('u-operator');
const PRIYA = who('u-priya', 'access');
const GRETA_AS_INTERVIEWER = who('u-greta', 'interviews', 'interviewer');

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
});

// Applied, no rounds: app-4shk59u3 (iOS) and app-5xecwhnp (EM). Rejected after screening, no rounds: app-y2pmbks8
// (backend). At debrief with three scored rounds: app-vfzc2x6g (backend, Amara decides). Interviewing on the iOS
// opening, which names no hiring manager: app-j7zuguu3 (cand-w4pvy8m9).
const APPLIED = 'app-4shk59u3';
const REJECTED = 'app-y2pmbks8';
const DEBRIEF = 'app-vfzc2x6g';
const WHY = 'The candidate asked to be considered again after all.';
const DECISION_WHY = 'Both rounds were strong on what the payments team needs most.';

const appOf = (id: string) => interviewApplicationsFixture.rows().find((a) => a.id === id)!;
const basedOn = (id: string) => appOf(id).history.length;
const move = (as: ReturnType<typeof who>, id: string, body: Record<string, unknown>) => as.post(`/applications/${id}/move`, body);
/** Amara's advance on the debrief: the only way to an offer, so the recruiter's offer moves start from it. */
const toOffer = async () => {
  const r = await AMARA.post(`/applications/${DEBRIEF}/stage`, { decision: 'advance', reason: DECISION_WHY, basedOn: basedOn(DEBRIEF) });
  expect(r.status).toBe(201);
  expect(appOf(DEBRIEF).stage).toBe('offer');
};

describe('the recruiter\'s moves', () => {
  it('starts screening on a new application, with who and the plain default in the history', async () => {
    const r = await move(GRETA, APPLIED, { move: 'screen', basedOn: basedOn(APPLIED) });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({ application: { id: APPLIED, stage: 'screening', basedOn: 2 } });
    expect(appOf(APPLIED).history.at(-1)).toMatchObject({ stage: 'screening', by: 'u-greta', reason: 'Screening started.' });
  });

  it('marks an offer hired, with the note when there is one', async () => {
    await toOffer();
    const r = await move(GRETA, DEBRIEF, { move: 'hire', basedOn: basedOn(DEBRIEF), reason: 'Signed; starts on the first of the month.' });
    expect(r.status).toBe(200);
    expect(appOf(DEBRIEF)).toMatchObject({ stage: 'hired' });
    expect(appOf(DEBRIEF).history.at(-1)).toMatchObject({ stage: 'hired', by: 'u-greta', reason: 'Signed; starts on the first of the month.' });
    // Hired is final.
    const again = await move(GRETA, DEBRIEF, { move: 'reopen', basedOn: basedOn(DEBRIEF), reason: WHY });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/hired/);
  });

  it('records a declined offer as rejected, and requires the reason', async () => {
    await toOffer();
    expect((await move(GRETA, DEBRIEF, { move: 'decline', basedOn: basedOn(DEBRIEF) })).status).toBe(400);
    const r = await move(GRETA, DEBRIEF, { move: 'decline', basedOn: basedOn(DEBRIEF), reason: 'They took a counter-offer from their current employer.' });
    expect(r.status).toBe(200);
    expect(appOf(DEBRIEF).history.at(-1)).toMatchObject({ stage: 'rejected', by: 'u-greta', reason: 'They took a counter-offer from their current employer.' });
  });

  it('reopens to interviewing when the application has held rounds, and to screening when it has none', async () => {
    await toOffer();
    await move(GRETA, DEBRIEF, { move: 'decline', basedOn: basedOn(DEBRIEF), reason: 'They took a counter-offer from their current employer.' });
    const back = await move(GRETA, DEBRIEF, { move: 'reopen', basedOn: basedOn(DEBRIEF), reason: WHY });
    expect(back.status).toBe(200);
    expect(back.body.application.stage).toBe('interviewing');
    const fresh = await move(GRETA, REJECTED, { move: 'reopen', basedOn: basedOn(REJECTED), reason: WHY });
    expect(fresh.status).toBe(200);
    expect(appOf(REJECTED).history.at(-1)).toMatchObject({ stage: 'screening', by: 'u-greta', reason: WHY });
  });

  it('reopens a withdrawn application (its rounds were cancelled, so it goes to screening) and an on-hold one', async () => {
    const nadia = 'app-efd7rc6g';
    expect((await GRETA.post(`/applications/${nadia}/withdraw`, { basedOn: basedOn(nadia) })).status).toBe(200);
    const r = await move(GRETA, nadia, { move: 'reopen', basedOn: basedOn(nadia), reason: WHY });
    expect(r.status).toBe(200);
    expect(r.body.application.stage).toBe('screening');
    expect((await AMARA.post(`/applications/${DEBRIEF}/stage`, { decision: 'hold', reason: DECISION_WHY, basedOn: basedOn(DEBRIEF) })).status).toBe(201);
    expect((await move(OPERATOR, DEBRIEF, { move: 'reopen', basedOn: basedOn(DEBRIEF), reason: WHY })).body.application.stage).toBe('interviewing');
  });

  it.each([
    ['screening an application already past applied', DEBRIEF, 'screen', undefined],
    ['hiring before an offer', DEBRIEF, 'hire', undefined],
    ['declining before an offer', DEBRIEF, 'decline', 'They took a counter-offer from their current employer.'],
    ['reopening an open application', APPLIED, 'reopen', WHY],
  ])('refuses %s with 409 and a sentence, writing nothing', async (_label, id, kind, reason) => {
    const before = basedOn(id);
    const r = await move(GRETA, id, { move: kind, basedOn: before, ...(reason ? { reason } : {}) });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/\.$/);
    expect(basedOn(id)).toBe(before);
  });

  it('refuses a stale read, and a body that is not a move', async () => {
    expect((await move(GRETA, APPLIED, { move: 'screen', basedOn: basedOn(APPLIED) + 1 })).status).toBe(409);
    expect((await move(GRETA, APPLIED, { move: 'screen', basedOn: basedOn(APPLIED) })).status).toBe(200);
    expect((await move(GRETA, APPLIED, { move: 'screen', basedOn: 1 })).status).toBe(409);
    expect((await move(GRETA, APPLIED, { move: 'screen' })).status).toBe(400);
    expect((await move(GRETA, APPLIED, { stage: 'hired', basedOn: 2 })).status).toBe(400);
  });
});

describe('who may move a stage', () => {
  it.each([
    ['an interviewer', WEN, 404],
    ['the hiring manager', AMARA, 404],
    ['the recruiter signed in as an interviewer', GRETA_AS_INTERVIEWER, 404],
    ['another tenant\'s role', PRIYA, 403],
  ])('%s is refused and nothing is written', async (_label, as, status) => {
    const before = basedOn(APPLIED);
    expect((await move(as, APPLIED, { move: 'screen', basedOn: before })).status).toBe(status);
    expect(basedOn(APPLIED)).toBe(before);
    expect(appOf(APPLIED).stage).toBe('applied');
  });

  it('an application that does not exist is not found', async () => {
    expect((await move(GRETA, 'app-nobody', { move: 'screen', basedOn: 1 })).status).toBe(404);
  });
});

describe('the debrief says why there is no decision control', () => {
  it('on an opening with no hiring manager: nobody can decide, and the recruiter sets one on the opening\'s details', async () => {
    for (const as of [GRETA, OPERATOR]) {
      const r = await as.get('/candidates/cand-w4pvy8m9/debrief');
      expect(r.status).toBe(200);
      const [a] = r.body.debrief.applications;
      expect(a.decide).toBeNull();
      expect(a.noDecision).toEqual({ reason: 'no-hiring-manager', message: expect.stringMatching(/no hiring manager.*recruiter.*opening's details/) });
    }
  });

  it('on an opening with one: the reader is told whose decision it is, and the hiring manager gets the control instead', async () => {
    const recruiter = (await GRETA.get('/candidates/cand-qz63q3a3/debrief')).body.debrief.applications[0];
    expect(recruiter.noDecision).toEqual({ reason: 'not-the-hiring-manager', message: expect.stringContaining('Amara Okafor') });
    const hm = (await AMARA.get('/candidates/cand-qz63q3a3/debrief')).body.debrief.applications[0];
    expect(hm.decide).not.toBeNull();
    expect(hm.noDecision).toBeNull();
  });

  it('the debrief history shows the recruiter\'s move with who and why', async () => {
    await toOffer();
    await move(GRETA, DEBRIEF, { move: 'hire', basedOn: basedOn(DEBRIEF), reason: 'Signed; starts on the first of the month.' });
    const a = (await AMARA.get('/candidates/cand-qz63q3a3/debrief')).body.debrief.applications[0];
    expect(a.history.at(-1)).toMatchObject({ stage: 'hired', by: 'u-greta', byName: 'Greta Lindqvist', reason: 'Signed; starts on the first of the month.', decision: null });
    expect(a.decide.options.every((o: { allowed: boolean }) => !o.allowed)).toBe(true);
  });
});
