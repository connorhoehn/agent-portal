// Runs of the code pad from both sides (routes/interviews/runs.ts, routes/interview-invite-runs.ts; row I4.4, contract
// U4), mounted as index.ts mounts them, with ConductInterview decided from the REAL seeds/roles/*/*.cedar files, the real
// spend door (mock holds), the real memory run store, and the mock executor at a hundredth of its pauses.
//
//   panel side   a seat (lead or panel) with ConductInterview, on a live technical round; everyone else 404
//   guest side   the admitted guest of that interview while it is live; anything else the guest's one 404
//   both         start (202, a repeat 200, 400, 402, 429), list, one, cancel by either person, the event stream
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
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

process.env['SESSION_SIGNING_KEY_DEV'] = 'interviews-runs-test-key';

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { GUEST_COOKIE_NAME, sessionMiddleware, type Session } from '../../lib/session.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { interviewInviteRouter, resetInviteThrottle } from '../interview-invite.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { interviewOpeningsFixture, interviewsFixture } from '../../mock/interviews.js';
import { interviewInvitesFixture } from '../../mock/interviews-invites.js';
import { interviewRunsFixture } from '../../mock/interviews-runs.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { createMockExecutor } from '../../lib/interviews/runs/mock-executor.js';
import { runsSettled, setRunDeps, type RunRecord } from '../../lib/interviews/runs/index.js';
import { setRunStreamTiming } from '../interviews/runs.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
  u('u-amara', 'Amara Okafor', { interviews: ['hiring-manager'] }),
  u('u-root', 'Root Admin', { interviews: ['admin'] }),
  u('u-priya', 'Priya Venkataraman', { access: ['access-admin'] }),
];

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(sessionMiddleware());
app.use((req, _res, next) => {
  const me = USERS.find((x) => x.id === String(req.headers['x-user'] ?? ''));
  if (me) {
    const tenant = Object.keys(me.grants)[0]!;
    req.session = { sub: me.id, name: me.displayName, tenant, role: me.grants[tenant]![0], grants: me.grants, iat: 0, epoch: 0 } as Session;
    req.sessionInvalid = false;
    req.sessionSource = 'cookie'; // a signed-in staff session, as a verified cookie makes it
  }
  next();
});
app.use('/api/interview-invite', interviewInviteRouter);
app.use('/api/interviews', requireTenant('interviews'), interviewsFlagGate, interviewsRouter);
app.use(errorHandler);

// Hugo leads Mateo's design round (technical, op-backend); made live here, with Wen added to its panel. Wen leads
// Nadia's leadership round (behavioural); Aiko's coding round is Wen's and stays `ready`.
const IV = 'iv-k1p5w8ra';
const BEHAVIOURAL = 'iv-n5z9f2cq';
const OTHER = 'iv-c3k8w2ma';
const API = '/api/interviews/interviews';
const G = '/api/interview-invite/runs';

const staff = (user: string) => ({
  get: (p: string) => request(app).get(p).set('x-user', user),
  post: (p: string, body: unknown = {}) => request(app).post(p).set('x-user', user).send(body as object),
});
const HUGO = staff('u-hugo');
const WEN = staff('u-wen');

function guestCookie(res: { headers: Record<string, unknown> }): string {
  const set = ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? []);
  const line = set.find((c) => c.startsWith(`${GUEST_COOKIE_NAME}=`));
  if (!line) throw new Error('no guest cookie was set');
  return line.split(';')[0]!;
}
async function guestOf(id = IV, admitted = true): Promise<string> {
  const issued = await request(app).post(`${API}/${id}/invite`).set('x-user', 'u-greta').send({});
  expect(issued.status).toBe(201);
  const token = String(issued.body.linkPath).split('#')[1]!;
  const cookie = guestCookie(await request(app).post('/api/interview-invite/exchange').send({ token }));
  if (admitted) {
    const invite = interviewInvitesFixture.rows().find((i) => i.interviewId === id && i.sessionHash)!;
    Object.assign(invite, { admissionState: 'admitted', knockedAt: new Date().toISOString(), admissionDecidedAt: new Date().toISOString() });
  }
  return cookie;
}
const guest = (cookie: string) => ({
  get: (p: string) => request(app).get(p).set('Cookie', cookie),
  post: (p: string, body: unknown = {}) => request(app).post(p).set('Cookie', cookie).send(body as object),
});

const state = (id: string, s: string) => { interviewsFixture.rows().find((i) => i.id === id)!.state = s as never; };
let k = 0;
const runBody = (over: Record<string, unknown> = {}) => ({
  runId: `run-${String(++k).padStart(5, '0')}`, language: 'python', entrypoint: 'main.py',
  files: [{ path: 'main.py', content: 'print("hello")\nprint("world")\n' }], ...over,
});
const fast = () => createMockExecutor({ wait: (ms) => new Promise((r) => setTimeout(r, ms / 100)) });

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  spendHolds.reset();
  spendEntries.reset();
  resetInviteThrottle();
  setRunDeps({ executor: fast });
  setRunStreamTiming(null);
  state(IV, 'live');
  interviewsFixture.rows().find((i) => i.id === IV)!.panelIds = ['u-wen'];
  k = 0;
});
afterAll(() => { setRunDeps(null); setRunStreamTiming(null); });

describe('the panel side', () => {
  it('the lead starts a run (202, queued), it runs on the mock, and the panel reads it', async () => {
    const res = await HUGO.post(`${API}/${IV}/runs`, runBody());
    expect(res.status).toBe(202);
    expect(res.body.run).toMatchObject({ runId: 'run-00001', language: 'python', status: 'queued', startedBy: { id: 'u-hugo', name: 'Hugo Marchetti', side: 'panel' }, result: null });
    await runsSettled(IV);
    const one = await WEN.get(`${API}/${IV}/runs/run-00001`);
    expect(one.status).toBe(200);
    expect(one.body.run).toMatchObject({ status: 'succeeded', result: { exitCode: 0, stdout: 'hello\nworld\n', backend: 'mock', runtimeVersion: 'Python 3.12.7' } });
    expect(Object.keys(one.body.run).sort()).toEqual(['endedAt', 'language', 'queuedAt', 'result', 'runId', 'startedAt', 'startedBy', 'status']);
    // The money: held, then settled at the run's price, on the interviews source.
    expect(spendEntries.rows().filter((e) => e.trigger === 'interviews:run').map((e) => e.costUsd)).toEqual([0.0017]);
  });

  it('a repeat of the runId is 200 with the first run; another run waits as queued; the list is newest first', async () => {
    const b = runBody({ files: [{ path: 'main.py', content: '# mock:timeout\nprint("x")' }] });
    expect((await HUGO.post(`${API}/${IV}/runs`, b)).status).toBe(202);
    const again = await WEN.post(`${API}/${IV}/runs`, { ...b, language: 'go' });
    expect(again.status).toBe(200);
    expect(again.body.run).toMatchObject({ runId: b.runId, language: 'python' });
    const second = await WEN.post(`${API}/${IV}/runs`, runBody());
    expect(second.body.run.status).toBe('queued');
    const list = await HUGO.get(`${API}/${IV}/runs`);
    expect(list.body.runs.map((r: { runId: string }) => r.runId)).toEqual(['run-00002', 'run-00001']);
    expect((await HUGO.get(`${API}/${IV}/runs/run-00002`)).body.run.status).toBe('queued');
    await runsSettled(IV);
  });

  it('either person may cancel any run of the interview; the candidate cancels the lead\'s', async () => {
    const cookie = await guestOf();
    await HUGO.post(`${API}/${IV}/runs`, runBody({ files: [{ path: 'main.py', content: '# mock:timeout' }] }));
    await HUGO.post(`${API}/${IV}/runs`, runBody());
    const byGuest = await guest(cookie).post(`${G}/run-00002/cancel`);
    expect(byGuest.status).toBe(200);
    expect(byGuest.body.run).toMatchObject({ status: 'cancelled', startedBy: { id: 'panel', name: 'Interviewer', side: 'panel' } });
    const byPanel = await WEN.post(`${API}/${IV}/runs/run-00001/cancel`);
    expect(byPanel.status).toBe(200);
    expect(['cancelled', 'timed_out']).toContain(byPanel.body.run.status);
    expect((await WEN.post(`${API}/${IV}/runs/run-none-here/cancel`)).status).toBe(404);
  });

  it('refuses a body it cannot run with a sentence, and never takes limits from it', async () => {
    const bad = async (over: Record<string, unknown>) => { const r = await HUGO.post(`${API}/${IV}/runs`, runBody(over)); return [r.status, r.body.error]; };
    expect(await bad({ language: 'rust' })).toEqual([400, expect.stringMatching(/^Choose one of the languages/)]);
    expect(await bad({ files: Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.py`, content: '' })) })).toEqual([400, 'A run takes one to 8 files.']);
    expect(await bad({ files: [{ path: '../x.py', content: '' }], entrypoint: '../x.py' })).toEqual([400, expect.stringMatching(/plain relative names/)]);
    expect(await bad({ files: [{ path: '/x.py', content: '' }], entrypoint: '/x.py' })).toEqual([400, expect.stringMatching(/plain relative names/)]);
    expect(await bad({ files: [{ path: 'main.py', content: 'x'.repeat(64 * 1024 + 1) }] })).toEqual([400, expect.stringMatching(/64 KB/)]);
    expect(await bad({ entrypoint: 'other.py' })).toEqual([400, 'Say which of the files to run.']);
    expect(await bad({ runId: 'x' })).toEqual([400, expect.stringMatching(/own id/)]);
    const ok = await HUGO.post(`${API}/${IV}/runs`, runBody({ limits: { wallMs: 999_999, maxOutputBytes: 1e9 } }));
    expect(ok.status).toBe(202);
    await runsSettled(IV);
  });

  it('the 61st run of an interview is 429 with a sentence', async () => {
    for (let i = 0; i < 60; i++) {
      interviewRunsFixture.rows().push({
        interviewId: IV, runId: `old-run-${i}`, language: 'python', entrypoint: 'main.py', files: [], source: [], stdin: null,
        startedBy: { id: 'u-hugo', name: 'Hugo Marchetti', side: 'panel' }, status: 'cancelled', queuedAt: new Date(Date.UTC(2026, 10, 17, 13, 0, i)).toISOString(),
        startedAt: null, endedAt: new Date().toISOString(), result: null, events: [], holdId: null, spendSourceId: null,
      } as RunRecord);
    }
    const res = await HUGO.post(`${API}/${IV}/runs`, runBody());
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'This interview has used all 60 of its runs, so no more can be started.' });
  });

  it('an opening with no cap runs nothing: 402 with the plain sentence, and nothing stored', async () => {
    interviewOpeningsFixture.rows().find((o) => o.id === 'op-backend')!.budgetCapUsd = null;
    const res = await HUGO.post(`${API}/${IV}/runs`, runBody());
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ error: expect.stringMatching(/no spending cap yet, so nothing that costs money can start/) });
    expect(interviewRunsFixture.rows()).toHaveLength(interviewRunsFixture.rows('default').length);
  });

  it('everyone else gets the one not-found, whatever the reason', async () => {
    const nf = async (who: ReturnType<typeof staff>, id: string) => {
      const s = [(await who.post(`${API}/${id}/runs`, runBody())).status, (await who.get(`${API}/${id}/runs`)).status,
        (await who.get(`${API}/${id}/runs/run-x0000`)).status, (await who.post(`${API}/${id}/runs/run-x0000/cancel`)).status,
        (await who.get(`${API}/${id}/runs/events`)).status];
      return s;
    };
    expect(await nf(staff('u-greta'), IV)).toEqual([404, 404, 404, 404, 404]);
    expect(await nf(staff('u-amara'), IV)).toEqual([404, 404, 404, 404, 404]);
    expect(await nf(staff('u-root'), IV)).toEqual([404, 404, 404, 404, 404]);
    state(BEHAVIOURAL, 'live');
    expect(await nf(WEN, BEHAVIOURAL)).toEqual([404, 404, 404, 404, 404]);
    expect(await nf(HUGO, OTHER)).toEqual([404, 404, 404, 404, 404]);
    state(IV, 'ready');
    expect(await nf(HUGO, IV)).toEqual([404, 404, 404, 404, 404]);
    state(IV, 'ended');
    expect(await nf(HUGO, IV)).toEqual([404, 404, 404, 404, 404]);
    expect((await staff('u-priya').get(`${API}/${IV}/runs`)).status).toBe(403);
    expect(interviewRunsFixture.rows()).toHaveLength(interviewRunsFixture.rows('default').length);
  });

  it('/interviews/:id/runs is the runs list, not the interview read', async () => {
    const res = await HUGO.get(`${API}/${IV}/runs`);
    expect(Object.keys(res.body)).toEqual(['runs', 'runner']);
    expect(res.body.runner).toEqual({ kind: 'simulated' });
  });

  it('a guest cookie is no session on the panel\'s routes', async () => {
    const cookie = await guestOf();
    expect((await guest(cookie).get(`${API}/${IV}/runs`)).status).toBe(401);
    expect((await guest(cookie).post(`${API}/${IV}/runs`, runBody())).status).toBe(401);
  });
});

describe('the guest side', () => {
  it('the admitted candidate starts a run in its live technical round and reads it; no panel member is named', async () => {
    const cookie = await guestOf();
    await HUGO.post(`${API}/${IV}/runs`, runBody());
    const res = await guest(cookie).post(G, runBody({ language: 'go', entrypoint: 'main.go', files: [{ path: 'main.go', content: 'package main\nimport "fmt"\nfunc main() { fmt.Println("hi") }\n' }] }));
    expect(res.status).toBe(202);
    expect(res.body.run).toMatchObject({ runId: 'run-00002', status: 'queued', startedBy: { name: 'Candidate', side: 'candidate' } });
    await runsSettled(IV);
    const list = await guest(cookie).get(G);
    expect(list.body.runs.map((r: { startedBy: { name: string } }) => r.startedBy.name)).toEqual(['Candidate', 'Interviewer']);
    expect(JSON.stringify(list.body)).not.toContain('Hugo');
    const one = await guest(cookie).get(`${G}/run-00002`);
    expect(one.body.run.result).toMatchObject({ status: 'succeeded', stdout: 'hi\n', runtimeVersion: 'Go 1.23.3' });
    // The panel sees the candidate's run as the candidate's.
    expect((await HUGO.get(`${API}/${IV}/runs/run-00002`)).body.run.startedBy).toMatchObject({ name: 'Candidate', side: 'candidate' });
  });

  it('a refused hold reads plainly and says nothing about money', async () => {
    const cookie = await guestOf();
    interviewOpeningsFixture.rows().find((o) => o.id === 'op-backend')!.budgetCapUsd = null;
    const res = await guest(cookie).post(G, runBody());
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ error: 'Runs are not available for this interview.' });
  });

  it('not admitted, not live, a behavioural round, no cookie: the guest\'s one not-found', async () => {
    const all = async (cookie: string) => [
      (await guest(cookie).post(G, runBody())).status, (await guest(cookie).get(G)).status, (await guest(cookie).get(`${G}/events`)).status,
      (await guest(cookie).get(`${G}/run-x0000`)).status, (await guest(cookie).post(`${G}/run-x0000/cancel`)).status,
    ];
    const waiting = await guestOf(IV, false);
    expect(await all(waiting)).toEqual([404, 404, 404, 404, 404]);
    expect((await guest(waiting).get(G)).body).toEqual({ error: 'This link no longer works.' });
    const admitted = await guestOf(IV, true);
    state(IV, 'ready');
    expect(await all(admitted)).toEqual([404, 404, 404, 404, 404]);
    state(BEHAVIOURAL, 'live');
    const behavioural = await guestOf(BEHAVIOURAL, true);
    expect(await all(behavioural)).toEqual([404, 404, 404, 404, 404]);
    expect(await all('')).toEqual([404, 404, 404, 404, 404]);
    expect(await all(`${GUEST_COOKIE_NAME}=forged`)).toEqual([404, 404, 404, 404, 404]);
  });

  it('a guest reads only its own interview\'s runs: another interview\'s run id is not found', async () => {
    state(OTHER, 'live');
    await WEN.post(`${API}/${OTHER}/runs`, runBody());
    await runsSettled(OTHER);
    const cookie = await guestOf();
    expect((await guest(cookie).get(`${G}/run-00001`)).status).toBe(404);
    expect((await guest(cookie).get(G)).body).toEqual({ runs: [], runner: { kind: 'simulated' } });
  });

  it('with the flag off every guest route is the ordinary not-found', async () => {
    const cookie = await guestOf();
    process.env['INTERVIEWS_ENABLED'] = 'false';
    expect((await guest(cookie).get(G)).status).toBe(404);
    delete process.env['INTERVIEWS_ENABLED'];
  });
});

describe('the event stream (both people see one run)', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => { server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
  afterAll(async () => { await new Promise((r) => server.close(r)); });

  interface Frame { id: string; data: { runId: string; seq: number; stream: string; data: string; at: string } }
  /** Read the stream until `until` holds or it ends; then stop reading. */
  async function read(path: string, headers: Record<string, string>, until: (f: Frame[]) => boolean, ms = 4000): Promise<{ frames: Frame[]; ended: boolean; status: number; type: string | null }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    const res = await fetch(`${base}${path}`, { headers, signal: ctl.signal });
    const frames: Frame[] = [];
    let ended = false;
    let buf = '';
    try {
      const reader = res.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { ended = true; break; }
        buf += new TextDecoder().decode(value);
        let at: number;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const id = /^id: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (id && data) frames.push({ id, data: JSON.parse(data) });
        }
        if (until(frames)) break;
      }
    } catch { /* aborted */ } finally {
      clearTimeout(timer);
      ctl.abort();
    }
    return { frames, ended, status: res.status, type: res.headers.get('content-type') };
  }

  it('the panel and the candidate read the same events, in order, ids <runId>:<seq>; a reconnect resumes after Last-Event-ID', async () => {
    const cookie = await guestOf();
    await HUGO.post(`${API}/${IV}/runs`, runBody({ language: 'java', entrypoint: 'Main.java', files: [{ path: 'Main.java', content: 'class Main { public static void main(String[] a) { System.out.println("hello"); } }' }] }));
    await runsSettled(IV);
    const done = (f: Frame[]) => f.some((x) => x.data.stream === 'status' && x.data.data === 'succeeded');
    const panel = await read(`${API}/${IV}/runs/events`, { 'x-user': 'u-hugo' }, done);
    const cand = await read(`${G}/events`, { cookie }, done);
    expect(panel.type).toMatch(/text\/event-stream/);
    const lines = (r: { frames: Frame[] }) => r.frames.map((f) => `${f.id} ${f.data.stream} ${JSON.stringify(f.data.data)}`);
    expect(lines(panel)).toEqual([
      'run-00001:1 status "queued"', 'run-00001:2 status "compiling"', 'run-00001:3 status "running"', 'run-00001:4 stdout "hello\\n"', 'run-00001:5 status "succeeded"',
    ]);
    expect(lines(cand)).toEqual(lines(panel));
    const resumed = await read(`${API}/${IV}/runs/events`, { 'x-user': 'u-wen', 'last-event-id': 'run-00001:3' }, done);
    expect(resumed.frames.map((f) => f.id)).toEqual(['run-00001:4', 'run-00001:5']);
    const byQuery = await read(`${G}/events?lastEventId=run-00001:4`, { cookie }, done);
    expect(byQuery.frames.map((f) => f.id)).toEqual(['run-00001:5']);
  });

  it('a live reader gets a run as it happens, and the stream closes when the interview ends', async () => {
    setRunStreamTiming({ checkMs: 20 });
    const cookie = await guestOf();
    const reading = read(`${G}/events`, { cookie }, () => false, 3000);
    await new Promise((r) => setTimeout(r, 50));
    await HUGO.post(`${API}/${IV}/runs`, runBody());
    await runsSettled(IV);
    await new Promise((r) => setTimeout(r, 50));
    state(IV, 'ended');
    const got = await reading;
    expect(got.ended).toBe(true);
    expect(got.frames.filter((f) => f.data.stream === 'status').map((f) => f.data.data)).toEqual(['queued', 'running', 'succeeded']);
    expect(got.frames.filter((f) => f.data.stream === 'stdout').map((f) => f.data.data).join('')).toBe('hello\nworld\n');
  });

  it('the panel\'s stream closes when the interview ends too', async () => {
    setRunStreamTiming({ checkMs: 20 });
    const reading = read(`${API}/${IV}/runs/events`, { 'x-user': 'u-wen' }, () => false, 3000);
    await new Promise((r) => setTimeout(r, 50));
    state(IV, 'ended');
    expect((await reading).ended).toBe(true);
  });
});

// The round that is live now (mock/interviews.ts LIVE_INTERVIEW_ID): Kwame's coding round with Hugo leading and Wen on the panel.
describe('the seeded round that is live now', () => {
  const LIVE = 'iv-s4e8u2zk';

  it('its two earlier runs read to both seats: the first failed with exit code 1, the second passed', async () => {
    for (const seat of [HUGO, WEN]) {
      const list = await seat.get(`${API}/${LIVE}/runs`);
      expect(list.status).toBe(200);
      expect(list.body.runs.map((r: { runId: string }) => r.runId)).toEqual(['run-kwame-02', 'run-kwame-01']);
    }
    const first = (await HUGO.get(`${API}/${LIVE}/runs/run-kwame-01`)).body.run;
    expect(first).toMatchObject({ status: 'failed', result: { exitCode: 1 } });
    expect(first.result.stderr).toContain('AssertionError');
    expect((await HUGO.get(`${API}/${LIVE}/runs/run-kwame-02`)).body.run).toMatchObject({ status: 'succeeded', result: { exitCode: 0 } });
  });
});
