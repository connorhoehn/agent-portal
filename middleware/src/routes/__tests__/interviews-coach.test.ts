// Milo's suggestion for the lead (routes/interviews/coach.ts; docs/interviews-tenant-plan.md row I3.3, contract D7), mounted
// as index.ts mounts the tenant, with ConductInterview decided from the REAL seeds/roles/*/*.cedar files, the real spend
// door (mock holds) and the real memory log; the transcript is a fixed one and the model is the scripted stand-in.
//
//   interviewer (lead)                         reads the suggestion (marks it shown) and answers it
//   panel / another round's interviewer / no seat / recruiter / hiring manager / admin   not found (404) on both routes
//   another tenant's role                      the tenant's usual refusal at the mount (403), before these routes

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
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
import { interviewOpeningsFixture, interviewsFixture } from '../../mock/interviews.js';
import { interviewConsentsFixture } from '../../mock/interviews-consents.js';
import { interviewSuggestionsFixture } from '../../mock/interviews-suggestions.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { CONSENT_NOTICE } from '../../lib/interviews/consent/notice.js';
import { setConsentStore } from '../../lib/interviews/consent/store.js';
import { setCoachDeps, setSuggestionStore } from '../../lib/interviews/coach/index.js';
import { setSpeakDeps } from '../../lib/interviews/speak/index.js';
import { ScriptedCoachModel } from '../../lib/interviews/coach/model.js';

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
const who = (id: string, tenant = 'interviews') => ({
  get: (p: string) => request(app).get(`${API}${p}`).set('x-user', id).set('x-tenant', tenant),
  post: (p: string, body: unknown) => request(app).post(`${API}${p}`).set('x-user', id).set('x-tenant', tenant).send(body as object),
});
const GRETA = who('u-greta');
const HUGO = who('u-hugo');
const WEN = who('u-wen');
const THIRD = who('u-third');
const AMARA = who('u-amara');
const OPERATOR = who('u-operator');
const PRIYA = who('u-priya', 'access');

// Wen leads Nadia's leadership round with Hugo on the panel (made live here); Hugo leads Nadia's design round.
const IV = 'iv-n5z9f2cq';
const OTHER_ROUND = 'iv-m8t3h6ng';
const GIVEN = '2026-11-16T09:00:00.000Z';
const postApproved = jest.fn(async (_callId: string, _text: string, _kind: string) => true);

function live(id = IV) { interviewsFixture.rows().find((i) => i.id === id)!.state = 'live'; }
function accept(id = IV, milo = true) {
  interviewConsentsFixture.rows().push({
    interviewId: id, noticeVersion: CONSENT_NOTICE.version, recording: true, recordingAt: GIVEN, transcription: true, transcriptionAt: GIVEN, milo, miloAt: GIVEN,
    answeredAt: GIVEN, changedAt: GIVEN, history: [], revision: 1,
  });
}

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  spendHolds.reset();
  spendEntries.reset();
  postApproved.mockClear();
  setSuggestionStore(null);
  setConsentStore(null);
  setSpeakDeps({ post: postApproved });
  setCoachDeps({
    model: () => new ScriptedCoachModel(),
    transcript: async () => ({ callId: 'call-1', lastSeq: 2, lines: [
      { seq: 1, side: 'panel', text: 'Tell me about someone on your team who was struggling. What did you do, and what happened?' },
      { seq: 2, side: 'candidate', text: 'One engineer kept missing reviews, so I set up a weekly one-to-one.' },
    ] }),
  });
  live();
  accept();
});
afterAll(() => { setCoachDeps(null); setSpeakDeps(null); });

const read = (as: ReturnType<typeof who>, id = IV) => as.get(`/interviews/${id}/suggestion`);
const answer = (as: ReturnType<typeof who>, sid: string, body: unknown, id = IV) => as.post(`/interviews/${id}/suggestion/${sid}/answer`, body);

describe('the lead', () => {
  it('reads a suggestion (shown, logged, paid by the opening) and reads the same one again', async () => {
    const first = await read(WEN);
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body).toMatchObject({ paused: null, retryAfterMs: 15_000, suggestion: { competency: { id: 'delivery', name: 'Delivery' }, basedOn: null } });
    expect(Object.keys(first.body.suggestion).sort()).toEqual(['basedOn', 'competency', 'id', 'shownAt', 'text']);
    expect((await read(WEN)).body.suggestion).toEqual(first.body.suggestion);
    const rows = interviewSuggestionsFixture.rows().filter((r) => r.interviewId === IV);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shownAt).toBe(first.body.suggestion.shownAt);
    expect(spendEntries.rows().some((e) => e.source === 'interviews' && String(e.sourceId).includes(`:${IV}:coach:`))).toBe(true);
  });

  it('answers once: Have Milo ask is logged unspoken and posted; a second answer is 409; a bad answer is 400', async () => {
    const { body } = await read(WEN);
    const sid = body.suggestion.id as string;
    expect((await answer(WEN, sid, { answer: 'maybe' })).status).toBe(400);
    const ok = await answer(WEN, sid, { answer: 'milo-ask' });
    expect(ok.status).toBe(200);
    // Posted to the call chat; no meeting assistant runs here to say it, so the receipt's reason is that Milo is not in the call.
    expect(ok.body).toEqual({ suggestion: null, said: 'chat', why: 'not-in-call', line: 'Milo could not say it aloud. The question is in the call chat.' });
    expect(interviewSuggestionsFixture.rows().find((r) => r.id === sid)).toMatchObject({ answer: 'milo-ask', spoken: false });
    expect(postApproved).toHaveBeenCalledWith('call-1', body.suggestion.text, 'question');
    expect((await answer(WEN, sid, { answer: 'skip' })).status).toBe(409);
    expect((await read(WEN)).body).toMatchObject({ suggestion: null });
  });

  it('nothing when the candidate declined Milo, and no money is held', async () => {
    interviewConsentsFixture.rows().splice(0);
    accept(IV, false);
    expect((await read(WEN)).body).toEqual({ suggestion: null, paused: null, retryAfterMs: 120_000 });
    expect(spendHolds.rows().filter((h) => h.source === 'interviews')).toHaveLength(0);
  });

  it('paused for the budget when the opening has no cap', async () => {
    const opening = interviewOpeningsFixture.rows().find((o) => o.id === 'op-em')!;
    opening.budgetCapUsd = null;
    expect((await read(WEN)).body).toEqual({ suggestion: null, paused: 'budget', retryAfterMs: 90_000 });
    expect(interviewSuggestionsFixture.rows().filter((r) => r.interviewId === IV)).toHaveLength(0);
  });

  it('cannot answer once the interview has ended (409)', async () => {
    const { body } = await read(WEN);
    interviewsFixture.rows().find((i) => i.id === IV)!.state = 'ended';
    expect((await answer(WEN, body.suggestion.id, { answer: 'ask' })).status).toBe(409);
  });
});

describe('everyone else', () => {
  it.each([
    ['a panel member', HUGO, IV],
    ['another round\'s interviewer (Wen, on the round Hugo leads)', WEN, OTHER_ROUND],
    ['an interviewer without a seat', THIRD, IV],
    ['the recruiter', GRETA, IV],
    ['the hiring manager', AMARA, IV],
    ['the admin', OPERATOR, IV],
    ['anyone, an interview that does not exist', WEN, 'iv-nobody'],
  ])('%s: not found on both routes, and nothing is made', async (_label, as, id) => {
    live(OTHER_ROUND);
    expect((await read(as, id)).status).toBe(404);
    expect((await answer(as, 'sg-mhzk2q4a7c1e93b05d', { answer: 'ask' }, id)).status).toBe(404);
    expect(interviewSuggestionsFixture.rows().filter((r) => r.interviewId === id && id !== 'iv-nobody')).toHaveLength(0);
  });

  it('a lead cannot answer another interview\'s suggestion through their own', async () => {
    expect((await answer(WEN, 'sg-mi3n7t1c9d0b25e61a', { answer: 'ask' })).status).toBe(404);
  });

  it('another tenant\'s role is refused at the tenant\'s mount on both routes', async () => {
    expect((await read(PRIYA)).status).toBe(403);
    expect((await answer(PRIYA, 'sg-x', { answer: 'ask' })).status).toBe(403);
  });
});
