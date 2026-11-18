// Milo for you and the live transcript (routes/interviews/milo.ts; docs/interviews-tenant-plan.md rows I3.6 and I3.7,
// contract E5), mounted as index.ts mounts the tenant, with ConductInterview decided from the REAL seeds/roles/*/*.cedar
// files, the real spend door (mock holds), the real memory coach log and suggestion log; the transcript is a fixed one
// and the model is the scripted stand-in (or an injected fake Bedrock client, never a provider).
//
//   transcript   the lead, the panel, the recruiter, the opening's hiring manager while live; everyone else 404
//   milo-notes   the lead and the panel while live; everyone else 404
//   milo-ask     the lead only; a panel member, the recruiter, the hiring manager, the admin 404; a guest is refused
//   another tenant's role                      the tenant's usual refusal at the mount (403), before these routes

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

const transcript = (as: ReturnType<typeof who>, id = IV, after?: number) => as.get(`/interviews/${id}/transcript${after === undefined ? '' : `?after=${after}`}`);
const notes = (as: ReturnType<typeof who>, id = IV) => as.get(`/interviews/${id}/milo-notes`);
const ask = (as: ReturnType<typeof who>, question: unknown, id = IV) => as.post(`/interviews/${id}/milo-ask`, { question });

describe('the live transcript (I3.7)', () => {
  it.each([['the lead', WEN], ['a panel member', HUGO], ['the recruiter', GRETA], ['the opening\'s hiring manager', AMARA]])('%s reads it with names, never the guest id', async (_l, as) => {
    const res = await transcript(as);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.transcript).toMatchObject({ state: 'on', off: null, lastSeq: 5 });
    expect(res.body.transcript.lines).toEqual([
      { seq: 1, at: new Date(START + 60_000).toISOString(), side: 'panel', speaker: 'Wen Zhao', text: LINES[0]!.text },
      { seq: 2, at: new Date(START + 90_000).toISOString(), side: 'candidate', speaker: 'Nadia Petrova', text: LINES[1]!.text },
      { seq: 4, at: new Date(START + 150_000).toISOString(), side: 'candidate', speaker: 'Nadia Petrova', text: LINES[2]!.text },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('guest:');
  });

  it('reads only what is newer than after', async () => {
    expect((await transcript(WEN, IV, 2)).body.transcript.lines.map((l: { seq: number }) => l.seq)).toEqual([4]);
  });

  it('is off, in one sentence, without the candidate\'s yes, and reads nothing of the call', async () => {
    const source = jest.fn(async () => null);
    setMiloDeps({ transcript: source, now: () => now });
    interviewConsentsFixture.rows().splice(0);
    expect((await transcript(WEN)).body.transcript).toEqual({ state: 'off', off: 'Milo is off for this interview until the candidate has answered the questions about the transcript and Milo.', lines: [], lastSeq: 0 });
    accept(IV, { transcription: false, milo: false });
    expect((await transcript(WEN)).body.transcript.off).toBe('Milo is off for this interview: the candidate chose to go without a transcript.');
    expect(source).not.toHaveBeenCalled();
  });

  it('is off when Milo was not invited, and runs with Milo declined but the transcript accepted', async () => {
    noCall = true;
    expect((await transcript(WEN)).body.transcript).toMatchObject({ state: 'off', off: 'There is no transcript yet: Milo has not been invited to the call.' });
    noCall = false;
    interviewConsentsFixture.rows().splice(0);
    accept(IV, { milo: false });
    expect((await transcript(WEN)).body.transcript.state).toBe('on');
  });
});

describe('Milo\'s notes (I3.6, no model)', () => {
  it('the lead and the panel read what was asked about and what is left, and the time check', async () => {
    for (const as of [WEN, HUGO]) {
      const res = await notes(as);
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(res.body.notes.competencies.map((c: { id: string }) => [c.id, c]));
      expect(byId['people-leadership'].asked).toEqual([{ text: LINES[0]!.text, questionId: 'q-em-struggling', by: 'panel' }]);
      expect(byId['delivery'].toAsk.map((q: { questionId: string }) => q.questionId)).toEqual(['q-em-slip']);
      expect(res.body.notes.time).toEqual({ startedAt: new Date(START).toISOString(), minutesIn: 20, minutes: 60, minutesLeft: 40, line: '20 of 60 min, 40 min left.' });
    }
    expect(spendHolds.rows().filter((h) => h.source === 'interviews')).toHaveLength(0);
  });

  it.each([['the recruiter', GRETA], ['the hiring manager', AMARA]])('%s does not read the notes (seats only)', async (_l, as) => {
    expect((await notes(as)).status).toBe(404);
  });
});

describe('the private question (I3.6)', () => {
  it('the lead gets an answer with its quoted lines, logged, paid by the opening', async () => {
    const res = await ask(WEN, 'What did she do about the missed reviews?');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refused: null, line: null, paused: null });
    expect(res.body.answer).toMatchObject({ question: 'What did she do about the missed reviews?', text: 'The candidate spoke of it in lines 2 and 4.' });
    expect(res.body.answer.sources).toEqual([
      { seq: 2, quote: LINES[1]!.text, speaker: 'Nadia Petrova', at: new Date(START + 90_000).toISOString() },
      { seq: 4, quote: LINES[2]!.text, speaker: 'Nadia Petrova', at: new Date(START + 150_000).toISOString() },
    ]);
    expect(myLog()).toEqual([expect.objectContaining({ kind: 'answer', askedBy: 'u-wen', code: null, modelId: 'scripted-milo', promptVersion: 'milo-ask-2026-11-17.1', sources: [{ seq: 2, quote: LINES[1]!.text }, { seq: 4, quote: LINES[2]!.text }] })]);
    expect(spendEntries.rows().some((e) => e.source === 'interviews' && String(e.sourceId).endsWith(`:${IV}:coach:ask-1`))).toBe(true);
  });

  it('a judgement gets the one fixed sentence, no model, no hold, a code in the log', async () => {
    const model = jest.fn();
    setMiloDeps({ model: () => ({ kind: 'bedrock', modelId: 'x', ask: model }) as never, transcript: async () => ({ callId: 'c', startedAtMs: START, lastSeq: 4, lines: LINES }), now: () => now });
    const res = await ask(WEN, 'Should we hire her?');
    expect(res.body).toEqual({ answer: null, refused: 'judgement', line: FIXED_ANSWER, paused: null, retryAfterMs: null });
    expect(model).not.toHaveBeenCalled();
    expect(spendHolds.rows().filter((h) => h.source === 'interviews')).toHaveLength(0);
    expect(myLog()).toEqual([expect.objectContaining({ question: 'Should we hire her?', answer: '', sources: [], code: 'refused-judgement', modelId: 'none' })]);
  });

  it('a judging answer from the model is dropped by code, never stored as text', async () => {
    const send = jest.fn(async () => ({ output: { message: { role: 'assistant', content: [{ text: JSON.stringify({ answer: 'A strong answer: she set up a weekly one-to-one.', sources: [{ seq: 2, quote: 'I set up a weekly one-to-one' }] }) }] } }, usage: { inputTokens: 1000, outputTokens: 30 } }));
    setMiloDeps({ model: () => new BedrockMiloModel({ send: send as never, modelId: 'amazon.nova-pro-v1:0' }), transcript: async () => ({ callId: 'c', startedAtMs: START, lastSeq: 4, lines: LINES }), now: () => now });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await ask(WEN, 'What did she do about the missed reviews?');
    warn.mockRestore();
    expect(res.body).toMatchObject({ answer: null, refused: 'dropped' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(myLog()).toEqual([expect.objectContaining({ answer: '', sources: [], code: 'judges', modelId: 'amazon.nova-pro-v1:0' })]);
    expect(JSON.stringify(myLog())).not.toContain('strong answer');
  });

  it('waits between questions, and stops at the maximum', async () => {
    expect((await ask(WEN, 'What about reviews?')).body.answer).not.toBeNull();
    const soon = await ask(WEN, 'What about the checklist?');
    expect(soon.body).toMatchObject({ answer: null, refused: 'too-soon', retryAfterMs: 20_000 });
    now += 21_000;
    expect((await ask(WEN, 'What about the checklist?')).body.answer).not.toBeNull();
    for (let n = 3; n <= 15; n++) { now += 21_000; await ask(WEN, 'What about the checklist?'); }
    now += 21_000;
    expect((await ask(WEN, 'What about reviews?')).body).toMatchObject({ refused: 'at-max' });
    expect(myLog()).toHaveLength(15);
  });

  it('paused for the budget when the opening has no cap: no call, no row', async () => {
    interviewOpeningsFixture.rows().find((o) => o.id === 'op-em')!.budgetCapUsd = null;
    expect((await ask(WEN, 'What about reviews?')).body).toEqual({ answer: null, refused: null, line: null, paused: 'budget', retryAfterMs: null });
    expect(myLog()).toHaveLength(0);
  });

  it('no consent: refused in one line, nothing read', async () => {
    interviewConsentsFixture.rows().splice(0);
    accept(IV, { milo: false });
    expect((await ask(WEN, 'What about reviews?')).body).toMatchObject({ answer: null, refused: 'no-consent' });
    expect(myLog()).toHaveLength(0);
  });

  it('400 for a missing or long question; 409 once the interview is not live', async () => {
    expect((await ask(WEN, '')).status).toBe(400);
    expect((await ask(WEN, 'x'.repeat(301))).status).toBe(400);
    interviewsFixture.rows().find((i) => i.id === IV)!.state = 'ended';
    const res = await ask(WEN, 'What about reviews?');
    expect(res.status).toBe(409);
    expect(res.body.refused).toBe('not-live');
  });
});

describe('everyone else', () => {
  it.each([
    ['another round\'s interviewer (Wen, on the round Hugo leads)', WEN, OTHER_ROUND],
    ['an interviewer without a seat', THIRD, IV],
    ['the admin', OPERATOR, IV],
    ['anyone, an interview that does not exist', WEN, 'iv-nobody'],
  ])('%s: not found on all three routes, and nothing is made', async (_label, as, id) => {
    live(OTHER_ROUND);
    expect((await transcript(as, id)).status).toBe(404);
    expect((await notes(as, id)).status).toBe(404);
    expect((await ask(as, 'What about reviews?', id)).status).toBe(404);
    expect(interviewCoachLogFixture.rows().filter((r) => r.interviewId === id)).toHaveLength(0);
  });

  it.each([['a panel member', HUGO], ['the recruiter', GRETA], ['the hiring manager', AMARA]])('%s: the ask is not found', async (_l, as) => {
    expect((await ask(as, 'What about reviews?')).status).toBe(404);
    expect(myLog()).toHaveLength(0);
  });

  it('the candidate (a guest) is refused all three', async () => {
    for (const res of [await transcript(GUEST), await notes(GUEST), await ask(GUEST, 'What about reviews?')]) expect([403, 404]).toContain(res.status);
  });

  it.each(['assigned', 'accepted', 'ready', 'ended', 'scored', 'reviewed', 'declined', 'cancelled'])('state %s: both reads are not found', async (state) => {
    interviewsFixture.rows().find((i) => i.id === IV)!.state = state as never;
    expect((await transcript(WEN)).status).toBe(404);
    expect((await notes(WEN)).status).toBe(404);
  });

  it('another tenant\'s role is refused at the tenant\'s mount', async () => {
    expect((await transcript(PRIYA)).status).toBe(403);
    expect((await notes(PRIYA)).status).toBe(403);
    expect((await ask(PRIYA, 'q')).status).toBe(403);
  });
});

// Lane SPEAK (row I3.5, contract U10): the lead's "Have Milo ask" on a kit question. The words are the question's prompt from the
// store; logged, posted, then said (lib/interviews/speak deps stand in for the chat and the call's voice here).
describe('POST /interviews/:id/say (I3.5)', () => {
  const said = new MemorySaidStore();
  const steps: string[] = [];
  let voice: 'spoken' | 'posted' | 'no-call' = 'spoken';
  let inCall = true;
  beforeEach(() => {
    steps.length = 0; voice = 'spoken'; inCall = true;
    setSpeakDeps({
      store: () => said,
      post: async (_c, text) => { steps.push(`post:${text.slice(0, 12)}`); return inCall; },
      say: async () => { steps.push('say'); return { outcome: voice, why: null }; },
      now: () => now,
    });
    interviewsFixture.rows().find((i) => i.id === IV)!.callId = 'call-1';
  });
  afterAll(() => setSpeakDeps(null));
  const sayQ = (as: ReturnType<typeof who>, body: unknown, id = IV) => as.post(`/interviews/${id}/say`, body);

  it('the lead: the prompt from the store is posted and said; the body never supplies the words', async () => {
    const res = await sayQ(WEN, { questionId: 'q-em-struggling', text: 'Something else entirely' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ said: 'spoken', line: SAID_ALOUD });
    const prompt = interviewOpeningsFixture.rows().flatMap((o) => o.kit.questions).find((q) => q.id === 'q-em-struggling')!.prompt;
    expect(steps).toEqual([`post:${prompt.slice(0, 12)}`, 'say']);
    expect((await said.list(IV)).at(-1)).toMatchObject({ kind: 'question', source: 'kit', questionId: 'q-em-struggling', text: prompt, askedBy: 'u-wen', spoken: true });
  });

  it('withheld or voice off: chat, with the one sentence; Milo not in the call: 409 with a sentence', async () => {
    voice = 'posted';
    expect((await sayQ(WEN, { questionId: 'q-em-slip' })).body).toEqual({ said: 'chat', line: 'Milo could not say it aloud. The question is in the call chat.' });
    inCall = false;
    const res = await sayQ(WEN, { questionId: 'q-em-slip' });
    expect([res.status, res.body.error]).toEqual([409, MILO_NOT_IN_CALL]);
  });

  it('400 for no question id; 404 for a question outside the round, another seat, a guest, or an interview not live', async () => {
    expect((await sayQ(WEN, {})).status).toBe(400);
    expect((await sayQ(WEN, { questionId: 'q-not-in-this-round' })).status).toBe(404);
    for (const as of [HUGO, GUEST]) expect((await sayQ(as, { questionId: 'q-em-slip' })).status).toBeGreaterThanOrEqual(400);
    interviewsFixture.rows().find((i) => i.id === IV)!.state = 'accepted';
    expect((await sayQ(WEN, { questionId: 'q-em-slip' })).status).toBe(404);
    expect(steps).toEqual([]);
  });
});
