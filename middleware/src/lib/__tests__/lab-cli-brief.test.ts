// The devbox `lab` CLI against the real routes: `lab brief` (the SessionStart
// hook) signs the lab envelope, presents LAB_RUN_TOKEN, and prints the frozen
// brief's bytes exactly; `lab applied` and `lab propose` report for THIS run.
// The real bash script, real curl, real python signing — only the store is private.

jest.mock('../role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn(async () => null), getProjectDecisions: jest.fn(async () => []) }));

import express from 'express';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { captureRawBody, LAB_CALLBACK_SERVICE_AUTH, resetServiceNonceCache } from '../service-auth.js';
import { createSessionBriefsRouter } from '../../routes/session-briefs.js';
import { createRunbooksRouter } from '../../routes/runbooks.js';
import { errorHandler } from '../async-handler.js';
import { mintRunToken } from '../run-token.js';
import { assembleBrief, renderRunbook, selectRunbooks, type RunbookStore } from '../runbooks/index.js';
import { loadCandidates } from '../session-brief-preview.js';
import { seededStore } from '../../routes/__tests__/runbook-world.js';
import { tenantCutoverV2 } from '../runbooks/__tests__/fixtures/good.js';

const LAB = join(__dirname, '..', '..', '..', '..', 'agents', 'devbox', 'lab');
const SECRET = 'lab-cli-secret';
let store: RunbookStore;
let server: Server;
let base = '';

function lab(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('bash', [LAB, ...args], { env: { PATH: process.env['PATH'] ?? '', HOME: tmpdir(), LAB_API_BASE: base, LAB_CALLBACK_SECRET: SECRET, SERVICE_AUTH_LEGACY_HEADERS: 'refuse', ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

async function freeze(runRef: string) {
  const candidates = await loadCandidates(store, Date.parse('2026-10-14T00:00:00Z'));
  const selected = selectRunbooks({ id: 'wi-1', title: 'Cut one tenant over from SAML to Cognito', description: 'tenant cutover saml cognito', labels: ['cutover'], repo: null, initiative_id: 'p-auth', pinned_runbook_ids: ['rb-tenant-cutover'] }, candidates).selected;
  const b = assembleBrief({ run_ref: runRef, assembled_at: '2026-10-14T00:00:00.000Z', framing: '', work_item: null, initiative: null, decisions: [], runbooks: selected });
  await store.putBrief(b);
  return b;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.use('/api/runbooks', createRunbooksRouter({ store: () => store }));
  app.use('/api', createSessionBriefsRouter({ store: () => store }));
  app.use(errorHandler);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  store = seededStore();
  process.env[LAB_CALLBACK_SERVICE_AUTH.envVar] = SECRET;
  resetServiceNonceCache();
});
afterEach(() => { delete process.env[LAB_CALLBACK_SERVICE_AUTH.envVar]; });

describe('lab brief (the SessionStart hook)', () => {
  it('prints the frozen bytes exactly, signed and bound to the run', async () => {
    const b = await freeze('job-cli-1');
    const r = await lab(['brief'], { LAB_RUN_REF: 'job-cli-1', LAB_RUN_TOKEN: await mintRunToken('job-cli-1') });
    expect(r.code).toBe(0);
    expect(r.out).toBe(b.markdown);
    expect(r.err).not.toContain('WARNING');
  });

  it("another run's token gets nothing, and a session outside a run says so without failing", async () => {
    await freeze('job-cli-1');
    const stolen = await lab(['brief'], { LAB_RUN_REF: 'job-cli-1', LAB_RUN_TOKEN: await mintRunToken('job-cli-2') });
    expect(stolen.code).toBe(0);
    expect(stolen.out).toContain('No session brief could be fetched for run job-cli-1 (HTTP 403)');
    const bare = await lab(['brief'], {});
    expect([bare.code, bare.out.trim()]).toEqual([0, 'No session brief: this session was not started by a dispatched run.']);
  });
});

describe('lab applied / lab propose / lab runbook', () => {
  it('report and propose for this run; the store records them against its brief', async () => {
    await freeze('job-cli-3');
    const env = { LAB_RUN_REF: 'job-cli-3', LAB_RUN_TOKEN: await mintRunToken('job-cli-3'), LAB_SESSION_ID: 'sess-cli' };

    const applied = await lab(['applied', 'rb-tenant-cutover', 'failed', '--step', '2', 'redirect still pointed at the old domain'], env);
    expect(applied.out.trim()).toBe('recorded: rb-tenant-cutover v1 failed');
    expect(await store.listApplications('rb-tenant-cutover')).toEqual([
      expect.objectContaining({ run_ref: 'job-cli-3', brief_id: 'brief-job-cli-3', outcome: 'failed', failed_at_step: 2, note: 'redirect still pointed at the old domain' }),
    ]);

    const dir = mkdtempSync(join(tmpdir(), 'lab-cli-'));
    writeFileSync(join(dir, 'runbook.md'), renderRunbook(tenantCutoverV2));
    const proposed = await lab(['propose', 'rb-tenant-cutover', join(dir, 'runbook.md'), 'The flip needs the callback first.'], env);
    expect(proposed.out).toMatch(/^proposed: prop-/);
    const open = (await store.listProposals({ status: ['open'] })).items;
    expect(open).toEqual([expect.objectContaining({ kind: 'edit', runbook_id: 'rb-tenant-cutover', source: expect.objectContaining({ kind: 'run', run_ref: 'job-cli-3', session_id: 'sess-cli' }) })]);

    const rb = await lab(['runbook', 'rb-tenant-cutover'], env);
    expect(rb.out).toContain('# Cut one tenant over from SAML to Cognito');
  });

  it('outside a run, reporting is a soft no-op', async () => {
    const r = await lab(['applied', 'rb-tenant-cutover', 'followed'], {});
    expect(r.code).toBe(0);
    expect(r.err).toContain('not a dispatched run');
  });
});
