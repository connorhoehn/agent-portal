// The skills demo director (mock/runbooks-tools-demo.ts, R8) told end to end over
// real HTTP against the real runbooks router: a run on Auth Migration keeps a
// websocket-over-CDP harness, the capture path proposes it with its files, an
// SME on Auth Migration accepts it through the real ReviewRunbook gate and the
// steward rule, the org library's sha moves, and a box running ANOTHER
// initiative's work installs the new skill and runs the harness from it.
//
// Then the same delivery through the real box: `lab skills` (the bash CLI, curl,
// python) syncs the library for Dex's run with the lab envelope and its run token,
// and the harness runs from the folder it installed.
jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    auth: { policyStoreId: '', sessionSigningSecretArn: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    cognito: { portalOrigin: '' },
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
  },
}));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn(async () => []) }));

import express from 'express';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fixtureRegistry } from '../core/index.js';
import { createRunbooksRouter } from '../../routes/runbooks.js';
import { createSessionBriefsRouter } from '../../routes/session-briefs.js';
import { errorHandler } from '../../lib/async-handler.js';
import { runbookStore } from '../../lib/runbooks/store-select.js';
import { loadSkillLibrary } from '../../lib/runbooks/index.js';
import { clearAuthzCache } from '../../lib/authz.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { captureRawBody, LAB_CALLBACK_SERVICE_AUTH, resetServiceNonceCache } from '../../lib/service-auth.js';
import { mintRunToken } from '../../lib/run-token.js';
import { startRunbooksToolsDemo, resetRunbooksToolsDemo, getRunbooksToolsDemoState } from '../runbooks-tools-demo.js';
import { BUILD_RUN, SKILL_ID, USE_RUN } from '../runbooks-tools-demo-script.js';
import { cdpWebsocketDoc } from '../runbook-bundles.js';

const PEOPLE: Record<string, { role: string }> = { 'u-vera': { role: 'org-leader' }, 'u-nora': { role: 'sme' }, 'u-eli': { role: 'sme' } };
const SECRET = 'tools-demo-secret';
const LAB = join(__dirname, '..', '..', '..', '..', 'agents', 'devbox', 'lab');

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.post('/api/session/login', (req, res) => {
    const userId = (req.body as { userId?: string }).userId ?? '';
    res.setHeader('set-cookie', ['demo-session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', `demo-session=${userId}; Path=/; HttpOnly`]);
    res.json({ sub: userId });
  });
  app.use((req, _res, next) => {
    const who = /^demo-session=(u-[a-z]+)$/.exec(req.headers.cookie ?? '')?.[1];
    const p = who ? PEOPLE[who] : undefined;
    if (who && p) (req as unknown as { session: unknown }).session = { sub: who, role: p.role, tenant: 'orgiq', grants: { orgiq: [p.role] }, iat: 0 };
    next();
  });
  app.use('/api/runbooks', createRunbooksRouter({ store: () => runbookStore() }));
  app.use('/api', createSessionBriefsRouter({ store: () => runbookStore() }));
  app.use(errorHandler);
  return app;
}

let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer(buildApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  resetRunbooksToolsDemo();
  fixtureRegistry.resetAll('default');
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  fixtureRegistry.resetAll('runbooks-tools-demo');
  resetRunbooksToolsDemo();
  clearAuthzCache();
  resetRateLimits();
  process.env[LAB_CALLBACK_SERVICE_AUTH.envVar] = SECRET;
  resetServiceNonceCache();
});
afterEach(() => { delete process.env[LAB_CALLBACK_SERVICE_AUTH.envVar]; });

describe('the skills demo director (runbooks-tools-demo)', () => {
  it('demo: reaches done — a run keeps the CDP harness, an SME accepts it, the library moves, another initiative\'s box runs it', async () => {
    const store = runbookStore();
    expect((await loadSkillLibrary(store)).skills.map((k) => k.name)).not.toContain(SKILL_ID);

    await startRunbooksToolsDemo(base, { paceMs: Number(process.env['DEMO_PACE_MS'] ?? 200) });
    const s = getRunbooksToolsDemoState();
    expect(s.errors).toEqual([]);
    expect(s.phase).toBe('done');
    expect(s.milestones).toEqual({ firstBrief: true, kept: true, proposed: true, accepted: true, libraryChanged: true, installed: true, ranHarness: true });
    expect(s.proposedFiles).toEqual(['data/expected-summary.txt', 'data/sample-frames.jsonl', 'scripts/cdp-ws-frames.mjs']);
    // Captured on Auth Migration, used on Observability: scope never gated it.
    expect(s.first!.initiative).toBe('p-auth-migration');
    expect(s.second!.initiative).toBe('p-observability');
    expect(s.libraryAfter).not.toBe(s.libraryBefore);
    expect(s.boxSkills).toContain(SKILL_ID);
    expect(s.harnessOutput).toBe('replay-ok');

    // The skill is org-wide with Auth Migration as its area, accepted by the SME, not the dispatcher.
    const rb = (await store.getRunbook(SKILL_ID))!;
    expect(rb).toEqual(expect.objectContaining({ scope: { kind: 'org', ref: null }, area: 'p-auth-migration', status: 'published' }));
    const proposal = (await store.getProposal(s.proposalId!))!;
    expect(proposal.decided_by).toBe('p-004');
    expect(proposal.source.dispatched_by).toBe(BUILD_RUN.by);

    // The real box: `lab skills` for Dex's run installs the new library, then the harness runs from it.
    const dir = mkdtempSync(join(tmpdir(), 'dex-skills-'));
    const token = await mintRunToken(USE_RUN.runRef);
    const synced = await new Promise<string>((resolve) => {
      let o = '';
      const p = spawn('bash', [LAB, 'skills'], { env: { PATH: process.env['PATH'] ?? '', HOME: tmpdir(), LAB_API_BASE: base, LAB_CALLBACK_SECRET: SECRET, SERVICE_AUTH_LEGACY_HEADERS: 'refuse', LAB_SKILLS_DIR: dir, LAB_RUN_REF: USE_RUN.runRef, LAB_RUN_TOKEN: token } });
      p.stdout.on('data', (d) => { o += String(d); });
      p.on('close', () => resolve(o));
    });
    expect(synced).toContain(`skills: installed the org's library ${s.libraryAfter!.slice(0, 12)}`);
    expect(readdirSync(dir)).toContain(SKILL_ID);
    const ran = execFileSync('bash', ['-c', cdpWebsocketDoc.verify[0]!.command!.text], { cwd: join(dir, SKILL_ID), encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
    expect(ran.trim()).toBe('replay-ok');
  });
});
