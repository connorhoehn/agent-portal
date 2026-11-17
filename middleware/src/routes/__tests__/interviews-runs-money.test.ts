// A run's money through the routes (routes/interviews/runs.ts, routes/interview-invite-runs.ts, routes/interviews/openings.ts
// `GET /openings/:id/spend`; row I4.4, decision 18's `run` part; OWED O-254, lane H8). Money is pinned, never fixed: a wrong
// number here is a finding. The same setup as interviews-runs.test.ts (the real spend door with mock holds, the mock executor).
//
//   after a run           the opening's spend read shows the run's price as spent, and nothing left held
//   the interview's cap   reached: the next run is refused on both sides, each in its own words (the panel's names the cap and
//                         the money; the candidate's names nothing about money), and nothing is stored or held
//   the opening's cap     reached across interviews: the same, with the opening's sentence
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

process.env['SESSION_SIGNING_KEY_DEV'] = 'interviews-runs-money-test-key';

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

const GRETA = staff('u-greta');
const PRICE = 0.0017;
const MONEY = /\$|cap\b|spend|budget|cost|money|pay|dollar/i;
const opening = () => interviewOpeningsFixture.rows().find((o) => o.id === 'op-backend')!;
const spend = async () => (await GRETA.get('/api/interviews/openings/op-backend/spend')).body.spend as { spentUsd: number; heldUsd: number; leftUsd: number | null; capUsd: number | null };

it('after a run the opening\'s spend read shows the run\'s price as spent, and nothing left held', async () => {
  const before = await spend();
  expect((await HUGO.post(`${API}/${IV}/runs`, runBody())).status).toBe(202);
  await runsSettled(IV);
  const after = await spend();
  expect(Math.round((after.spentUsd - before.spentUsd) * 10_000) / 10_000).toBe(PRICE);
  expect(after.heldUsd).toBe(before.heldUsd);
  expect(after.leftUsd).toBe(Math.round((after.capUsd! - after.spentUsd - after.heldUsd) * 10_000) / 10_000);
});

it('the interview\'s cap reached: the next run is refused on both sides in their own words; nothing stored or held', async () => {
  opening().interviewCapUsd = PRICE; // room for exactly one run (reaching a cap exactly is allowed)
  const cookie = await guestOf();
  expect((await HUGO.post(`${API}/${IV}/runs`, runBody())).status).toBe(202);
  await runsSettled(IV);
  const holds = spendHolds.rows().length;
  const panel = await WEN.post(`${API}/${IV}/runs`, runBody());
  const cand = await guest(cookie).post(G, runBody());
  expect([panel.status, cand.status]).toEqual([402, 402]);
  expect(panel.body.error).toMatch(/^This interview has reached its spending cap of \$/);
  expect(cand.body.error).toBe('Runs are not available for this interview.');
  expect(cand.body.error).not.toMatch(MONEY);
  expect((await HUGO.get(`${API}/${IV}/runs`)).body.runs).toHaveLength(1);
  expect(spendHolds.rows().length).toBe(holds);
});

it('the opening\'s cap reached across its interviews: refused on both sides, the panel reads the opening\'s sentence', async () => {
  const cookie = await guestOf();
  const now = await spend();
  opening().budgetCapUsd = Math.round((now.spentUsd + now.heldUsd) * 10_000) / 10_000; // nothing left
  const panel = await HUGO.post(`${API}/${IV}/runs`, runBody());
  const cand = await guest(cookie).post(G, runBody());
  expect([panel.status, cand.status]).toEqual([402, 402]);
  expect(panel.body.error).toMatch(/^This opening has reached its spending cap/);
  expect(cand.body.error).toBe('Runs are not available for this interview.');
  expect((await HUGO.get(`${API}/${IV}/runs`)).body.runs).toEqual([]);
});
