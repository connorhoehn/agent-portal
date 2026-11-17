// Milo's recap (routes/interviews/recap.ts; docs/interviews-tenant-plan.md row I5.2, contract E3), mounted as index.ts
// mounts the tenant, with ConductInterview decided from the REAL seeds/roles/*/*.cedar files.
//
//   a seat (lead, panel)        opens it once the round has ended (storing their ratings); reads it only after their own
//                               open or their own scorecard (rate first, decision 14)
//   recruiter, hiring manager, admin   read it once the round has ended; never write it; opening is refused (403 / 404)
//   an interviewer of another round of the same candidate   reads it only under the scorecards' rule (othersRevealed)
//   another round's interviewer otherwise, another opening's hiring manager   not found (404)
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
import { interviewRecapOpensFixture, interviewRecapsFixture } from '../../mock/interviews-recaps.js';
import { setCoachModelFactory, ScriptedCoachModel } from '../../lib/interviews/coach/index.js';
import { setRecapDeps } from '../../lib/interviews/recap/index.js';
import type { Session } from '../../lib/session.js';
import { interviewCoachLogFixture } from '../../mock/interviews-coach-log.js';
import { BedrockMiloModel, FIXED_ANSWER, ScriptedMiloModel, setCoachLogStore, setMiloDeps } from '../../lib/interviews/milo-notes/index.js';
import type { TranscriptLineView } from '../../lib/interviews/milo-notes/transcript.js';

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


// Nadia's leadership round has ended here (Wen leads, Hugo on the panel; Nadia accepted everything); Hugo's design round
// for Nadia is cancelled. Ingrid's two seeded rounds (Hugo's coding, Wen's "Working together") are reviewed.
const NADIA = 'iv-nadia-leadership';
const JONAH = 'iv-jonah-leadership';
const INGRID_CODING = 'iv-ingrid-coding';
const INGRID_TOGETHER = 'iv-ingrid-together';

beforeAll(() => setCoachModelFactory(() => new ScriptedCoachModel()));
afterAll(() => { setCoachModelFactory(null); setRecapDeps(null); });
beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  for (const i of interviewsFixture.rows()) {
    if (i.id === NADIA) { i.state = 'ended'; i.endedAt = '2026-11-16T10:00:00.000Z'; i.questionIds = ['q-em-struggling']; }
    if (i.id === 'iv-nadia-design') i.state = 'cancelled';
  }
  setRecapDeps({
    consents: async () => ({ transcription: true, milo: true }),
    transcript: async () => ({ callId: 'call-1', lastSeq: 2, lines: [
      { seq: 1, side: 'panel', text: 'Tell me about someone on your team who was struggling. What did you do, and what happened?' },
      { seq: 2, side: 'candidate', text: 'One engineer kept missing reviews, so I set up a weekly one-to-one and we agreed a plan.' },
    ] }),
    reserve: async (i) => ({ ok: true, holdId: null, sourceId: `iv:op-em:${i.interviewId}:coach:${i.key}`, amountUsd: 0 }),
    settle: async () => undefined,
    release: async () => undefined,
  });
});

type Who = ReturnType<typeof who>;
const KIT = async () => (await GRETA.get(`/interviews/${NADIA}/scorecard`)).body.scorecard.competencies as Array<{ id: string }>;
const ratings = async (rating = 3) => ({ ratings: (await KIT()).map((c) => ({ competencyId: c.id, rating })) });
const openAs = async (as: Who, id = NADIA, rating = 3) => as.post(`/interviews/${id}/recap/open`, await ratings(rating));
const readAs = (as: Who, id = NADIA) => as.get(`/interviews/${id}/recap`);

describe('opening the recap', () => {
  it('a seat opens it after rating: the ratings are stored once and the recap is written once, with its sources', async () => {
    const res = await openAs(WEN);
    expect(res.status).toBe(200);
    expect(res.body.recap).toMatchObject({ state: 'ready', paused: null });
    expect(res.body.recap.competencies[0].evidence[0].source).toEqual({ kind: 'transcript', seq: 2, quote: 'One engineer kept missing reviews, so I set up a weekly one-to-one and we agreed a plan.' });
    expect((await openAs(WEN, NADIA, 1)).body.recap).toEqual(res.body.recap);
    expect(interviewRecapOpensFixture.rows().filter((o) => o.interviewId === NADIA).map((o) => [o.interviewerId, o.ratings[0]!.rating])).toEqual([['u-wen', 3]]);
    expect(interviewRecapsFixture.rows().filter((r) => r.interviewId === NADIA)).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toMatch(/rating|score|recommend/i);
  });

  it('ratings that do not rate every competency once are 400; before the round has ended it is 409', async () => {
    const some = await ratings();
    expect((await WEN.post(`/interviews/${NADIA}/recap/open`, { ratings: some.ratings.slice(1) })).status).toBe(400);
    expect((await WEN.post(`/interviews/${NADIA}/recap/open`, {})).status).toBe(400);
    for (const i of interviewsFixture.rows()) if (i.id === NADIA) i.state = 'live';
    expect((await openAs(WEN)).status).toBe(409);
    expect(interviewRecapOpensFixture.rows().filter((o) => o.interviewId === NADIA)).toEqual([]);
  });

  it.each([
    ['the recruiter (no ConductInterview)', () => GRETA, NADIA, 403],
    ['the hiring manager (no ConductInterview)', () => AMARA, NADIA, 403],
    ['the admin, no seat', () => OPERATOR, NADIA, 404],
    ['an interviewer of another round', () => HUGO, JONAH, 404],
  ])('%s: refused', async (_l, as, id, status) => {
    expect((await openAs(as(), id)).status).toBe(status);
    expect(interviewRecapsFixture.rows().filter((r) => r.interviewId === id)).toEqual([]);
  });

  it('another tenant\'s role is refused at the mount', async () => {
    expect((await openAs(PRIYA)).status).toBeGreaterThanOrEqual(403);
    expect((await readAs(PRIYA)).status).toBeGreaterThanOrEqual(403);
  });
});

describe('reading the recap', () => {
  it('a seat reads nothing before their own open or scorecard (rate first), then reads it', async () => {
    expect((await readAs(WEN)).status).toBe(404);
    await openAs(WEN);
    expect((await readAs(WEN)).body.recap.state).toBe('ready');
    // Hugo has not opened it and has no scorecard yet: still not found for him.
    expect((await readAs(HUGO)).status).toBe(404);
  });

  it('a seat whose scorecard is in reads it without opening', async () => {
    const kit = await KIT();
    expect((await HUGO.post(`/interviews/${NADIA}/scorecard`, { ratings: kit.map((c) => ({ competencyId: c.id, rating: 2, note: '' })), recommendation: 'yes', summary: 'Fine.', basedOn: 0 })).status).toBe(201);
    expect((await readAs(HUGO)).body.recap.state).toBe('none');
    expect(interviewRecapsFixture.rows().filter((r) => r.interviewId === NADIA)).toEqual([]);
  });

  it('the recruiter, the opening\'s hiring manager and the admin read it once the round has ended, and their read never writes', async () => {
    for (const as of [GRETA, AMARA, OPERATOR]) {
      const res = await readAs(as);
      expect([res.status, res.body.recap?.state]).toEqual([200, 'none']);
    }
    expect(interviewRecapsFixture.rows().filter((r) => r.interviewId === NADIA)).toEqual([]);
    await openAs(WEN);
    for (const as of [GRETA, AMARA, OPERATOR]) expect((await readAs(as)).body.recap.state).toBe('ready');
    for (const i of interviewsFixture.rows()) if (i.id === NADIA) i.state = 'live';
    for (const as of [GRETA, AMARA, OPERATOR]) expect((await readAs(as)).status).toBe(404);
  });

  it('another opening\'s hiring manager and another round\'s interviewer: not found', async () => {
    await openAs(WEN);
    expect((await readAs(OTHER_HM)).status).toBe(404);
    expect((await readAs(HUGO, JONAH)).status).toBe(404);
    expect((await readAs(who('u-third'))).status).toBe(404);
  });

  it('an interviewer of another round of the same candidate follows the scorecards\' rule', async () => {
    // Wen's scorecard for Ingrid's "Working together" is in: she reads the recap of Hugo's coding round too.
    expect((await readAs(WEN, INGRID_CODING)).status).toBe(200);
    expect((await readAs(HUGO, INGRID_TOGETHER)).body.recap.competencies.map((c: { id: string }) => c.id)).toEqual(['communication']);
    // Without her own scorecard in, she reads nothing of the other round.
    const cards = interviewScorecardsFixture.rows();
    cards.splice(cards.findIndex((c) => c.interviewId === INGRID_TOGETHER && c.interviewerId === 'u-wen'), 1);
    expect((await readAs(WEN, INGRID_CODING)).status).toBe(404);
  });
});


// ── The question after the call (contract F1) ───────────────────────────────────────────────────────────────────────
describe('asking Milo from the recap (F1)', () => {
  const FINISHED: TranscriptLineView[] = [
    { seq: 1, at: '2026-11-16T09:01:00.000Z', side: 'panel', speaker: 'Wen Zhao', text: 'Tell me about someone on your team who was struggling. What did you do, and what happened?' },
    { seq: 2, at: '2026-11-16T09:02:00.000Z', side: 'candidate', speaker: 'Nadia Petrova', text: 'One engineer kept missing reviews, so I set up a weekly one-to-one and we agreed a plan.' },
  ];
  let nowMs = Date.parse('2026-11-16T12:00:00.000Z');
  const reserve = jest.fn(async (i: { interviewId: string; key: string }) => ({ ok: true as const, holdId: null, sourceId: `iv:op-em:${i.interviewId}:coach:${i.key}`, amountUsd: 0 }));
  const askAs = (as: Who, question: unknown = 'Where did they talk about the missed reviews?', id = NADIA) => as.post(`/interviews/${id}/recap/ask`, { question });
  const log = () => interviewCoachLogFixture.rows().filter((r) => r.interviewId === NADIA);

  beforeEach(() => {
    setCoachLogStore(null);
    reserve.mockClear();
    nowMs = Date.parse('2026-11-16T12:00:00.000Z');
    useDeps({});
  });
  const useDeps = (over: Parameters<typeof setMiloDeps>[0]) => setMiloDeps({
    model: () => new ScriptedMiloModel(), consents: async () => ({ transcription: true, milo: true }), finished: async () => FINISHED,
    reserve, settle: async () => undefined, release: async () => undefined, now: () => nowMs, ...over,
  });
  afterAll(() => setMiloDeps(null));

  it('a seat that opened the recap gets an answer with its quoted lines; the row names the asker and is after the end', async () => {
    await openAs(HUGO);
    const res = await askAs(HUGO);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refused: null, line: null, paused: null });
    expect(res.body.answer.sources[0]).toEqual({ seq: 2, quote: FINISHED[1]!.text, speaker: 'Nadia Petrova', at: FINISHED[1]!.at });
    expect(log()).toEqual([expect.objectContaining({ kind: 'answer', askedBy: 'u-hugo', code: null, modelId: 'scripted-milo' })]);
    expect(log()[0]!.askedAt >= '2026-11-16T10:00:00.000Z').toBe(true);
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('is counted per person: a second seat asks while the first waits', async () => {
    await openAs(HUGO); await openAs(WEN);
    expect((await askAs(HUGO)).body.answer).not.toBeNull();
    expect((await askAs(HUGO)).body).toMatchObject({ answer: null, refused: 'too-soon' });
    expect((await askAs(WEN)).body.answer).not.toBeNull();
    expect(log().map((r) => r.askedBy)).toEqual(['u-hugo', 'u-wen']);
  });

  it.each([['a seat that has not opened the recap', HUGO], ['the recruiter', GRETA], ['the hiring manager', AMARA], ['the admin', OPERATOR]])('%s: not found, nothing made', async (_l, as) => {
    expect((await askAs(as)).status).toBe(404);
    expect(log()).toHaveLength(0);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('another round\'s interviewer and a guest are not found', async () => {
    await openAs(HUGO);
    expect((await askAs(OTHER_HM)).status).toBe(404);
    expect([403, 404]).toContain((await askAs(who('guest:inv-nadia'))).status);
    expect((await askAs(who('u-third'))).status).toBe(404);
  });

  it('409 before the interview has ended; 400 for a missing or long question; 404 once reviewed', async () => {
    await openAs(HUGO);
    expect((await askAs(HUGO, '')).status).toBe(400);
    expect((await askAs(HUGO, 'x'.repeat(301))).status).toBe(400);
    for (const i of interviewsFixture.rows()) if (i.id === NADIA) i.state = 'live';
    const live = await askAs(HUGO);
    expect(live.status).toBe(409);
    expect(typeof live.body.error).toBe('string');
    for (const i of interviewsFixture.rows()) if (i.id === NADIA) i.state = 'reviewed';
    expect((await askAs(HUGO)).status).toBe(404);
  });

  it('a judgement gets the fixed sentence with no model call and no hold', async () => {
    await openAs(HUGO);
    const model = jest.fn();
    useDeps({ model: () => ({ kind: 'bedrock', modelId: 'x', ask: model }) as never });
    const res = await askAs(HUGO, 'Should we hire her?');
    expect(res.body).toEqual({ answer: null, refused: 'judgement', line: FIXED_ANSWER, paused: null, retryAfterMs: null });
    expect(model).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(log()).toEqual([expect.objectContaining({ code: 'refused-judgement', modelId: 'none', askedBy: 'u-hugo' })]);
  });

  it('an unsourced answer is dropped by code and never stored as text', async () => {
    await openAs(HUGO);
    const send = jest.fn(async () => ({ output: { message: { role: 'assistant', content: [{ text: JSON.stringify({ answer: 'She set up a weekly one-to-one.', sources: [{ seq: 2, quote: 'a daily stand-up with the whole team' }] }) }] } }, usage: { inputTokens: 900, outputTokens: 30 } }));
    useDeps({ model: () => new BedrockMiloModel({ send: send as never, modelId: 'amazon.nova-pro-v1:0' }) });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await askAs(HUGO);
    warn.mockRestore();
    expect(res.body).toMatchObject({ answer: null, refused: 'dropped' });
    expect(log()).toEqual([expect.objectContaining({ answer: '', sources: [], code: 'unsourced' })]);
  });

  it('a paused budget makes no call and no row', async () => {
    await openAs(HUGO);
    useDeps({ reserve: async () => ({ ok: false, reason: 'cap' }) as never });
    expect((await askAs(HUGO)).body).toEqual({ answer: null, refused: null, line: null, paused: 'budget', retryAfterMs: null });
    expect(log()).toHaveLength(0);
  });
});
