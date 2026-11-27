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
import { interviewApplicationsFixture, interviewScorecardsFixture, interviewsFixture } from '../../mock/interviews.js';
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
      const r = await debrief(as, 'cand-qz63q3a3');
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      const [a] = r.body.debrief.applications;
      expect(a.applicationId).toBe('app-vfzc2x6g');
      expect(a.decide !== null).toBe(decides);
    }
  });

  it('an interviewer who has submitted, another opening\'s hiring manager and a candidate off the hiring manager\'s openings are not found', async () => {
    expect((await debrief(HUGO, 'cand-qz63q3a3')).status).toBe(404);
    expect((await debrief(WEN, 'cand-qz63q3a3')).status).toBe(404);
    expect((await debrief(OTHER_HM, 'cand-qz63q3a3')).status).toBe(404);
    expect((await debrief(AMARA, 'cand-w4pvy8m9')).status).toBe(404);
    expect((await debrief(GRETA, 'cand-nobody')).status).toBe(404);
  });

  it('another tenant\'s role is refused at the mount', async () => {
    expect([401, 403, 404]).toContain((await debrief(PRIYA, 'cand-qz63q3a3')).status);
  });

  it('shows each round side by side: every scorecard whole, who is due, the recap and record paths; no consent, no score of its own', async () => {
    const a = (await debrief(AMARA, 'cand-qz63q3a3')).body.debrief.applications[0];
    expect(a.stage).toBe('debrief');
    expect(a.basedOn).toBe(a.history.length);
    expect(a.competencies.length).toBeGreaterThan(0);
    const coding = a.rounds.find((r: { interviewId: string }) => r.interviewId === 'iv-d7q4n9xe');
    expect(coding).toMatchObject({ state: 'scored', lead: { id: 'u-hugo', name: 'Hugo Marchetti' }, due: [],
      recapPath: '/api/interviews/interviews/iv-d7q4n9xe/recap', recordPath: '/interviews/rounds/iv-d7q4n9xe/record' });
    expect(coding.scorecards).toHaveLength(1);
    expect(coding.scorecards[0]).toMatchObject({ interviewer: { id: 'u-hugo' }, recommendation: 'strong-yes', version: 1, changedAfterRecap: false, correctionReason: null, earlierVersions: 0 });
    expect(coding.scorecards[0].ratings[0]).toMatchObject({ competencyId: 'problem-solving', rating: 4, note: expect.any(String), competency: expect.any(String) });
    const keys = keysOf(a);
    for (const k of keys) expect([k, /consent|average|total|rank|score$/i.test(k)]).toEqual([k, false]);
  });

  it('carries the red flags ticked on submitted scorecards: on each scorecard, and once per round with who ticked them (gap audit 2026-11-20)', async () => {
    const FLAG = 'Cannot say how the system behaves under load.';
    interviewScorecardsFixture.rows().find((c) => c.interviewId === 'iv-d7q4n9xe' && c.interviewerId === 'u-hugo')!.redFlagsSeen = [FLAG];
    for (const as of [GRETA, AMARA, OPERATOR]) {
      const coding = (await debrief(as, 'cand-qz63q3a3')).body.debrief.applications[0].rounds.find((r: { interviewId: string }) => r.interviewId === 'iv-d7q4n9xe');
      expect(coding.scorecards[0].redFlagsSeen).toEqual([FLAG]);
      expect(coding.redFlags).toEqual([{ text: FLAG, by: [{ id: 'u-hugo', name: 'Hugo Marchetti' }] }]);
    }
    expect((await debrief(HUGO, 'cand-qz63q3a3')).status).toBe(404);
  });

  it('a round with no flag ticked has an empty list and no flags on its scorecards', async () => {
    const coding = (await debrief(AMARA, 'cand-qz63q3a3')).body.debrief.applications[0].rounds.find((r: { interviewId: string }) => r.interviewId === 'iv-d7q4n9xe');
    expect(coding.redFlags).toEqual([]);
    expect(coding.scorecards[0]).not.toHaveProperty('redFlagsSeen');
  });

  it('a round still owed a scorecard names who is due; one not yet held has no recap or record', async () => {
    const jonah = (await debrief(AMARA, 'cand-zrtncmb2')).body.debrief.applications[0];
    expect(jonah.rounds[0]).toMatchObject({ state: 'ended', scorecards: [], due: [{ id: 'u-wen', name: 'Wen Zhao' }] });
    const mateo = (await debrief(GRETA, 'cand-rx6tcaqj')).body.debrief.applications[0];
    expect(mateo.rounds.find((r: { interviewId: string }) => r.interviewId === 'iv-k1p5w8ra')).toMatchObject({ state: 'ready', due: [], recapPath: null, recordPath: null });
  });
});

describe('who decides', () => {
  it('the recruiter and the admin read and do not decide: refused with that sentence', async () => {
    for (const as of [GRETA, OPERATOR]) {
      const r = await decide(as, 'app-vfzc2x6g', { decision: 'advance', reason: REASON, basedOn: 4 });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/Only the hiring manager of this opening records a decision/);
    }
  });

  it('an interviewer is refused at the action; another opening\'s hiring manager, and the hiring manager off their opening, are not found', async () => {
    expect((await decide(HUGO, 'app-vfzc2x6g', { decision: 'advance', reason: REASON, basedOn: 4 })).status).toBe(403);
    expect((await decide(OTHER_HM, 'app-vfzc2x6g', { decision: 'advance', reason: REASON, basedOn: 4 })).status).toBe(404);
    expect((await decide(AMARA, 'app-j7zuguu3', { decision: 'hold', reason: REASON, basedOn: 3 })).status).toBe(404);
    expect((await decide(AMARA, 'app-nobody', { decision: 'hold', reason: REASON, basedOn: 1 })).status).toBe(404);
    expect([401, 403, 404]).toContain((await decide(PRIYA, 'app-vfzc2x6g', { decision: 'hold', reason: REASON, basedOn: 4 })).status);
  });

  it('a bad body is refused with the field, and nothing is written', async () => {
    const r = await decide(AMARA, 'app-vfzc2x6g', { decision: 'advance', reason: 'ok', basedOn: 4 });
    expect(r.status).toBe(400);
    expect(r.body.fields[0].field).toBe('reason');
    expect((await debrief(AMARA, 'cand-qz63q3a3')).body.debrief.applications[0].history).toHaveLength(4);
  });
});

describe('the decision', () => {
  it('advance from debrief: the stage moves to offer under the hiring manager\'s name, the scored rounds become reviewed, and the recruiter is told', async () => {
    const r = await decide(AMARA, 'app-vfzc2x6g', { decision: 'advance', reason: REASON, basedOn: 4 });
    expect(r.status).toBe(201);
    const a = r.body.debrief.applications[0];
    expect(a.stage).toBe('offer');
    expect(a.basedOn).toBe(5);
    expect(a.history[4]).toMatchObject({ stage: 'offer', by: 'u-amara', byName: 'Amara Okafor', reason: REASON, decision: 'advance', scorecardsMissing: 0 });
    expect(a.history.slice(0, 4).every((h: { decision: unknown }) => h.decision === null)).toBe(true);
    expect(interviewsFixture.rows().filter((i) => i.applicationId === 'app-vfzc2x6g').map((i) => i.state)).toEqual(['reviewed', 'reviewed', 'reviewed']);
    expect(a.decide.options.every((o: { allowed: boolean }) => !o.allowed)).toBe(true);
    await settle();
    expect(sent.map((s) => s.userId)).toEqual(['u-greta']);
  });

  it('a stale page is refused with the debrief as it now reads; a later decision is a new entry, never an edit', async () => {
    expect((await decide(AMARA, 'app-vfzc2x6g', { decision: 'hold', reason: REASON, basedOn: 4 })).status).toBe(201);
    const stale = await decide(AMARA, 'app-vfzc2x6g', { decision: 'reject', reason: REASON, basedOn: 4 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/changed while you were reading/);
    expect(stale.body.debrief.applications[0]).toMatchObject({ stage: 'on-hold', basedOn: 5 });
    const later = await decide(AMARA, 'app-vfzc2x6g', { decision: 'advance', reason: 'The second team said yes after all.', basedOn: 5 });
    expect(later.status).toBe(201);
    expect(later.body.debrief.applications[0].history.slice(4).map((h: { decision: string }) => h.decision)).toEqual(['hold', 'advance']);
  });

  it('advance waits for a round still to run; hold does not; a held candidate cannot be held again but can be rejected', async () => {
    const early = await decide(AMARA, 'app-7b69njmx', { decision: 'advance', reason: REASON, basedOn: 3 });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/still to run/);
    expect((await decide(AMARA, 'app-7b69njmx', { decision: 'hold', reason: REASON, basedOn: 3 })).body.debrief.applications[0].stage).toBe('on-hold');
    expect((await decide(AMARA, 'app-7b69njmx', { decision: 'hold', reason: REASON, basedOn: 4 })).status).toBe(409);
    expect((await decide(AMARA, 'app-7b69njmx', { decision: 'reject', reason: REASON, basedOn: 4 })).body.debrief.applications[0].stage).toBe('rejected');
    // Mateo's design round was ready, not scored: nothing is marked reviewed but the scored coding round.
    expect(interviewsFixture.rows().filter((i) => i.applicationId === 'app-7b69njmx').map((i) => [i.id, i.state]))
      .toEqual([['iv-j6x2d9sb', 'reviewed'], ['iv-k1p5w8ra', 'ready']]);
  });

  it('with no scorecard in, nothing is decided; with one still due, the decision records how many were missing', async () => {
    expect((await decide(AMARA, 'app-5j2chffb', { decision: 'reject', reason: REASON, basedOn: 3 })).status).toBe(409);
    const jonah = interviewsFixture.rows().find((i) => i.id === 'iv-g9r1y8lp')!;
    jonah.panelIds = ['u-hugo'];
    interviewScorecardsFixture.rows().push({ id: 'sc-jonah-wen', interviewId: jonah.id, interviewerId: 'u-wen', ratings: [], recommendation: 'yes', summary: 's',
      submittedAt: '2026-11-16T10:00:00.000Z', version: 1, changedAfterRecap: false, correctionReason: null });
    const before = (await debrief(AMARA, 'cand-zrtncmb2')).body.debrief.applications[0];
    expect(before.decide.scorecardsMissing).toBe(1);
    expect(before.rounds[0].due).toEqual([{ id: 'u-hugo', name: 'Hugo Marchetti' }]);
    const r = await decide(AMARA, 'app-5j2chffb', { decision: 'hold', reason: REASON, basedOn: 3 });
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
    interviewsFixture.rows().find((i) => i.id === 'iv-g9r1y8lp')!.panelIds = ['u-hugo'];
    expect(await interviewEnded('iv-g9r1y8lp')).toEqual(['u-wen', 'u-hugo']);
    expect(sent[0]!.input).toMatchObject({ title: 'Your scorecard is due: Leadership for Engineering Manager',
      action: { label: 'Open My interviews', href: '/interviews/my-interviews' }, payload: { tenant: 'interviews', kind: 'interview-scorecard-due', audience: 'interviewer' } });
    expect(await interviewEnded('iv-k1p5w8ra')).toEqual([]);
    clean();
  });

  it('submitted: the recruiter on every first version, the hiring manager once every seat\'s is in; a correction rings the recruiter only', async () => {
    expect(await scorecardSubmitted('iv-d7q4n9xe', 'u-hugo', 1)).toEqual(['u-greta', 'u-amara']);
    expect(sent[0]!.input).toMatchObject({ title: expect.stringMatching(/^Hugo Marchetti submitted a scorecard: .+ for Senior Backend Engineer$/),
      action: { label: 'Open the debrief', href: '/interviews/rounds/iv-d7q4n9xe/debrief' }, payload: { audience: 'recruiter', kind: 'interview-scorecard-submitted' } });
    expect(sent[1]!.input).toMatchObject({ title: expect.stringMatching(/^Every scorecard is in: /), payload: { audience: 'hiring-manager' } });
    sent = [];
    expect(await scorecardSubmitted('iv-d7q4n9xe', 'u-hugo', 2)).toEqual(['u-greta']);
    expect(sent[0]!.input.title).toMatch(/^Hugo Marchetti corrected their scorecard: /);
    sent = [];
    // A panel member's first version while another seat is still due: the recruiter only.
    interviewsFixture.rows().find((i) => i.id === 'iv-d7q4n9xe')!.panelIds = ['u-wen'];
    expect(await scorecardSubmitted('iv-d7q4n9xe', 'u-hugo', 1)).toEqual(['u-greta']);
    // Someone who has written nothing on the round rings nobody.
    expect(await scorecardSubmitted('iv-d7q4n9xe', 'u-other-hm', 1)).toEqual([]);
    clean();
  });

  it('decided: the opening\'s recruiter, that a decision was recorded and by whom, opening the debrief', async () => {
    expect(await stageDecided('app-vfzc2x6g', 'u-amara')).toEqual(['u-greta']);
    expect(sent[0]!.input).toMatchObject({ title: 'A decision was recorded on Senior Backend Engineer',
      body: 'Recorded by Amara Okafor. Open the debrief to read it and arrange what follows.',
      action: { href: expect.stringMatching(/^\/interviews\/rounds\/iv-(d7q4n9xe|f2b6t5zh)\/debrief$/) }, payload: { audience: 'recruiter', kind: 'interview-decided' } });
    expect(await stageDecided('app-nobody', 'u-amara')).toEqual([]);
    clean();
  });

  it('never throw, with no sink or an unknown round', async () => {
    setNotificationSink(null);
    expect(await interviewEnded('iv-g9r1y8lp')).toEqual([]);
    expect(await scorecardSubmitted('iv-nope', 'u-hugo', 1)).toEqual([]);
  });
});

// Hardening H4 (O-155): the three cases the first pass left open.
describe('a late scorecard after a hold', () => {
  const JONAH = 'iv-g9r1y8lp';
  const scorecardBody = async (as: Who, id: string) => {
    const page = (await as.get(`/interviews/${id}/scorecard`)).body.scorecard;
    return {
      ratings: page.competencies.map((c: { id: string }, n: number) => ({ competencyId: c.id, rating: (n % 4) + 1, note: '' })),
      recommendation: 'yes', summary: 'Clear examples throughout.', basedOn: page.mine?.version ?? 0,
    };
  };

  /** Jonah's round with Hugo beside Wen: Wen's is in, Hugo's is due, so a hold has a scorecard to stand on and one still missing. */
  function hugoDue() {
    interviewsFixture.rows().find((i) => i.id === JONAH)!.panelIds = ['u-hugo'];
    interviewScorecardsFixture.rows().push({ id: 'sc-jonah-wen', interviewId: JONAH, interviewerId: 'u-wen', ratings: [], recommendation: 'yes', summary: 's',
      submittedAt: '2026-11-16T10:00:00.000Z', version: 1, changedAfterRecap: false, correctionReason: null });
  }

  it('a hold with Hugo\'s scorecard still due is recorded with one missing; his scorecard then arrives and reads in the round, while the decision keeps what it said', async () => {
    hugoDue();
    const held = await decide(AMARA, 'app-5j2chffb', { decision: 'hold', reason: REASON, basedOn: 3 });
    expect(held.status).toBe(201);
    expect(held.body.debrief.applications[0].history[3]).toMatchObject({ decision: 'hold', scorecardsMissing: 1 });
    expect(held.body.debrief.applications[0].stage).toBe('on-hold');
    expect(interviewsFixture.rows().find((i) => i.id === JONAH)!.state).toBe('ended'); // not every seat was in, so nothing was scored to review

    const late = await HUGO.post(`/interviews/${JONAH}/scorecard`, await scorecardBody(HUGO, JONAH));
    expect(late.status).toBe(201);
    const a = (await debrief(AMARA, 'cand-zrtncmb2')).body.debrief.applications[0];
    expect(a.rounds[0]).toMatchObject({ state: 'scored', due: [] });
    expect(a.rounds[0].scorecards.map((s: { interviewer: { id: string } }) => s.interviewer.id).sort()).toEqual(['u-hugo', 'u-wen']);
    // The entry is the record of what the hiring manager knew then: it is never edited, and the stage did not move.
    expect(a.history[3]).toMatchObject({ decision: 'hold', scorecardsMissing: 1 });
    expect(a.stage).toBe('on-hold');
    expect(a.basedOn).toBe(4);
  });

  it('after the late scorecard the held candidate can still be rejected from the page as it now reads, and the round is reviewed', async () => {
    hugoDue();
    await decide(AMARA, 'app-5j2chffb', { decision: 'hold', reason: REASON, basedOn: 3 });
    await HUGO.post(`/interviews/${JONAH}/scorecard`, await scorecardBody(HUGO, JONAH));
    const next = await decide(AMARA, 'app-5j2chffb', { decision: 'reject', reason: 'The role needs more people leadership than this round showed.', basedOn: 4 });
    expect(next.status).toBe(201);
    const a = next.body.debrief.applications[0];
    expect(a.history.slice(3).map((h: { decision: string; scorecardsMissing: number }) => [h.decision, h.scorecardsMissing])).toEqual([['hold', 1], ['reject', 0]]);
    expect(interviewsFixture.rows().find((i) => i.id === JONAH)!.state).toBe('reviewed');
  });
});

describe('a hiring manager with two applications', () => {
  /** Ingrid also applied to the Engineering Manager opening, Amara\'s second: two applications, one candidate, one hiring manager. */
  function second() {
    const first = interviewApplicationsFixture.rows().find((a) => a.id === 'app-vfzc2x6g')!;
    interviewApplicationsFixture.rows().push({ ...first, id: 'app-vfzc2x6g-em', openingId: 'op-em', stage: 'interviewing', history: first.history.slice(0, 3).map((h) => ({ ...h })) });
  }

  it('the debrief lists both, each with its own stage and basedOn; deciding one leaves the other alone', async () => {
    second();
    const before = (await debrief(AMARA, 'cand-qz63q3a3')).body.debrief.applications;
    expect(before.map((a: { applicationId: string }) => a.applicationId).sort()).toEqual(['app-vfzc2x6g', 'app-vfzc2x6g-em']);
    const em = before.find((a: { applicationId: string }) => a.applicationId === 'app-vfzc2x6g-em');
    expect(em).toMatchObject({ stage: 'interviewing', basedOn: 3 });
    expect(em.rounds).toEqual([]);

    const r = await decide(AMARA, 'app-vfzc2x6g', { decision: 'advance', reason: REASON, basedOn: 4 });
    expect(r.status).toBe(201);
    const after = r.body.debrief.applications;
    expect(after.find((a: { applicationId: string }) => a.applicationId === 'app-vfzc2x6g')).toMatchObject({ stage: 'offer', basedOn: 5 });
    expect(after.find((a: { applicationId: string }) => a.applicationId === 'app-vfzc2x6g-em')).toMatchObject({ stage: 'interviewing', basedOn: 3 });
    expect(interviewApplicationsFixture.rows().find((a) => a.id === 'app-vfzc2x6g-em')!.history).toHaveLength(3);
  });

  it('a page read for one application\'s basedOn does not authorise the other: the other is judged on its own history and its own rounds', async () => {
    second();
    const stale = await decide(AMARA, 'app-vfzc2x6g-em', { decision: 'hold', reason: REASON, basedOn: 4 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/changed while you were reading/);
    // On its own history it is current, but it has no round with a scorecard in, so nothing can be decided yet.
    const current = await decide(AMARA, 'app-vfzc2x6g-em', { decision: 'hold', reason: REASON, basedOn: 3 });
    expect(current.status).toBe(409);
    expect(current.body.error).not.toMatch(/changed while you were reading/);
    expect(interviewApplicationsFixture.rows().find((a) => a.id === 'app-vfzc2x6g-em')!.history).toHaveLength(3);
  });

  it('the recruiter reads both and decides neither; another opening\'s hiring manager gets neither', async () => {
    second();
    expect((await debrief(GRETA, 'cand-qz63q3a3')).body.debrief.applications).toHaveLength(2);
    expect((await decide(GRETA, 'app-vfzc2x6g-em', { decision: 'hold', reason: REASON, basedOn: 3 })).status).toBe(403);
    expect((await debrief(OTHER_HM, 'cand-qz63q3a3')).status).toBe(404);
  });
});

describe('a correction after the decision', () => {
  const CODING = 'iv-d7q4n9xe';
  const correction = async (as: Who, id: string) => {
    const page = (await as.get(`/interviews/${id}/scorecard`)).body.scorecard;
    return as.post(`/interviews/${id}/scorecard`, {
      ratings: page.competencies.map((c: { id: string }) => ({ competencyId: c.id, rating: 1, note: '' })),
      recommendation: 'no', summary: 'Second thoughts.', reason: 'I misremembered the second question.', basedOn: page.mine.version,
    });
  };

  it('before the decision the lead may correct; once the hiring manager has decided, the round is reviewed and the correction is refused', async () => {
    const early = await correction(HUGO, CODING);
    expect(early.status).toBe(201);
    expect(early.body.scorecard.mine).toMatchObject({ version: 2, correctionReason: 'I misremembered the second question.' });

    expect((await decide(AMARA, 'app-vfzc2x6g', { decision: 'advance', reason: REASON, basedOn: 4 })).status).toBe(201);
    expect(interviewsFixture.rows().find((i) => i.id === CODING)!.state).toBe('reviewed');

    const late = await correction(HUGO, CODING);
    expect(late.status).toBe(409);
    expect(late.body.error).toMatch(/reviewed, so its scorecards can no longer be corrected/);
    const read = (await HUGO.get(`/interviews/${CODING}/scorecard`)).body.scorecard;
    expect(read).toMatchObject({ canSubmit: false, mine: { version: 2 } });
    // The decision is the record: what was submitted stays as it was.
    expect(interviewScorecardsFixture.rows().filter((s) => s.interviewId === CODING && s.interviewerId === 'u-hugo').map((s) => s.version)).toEqual([1, 2]);
  });

  it('after the decision nobody else on the round may correct either, and the first-version path is closed too', async () => {
    await decide(AMARA, 'app-vfzc2x6g', { decision: 'hold', reason: REASON, basedOn: 4 });
    const together = 'iv-f2b6t5zh';
    expect((await correction(WEN, together)).status).toBe(409);
    expect(interviewsFixture.rows().find((i) => i.id === together)!.state).toBe('reviewed');
  });
});
