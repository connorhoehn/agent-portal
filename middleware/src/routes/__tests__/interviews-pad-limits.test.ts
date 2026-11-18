// The pad log's body limits through the real app (src/index.ts: its middleware order and express.json's default 100 KB limit;
// row I4.3, decision 12; OWED O-243, lane H8). Like interviews-invite-sweep.test.ts, this boots the real server under dev:mock's
// settings on a free port of its own and stops only the process it started. Nothing a person types is run: the pad log stores
// counts and snapshot text.
//
//   a 64 KB snapshot in its own post     stored (the reporter sends a snapshot alone for this reason)
//   a snapshot over 64 KB, under 100 KB  refused whole with the route's sentence (400), nothing stored
//   a body over 100 KB                   refused with 413 and a sentence, never a 500
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';

jest.setTimeout(180_000);
const ROOT = join(__dirname, '..', '..', '..');
const LIVE = 'iv-s4e8u2zk'; // Kwame's coding round, live in the seed: Hugo leads, Wen on the panel

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
let hugo = '';

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(ROOT, 'node_modules', '.bin', 'tsx'), 'src/index.ts'], {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...devMockEnv(), PORT: String(port), MOCK_PERSIST_PAIRINGS: '0', VOICE_LOG_DIR: mkdtempSync(join(tmpdir(), 'pad-limits-voice-')), JEST_WORKER_ID: '' },
  });
  child.stdout?.on('data', (d: Buffer) => { log = (log + d.toString()).slice(-4000); });
  child.stderr?.on('data', (d: Buffer) => { log = (log + d.toString()).slice(-4000); });
  const until = Date.now() + 150_000;
  let up = false;
  while (!up && Date.now() < until) {
    if (child.exitCode !== null) break;
    try { up = (await fetch(`${base}/api/health`)).status < 500; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`the server did not come up: ${log.slice(-1500)}`);
  expect((await fetch(`${base}/api/__mock/reset`, { method: 'POST' })).status).toBe(200);
  const login = await fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'u-hugo' }) });
  expect(login.status).toBe(200);
  // The login clears any old session cookie first, then sets the new one: keep the last.
  hugo = login.headers.getSetCookie().map((c) => c.split(';')[0]!).filter((c) => c.startsWith('orgiq.session=') && c.length > 'orgiq.session='.length).at(-1) ?? '';
  expect(hugo).toMatch(/orgiq\.session=/);
}, 170_000);
afterAll(() => {
  if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }
});

const at = '2026-11-17T10:00:00.000Z';
const post = (body: string) => fetch(`${base}/api/interviews/interviews/${LIVE}/pad/events`, { method: 'POST', headers: { cookie: hugo, 'content-type': 'application/json' }, body });
const snapshot = (chars: number) => JSON.stringify({ events: [{ kind: 'snapshot', clientAt: at, text: 'x'.repeat(chars) }] });
const snapshots = async () => {
  const r = await fetch(`${base}/api/interviews/interviews/${LIVE}/pad/log`, { headers: { cookie: hugo } });
  expect(r.status).toBe(200);
  return ((await r.json()) as { events: Array<{ kind: string; text?: string }> }).events.filter((e) => e.kind === 'snapshot');
};

it('a 64 KB snapshot in its own post is stored whole', async () => {
  const before = (await snapshots()).length;
  const body = snapshot(64 * 1024);
  expect(Buffer.byteLength(body)).toBeLessThan(100 * 1024);
  const r = await post(body);
  expect([r.status, await r.json()]).toEqual([200, { accepted: 1 }]);
  const all = await snapshots();
  expect(all).toHaveLength(before + 1);
  expect(all.at(-1)!.text).toHaveLength(64 * 1024);
});

it('a snapshot over 64 KB but under the app\'s 100 KB is refused whole with the route\'s sentence, nothing stored', async () => {
  const before = (await snapshots()).length;
  const r = await post(snapshot(64 * 1024 + 1));
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toBe('The pad log could not read these events. Nothing was stored.');
  expect(await snapshots()).toHaveLength(before);
});

it('a body over the app\'s 100 KB limit is refused (4xx), and nothing is stored', async () => {
  const before = (await snapshots()).length;
  const r = await post(snapshot(150 * 1024));
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(await snapshots()).toHaveLength(before);
});

// O-243: a body past the limit is refused with a sentence, never a 500 (the shared error handler, lib/async-handler.ts).
it('a body over the app\'s 100 KB limit is a 413 with a plain sentence, never a 500', async () => {
  const r = await post(snapshot(150 * 1024));
  expect(r.status).toBe(413);
  const body = (await r.json()) as { error?: string };
  expect(body.error).toBeTruthy();
  expect(body.error).not.toBe('Internal server error');
});
