// node --test scripts/user-search-results.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeGroups, takeProbeRunLock } from './user-search-results.mjs';

const KEYS = ['orgiq:member', 'access:requester'];
const row = (key, n) => ({ intent: `${key}-${n}`, tenant: key.split(':')[0], role: key.split(':')[1] });
const run = (digest, at) => ({ generatedAt: at, gitHead: 'abc', watchedDigest: digest, baseURL: 'http://x', pid: 1 });
const group = (key, n = 2) => ({ persona: { cloneOf: key }, probes: Array.from({ length: n }, (_, i) => row(key, i)) });

test('workers fold their own groups without overwriting each other', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'us-results-')), 'r.json');
  mergeGroups(out, run('d1', 't1'), { 'orgiq:member': group('orgiq:member') }, KEYS, []);
  mergeGroups(out, { ...run('d1', 't2'), pid: 2 }, { 'access:requester': group('access:requester', 3) }, KEYS, []);
  const r = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(r.probes.length, 5);
  assert.equal(r.watchedDigest, 'd1');
  assert.deepEqual(Object.keys(r.personas).sort(), [...KEYS].sort());
});

test('a partial re-probe on a changed tree leaves the file stale until every persona is re-probed', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'us-results-')), 'r.json');
  mergeGroups(out, run('d1', 't1'), { 'orgiq:member': group('orgiq:member'), 'access:requester': group('access:requester') }, KEYS, []);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).watchedDigest, 'd1');
  assert.equal(mergeGroups(out, run('d2', 't2'), { 'access:requester': group('access:requester', 4) }, KEYS, []), null);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).watchedDigest, null);
  assert.equal(mergeGroups(out, run('d2', 't3'), { 'orgiq:member': group('orgiq:member', 1) }, KEYS, []), 'd2');
});

test('a partial re-probe on an unchanged tree stays fresh, and a legacy file counts as its own digest', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'us-results-')), 'r.json');
  writeFileSync(out, JSON.stringify({ watchedDigest: 'd1', personas: { 'orgiq:member': {}, 'access:requester': {} }, probes: [row('orgiq:member', 0), row('access:requester', 0)], runs: [] }));
  assert.equal(mergeGroups(out, run('d1', 't1'), { 'access:requester': group('access:requester') }, KEYS, []), 'd1');
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).probes.filter((p) => p.tenant === 'orgiq').length, 1);
});

test('parallel probe workers share their runner lock and refuse another live runner', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'us-run-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, 'runner');
  const module = new URL('./user-search-results.mjs', import.meta.url).href;
  const worker = `import { takeProbeRunLock } from ${JSON.stringify(module)};
    takeProbeRunLock(process.argv[1], process.argv[2] === 'self' ? process.pid : Number(process.argv[2]));`;
  const claim = (owner) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, lock, String(owner)]);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr, pid: child.pid }));
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => claim(process.pid)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  const other = await claim('self');
  assert.notEqual(other.code, 0);
  assert.match(other.stderr, /another user-search probe is running/);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  writeFileSync(lock, String(other.pid));
  takeProbeRunLock(lock, process.pid);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid), 'a departed runner releases its claim');
});

test('an empty legacy probe lock never treats process group zero as a live runner', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'us-empty-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, 'runner');
  writeFileSync(lock, '');
  takeProbeRunLock(lock, process.pid);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  assert.throws(() => takeProbeRunLock(lock, 0), /PID must be positive/);
});
