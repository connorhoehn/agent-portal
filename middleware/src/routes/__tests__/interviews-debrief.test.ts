// The debrief and the stage decision (routes/interviews/debrief.ts; docs/interviews-tenant-plan.md rows I5.4, I5.5, I5.6;
// contract E4), mounted as index.ts mounts the tenant, with DecideCandidate decided from the REAL seeds/roles/*/*.cedar files.
//
//   recruiter, admin                   read every debrief; deciding is refused with the sentence that says so (403)
//   hiring manager of the opening      reads its applications' debrief and decides; another opening's: not found (404)
//   interviewer                        not found, whatever they have submitted; deciding is refused at the action (403)
//   another tenant's role              the tenant's usual refusal at the mount
// and the three bells after the call (lib/interviews/result-bells.ts): who gets each, and that none carries the interview.

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
import type { Session } from '../../lib/session.js';
import { setNotificationSink, type NotificationInputLike } from '../../lib/social-notify.js';
import { interviewEnded, scorecardSubmitted, stageDecided } from '../../lib/interviews/result-bells.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
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
const who = (id: string, tenant = 'interviews') => {
  const set = (r: ReturnType<ReturnType<typeof request>['get']>) => r.set('x-user', id).set('x-tenant', tenant);
  return {
    get: (p: string) => set(request(app).get(`${API}${p}`)),
    post: (p: string, body: unknown) => set(request(app).post(`${API}${p}`)).send(body as object),
  };
};
const GRETA = who('u-greta');
const HUGO = who('u-hugo');
const WEN = who('u-wen');
const AMARA = who('u-amara');
const OTHER_HM = who('u-other-hm');
const OPERATOR = who('u-operator');
const PRIYA = who('u-priya', 'access');

let sent: Array<{ userId: string; input: NotificationInputLike }> = [];
beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  sent = [];
  setNotificationSink({ notifyUser: async (userId, input) => { sent.push({ userId, input }); return {}; } });
});
afterEach(() => setNotificationSink(null));

type Who = ReturnType<typeof who>;
const debrief = (as: Who, candidate: string) => as.get(`/candidates/${candidate}/debrief`);
const decide = (as: Who, application: string, body: Record<string, unknown>) => as.post(`/applications/${application}/stage`, body);
const REASON = 'Both rounds were strong on what the payments team needs most.';
const settle = () => new Promise((r) => setTimeout(r, 20));

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); keysOf(v, out); }
  return out;
}

describe('who reads the debrief', () => {
  it('the recruiter, the opening\'s hiring manager and the admin read it; only the hiring manager is offered the decision', async () => {
    for (const [as, decides] of [[GRETA, false], [AMARA, true], [OPERATOR, false]] as const) {
      const r = await debrief(as, 'cand-ingrid');
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      const [a] = r.body.debrief.applications;
      expect(a.applicationId).toBe('app-ingrid');
      expect(a.decide !== null).toBe(decides);
    }
  });

  it('an interviewer who has submitted, another opening\'s hiring manager and a candidate off the hiring manager\'s openings are not found', async () => {
    expect((await debrief(HUGO, 'cand-ingrid')).status).toBe(404);
    expect((await debrief(WEN, 'cand-ingrid')).status).toBe(404);
    expect((await debrief(OTHER_HM, 'cand-ingrid')).status).toBe(404);
    expect((await debrief(AMARA, 'cand-ravi')).status).toBe(404);
    expect((await debrief(GRETA, 'cand-nobody')).status).toBe(404);
  });

  it('another tenant\'s role is refused at the mount', async () => {
    expect([401, 403, 404]).toContain((await debrief(PRIYA, 'cand-ingrid')).status);
  });

  it('shows each round side by side: every scorecard whole, who is due, the recap and record paths; no consent, no score of its own', async () => {
    const a = (await debrief(AMARA, 'cand-ingrid')).body.debrief.applications[0];
    expect(a.stage).toBe('debrief');
    expect(a.basedOn).toBe(a.history.length);
    expect(a.competencies.length).toBeGreaterThan(0);
    const coding = a.rounds.find((r: { interviewId: string }) => r.interviewId === 'iv-ingrid-coding');
    expect(coding).toMatchObject({ state: 'scored', lead: { id: 'u-hugo', name: 'Hugo Marchetti' }, due: [],
      recapPath: '/api/interviews/interviews/iv-ingrid-coding/recap', recordPath: '/interviews/rounds/iv-ingrid-coding/record' });
    expect(coding.scorecards).toHaveLength(1);
    expect(coding.scorecards[0]).toMatchObject({ interviewer: { id: 'u-hugo' }, recommendation: 'strong-yes', version: 1, changedAfterRecap: false, correctionReason: null, earlierVersions: 0 });
    expect(coding.scorecards[0].ratings[0]).toMatchObject({ competencyId: 'problem-solving', rating: 4, note: expect.any(String), competency: expect.any(String) });
    const keys = keysOf(a);
    for (const k of keys) expect([k, /consent|average|total|rank|score$/i.test(k)]).toEqual([k, false]);
  });

  it('a round still owed a scorecard names who is due; one not yet held has no recap or record', async () => {
    const jonah = (await debrief(AMARA, 'cand-jonah')).body.debrief.applications[0];
    expect(jonah.rounds[0]).toMatchObject({ state: 'ended', scorecards: [], due: [{ id: 'u-wen', name: 'Wen Zhao' }] });
    const mateo = (await debrief(GRETA, 'cand-mateo')).body.debrief.applications[0];
    expect(mateo.rounds.find((r: { interviewId: string }) => r.interviewId === 'iv-mateo-design')).toMatchObject({ state: 'ready', due: [], recapPath: null, recordPath: null });
  });
});

describe('who decides', () => {
  it('the recruiter and the admin read and do not decide: refused with that sentence', async () => {
    for (const as of [GRETA, OPERATOR]) {
      const r = await decide(as, 'app-ingrid', { decision: 'advance', reason: REASON, basedOn: 4 });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/Only the hiring manager of this opening records a decision/);
    }
  });

  it('an interviewer is refused at the action; another opening\'s hiring manager, and the hiring manager off their opening, are not found', async () => {
    expect((await decide(HUGO, 'app-ingrid', { decision: 'advance', reason: REASON, basedOn: 4 })).status).toBe(403);
    expect((await decide(OTHER_HM, 'app-ingrid', { decision: 'advance', reason: REASON, basedOn: 4 })).status).toBe(404);
    expect((await decide(AMARA, 'app-ravi', { decision: 'hold', reason: REASON, basedOn: 3 })).status).toBe(404);
    expect((await decide(AMARA, 'app-nobody', { decision: 'hold', reason: REASON, basedOn: 1 })).status).toBe(404);
    expect([401, 403, 404]).toContain((await decide(PRIYA, 'app-ingrid', { decision: 'hold', reason: REASON, basedOn: 4 })).status);
  });

  it('a bad body is refused with the field, and nothing is written', async () => {
    const r = await decide(AMARA, 'app-ingrid', { decision: 'advance', reason: 'ok', basedOn: 4 });
    expect(r.status).toBe(400);
    expect(r.body.fields[0].field).toBe('reason');
    expect((await debrief(AMARA, 'cand-ingrid')).body.debrief.applications[0].history).toHaveLength(4);
  });
});

describe('the decision', () => {
  it('advance from debrief: the stage moves to offer under the hiring manager\'s name, the scored rounds become reviewed, and the recruiter is told', async () => {
    const r = await decide(AMARA, 'app-ingrid', { decision: 'advance', reason: REASON, basedOn: 4 });
    expect(r.status).toBe(201);
    const a = r.body.debrief.applications[0];
    expect(a.stage).toBe('offer');
    expect(a.basedOn).toBe(5);
    expect(a.history[4]).toMatchObject({ stage: 'offer', by: 'u-amara', byName: 'Amara Okafor', reason: REASON, decision: 'advance', scorecardsMissing: 0 });
    expect(a.history.slice(0, 4).every((h: { decision: unknown }) => h.decision === null)).toBe(true);
    expect(interviewsFixture.rows().filter((i) => i.applicationId === 'app-ingrid').map((i) => i.state)).toEqual(['reviewed', 'reviewed']);
    expect(a.decide.options.every((o: { allowed: boolean }) => !o.allowed)).toBe(true);
    await settle();
    expect(sent.map((s) => s.userId)).toEqual(['u-greta']);
  });

  it('a stale page is refused with the debrief as it now reads; a later decision is a new entry, never an edit', async () => {
    expect((await decide(AMARA, 'app-ingrid', { decision: 'hold', reason: REASON, basedOn: 4 })).status).toBe(201);
    const stale = await decide(AMARA, 'app-ingrid', { decision: 'reject', reason: REASON, basedOn: 4 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/changed while you were reading/);
    expect(stale.body.debrief.applications[0]).toMatchObject({ stage: 'on-hold', basedOn: 5 });
    const later = await decide(AMARA, 'app-ingrid', { decision: 'advance', reason: 'The second team said yes after all.', basedOn: 5 });
    expect(later.status).toBe(201);
    expect(later.body.debrief.applications[0].history.slice(4).map((h: { decision: string }) => h.decision)).toEqual(['hold', 'advance']);
  });

  it('advance waits for a round still to run; hold does not; a held candidate cannot be held again but can be rejected', async () => {
    const early = await decide(AMARA, 'app-mateo', { decision: 'advance', reason: REASON, basedOn: 3 });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/still to run/);
    expect((await decide(AMARA, 'app-mateo', { decision: 'hold', reason: REASON, basedOn: 3 })).body.debrief.applications[0].stage).toBe('on-hold');
    expect((await decide(AMARA, 'app-mateo', { decision: 'hold', reason: REASON, basedOn: 4 })).status).toBe(409);
    expect((await decide(AMARA, 'app-mateo', { decision: 'reject', reason: REASON, basedOn: 4 })).body.debrief.applications[0].stage).toBe('rejected');
    // Mateo's design round was ready, not scored: nothing is marked reviewed but the scored coding round.
    expect(interviewsFixture.rows().filter((i) => i.applicationId === 'app-mateo').map((i) => [i.id, i.state]))
      .toEqual([['iv-mateo-coding', 'reviewed'], ['iv-mateo-design', 'ready']]);
  });

  it('with no scorecard in, nothing is decided; with one still due, the decision records how many were missing', async () => {
    expect((await decide(AMARA, 'app-jonah', { decision: 'reject', reason: REASON, basedOn: 3 })).status).toBe(409);
    const jonah = interviewsFixture.rows().find((i) => i.id === 'iv-jonah-leadership')!;
    jonah.panelIds = ['u-hugo'];
    interviewScorecardsFixture.rows().push({ id: 'sc-jonah-wen', interviewId: jonah.id, interviewerId: 'u-wen', ratings: [], recommendation: 'yes', summary: 's',
      submittedAt: '2026-11-16T10:00:00.000Z', version: 1, changedAfterRecap: false, correctionReason: null });
    const before = (await debrief(AMARA, 'cand-jonah')).body.debrief.applications[0];
    expect(before.decide.scorecardsMissing).toBe(1);
    expect(before.rounds[0].due).toEqual([{ id: 'u-hugo', name: 'Hugo Marchetti' }]);
    const r = await decide(AMARA, 'app-jonah', { decision: 'hold', reason: REASON, basedOn: 3 });
    expect(r.status).toBe(201);
    expect(r.body.debrief.applications[0].history[3]).toMatchObject({ decision: 'hold', scorecardsMissing: 1 });
    expect(jonah.state).toBe('ended');
  });
});

describe('the bells after the call', () => {
  const textOf = (s: { input: NotificationInputLike }) => JSON.stringify({ title: s.input.title, body: s.input.body, payload: s.input.payload });
  const NEVER = ['Ingrid', 'Solberg', 'Mateo', 'Jonah', 'cand-', 'Strong', 'strong', 'yes', REASON, 'token bucket', 'rating'];
  const clean = () => { for (const s of sent) for (const w of NEVER) expect([w, textOf(s).includes(w), (s.input.action?.href ?? '').includes(w)]).toEqual([w, false, false]); };

  it('scorecard due: each seat of the round that ended, opening My interviews', async () => {
    interviewsFixture.rows().find((i) => i.id === 'iv-jonah-leadership')!.panelIds = ['u-hugo'];
    expect(await interviewEnded('iv-jonah-leadership')).toEqual(['u-wen', 'u-hugo']);
    expect(sent[0]!.input).toMatchObject({ title: 'Your scorecard is due: Leadership for Engineering Manager',
      action: { label: 'Open My interviews', href: '/interviews/my-interviews' }, payload: { tenant: 'interviews', kind: 'interview-scorecard-due', audience: 'interviewer' } });
    expect(await interviewEnded('iv-mateo-design')).toEqual([]);
    clean();
  });

  it('submitted: the recruiter on every first version, the hiring manager once every seat\'s is in; a correction rings the recruiter only', async () => {
    expect(await scorecardSubmitted('iv-ingrid-coding', 'u-hugo', 1)).toEqual(['u-greta', 'u-amara']);
    expect(sent[0]!.input).toMatchObject({ title: expect.stringMatching(/^Hugo Marchetti submitted a scorecard: .+ for Senior Backend Engineer$/),
      action: { label: 'Open the debrief', href: '/interviews/rounds/iv-ingrid-coding/debrief' }, payload: { audience: 'recruiter', kind: 'interview-scorecard-submitted' } });
    expect(sent[1]!.input).toMatchObject({ title: expect.stringMatching(/^Every scorecard is in: /), payload: { audience: 'hiring-manager' } });
    sent = [];
    expect(await scorecardSubmitted('iv-ingrid-coding', 'u-hugo', 2)).toEqual(['u-greta']);
    expect(sent[0]!.input.title).toMatch(/^Hugo Marchetti corrected their scorecard: /);
    sent = [];
    // A panel member's first version while another seat is still due: the recruiter only.
    interviewsFixture.rows().find((i) => i.id === 'iv-ingrid-coding')!.panelIds = ['u-wen'];
    expect(await scorecardSubmitted('iv-ingrid-coding', 'u-hugo', 1)).toEqual(['u-greta']);
    // Someone who has written nothing on the round rings nobody.
    expect(await scorecardSubmitted('iv-ingrid-coding', 'u-other-hm', 1)).toEqual([]);
    clean();
  });

  it('decided: the opening\'s recruiter, that a decision was recorded and by whom, opening the debrief', async () => {
    expect(await stageDecided('app-ingrid', 'u-amara')).toEqual(['u-greta']);
    expect(sent[0]!.input).toMatchObject({ title: 'A decision was recorded on Senior Backend Engineer',
      body: 'Recorded by Amara Okafor. Open the debrief to read it and arrange what follows.',
      action: { href: expect.stringMatching(/^\/interviews\/rounds\/iv-ingrid-(coding|together)\/debrief$/) }, payload: { audience: 'recruiter', kind: 'interview-decided' } });
    expect(await stageDecided('app-nobody', 'u-amara')).toEqual([]);
    clean();
  });

  it('never throw, with no sink or an unknown round', async () => {
    setNotificationSink(null);
    expect(await interviewEnded('iv-jonah-leadership')).toEqual([]);
    expect(await scorecardSubmitted('iv-nope', 'u-hugo', 1)).toEqual([]);
  });
});
