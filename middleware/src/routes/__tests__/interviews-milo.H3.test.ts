// Hardening H3 edges for Milo for you and the live transcript (OWED O-121, O-122). The harness is interviews-milo.test.ts's,
// copied as it stands; that file's header says what is real and what is stood in.
//
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
  // A guest holds no staff session: lib/session.ts marks a guest-only request's session invalid, so every staff gate answers 401.
  if (id.startsWith('guest:')) { req.sessionInvalid = true; next(); return; }
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

describe('the edges (hardening H3)', () => {
  it('O-121: two lead tabs asking at once make one model call and one hold; the other tab is told a question is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls = jest.fn();
    const inner = new ScriptedMiloModel();
    setMiloDeps({
      model: () => ({ kind: inner.kind, modelId: inner.modelId, ask: async (input: never) => { calls(); await gate; return inner.ask(input); } }) as never,
      transcript: async (_i, after) => ({ callId: 'call-1', startedAtMs: START, lastSeq: Math.max(after, 5), lines: lines.filter((l) => l.seq > after) }),
      now: () => now,
    });
    const first = ask(WEN, 'What did she do about the missed reviews?').then((r) => r);
    for (let i = 0; i < 50 && calls.mock.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveBeenCalledTimes(1);
    const second = await ask(WEN, 'What about the release checklist?');
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ answer: null, refused: 'in-flight', retryAfterMs: 5_000 });
    release();
    const done = await first;
    expect(done.body.answer).not.toBeNull();
    expect(calls).toHaveBeenCalledTimes(1);
    expect(spendHolds.rows().filter((h) => h.source === 'interviews')).toHaveLength(1);
    expect(myLog().filter((r) => r.code === null)).toHaveLength(1);
  });

  it('O-121: two asks fired in the same moment still make one model call', async () => {
    const calls = jest.fn();
    const inner = new ScriptedMiloModel();
    setMiloDeps({
      model: () => ({ kind: inner.kind, modelId: inner.modelId, ask: async (input: never) => { calls(); await new Promise((r) => setTimeout(r, 30)); return inner.ask(input); } }) as never,
      transcript: async (_i, after) => ({ callId: 'call-1', startedAtMs: START, lastSeq: Math.max(after, 5), lines: lines.filter((l) => l.seq > after) }),
      now: () => now,
    });
    const both = await Promise.all([ask(WEN, 'What about reviews?'), ask(WEN, 'What about the checklist?')]);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(both.filter((r) => r.body.answer !== null)).toHaveLength(1);
    expect(both.map((r) => r.body.refused).filter(Boolean)).toEqual([expect.stringMatching(/^(in-flight|too-soon)$/)]);
  });

  it('O-122: the recruiter reads a line by someone with no directory entry under a plain name, never their id', async () => {
    lines = [...LINES, { seq: 5, atMs: START + 200_000, userId: 'u-gone', text: 'I will take notes on the plan.' }];
    const res = await transcript(GRETA);
    expect(res.status).toBe(200);
    expect(res.body.transcript.lines.at(-1)).toEqual({ seq: 5, at: new Date(START + 200_000).toISOString(), side: 'panel', speaker: 'Someone without an account here', text: 'I will take notes on the plan.' });
    expect(JSON.stringify(res.body)).not.toContain('u-gone');
  });

  it('O-122: the recruiter reads a live interview with no record of Milo\'s call: one sentence, no lines', async () => {
    const { MemoryAssistantStore } = await import('../../lib/meeting-assistant/store.js');
    const { setAssistantStore } = await import('../../lib/meeting-assistant/store-select.js');
    const { assistantLiveTranscript } = await import('../../lib/interviews/milo-notes/transcript.js');
    setAssistantStore(new MemoryAssistantStore());
    try {
      setMiloDeps({ transcript: assistantLiveTranscript, now: () => now });
      const res = await transcript(GRETA);
      expect(res.status).toBe(200);
      expect(res.body.transcript).toEqual({ state: 'off', off: 'There is no transcript yet: Milo has not been invited to the call.', lines: [], lastSeq: 0 });
    } finally {
      setAssistantStore(null);
    }
  });
});
