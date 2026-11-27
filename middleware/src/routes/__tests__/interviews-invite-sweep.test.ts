// The test that starts from a guest (docs/interviews-tenant-plan.md row I2.1's bar, and the seed of E2).
//
// It boots the real server (src/index.ts under dev:mock's settings, on a free port of its own), makes a link as
// the recruiter, opens it as a guest, and then walks EVERY route the server mounts, read from the routers
// themselves (mock/core/wire/routes.ts enumerateRoutes, the inventory the wire snapshots and the route-coverage
// ratchet use), with only the guest's cookie. Each path parameter is filled with the guest's OWN interview id,
// the most tempting value there is, and the interviews routes are walked a second time with ANOTHER interview's.
//
// Every route must refuse the guest (a 4xx or 5xx) except the guest's own routes that answer before admission
// (GUEST_ROUTES: the exchange, its interview, its realtime token, the knock and its admission, CONSENT's two consents
// routes, and its room) and a public route, which is allowed only when it answers the guest exactly what it answers a
// caller whose credential was rejected (same status, same body): the guest gains nothing by being a guest. The guest's
// routes that need the lead's admission (GUEST_ADMITTED_ROUTES) are swept too, and refuse a guest not let in.
// Lane H6 (row E2) adds: the router's guest routes must be exactly the two sets named here (a route added later fails
// the sweep until it is named); each guest route refuses no cookie, a staff session and a guest not admitted, and an
// admitted guest of one live interview reaches nothing of another; the routes rounds 3 to 6 added are named and refused;
// and the reverse, a Work-only person and a caller holding only a guest cookie on every interviews route.
// The answer key (lib/interviews/answer-key.ts): an admitted guest of a live system design round on "Design Twitter" walks
// every GET route the server mounts and Milo's request, and no answer has a word of the provided design, an answer or a
// red flag; the lead's room has them (so the check can fail), and only the lead may reveal the provided design.
// The server runs with Milo on (MEETING_ASSISTANT_ENABLED, as the walk runs it), so Milo's call routes are judged by
// their gates, not by the feature flag's 404.
// Writes to the mock control routes (/api/__mock/*: reset, scenarios, the clock) are not sent: they would
// reset the very world the guest stands in. Then: a staff session against the guest routes, and the guest
// after the recruiter revokes the link. Expiry and the flag are in interviews-invite.test.ts (they need the
// clock and the environment of a process this test does not own).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { enumerateRoutes } from '../../mock/core/wire/routes.js';
import { TWITTER_QUESTIONS, TWITTER_RED_FLAGS } from '../../mock/interviews-design-twitter.js';

const ROOT = join(__dirname, '..', '..', '..');
const OWN = 'iv-k1p5w8ra';
const OTHER = 'iv-c3k8w2ma';
const GUEST_ROUTES = new Set([
  'POST /api/interview-invite/exchange',
  'GET /api/interview-invite/interview',
  'GET /api/interview-invite/realtime-token',
  'POST /api/interview-invite/knock',
  'POST /api/interview-invite/cant-make',
  'GET /api/interview-invite/admission',
  'GET /api/interview-invite/consents',
  'PUT /api/interview-invite/consents',
  'GET /api/interview-invite/room',
]);
/** The guest's routes that answer only once the lead has let the guest in (and, for most, while the interview is live). */
const GUEST_ADMITTED_ROUTES = new Set([
  'POST /api/interview-invite/pad/events',
  'POST /api/interview-invite/runs',
  'GET /api/interview-invite/runs',
  'GET /api/interview-invite/runs/events',
  'GET /api/interview-invite/runs/:runId',
  'POST /api/interview-invite/runs/:runId/cancel',
  'POST /api/interview-invite/milo/request',
  'GET /api/interview-invite/milo/floor',
  'POST /api/interview-invite/milo/hold/:action',
  'POST /api/interview-invite/media/participant',
  'GET /api/interview-invite/calls/:callId/chat/reads',
  'PUT /api/interview-invite/calls/:callId/chat/reads',
  'GET /api/interview-invite/captions',
]);

/** The routes rounds 3 to 6 added (OWED O-184), as the routers name them. */
const ROUNDS_3_TO_6 = [
  'GET /api/interviews/interviews/:id/transcript', 'GET /api/interviews/interviews/:id/milo-notes', 'POST /api/interviews/interviews/:id/milo-ask',
  'GET /api/interviews/interviews/:id/recap', 'POST /api/interviews/interviews/:id/recap/open', 'POST /api/interviews/interviews/:id/recap/ask',
  'POST /api/interviews/interviews/:id/plan-draft', 'GET /api/interviews/interviews/:id/record', 'GET /api/interviews/interviews/:id/consents',
  'GET /api/interviews/candidates/:id/consents', 'GET /api/interviews/interviews/:id/milo-export', 'GET /api/interviews/candidates/:id/debrief',
  'POST /api/interviews/applications/:id/stage', 'POST /api/interviews/candidates/:id/deletion', 'GET /api/interviews/candidates/:id/deletions',
  'GET /api/interviews/interviews/:id/suggestion', 'POST /api/interviews/interviews/:id/suggestion/:suggestionId/answer',
];

/** dev:mock's environment, read from package.json as the journeys read it. */
function devMockEnv(): Record<string, string> {
  const script = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts['dev:mock'] as string;
  const env: Record<string, string> = {};
  for (const tok of script.split(/\s+/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(tok);
    if (!m) break;
    env[m[1]!] = m[2]!;
  }
  return env;
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

let child: ChildProcess | null = null;
let base = '';
let log = '';

async function up(deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) return false;
    try { if ((await fetch(`${base}/api/health`)).status < 500) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(ROOT, 'node_modules', '.bin', 'tsx'), 'src/index.ts'], {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...devMockEnv(), PORT: String(port), MOCK_PERSIST_PAIRINGS: '0', MOCK_VOICE: '1', MEETING_ASSISTANT_ENABLED: 'true', VOICE_LOG_DIR: mkdtempSync(join(tmpdir(), 'guest-sweep-voice-')), JEST_WORKER_ID: '' },
  });
  child.stdout?.on('data', (d: Buffer) => { log = (log + d.toString()).slice(-4000); });
  child.stderr?.on('data', (d: Buffer) => { log = (log + d.toString()).slice(-4000); });
  if (!(await up(120_000))) throw new Error(`the server did not come up: ${log.slice(-1500)}`);
}, 150_000);

afterAll(() => {
  if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }
});

type Answer = { status: number; body: string };
async function call(method: string, path: string, cookie: string | null, body?: unknown): Promise<Answer> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers['cookie'] = cookie;
  const res = await fetch(`${base}${path}`, {
    method, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  return { status: res.status, body: await res.text().catch(() => '') };
}
const cookieOf = (res: Response, name: string): string => {
  // The last one set with a value: an answer may clear the cookie before it sets the new one.
  const line = res.headers.getSetCookie().filter((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`)).pop();
  if (!line) throw new Error(`no ${name} cookie`);
  return line.split(';')[0]!;
};

describe('a guest against every route the server mounts', () => {
  let staff = '';
  let guest = '';

  beforeAll(async () => {
    expect((await fetch(`${base}/api/__mock/reset`, { method: 'POST' })).status).toBe(200);
    const login = await fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'u-greta' }) });
    expect(login.status).toBe(200);
    staff = cookieOf(login, 'orgiq.session');
    const made = await fetch(`${base}/api/interviews/interviews/${OWN}/invite`, { method: 'POST', headers: { cookie: staff, 'content-type': 'application/json' }, body: '{}' });
    expect(made.status).toBe(201);
    const token = String(((await made.json()) as { linkPath: string }).linkPath).split('#')[1];
    const opened = await fetch(`${base}/api/interview-invite/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    expect(opened.status).toBe(200);
    guest = cookieOf(opened, 'interviews.guest');
  }, 60_000);

  afterAll(async () => { await fetch(`${base}/api/__mock/reset`, { method: 'POST' }).catch(() => undefined); });

  it('refuses the guest everywhere but its own routes; a public route answers it no more than a rejected credential', async () => {
    const { routes } = enumerateRoutes();
    const seen = new Set<string>();
    const leaks: string[] = [];
    const publicRoutes: string[] = [];
    let refused = 0;
    const fill = (path: string, id: string) => path.replace(/:[A-Za-z_]+\??/g, id).replace(/\*/g, id);
    const targets: Array<{ method: string; path: string; key: string }> = [];
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      if (seen.has(key) || r.method === 'HEAD' || r.method === 'OPTIONS') continue;
      seen.add(key);
      if (GUEST_ROUTES.has(key)) continue;
      if (r.path.startsWith('/api/__mock') && r.method !== 'GET') continue;
      targets.push({ method: r.method, path: fill(r.path, OWN), key });
      if (r.path.startsWith('/api/interviews') && r.path.includes(':')) targets.push({ method: r.method, path: fill(r.path, OTHER), key: `${key} (another interview)` });
    }
    expect(targets.length).toBeGreaterThan(200);
    const statusOf = new Map<string, number>();
    for (const t of targets) {
      const asGuest = await call(t.method, t.path, guest);
      statusOf.set(t.key, asGuest.status);
      if (asGuest.status >= 400) { refused++; continue; }
      const rejected = await call(t.method, t.path, 'orgiq.session=not.a-session');
      if (rejected.status === asGuest.status && rejected.body === asGuest.body) publicRoutes.push(`${t.key} ${asGuest.status}`);
      else leaks.push(`${t.key}: guest ${asGuest.status}, rejected credential ${rejected.status}`);
    }
    // The guest's cookie is still good after the walk, so the refusals above were refusals of a live guest.
    expect((await call('GET', '/api/interview-invite/interview', guest)).status).toBe(200);
    expect(leaks).toEqual([]);
    // The call chat's REST reads (contract E9): the resolver, a pinned or linked message, the pins, and /summarize over the chat.
    // A guest reads its call's chat only over its socket, filtered there (lib/call-chat.ts guestMaySee); every REST read refuses it.
    for (const key of ['GET /api/calls/:callId/chat', 'GET /api/chat/message', 'GET /api/chat/pins', 'POST /api/conversations/summarize/run']) {
      expect([key, statusOf.has(key)]).toEqual([key, true]);
      expect([key, (statusOf.get(key) ?? 0) >= 400]).toEqual([key, true]);
    }
    // The after-call question (contract F1) is enumerated and refused to the guest like the room's ask.
    expect([statusOf.has('POST /api/interviews/interviews/:id/recap/ask'), (statusOf.get('POST /api/interviews/interviews/:id/recap/ask') ?? 0) >= 400]).toEqual([true, true]);
    // Lane H6 (O-184): the routes rounds 3 to 6 added, by name. Each is enumerated from the routers and refused to the guest, on its
    // own interview and on another.
    for (const key of ROUNDS_3_TO_6) {
      for (const k of key.includes('/interviews/:id') ? [key, `${key} (another interview)`] : [key]) {
        expect([k, statusOf.has(k), (statusOf.get(k) ?? 0) >= 400]).toEqual([k, true, true]);
      }
    }
    // A guest cookie carried onto a staff route is the gate's 401 (lib/session.ts: a guest is never the demo identity), on every
    // interviews route: never a 403 that would say the tenant exists for it, never a 404 from inside a route.
    const notGate = [...statusOf].filter(([k, st]) => k.includes(' /api/interviews') && st !== 401).map(([k, st]) => `${k} ${st}`);
    expect(notGate).toEqual([]);
    expect(refused).toBeGreaterThan(targets.length * 0.9);
    // What the public surface is, for the record (health, config, the sign-in page's lists): printed, not hidden.
    console.log(`guest sweep: ${targets.length} requests, ${refused} refused, ${publicRoutes.length} public:\n  ${publicRoutes.join('\n  ')}`);
  }, 300_000);

  it('the guest\'s own read answers the guest; a staff session is no guest on it or on the exchange', async () => {
    expect((await call('GET', '/api/interview-invite/interview', guest)).status).toBe(200);
    expect((await call('GET', '/api/interview-invite/interview', staff)).status).toBe(404);
    expect((await call('POST', '/api/interview-invite/exchange', staff, {})).status).toBe(404);
    // And the recruiter still reads her own pages with the guest cookie beside her session.
    expect((await call('GET', `/api/interviews/interviews/${OWN}`, `${staff}; ${guest}`)).status).toBe(200);
  });

  it('after the recruiter revokes the link, the guest is refused on its own routes too', async () => {
    const revoked = await fetch(`${base}/api/interviews/interviews/${OWN}/invite`, { method: 'DELETE', headers: { cookie: staff } });
    expect(revoked.status).toBe(200);
    expect((await call('GET', '/api/interview-invite/interview', guest)).status).toBe(404);
    expect((await call('GET', `/api/interviews/interviews/${OWN}`, guest)).status).toBe(401);
  });
});

// Lane PADLOG (row I4.3): the pad log's two staff routes refuse a guest on its own interview and on another, and its
// one guest route refuses a guest the lead has not admitted (and a staff session). That a guest of another interview
// writes only its own interview's log, and only while that one is live, is in interviews-pad.test.ts (it needs a live,
// admitted guest, which this server's walk does not make).
describe('the pad log against a guest', () => {
  let staff = '';
  let guest = '';

  beforeAll(async () => {
    expect((await fetch(`${base}/api/__mock/reset`, { method: 'POST' })).status).toBe(200);
    const login = await fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'u-greta' }) });
    staff = cookieOf(login, 'orgiq.session');
    const made = await fetch(`${base}/api/interviews/interviews/${OWN}/invite`, { method: 'POST', headers: { cookie: staff, 'content-type': 'application/json' }, body: '{}' });
    const token = String(((await made.json()) as { linkPath: string }).linkPath).split('#')[1];
    const opened = await fetch(`${base}/api/interview-invite/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    guest = cookieOf(opened, 'interviews.guest');
  }, 60_000);

  afterAll(async () => { await fetch(`${base}/api/__mock/reset`, { method: 'POST' }).catch(() => undefined); });

  const EVENTS = { events: [{ kind: 'paste', clientAt: '2026-11-17T10:00:00.000Z', from: 0, inserted: 10, lines: 1, via: 'paste' }] };

  it('refuses the guest the staff routes, on its own interview and on another', async () => {
    for (const id of [OWN, OTHER]) {
      expect((await call('POST', `/api/interviews/interviews/${id}/pad/events`, guest, EVENTS)).status).toBeGreaterThanOrEqual(400);
      expect((await call('GET', `/api/interviews/interviews/${id}/pad/log`, guest)).status).toBeGreaterThanOrEqual(400);
    }
  });

  it('refuses the guest route to a guest not admitted, to a staff session and to no cookie, with the one not-found', async () => {
    const asGuest = await call('POST', '/api/interview-invite/pad/events', guest, EVENTS);
    expect(asGuest.status).toBe(404);
    expect(JSON.parse(asGuest.body)).toEqual({ error: 'This link no longer works.' });
    expect((await call('POST', '/api/interview-invite/pad/events', staff, EVENTS)).status).toBe(404);
    expect((await call('POST', '/api/interview-invite/pad/events', null, EVENTS)).status).toBe(404);
    // No read for the guest: there is no guest route that answers the log.
    expect((await call('GET', '/api/interview-invite/pad/events', guest)).status).toBeGreaterThanOrEqual(400);
    // The guest's cookie still works, so these were refusals of a live guest.
    expect((await call('GET', '/api/interview-invite/interview', guest)).status).toBe(200);
  });
});

describe('lane RUNS (rows I4.4, I4.5): the runs routes and a guest', () => {
  let staff = '';
  let guest = '';

  beforeAll(async () => {
    expect((await fetch(`${base}/api/__mock/reset`, { method: 'POST' })).status).toBe(200);
    const login = await fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'u-greta' }) });
    staff = cookieOf(login, 'orgiq.session');
    const made = await fetch(`${base}/api/interviews/interviews/${OWN}/invite`, { method: 'POST', headers: { cookie: staff, 'content-type': 'application/json' }, body: '{}' });
    const token = String(((await made.json()) as { linkPath: string }).linkPath).split('#')[1];
    const opened = await fetch(`${base}/api/interview-invite/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    guest = cookieOf(opened, 'interviews.guest');
  }, 60_000);

  afterAll(async () => { await fetch(`${base}/api/__mock/reset`, { method: 'POST' }).catch(() => undefined); });

  const body = { runId: 'sweep-run-0001', language: 'python', entrypoint: 'main.py', files: [{ path: 'main.py', content: 'print("x")' }] };

  it('refuses the guest every staff runs route, for its own interview and another', async () => {
    for (const id of [OWN, OTHER]) {
      for (const [method, path] of [
        ['POST', `/api/interviews/interviews/${id}/runs`], ['GET', `/api/interviews/interviews/${id}/runs`], ['GET', `/api/interviews/interviews/${id}/runs/events`],
        ['GET', `/api/interviews/interviews/${id}/runs/sweep-run-0001`], ['POST', `/api/interviews/interviews/${id}/runs/sweep-run-0001/cancel`],
      ] as const) {
        const answer = await call(method, path, guest, body);
        expect([`${method} ${path}`, answer.status >= 400]).toEqual([`${method} ${path}`, true]);
      }
    }
  });

  it('the guest\'s own runs routes refuse it until the lead lets it in (and the interview is live)', async () => {
    for (const [method, path] of [
      ['POST', '/api/interview-invite/runs'], ['GET', '/api/interview-invite/runs'], ['GET', '/api/interview-invite/runs/events'],
      ['GET', '/api/interview-invite/runs/sweep-run-0001'], ['POST', '/api/interview-invite/runs/sweep-run-0001/cancel'],
    ] as const) {
      const answer = await call(method, path, guest, body);
      expect([`${method} ${path}`, answer.status, answer.body]).toEqual([`${method} ${path}`, 404, JSON.stringify({ error: 'This link no longer works.' })]);
      // A staff session is no guest on them.
      expect((await call(method, path, staff, body)).status).toBe(404);
    }
  });
});

describe('lane DESK-B (Add a candidate): the route against a guest', () => {
  let guest = '';

  beforeAll(async () => {
    expect((await fetch(`${base}/api/__mock/reset`, { method: 'POST' })).status).toBe(200);
    const login = await fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'u-greta' }) });
    const staff = cookieOf(login, 'orgiq.session');
    const made = await fetch(`${base}/api/interviews/interviews/${OWN}/invite`, { method: 'POST', headers: { cookie: staff, 'content-type': 'application/json' }, body: '{}' });
    const token = String(((await made.json()) as { linkPath: string }).linkPath).split('#')[1];
    const opened = await fetch(`${base}/api/interview-invite/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    guest = cookieOf(opened, 'interviews.guest');
  }, 60_000);

  afterAll(async () => { await fetch(`${base}/api/__mock/reset`, { method: 'POST' }).catch(() => undefined); });

  it('refuses the guest, and writes no candidate', async () => {
    const body = { name: 'Guest Made', email: 'guest.made@mail.example', openingId: 'op-backend' };
    expect((await call('POST', '/api/interviews/candidates', guest, body)).status).toBeGreaterThanOrEqual(400);
    const login = await fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'u-greta' }) });
    const list = await fetch(`${base}/api/interviews/candidates`, { headers: { cookie: cookieOf(login, 'orgiq.session') } });
    expect(JSON.stringify(await list.json())).not.toContain('guest.made@mail.example');
  });
});

// Lane SPEAK (rows I3.5, I3.8; contract U10): the lead's `/say` refuses a guest on its own interview and on another, and the
// candidate's `/milo/request` refuses a guest the lead has not let in, a staff session and no cookie, with the one not-found.
describe('lane SPEAK (rows I3.5, I3.8): Milo\'s approved words and a guest', () => {
  let staff = '';
  let guest = '';

  beforeAll(async () => {
    expect((await fetch(`${base}/api/__mock/reset`, { method: 'POST' })).status).toBe(200);
    const login = await fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'u-greta' }) });
    staff = cookieOf(login, 'orgiq.session');
    const made = await fetch(`${base}/api/interviews/interviews/${OWN}/invite`, { method: 'POST', headers: { cookie: staff, 'content-type': 'application/json' }, body: '{}' });
    const token = String(((await made.json()) as { linkPath: string }).linkPath).split('#')[1];
    const opened = await fetch(`${base}/api/interview-invite/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    guest = cookieOf(opened, 'interviews.guest');
  }, 60_000);

  afterAll(async () => { await fetch(`${base}/api/__mock/reset`, { method: 'POST' }).catch(() => undefined); });

  it('refuses the guest the lead\'s say route, for its own interview and another', async () => {
    for (const id of [OWN, OTHER]) {
      const answer = await call('POST', `/api/interviews/interviews/${id}/say`, guest, { questionId: 'q-1' });
      expect([id, answer.status >= 400]).toEqual([id, true]);
    }
  });

  it('the guest\'s own request route refuses it until the lead lets it in, and refuses a staff session and no cookie', async () => {
    const asGuest = await call('POST', '/api/interview-invite/milo/request', guest, { request: 'repeat' });
    expect([asGuest.status, asGuest.body]).toEqual([404, JSON.stringify({ error: 'This link no longer works.' })]);
    expect((await call('POST', '/api/interview-invite/milo/request', staff, { request: 'time' })).status).toBe(404);
    expect((await call('POST', '/api/interview-invite/milo/request', null, { request: 'time' })).status).toBe(404);
    expect((await call('GET', '/api/interview-invite/milo/request', guest)).status).toBeGreaterThanOrEqual(400);
    expect((await call('GET', '/api/interview-invite/interview', guest)).status).toBe(200);
  });
});

// Lane H6 (row E2; OWED O-275): every guest route named from the router itself, and for each, who it refuses. A guest route
// takes no interview id: the guest's cookie names the interview. So "a guest of another interview" is proved on what an
// admitted guest of one live interview can reach of another live interview (its runs, by id), and on what each guest's own
// reads name (its own interview only).
describe('lane H6: every guest route, from the router', () => {
  const KWAME_LIVE = 'iv-s4e8u2zk'; // live, technical, Hugo leads, two seeded runs
  let greta = ''; let hugo = '';
  let notAdmitted = ''; let admittedKwame = ''; let admittedOwn = '';
  const login = async (userId: string) => cookieOf(await fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId }) }), 'orgiq.session');
  const guestOf = async (interviewId: string): Promise<string> => {
    const made = await fetch(`${base}/api/interviews/interviews/${interviewId}/invite`, { method: 'POST', headers: { cookie: greta, 'content-type': 'application/json' }, body: '{}' });
    expect([interviewId, made.status]).toEqual([interviewId, 201]);
    const token = String(((await made.json()) as { linkPath: string }).linkPath).split('#')[1];
    return cookieOf(await fetch(`${base}/api/interview-invite/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }), 'interviews.guest');
  };
  const letIn = async (guest: string, interviewId: string) => {
    // The three answers first (Kwame's are seeded, so his answer is a 409 that changes nothing), then the knock and Admit.
    const notice = (json(await call('GET', '/api/interview-invite/consents', guest))['notice'] ?? {}) as { version?: string };
    expect((await call('PUT', '/api/interview-invite/consents', guest, { noticeVersion: notice.version, recording: true, transcription: true, milo: true })).status).toBeLessThan(500);
    expect((await call('POST', '/api/interview-invite/knock', guest, {})).status).toBe(200);
    expect((await call('POST', `/api/interviews/interviews/${interviewId}/admit`, hugo, { admit: true })).status).toBe(200);
  };
  const json = (a: Answer): Record<string, unknown> => { try { return JSON.parse(a.body) as Record<string, unknown>; } catch { return {}; } };
  const runIds = (a: Answer): string[] => ((json(a)['runs'] ?? []) as Array<{ runId: string }>).map((r) => r.runId);
  const REFUSAL = JSON.stringify({ error: 'This link no longer works.' });
  const RUN_BODY = (runId: string) => ({ runId, language: 'python', entrypoint: 'main.py', files: [{ path: 'main.py', content: 'print(1)' }] });
  const BODIES: Record<string, unknown> = {
    'POST /api/interview-invite/pad/events': { events: [{ kind: 'paste', clientAt: '2026-11-17T10:00:00.000Z', from: 0, inserted: 10, lines: 1, via: 'paste' }] },
    'POST /api/interview-invite/runs': RUN_BODY('h6-sweep-run-0001'),
    'POST /api/interview-invite/milo/request': { request: 'time' },
    'POST /api/interview-invite/media/participant': { callId: 'h6-no-such-call', participantId: 'guest:inv-x-abc' },
    'PUT /api/interview-invite/calls/:callId/chat/reads': { tab: 'chat', readAt: '2026-10-10T12:00:00.000Z' },
  };
  const pathOf = (key: string) => key.split(' ')[1]!.replace(':runId', 'run-kwame-01').replace(':callId', 'h6-no-such-call').replace(':action', 'press');

  beforeAll(async () => {
    expect((await fetch(`${base}/api/__mock/reset`, { method: 'POST' })).status).toBe(200);
    greta = await login('u-greta'); hugo = await login('u-hugo');
    notAdmitted = await guestOf(OTHER);
    admittedKwame = await guestOf(KWAME_LIVE);
    await letIn(admittedKwame, KWAME_LIVE);
    // A second live technical round with a guest let in: Hugo starts Mateo's design round (ready, his).
    const own = json(await call('GET', `/api/interviews/interviews/${OWN}`, hugo))['interview'] as { revision: number };
    expect((await call('POST', `/api/interviews/interviews/${OWN}/start`, hugo, { revision: own.revision })).status).toBe(200);
    admittedOwn = await guestOf(OWN);
    await letIn(admittedOwn, OWN);
    expect((await call('POST', `/api/interviews/interviews/${OWN}/runs`, hugo, RUN_BODY('h6-own-run-0001'))).status).toBe(202);
  }, 60_000);

  afterAll(async () => { await fetch(`${base}/api/__mock/reset`, { method: 'POST' }).catch(() => undefined); });

  it('names every guest route the router mounts, and no more', () => {
    const mounted = new Set(enumerateRoutes().routes.filter((r) => r.path.startsWith('/api/interview-invite') && r.method !== 'HEAD' && r.method !== 'OPTIONS').map((r) => `${r.method} ${r.path}`));
    const named = new Set([...GUEST_ROUTES, ...GUEST_ADMITTED_ROUTES]);
    expect([...mounted].filter((k) => !named.has(k)).sort()).toEqual([]);
    expect([...named].filter((k) => !mounted.has(k)).sort()).toEqual([]);
    expect(mounted.size).toBe(22);
  });

  it('refuses each guest route to no cookie and to a staff session, with the one not-found', async () => {
    for (const key of [...GUEST_ROUTES, ...GUEST_ADMITTED_ROUTES]) {
      if (key === 'GET /api/interview-invite/runs/events') continue; // a stream once open; its refusals are below with the others'
      const [method] = key.split(' ');
      for (const [who, cookie] of [['no cookie', null], ['staff', hugo]] as const) {
        const a = await call(method!, pathOf(key), cookie, BODIES[key] ?? {});
        // The exchange reads a token, not a cookie: with none in the body it is the same not-found.
        expect([key, who, a.status]).toEqual([key, who, 404]);
      }
    }
    for (const cookie of [null, hugo]) expect((await call('GET', '/api/interview-invite/runs/events', cookie)).status).toBe(404);
  });

  it('refuses each route that needs admission to a guest the lead has not let in', async () => {
    for (const key of GUEST_ADMITTED_ROUTES) {
      const [method] = key.split(' ');
      const a = await call(method!, pathOf(key), notAdmitted, BODIES[key] ?? {});
      expect([key, a.status, a.body]).toEqual([key, 404, REFUSAL]);
    }
    // Its cookie is good: these were refusals of a live guest, not of a dead link.
    expect((await call('GET', '/api/interview-invite/interview', notAdmitted)).status).toBe(200);
  });

  it('answers an admitted guest of a live round on its own routes', async () => {
    for (const key of GUEST_ADMITTED_ROUTES) {
      if (key === 'GET /api/interview-invite/runs/events' || key === 'POST /api/interview-invite/media/participant' || key.includes('/chat/reads') || key.includes('/milo/hold/') || key.endsWith('/captions')) continue; // a stream; a call the mock has not started; no hands-free run; captions off by default
      const [method] = key.split(' ');
      const a = await call(method!, pathOf(key), admittedKwame, BODIES[key] ?? {});
      expect([key, a.status < 300]).toEqual([key, true]);
    }
    // No hands-free run in the mock world: the hold is the plain 409, never the guest refusal.
    expect((await call('POST', pathOf('POST /api/interview-invite/milo/hold/:action'), admittedKwame, {})).status).toBe(409);
    // No call is running, so the media binding is the same not-found as any other (the bound case is interview-invite-media's).
    expect((await call('POST', '/api/interview-invite/media/participant', admittedKwame, BODIES['POST /api/interview-invite/media/participant'])).status).toBe(404);
    // The candidate's captions are off unless the deployment turns them on (INTERVIEWS_CANDIDATE_CAPTIONS; interviews-invite-captions.test.ts).
    expect((await call('GET', '/api/interview-invite/captions', admittedKwame)).status).toBe(404);
    // The call chat's read position is the guest's only in a call of their interview they are seated in: none runs here.
    for (const method of ['GET', 'PUT']) {
      expect((await call(method, pathOf('GET /api/interview-invite/calls/:callId/chat/reads'), admittedKwame, BODIES['PUT /api/interview-invite/calls/:callId/chat/reads'])).status).toBe(404);
    }
  });

  it('keeps one live round\'s guest out of another live round\'s runs', async () => {
    const kwame = runIds(await call('GET', '/api/interview-invite/runs', admittedKwame));
    const own = runIds(await call('GET', '/api/interview-invite/runs', admittedOwn));
    expect(kwame).toEqual(expect.arrayContaining(['run-kwame-01', 'run-kwame-02']));
    expect(kwame).not.toContain('h6-own-run-0001');
    expect(own).toContain('h6-own-run-0001');
    expect(own.filter((id) => id.startsWith('run-kwame'))).toEqual([]);
    for (const [guest, foreign] of [[admittedKwame, 'h6-own-run-0001'], [admittedOwn, 'run-kwame-01']] as const) {
      expect((await call('GET', `/api/interview-invite/runs/${foreign}`, guest)).status).toBe(404);
      expect((await call('POST', `/api/interview-invite/runs/${foreign}/cancel`, guest, {})).status).toBe(404);
    }
    // A run id already used in the other round is a new run of its own round, never a reach into the other's.
    const reuse = await call('POST', '/api/interview-invite/runs', admittedOwn, RUN_BODY('run-kwame-01'));
    expect(reuse.status).toBeLessThan(500);
    const after = await call('GET', `/api/interviews/interviews/${KWAME_LIVE}/runs`, hugo);
    expect(((json(after)['runs'] ?? []) as Array<{ runId: string }>).filter((r) => r.runId === 'run-kwame-01')).toHaveLength(1);
  });

  it('names only its own interview in each guest\'s reads', async () => {
    for (const [guest, mine, theirs] of [[admittedKwame, KWAME_LIVE, OWN], [admittedOwn, OWN, KWAME_LIVE], [notAdmitted, OTHER, KWAME_LIVE]] as const) {
      for (const p of ['/interview', '/admission', '/consents', '/room', '/realtime-token']) {
        const a = await call('GET', `/api/interview-invite${p}`, guest);
        expect([p, a.body.includes(theirs)]).toEqual([p, false]);
        if (p === '/room' && a.status === 200) expect(a.body).toContain(mine);
      }
    }
  });
});

// Lane H6 (row E2): the reverse. A person of another tenant (the Work-only persona) is stopped at the tenant gate on every
// interviews route (403, before any route reads anything), and so is a caller holding only a guest cookie (401).
describe('lane H6: another tenant\'s person and a bare guest cookie on every interviews route', () => {
  it('answers the Work-only persona 403 and the guest cookie 401 on every route, enumerated', async () => {
    expect((await fetch(`${base}/api/__mock/reset`, { method: 'POST' })).status).toBe(200);
    const theo = cookieOf(await fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'u-theo' }) }), 'orgiq.session');
    const keys = [...new Set(enumerateRoutes().routes.filter((r) => r.path.startsWith('/api/interviews/') && r.method !== 'HEAD' && r.method !== 'OPTIONS').map((r) => `${r.method} ${r.path}`))];
    expect(keys.length).toBeGreaterThan(55);
    const wrong: string[] = [];
    for (const key of keys) {
      const [method, path] = key.split(' ');
      for (const id of [OWN, 'iv-s4e8u2zk']) {
        const p = path!.replace(/:[A-Za-z_]+/g, id);
        const asTheo = await call(method!, p, theo, {});
        if (asTheo.status !== 403) wrong.push(`${key} (${id}) Work-only ${asTheo.status}`);
        const asCookie = await call(method!, p, 'interviews.guest=not.a-guest', {});
        if (asCookie.status !== 401) wrong.push(`${key} (${id}) guest cookie ${asCookie.status}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});

describe('the answer key against a guest: a live "Design Twitter" round', () => {
  let greta = ''; let hugo = ''; let wen = ''; let guest = ''; let other = '';
  let IV = '';
  const login = async (userId: string) => cookieOf(await fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId }) }), 'orgiq.session');
  const json = (a: Answer): Record<string, unknown> => { try { return JSON.parse(a.body) as Record<string, unknown>; } catch { return {}; } };
  const api = (p: string) => `/api/interviews/interviews${p}`;
  const revision = async () => (json(await call('GET', api(`/${IV}`), hugo))['interview'] as { revision: number }).revision;
  const guestOf = async (interviewId: string): Promise<string> => {
    const made = await call('POST', api(`/${interviewId}/invite`), greta, {});
    expect([interviewId, made.status]).toEqual([interviewId, 201]);
    const token = String(json(made)['linkPath']).split('#')[1];
    return cookieOf(await fetch(`${base}/api/interview-invite/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }), 'interviews.guest');
  };
  // Pieces of the answer key no other text in the seed holds: each answer's and red flag's opening words, and the provided design's ids.
  const MARKERS = [...TWITTER_QUESTIONS.map((q) => q.answer!.slice(0, 32)), ...TWITTER_RED_FLAGS.map((f) => f.text.slice(0, 32)), 'pd-node-', 'providedDesign', 'redFlags', 'designQuestions'];
  const leaked = (body: string) => MARKERS.filter((m) => body.includes(m));

  beforeAll(async () => {
    expect((await fetch(`${base}/api/__mock/reset`, { method: 'POST' })).status).toBe(200);
    greta = await login('u-greta'); hugo = await login('u-hugo'); wen = await login('u-wen');
    const made = await call('POST', api(''), greta, { applicationId: 'app-7b69njmx', roundId: 'rd-design', leadId: 'u-hugo', panelIds: [] });
    expect(made.status).toBe(201);
    IV = String((json(made)['interview'] as { id: string }).id);
    const notice = json(await call('GET', api('/panel-notice'), hugo)) as { acknowledged?: boolean; notice?: { version?: string } };
    if (notice.acknowledged === false && notice.notice?.version) await call('POST', api(`/${IV}/panel-notice`), hugo, { version: notice.notice.version });
    expect((await call('POST', api(`/${IV}/answer`), hugo, { revision: await revision(), answer: 'accept' })).status).toBe(200);
    const when = new Date(Math.ceil((Date.now() + 5 * 60_000) / 60_000) * 60_000).toISOString();
    expect((await call('PUT', api(`/${IV}/time`), greta, { revision: await revision(), scheduledAt: when })).status).toBe(200);
    expect((await call('PUT', api(`/${IV}/questions`), hugo, { revision: await revision(), questionIds: ['q-be-twitter'] })).status).toBe(200);
    expect((await call('POST', api(`/${IV}/start`), hugo, { revision: await revision() })).status).toBe(200);
    guest = await guestOf(IV);
    const consent = (json(await call('GET', '/api/interview-invite/consents', guest))['notice'] ?? {}) as { version?: string };
    expect((await call('PUT', '/api/interview-invite/consents', guest, { noticeVersion: consent.version, recording: true, transcription: true, milo: true })).status).toBeLessThan(500);
    expect((await call('POST', '/api/interview-invite/knock', guest, {})).status).toBe(200);
    expect((await call('POST', api(`/${IV}/admit`), hugo, { admit: true })).status).toBe(200);
    other = await guestOf(OTHER);
  }, 90_000);

  afterAll(async () => { await fetch(`${base}/api/__mock/reset`, { method: 'POST' }).catch(() => undefined); });

  it('the lead\'s room carries the answer key, so the markers are real', async () => {
    const room = await call('GET', api(`/${IV}/room`), hugo);
    expect(room.status).toBe(200);
    expect(leaked(room.body).length).toBeGreaterThan(10);
  });

  it('no GET route the server mounts, nor Milo\'s request, answers the admitted guest (or another interview\'s) any of it', async () => {
    const fill = (path: string) => path.replace(/:runId/g, 'run-x').replace(/:[A-Za-z_]+\??/g, IV).replace(/\*/g, IV);
    const seen = new Set<string>();
    const found: string[] = [];
    let answered = 0;
    for (const r of enumerateRoutes().routes) {
      const key = `${r.method} ${r.path}`;
      if (r.method !== 'GET' || seen.has(key) || key === 'GET /api/interview-invite/runs/events') continue;
      seen.add(key);
      for (const [who, cookie] of [['guest', guest], ['another interview\'s guest', other]] as const) {
        const a = await call('GET', fill(r.path), cookie);
        if (a.status < 400) answered++;
        if (leaked(a.body).length) found.push(`${key} (${who}): ${leaked(a.body).join(', ')}`);
      }
    }
    const milo = await call('POST', '/api/interview-invite/milo/request', guest, { request: 'time' });
    if (leaked(milo.body).length) found.push(`POST milo/request: ${leaked(milo.body).join(', ')}`);
    expect(answered).toBeGreaterThan(5);
    expect(found).toEqual([]);
  });

  it('only the lead reveals the provided design: not the guest, not an interviewer without a seat, not for a question not chosen', async () => {
    // The guest holds no staff session: the tenant's mount refuses it before the route.
    expect([401, 404]).toContain((await call('POST', api(`/${IV}/board/reveal`), guest, { questionId: 'q-be-twitter' })).status);
    expect((await call('POST', api(`/${IV}/board/reveal`), wen, { questionId: 'q-be-twitter' })).status).toBe(404);
    expect((await call('POST', api(`/${IV}/board/reveal`), hugo, { questionId: 'q-be-ledger' })).status).toBe(404);
    const shown = await call('POST', api(`/${IV}/board/reveal`), hugo, { questionId: 'q-be-twitter' });
    expect(shown.status).toBe(200);
    expect((json(shown)['board'] as { name: string }).name).toBe('Provided design');
    expect(json(shown)['already']).toBe(false);
    const reveals = async () => ((json(await call('GET', api(`/${IV}/pad/log`), hugo))['events'] ?? []) as Array<{ kind: string; questionId?: string }>)
      .filter((e) => e.kind === 'reveal').map((e) => e.questionId);
    // the ask logs nothing: only the lead's room's ack, once the board holds it, and only once
    expect(await reveals()).toEqual([]);
    expect((await call('POST', api(`/${IV}/board/reveal/shown`), wen, { questionId: 'q-be-twitter' })).status).toBe(404);
    expect(json(await call('POST', api(`/${IV}/board/reveal/shown`), hugo, { questionId: 'q-be-twitter' }))).toEqual({ logged: true, already: false });
    expect(json(await call('POST', api(`/${IV}/board/reveal/shown`), hugo, { questionId: 'q-be-twitter' }))).toEqual({ logged: false, already: true });
    expect(json(await call('POST', api(`/${IV}/board/reveal`), hugo, { questionId: 'q-be-twitter' }))['already']).toBe(true);
    expect(await reveals()).toEqual(['q-be-twitter']);
    // the room reads what was revealed from the server, not from page memory
    expect(json(await call('GET', api(`/${IV}/board/reveals`), hugo))).toEqual({ questionIds: ['q-be-twitter'] });
    expect([401, 404]).toContain((await call('GET', api(`/${IV}/board/reveals`), guest)).status);
  });
});
