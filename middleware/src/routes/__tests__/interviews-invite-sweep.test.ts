// The test that starts from a guest (docs/interviews-tenant-plan.md row I2.1's bar, and the seed of E2).
//
// It boots the real server (src/index.ts under dev:mock's settings, on a free port of its own), makes a link as
// the recruiter, opens it as a guest, and then walks EVERY route the server mounts, read from the routers
// themselves (mock/core/wire/routes.ts enumerateRoutes, the inventory the wire snapshots and the route-coverage
// ratchet use), with only the guest's cookie. Each path parameter is filled with the guest's OWN interview id,
// the most tempting value there is, and the interviews routes are walked a second time with ANOTHER interview's.
//
// Every route must refuse the guest (a 4xx or 5xx) except the guest's own (GUEST_ROUTES: the exchange, its
// interview, its realtime token, the knock and its admission, CONSENT's two consents routes, and its room) and a public route, which is allowed only when it answers the guest exactly what it answers a
// caller whose credential was rejected (same status, same body): the guest gains nothing by being a guest.
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

const ROOT = join(__dirname, '..', '..', '..');
const OWN = 'iv-k1p5w8ra';
const OTHER = 'iv-c3k8w2ma';
const GUEST_ROUTES = new Set([
  'POST /api/interview-invite/exchange',
  'GET /api/interview-invite/interview',
  'GET /api/interview-invite/realtime-token',
  'POST /api/interview-invite/knock',
  'GET /api/interview-invite/admission',
  'GET /api/interview-invite/consents',
  'PUT /api/interview-invite/consents',
  'GET /api/interview-invite/room',
]);

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
    env: { ...process.env, ...devMockEnv(), PORT: String(port), MOCK_PERSIST_PAIRINGS: '0', VOICE_LOG_DIR: mkdtempSync(join(tmpdir(), 'guest-sweep-voice-')), JEST_WORKER_ID: '' },
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

  it('refuses the guest everywhere but its two routes; a public route answers it no more than a rejected credential', async () => {
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
    expect(refused).toBeGreaterThan(targets.length * 0.9);
    // What the public surface is, for the record (health, config, the sign-in page's lists): printed, not hidden.
    console.log(`guest sweep: ${targets.length} requests, ${refused} refused, ${publicRoutes.length} public:\n  ${publicRoutes.join('\n  ')}`);
  }, 300_000);

  it('the guest\'s own two routes answer the guest; a staff session is no guest on them', async () => {
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
