// The runs' event stream and its races (routes/interviews/runs.ts, routes/interview-invite-runs.ts; row I4.4; OWED O-253 and
// O-255, lane H8). Mounted as interviews-runs.test.ts mounts them (the same setup: the REAL Cedar roles, the real spend door with
// mock holds, the memory run store, the mock executor at a hundredth of its pauses). Every run goes to the mock executor.
//
//   O-253  the stream closes for a candidate turned away mid-run, for one whose link is revoked mid-run, and for a panel
//          member taken off the panel
//   O-255  the same runId started from both sides at once is one run and one hold; a run the lead's end overtakes ends in
//          one state and is paid once (the end does not stop it: pinned)
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

process.env['SESSION_SIGNING_KEY_DEV'] = 'interviews-runs-stream-test-key';

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

let server: Server;
let base = '';
beforeAll(async () => { server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(async () => { await new Promise((r) => server.close(r)); });

interface Frame { id: string; data: { runId: string; seq: number; stream: string; data: string } }
/** Read a stream until it ends or `ms` passes; `ended` is true only when the server closed it. */
async function read(path: string, headers: Record<string, string>, ms = 3000): Promise<{ frames: Frame[]; ended: boolean; status: number }> {
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
    }
  } catch { /* aborted: still open */ } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return { frames, ended, status: res.status };
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A run that would wait until its wall time (10 s; the fast executor does not shorten the service's own limit).
const slow = () => runBody({ files: [{ path: 'main.py', content: 'print("waiting")\n# mock:timeout\n' }] });

describe('O-253: the stream closes for someone who may no longer read it', () => {
  beforeEach(() => setRunStreamTiming({ checkMs: 20 }));

  it('a candidate turned away mid-run: the stream closes; the run goes on for the panel', async () => {
    const cookie = await guestOf();
    const reading = read(`${G}/events`, { cookie });
    await pause(50);
    const started = await HUGO.post(`${API}/${IV}/runs`, slow());
    expect(started.status).toBe(202);
    await pause(80);
    Object.assign(interviewInvitesFixture.rows().find((i) => i.interviewId === IV && i.sessionHash)!, { admissionState: 'turned-away' });
    const got = await reading;
    expect(got.ended).toBe(true);
    expect((await guest(cookie).get(G)).status).toBe(404);
    expect((await HUGO.get(`${API}/${IV}/runs/${started.body.run.runId}`)).body.run.status).not.toBe('cancelled');
    await HUGO.post(`${API}/${IV}/runs/${started.body.run.runId}/cancel`);
    await runsSettled(IV);
  });

  it('a link revoked mid-run: the stream closes and every guest read is the not-found', async () => {
    const cookie = await guestOf();
    const reading = read(`${G}/events`, { cookie });
    await pause(50);
    const started = await HUGO.post(`${API}/${IV}/runs`, slow());
    await pause(80);
    expect((await request(app).delete(`${API}/${IV}/invite`).set('x-user', 'u-greta')).status).toBeLessThan(300);
    const got = await reading;
    expect(got.ended).toBe(true);
    expect((await guest(cookie).post(G, runBody())).status).toBe(404);
    await HUGO.post(`${API}/${IV}/runs/${started.body.run.runId}/cancel`);
    await runsSettled(IV);
  });

  it('a panel member taken off the panel: their stream closes, the lead\'s stays open', async () => {
    const wen = read(`${API}/${IV}/runs/events`, { 'x-user': 'u-wen' });
    const hugo = read(`${API}/${IV}/runs/events`, { 'x-user': 'u-hugo' }, 1200);
    await pause(50);
    const started = await HUGO.post(`${API}/${IV}/runs`, slow());
    await pause(80);
    interviewsFixture.rows().find((i) => i.id === IV)!.panelIds = [];
    const [w, h] = await Promise.all([wen, hugo]);
    expect(w.ended).toBe(true);
    expect(h.ended).toBe(false);
    expect((await WEN.get(`${API}/${IV}/runs`)).status).toBe(404);
    await HUGO.post(`${API}/${IV}/runs/${started.body.run.runId}/cancel`);
    await runsSettled(IV);
  });
});

describe('O-255: races', () => {
  const holdsOf = (runId: string) => spendHolds.rows().filter((h) => String(h.sourceId ?? '').includes(runId));
  const entriesOf = (runId: string) => spendEntries.rows().filter((e) => String((e as { sourceId?: string | null }).sourceId ?? '').includes(runId));

  it('the same runId started from both sides at once is one run, one hold and one charge', async () => {
    const cookie = await guestOf();
    const body = runBody();
    const [a, b] = await Promise.all([HUGO.post(`${API}/${IV}/runs`, body), guest(cookie).post(G, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    await runsSettled(IV);
    const list = (await HUGO.get(`${API}/${IV}/runs`)).body.runs;
    expect(list).toHaveLength(1);
    expect(holdsOf(body.runId)).toHaveLength(1);
    expect(entriesOf(body.runId).map((e) => e.costUsd)).toEqual([0.0017]);
  });

  it('a run the lead\'s end overtakes ends in one state and is paid once (pinned: the end does not cancel it)', async () => {
    const body = runBody({ files: [{ path: 'main.py', content: 'print("a")\nprint("b")\nprint("c")\n' }] });
    expect((await HUGO.post(`${API}/${IV}/runs`, body)).status).toBe(202);
    state(IV, 'ended');
    await runsSettled(IV);
    const run = interviewRunsFixture.rows().find((r) => r.interviewId === IV && r.runId === body.runId)!;
    expect(run.status).toBe('succeeded');
    expect(run.events.filter((e) => e.stream === 'status' && ['succeeded', 'failed', 'cancelled', 'timed_out', 'internal_error'].includes(e.data))).toHaveLength(1);
    expect(holdsOf(body.runId)).toHaveLength(1);
    expect(entriesOf(body.runId).map((e) => e.costUsd)).toEqual([0.0017]);
    // Neither side can touch it once the interview has ended.
    expect((await HUGO.post(`${API}/${IV}/runs/${body.runId}/cancel`)).status).toBe(404);
  });
});
