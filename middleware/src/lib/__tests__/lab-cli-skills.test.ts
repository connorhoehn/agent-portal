// R8 — the box's half of skills, with the real `lab` script, real curl and real
// python against the real routes:
//
//   lab skills   one verified copy of the org's skill library into ~/.claude/skills
//                (LAB_SKILLS_DIR here), skipped when its sha is unchanged; refuses a
//                tampered or path-escaping library; never overwrites a skill it did
//                not install; removes a retired one.
//   lab keep     each .lab/keep/<rb-name>/ folder becomes a proposal with its files;
//                links, binaries and bad names are not carried; the TypeScript reader
//                (lib/runbooks/keep.ts) agrees with it byte for byte.

jest.mock('../role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn(async () => null), getProjectDecisions: jest.fn(async () => []) }));

import express from 'express';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { captureRawBody, LAB_CALLBACK_SERVICE_AUTH, resetServiceNonceCache } from '../service-auth.js';
import { createSessionBriefsRouter } from '../../routes/session-briefs.js';
import { createRunbooksRouter } from '../../routes/runbooks.js';
import { errorHandler } from '../async-handler.js';
import { mintRunToken } from '../run-token.js';
import { assembleBrief, briefLibraryOf, loadSkillLibrary, renderSkill, versionOf, LIBRARY_FORMAT, type RunbookStore } from '../runbooks/index.js';
import { readKeepFolder } from '../runbooks/keep.js';
import { seededStore } from '../../routes/__tests__/runbook-world.js';
import { cdpWebsocketDoc, bundleFiles, CDP_RUNBOOK_ID } from '../../mock/runbook-bundles.js';

const LAB = join(__dirname, '..', '..', '..', '..', 'agents', 'devbox', 'lab');
const SECRET = 'lab-skills-secret';
let store: RunbookStore;
let server: Server;
let base = '';
let fake: Server;
let fakeBody: (() => { status: number; body: string; sha?: string }) | null = null;
let fakeBase = '';

function lab(args: string[], env: Record<string, string>, opts: { cwd?: string; base?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('bash', [LAB, ...args], {
      cwd: opts.cwd ?? tmpdir(),
      env: { PATH: process.env['PATH'] ?? '', HOME: tmpdir(), LAB_API_BASE: opts.base ?? base, LAB_CALLBACK_SECRET: SECRET, SERVICE_AUTH_LEGACY_HEADERS: 'refuse', ...env },
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

async function runEnv(runRef: string, skillsDir: string) {
  const lib = await loadSkillLibrary(store);
  await store.putBrief(assembleBrief({ run_ref: runRef, assembled_at: '2026-10-15T00:00:00.000Z', framing: '', work_item: null, initiative: null, decisions: [], skill_library: briefLibraryOf(lib) }));
  return { LAB_RUN_REF: runRef, LAB_RUN_TOKEN: await mintRunToken(runRef), LAB_SKILLS_DIR: skillsDir, LAB_SESSION_ID: 'sess-skills' };
}

async function addCdp(s: RunbookStore): Promise<void> {
  const at = '2026-10-15T00:00:00.000Z';
  await s.createRunbook(
    { id: CDP_RUNBOOK_ID, scope: { kind: 'org', ref: null }, owner_person_id: 'p-100', status: 'published', current_version: 1, created_at: at, updated_at: at },
    versionOf({ runbook_id: CDP_RUNBOOK_ID, version: 1, doc: cdpWebsocketDoc, author: { kind: 'person', id: 'p-100' }, files: bundleFiles(CDP_RUNBOOK_ID) }),
  );
}

beforeAll(async () => {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.use('/api/runbooks', createRunbooksRouter({ store: () => store }));
  app.use('/api', createSessionBriefsRouter({ store: () => store }));
  app.use(errorHandler);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // A hostile library server: whatever fakeBody returns, for any path.
  fake = createServer((_req, res) => {
    const f = fakeBody!();
    res.writeHead(f.status, { 'content-type': 'application/json', ...(f.sha ? { 'x-skill-library-sha256': f.sha } : {}) });
    res.end(f.body);
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  fakeBase = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));
});
beforeEach(async () => {
  store = seededStore();
  await addCdp(store);
  process.env[LAB_CALLBACK_SERVICE_AUTH.envVar] = SECRET;
  resetServiceNonceCache();
});
afterEach(() => { delete process.env[LAB_CALLBACK_SERVICE_AUTH.envVar]; });

describe('lab skills (box delivery)', () => {
  it('box: installs the whole library as Claude Code skills, verified, and skips an unchanged copy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-'));
    const env = await runEnv('job-sk-1', dir);
    const lib = await loadSkillLibrary(store);
    const first = await lab(['skills'], env);
    expect(first.out.trim()).toBe(`skills: installed the org's library ${lib.sha256.slice(0, 12)}: ${lib.skills.length} skill(s) in ${dir}`);
    // Every skill directory, and every file byte for byte with its mode.
    for (const f of lib.files) {
      const p = join(dir, f.path);
      expect([f.path, createHash('sha256').update(readFileSync(p)).digest('hex')]).toEqual([f.path, f.sha256]);
      expect((statSync(p).mode & 0o777).toString(8)).toBe(f.mode);
    }
    expect(readFileSync(join(dir, CDP_RUNBOOK_ID, 'SKILL.md'), 'utf8')).toBe(renderSkill(CDP_RUNBOOK_ID, cdpWebsocketDoc));
    // The installed harness runs from the skill folder, offline.
    const ran = execFileSync('bash', ['-c', cdpWebsocketDoc.verify[0]!.command!.text], { cwd: join(dir, CDP_RUNBOOK_ID), encoding: 'utf8' });
    expect(ran.trim()).toBe('replay-ok');
    // Same library again: a 304, no copy.
    const second = await lab(['skills'], { ...env, LAB_RUN_TOKEN: await mintRunToken('job-sk-1') });
    expect(second.out.trim()).toBe(`skills: library ${lib.sha256.slice(0, 12)} unchanged in ${dir}`);
  });

  it('box: an accepted change moves the hash and the next sync replaces it; a retired skill is removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-'));
    await lab(['skills'], await runEnv('job-sk-2', dir));
    const before = (await loadSkillLibrary(store)).sha256;
    const rb = (await store.getRunbook('rb-tenant-cutover'))!;
    await store.putRunbook({ ...rb, status: 'retired', updated_at: '2026-10-15T01:00:00.000Z', retired: { at: '2026-10-15T01:00:00.000Z', by: 'p-002', reason: 'gone', superseded_by: null } }, rb.updated_at);
    const after = (await loadSkillLibrary(store)).sha256;
    expect(after).not.toBe(before);
    const r = await lab(['skills'], await runEnv('job-sk-3', dir));
    expect(r.out).toContain(`library ${after.slice(0, 12)}`);
    expect(r.out).toContain('1 retired removed');
    expect(existsSync(join(dir, 'rb-tenant-cutover'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, '.orgiq-library.json'), 'utf8')).sha256).toBe(after);
  });

  it('box: never overwrites a skill of the same name it did not install', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-'));
    mkdirSync(join(dir, CDP_RUNBOOK_ID));
    writeFileSync(join(dir, CDP_RUNBOOK_ID, 'SKILL.md'), 'mine');
    const r = await lab(['skills'], await runEnv('job-sk-4', dir));
    expect(r.out).toContain(`skipped ${CDP_RUNBOOK_ID}`);
    expect(readFileSync(join(dir, CDP_RUNBOOK_ID, 'SKILL.md'), 'utf8')).toBe('mine');
  });

  it("box: another run's token, or no run at all, gets nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-'));
    const env = await runEnv('job-sk-5', dir);
    const stolen = await lab(['skills'], { ...env, LAB_RUN_TOKEN: await mintRunToken('job-other') });
    expect(stolen.out).toContain('could not fetch the org\'s skill library (HTTP 403)');
    expect(readdirSync(dir)).toEqual([]);
    const bare = await lab(['skills'], { LAB_SKILLS_DIR: dir });
    expect(bare.err).toContain('not a dispatched run');
  });

  describe('a tampered library is refused whole and nothing is written', () => {
    const lines = (files: Array<{ path: string; mode: string; sha256: string }>) =>
      createHash('sha256').update([LIBRARY_FORMAT, ...files.map((f) => `${f.path} ${f.mode} ${f.sha256}`).sort()].join('\n') + '\n').digest('hex');
    const file = (path: string, content: string, mode = '644') => ({ path, content, mode, sha256: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content) });
    const cases: Array<[string, () => { status: number; body: string; sha?: string }, string]> = [
      ['a file whose bytes do not match its sha', () => {
        const f = { ...file('rb-xy/SKILL.md', 'ok'), content: 'evil' };
        return { status: 200, body: JSON.stringify({ format: LIBRARY_FORMAT, sha256: lines([f]), files: [f] }) };
      }, 'does not match its sha256'],
      ['a set whose sha is wrong', () => {
        const f = file('rb-xy/SKILL.md', 'ok');
        return { status: 200, body: JSON.stringify({ format: LIBRARY_FORMAT, sha256: '0'.repeat(64), files: [f] }) };
      }, 'the set does not match'],
      ['a path that climbs out', () => {
        const f = file('rb-xy/scripts/../../../escape.sh', '#!/bin/sh\n', '755');
        return { status: 200, body: JSON.stringify({ format: LIBRARY_FORMAT, sha256: lines([f]), files: [f] }) };
      }, 'unsafe path'],
      ['an absolute path', () => {
        const f = file('/etc/cron.d/x', 'x');
        return { status: 200, body: JSON.stringify({ format: LIBRARY_FORMAT, sha256: lines([f]), files: [f] }) };
      }, 'unsafe path'],
      ['a skill name outside rb-', () => {
        const f = file('.ssh/authorized_keys', 'x');
        return { status: 200, body: JSON.stringify({ format: LIBRARY_FORMAT, sha256: lines([f]), files: [f] }) };
      }, 'unsafe path'],
      ['an oversized file', () => {
        const f = file('rb-xy/data/big.txt', 'x'.repeat(40 * 1024));
        return { status: 200, body: JSON.stringify({ format: LIBRARY_FORMAT, sha256: lines([f]), files: [f] }) };
      }, 'is over'],
    ];
    for (const [label, body, why] of cases) {
      it(`box: refuses ${label}`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'skills-'));
        fakeBody = body;
        const r = await lab(['skills'], { LAB_RUN_REF: 'job-fake', LAB_RUN_TOKEN: 'x', LAB_SKILLS_DIR: dir }, { base: fakeBase });
        expect(r.out).toContain('REFUSED');
        expect(r.out).toContain(why);
        expect(readdirSync(dir)).toEqual([]);
        expect(existsSync(join(dir, '..', 'escape.sh'))).toBe(false);
      });
    }
  });
});

describe('lab keep (capture)', () => {
  function keepDir(): string {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    const tool = join(ws, '.lab', 'keep', 'rb-ws-cdp-debug-v2');
    mkdirSync(join(tool, 'scripts'), { recursive: true });
    mkdirSync(join(tool, 'data'), { recursive: true });
    writeFileSync(join(tool, 'SKILL.md'), renderSkill('rb-ws-cdp-debug-v2', cdpWebsocketDoc));
    for (const f of bundleFiles(CDP_RUNBOOK_ID)) {
      writeFileSync(join(tool, f.path), f.content);
      if (f.mode === '755') chmodSync(join(tool, f.path), 0o755);
    }
    return ws;
  }

  it('capture: lab keep --dry-run and the TypeScript reader agree, byte for byte', async () => {
    const ws = keepDir();
    const r = await lab(['keep', '--dry-run'], { LAB_RUN_REF: 'job-k', LAB_SESSION_ID: 's-k', LAB_SKILLS_DIR: mkdtempSync(join(tmpdir(), 'sk-')) }, { cwd: ws });
    const fromLab = r.out.trim().split('\n').map((l) => JSON.parse(l));
    const fromTs = readKeepFolder(join(ws, '.lab', 'keep'), { runRef: 'job-k', sessionId: 's-k' });
    expect(fromLab).toEqual(JSON.parse(JSON.stringify(fromTs)));
    expect(fromTs[0]!.body!.files.map((f) => [f.path, f.mode])).toEqual([
      ['scripts/cdp-ws-frames.mjs', '755'], ['data/expected-summary.txt', '644'], ['data/sample-frames.jsonl', '644'],
    ]);
  });

  it('capture: links, binaries, bad names and oversize files are not carried', async () => {
    const ws = keepDir();
    const tool = join(ws, '.lab', 'keep', 'rb-ws-cdp-debug-v2');
    const secret = join(ws, 'id_rsa'); writeFileSync(secret, '-----BEGIN OPENSSH PRIVATE KEY-----');
    symlinkSync(secret, join(tool, 'data', 'key.txt'));
    writeFileSync(join(tool, 'data', 'blob.bin'), Buffer.from([1, 0, 2]));
    writeFileSync(join(tool, 'data', 'big.txt'), 'x'.repeat(40 * 1024));
    mkdirSync(join(ws, '.lab', 'keep', '../escape'), { recursive: true });
    mkdirSync(join(ws, '.lab', 'keep', 'NotAName'), { recursive: true });
    const r = await lab(['keep', '--dry-run'], { LAB_RUN_REF: 'job-k', LAB_SKILLS_DIR: mkdtempSync(join(tmpdir(), 'sk-')) }, { cwd: ws });
    const rows = r.out.trim().split('\n').map((l) => JSON.parse(l) as { name: string; problems?: string[]; body?: unknown });
    const tool2 = rows.find((x) => x.name === 'rb-ws-cdp-debug-v2')!;
    expect(tool2.body).toBeUndefined();
    expect(tool2.problems).toEqual(expect.arrayContaining([
      'data/key.txt is not a regular file (links are not carried)', 'data/blob.bin is binary (only text is carried)', expect.stringMatching(/^data\/big\.txt is 40960 bytes/),
    ]));
    expect(rows.find((x) => x.name === 'NotAName')!.problems).toEqual(expect.arrayContaining([expect.stringContaining('rb-some-name')]));
    expect(JSON.stringify(rows)).not.toContain('OPENSSH');
    const ts = readKeepFolder(join(ws, '.lab', 'keep'), { runRef: 'job-k' });
    expect(ts.find((x) => x.name === 'rb-ws-cdp-debug-v2')!.body).toBeUndefined();
  });

  it('capture: lab keep files a new-skill proposal with its files, for this run, for a person to review', async () => {
    const ws = keepDir();
    const env = await runEnv('job-keep-1', mkdtempSync(join(tmpdir(), 'sk-')));
    const r = await lab(['keep'], env, { cwd: ws });
    expect(r.out).toMatch(/^proposed: rb-ws-cdp-debug-v2 as prop-[0-9a-f-]+ with 3 file\(s\) — a person reviews it/);
    const [p] = (await store.listProposals({ status: ['open'] })).items;
    expect(p).toEqual(expect.objectContaining({ kind: 'new', proposed_id: 'rb-ws-cdp-debug-v2', status: 'open', source: expect.objectContaining({ kind: 'run', run_ref: 'job-keep-1' }) }));
    expect(p!.proposed_files!.map((f) => f.path)).toEqual(['data/expected-summary.txt', 'data/sample-frames.jsonl', 'scripts/cdp-ws-frames.mjs']);
    // Nothing reached the library: only a person's accept puts it there.
    expect((await loadSkillLibrary(store)).skills.map((k) => k.name)).not.toContain('rb-ws-cdp-debug-v2');
  });

  it('capture: a kept copy of an installed skill is proposed as an edit of it', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    const tool = join(ws, '.lab', 'keep', CDP_RUNBOOK_ID);
    mkdirSync(join(tool, 'scripts'), { recursive: true });
    mkdirSync(join(tool, 'data'), { recursive: true });
    writeFileSync(join(tool, 'SKILL.md'), renderSkill(CDP_RUNBOOK_ID, { ...cdpWebsocketDoc, notes: `${cdpWebsocketDoc.notes} Replays also accept a HAR export converted to JSONL.` }));
    for (const f of bundleFiles(CDP_RUNBOOK_ID)) writeFileSync(join(tool, f.path), f.content, { mode: parseInt(f.mode, 8) });
    const skills = mkdtempSync(join(tmpdir(), 'sk-'));
    const env = await runEnv('job-keep-2', skills);
    await lab(['skills'], env);
    const r = await lab(['keep'], { ...env, LAB_RUN_TOKEN: await mintRunToken('job-keep-2') }, { cwd: ws });
    expect(r.out).toMatch(/^proposed: rb-ws-cdp-debug as prop-/);
    const [p] = (await store.listProposals({ status: ['open'] })).items;
    expect(p).toEqual(expect.objectContaining({ kind: 'edit', runbook_id: CDP_RUNBOOK_ID, base_version: 1 }));
  });
});
