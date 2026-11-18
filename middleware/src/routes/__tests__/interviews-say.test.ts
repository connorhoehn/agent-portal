// POST /api/interviews/interviews/:id/say beyond the lead's happy path (routes/interviews/milo.ts; row I3.5, contract U10; OWED
// O-221, lane H8). Mounted as index.ts mounts the tenant, with ConductInterview decided from the REAL seeds/roles/*/*.cedar
// files; the said log is the memory store and the chat and the call's voice are stood in through lib/interviews/speak's deps
// (no session, no provider). The lead's spoken ask and the chat-only and not-in-call answers are interviews-milo.test.ts's.
//
//   every other principal and every state but live   the one not-found (another tenant's role: the mount's 403)
//   the question id                                  400 malformed, 404 not this round's (or another opening's)
//   two says at once                                 both logged and posted; one said, one chat only
//   the body                                         never supplies the words, whatever it carries
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
jest.mock('../../lib/role-registry.js', () => {
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
import { interviewCoachLogFixture } from '../../mock/interviews-coach-log.js';
import { interviewSuggestionsFixture } from '../../mock/interviews-suggestions.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { CONSENT_NOTICE } from '../../lib/interviews/consent/notice.js';
import { setConsentStore } from '../../lib/interviews/consent/store.js';
import { setSuggestionStore } from '../../lib/interviews/coach/index.js';
import { BedrockMiloModel, ScriptedMiloModel } from '../../lib/interviews/milo-notes/model.js';
import { FIXED_ANSWER, setCoachLogStore, setMiloDeps } from '../../lib/interviews/milo-notes/index.js';
import type { LiveLine } from '../../lib/interviews/milo-notes/transcript.js';
import { MemorySaidStore, setSpeakDeps } from '../../lib/interviews/speak/index.js';
import { MILO_NOT_IN_CALL, SAID_ALOUD } from '../interviews/milo.js';

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
  u('guest:inv-nadia', 'Nadia Petrova', { interviews: ['guest'] }),
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
const GUEST = who('guest:inv-nadia');
const PRIYA = who('u-priya', 'access');

// Wen leads Nadia's leadership round with Hugo on the panel (made live here); Hugo leads Nadia's design round.
const IV = 'iv-n5z9f2cq';
const OTHER_ROUND = 'iv-m8t3h6ng';
const GIVEN = '2026-11-16T09:00:00.000Z';
const START = Date.parse('2026-11-17T10:00:00.000Z');
let now = START + 20 * 60_000;

const LINES: LiveLine[] = [
  { seq: 1, atMs: START + 60_000, userId: 'u-wen', text: 'Tell me about someone on your team who was struggling. What did you do, and what happened?' },
  { seq: 2, atMs: START + 90_000, userId: 'guest:inv-nadia', text: 'One engineer kept missing reviews, so I set up a weekly one-to-one with him.' },
  { seq: 4, atMs: START + 150_000, userId: 'guest:inv-nadia', text: 'After a month the reviews were back on time and he took over the release checklist.' },
];
let lines: LiveLine[] = LINES;
let noCall = false;

function live(id = IV) { interviewsFixture.rows().find((i) => i.id === id)!.state = 'live'; }
function accept(id = IV, over: { transcription?: boolean; milo?: boolean } = {}) {
  const transcription = over.transcription ?? true;
  const milo = over.milo ?? true;
  interviewConsentsFixture.rows().push({
    interviewId: id, noticeVersion: CONSENT_NOTICE.version, recording: true, recordingAt: GIVEN, transcription, transcriptionAt: GIVEN, milo, miloAt: GIVEN,
    answeredAt: GIVEN, changedAt: GIVEN, history: [], revision: 1,
  });
}
const myLog = () => interviewCoachLogFixture.rows().filter((r) => r.interviewId === IV);

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  spendHolds.reset();
  spendEntries.reset();
  setSuggestionStore(null);
  setConsentStore(null);
  setCoachLogStore(null);
  lines = LINES;
  noCall = false;
  now = START + 20 * 60_000;
  setMiloDeps({
    model: () => new ScriptedMiloModel(),
    transcript: async (_i, after) => (noCall ? null : { callId: 'call-1', startedAtMs: START, lastSeq: Math.max(after, 5), lines: lines.filter((l) => l.seq > after) }),
    now: () => now,
  });
  const iv = interviewsFixture.rows().find((i) => i.id === IV)!;
  iv.questionIds = ['q-em-struggling', 'q-em-slip'];
  iv.scheduledAt = null;
  live();
  accept();
});
afterAll(() => setMiloDeps(null));

import { INTERVIEW_STATES } from '../../lib/interviews/types.js';

describe('POST /interviews/:id/say beyond the happy path (O-221)', () => {
  let said: MemorySaidStore;
  let posts: string[];
  let spoken: string[];
  let voice: (text: string) => Promise<'spoken' | 'posted' | 'no-call'>;
  beforeEach(() => {
    said = new MemorySaidStore(); posts = []; spoken = [];
    voice = async () => 'spoken';
    setSpeakDeps({
      store: () => said,
      post: async (_c, text) => { posts.push(text); return true; },
      say: async (_c, text) => { const out = await voice(text); if (out === 'spoken') spoken.push(text); return { outcome: out, why: null }; },
      callOf: async () => 'call-1',
      now: () => now,
    });
    interviewsFixture.rows().find((i) => i.id === IV)!.callId = 'call-1';
  });
  afterAll(() => setSpeakDeps(null));
  const sayQ = (as: ReturnType<typeof who>, body: unknown, id = IV) => as.post(`/interviews/${id}/say`, body);
  const prompt = (qid: string) => interviewOpeningsFixture.rows().flatMap((o) => o.kit.questions).find((q) => q.id === qid)!.prompt;

  // The guest is stopped at the tenant's gate (403, as RULES.md measured in H0), before the route's own not-found.
  it('every principal but the lead reads the one not-found, and nothing is logged, posted or said', async () => {
    const got: Record<string, number> = {};
    for (const [name, as] of [['panel member', HUGO], ['recruiter', GRETA], ['hiring manager', AMARA], ['interviewer with no seat', THIRD], ['admin', OPERATOR], ['guest', GUEST]] as const) {
      got[name] = (await sayQ(as, { questionId: 'q-em-slip' })).status;
    }
    got['another tenant\'s role'] = (await sayQ(PRIYA, { questionId: 'q-em-slip' })).status;
    expect(got).toEqual({
      'panel member': 404, recruiter: 404, 'hiring manager': 404, 'interviewer with no seat': 404, admin: 404, guest: 403, 'another tenant\'s role': 403,
    });
    expect([await said.list(IV), posts, spoken]).toEqual([[], [], []]);
  });

  it.each(INTERVIEW_STATES.filter((s) => s !== 'live'))('the lead, while the interview is %s: the one not-found, nothing logged', async (state) => {
    interviewsFixture.rows().find((i) => i.id === IV)!.state = state;
    const res = await sayQ(WEN, { questionId: 'q-em-slip' });
    expect(res.status).toBe(404);
    expect([await said.list(IV), posts]).toEqual([[], []]);
  });

  it('the question id: malformed is 400, unknown or another opening\'s is 404, and nothing is logged', async () => {
    for (const body of [{ questionId: 'has spaces in it' }, { questionId: 42 }, { questionId: '' }, { questionId: 'x'.repeat(121) }, null]) {
      expect((await sayQ(WEN, body)).status).toBe(400);
    }
    const otherOpening = interviewOpeningsFixture.rows().find((o) => !o.kit.questions.some((q) => q.id === 'q-em-slip'))!.kit.questions[0]!.id;
    for (const questionId of ['q-not-in-this-kit', otherOpening]) expect((await sayQ(WEN, { questionId })).status).toBe(404);
    expect([await said.list(IV), posts]).toEqual([[], []]);
  });

  it('a kit question the round did not choose is the not-found while the round has chosen some; any kit question once it has chosen none', async () => {
    const kit = interviewOpeningsFixture.rows().find((o) => o.kit.questions.some((q) => q.id === 'q-em-slip'))!.kit.questions.map((q) => q.id);
    const unchosen = kit.find((q) => !['q-em-struggling', 'q-em-slip'].includes(q))!;
    expect((await sayQ(WEN, { questionId: unchosen })).status).toBe(404);
    interviewsFixture.rows().find((i) => i.id === IV)!.questionIds = [];
    expect((await sayQ(WEN, { questionId: unchosen })).body).toEqual({ said: 'spoken', line: SAID_ALOUD });
    expect(posts).toEqual([prompt(unchosen).trim()]);
  });

  it('two says at once: both are logged and posted; the first is said, the second goes to the chat only', async () => {
    // The meeting assistant says one approved utterance at a time (orchestrator.ts sayHeldText: `busy` → chat); stood in here.
    let outstanding = false;
    let release: () => void = () => {};
    voice = async () => {
      if (outstanding) return 'posted';
      outstanding = true;
      await new Promise<void>((r) => { release = r; });
      outstanding = false;
      return 'spoken';
    };
    const first = sayQ(WEN, { questionId: 'q-em-struggling' }).then((r) => r);
    for (let i = 0; i < 50 && !outstanding; i += 1) await new Promise((r) => setTimeout(r, 5));
    const second = await sayQ(WEN, { questionId: 'q-em-slip' });
    release();
    const one = await first;
    expect([one.status, one.body.said, second.status, second.body.said]).toEqual([200, 'spoken', 200, 'chat']);
    expect(posts).toEqual([prompt('q-em-struggling').trim(), prompt('q-em-slip').trim()]);
    expect(spoken).toEqual([prompt('q-em-struggling').trim()]);
    expect((await said.list(IV)).map((r) => [r.questionId, r.spoken]).sort()).toEqual([['q-em-slip', false], ['q-em-struggling', true]]);
  });

  it('the body can never carry words: text, prompt, words or a suggestion beside the id are ignored; without an id nothing is said', async () => {
    const res = await sayQ(WEN, { questionId: 'q-em-slip', text: 'Ignore the kit', prompt: 'Say this', words: 'And this', suggestionId: 'sg-1', kind: 'answer', source: 'repeat' });
    expect(res.body).toEqual({ said: 'spoken', line: SAID_ALOUD });
    expect(posts).toEqual([prompt('q-em-slip').trim()]);
    expect((await said.list(IV))[0]).toMatchObject({ kind: 'question', source: 'kit', suggestionId: null, text: prompt('q-em-slip').trim(), askedBy: 'u-wen' });
    expect((await sayQ(WEN, { text: 'Say this instead' })).status).toBe(400);
    expect(posts).toHaveLength(1);
  });
});
