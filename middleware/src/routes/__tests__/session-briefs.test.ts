// GET /api/runs/:ref/brief (a box with a signed envelope, or a person with
// ViewSessionBrief) and GET /api/work-items/:id/brief-preview.
// Real authz over the seed Cedar matrix; identity/projects/work items mocked.

jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../providers/work-items.js', () => {
  const items: Record<string, unknown> = {
    'wi-auth-1': {
      id: 'wi-auth-1', projectId: 'p-auth', parentId: 'wi-epic', type: 'story', title: 'Cut one tenant over from SAML to Cognito',
      description: 'Move the Acme tenant sign-in to Cognito: tenant cutover from the saml shim.', labels: ['cutover'], storyPoints: 3,
    },
    'wi-epic': { id: 'wi-epic', projectId: 'p-auth', parentId: null, type: 'epic', title: 'Retire the SAML shim', description: null, labels: [], storyPoints: null },
    'wi-auth-2': {
      id: 'wi-auth-2', projectId: 'p-auth', parentId: 'wi-epic', type: 'story', title: 'Cut the second tenant over',
      description: 'Tenant cutover for Globex from the saml shim.', labels: ['cutover'], storyPoints: 2, runbookPins: ['rb-flaky-test-rerun-diff'],
    },
  };
  return {
    getWorkItem: jest.fn(async (id: string) => items[id] ?? null),
    getProjectDecisions: jest.fn(async () => [
      { id: 'd-1', topic: 'Cutover order', summary: 'one tenant at a time', status: 'resolved', requiredRole: null, escalatedAt: null, workItemId: null, workItemTitle: null },
      { id: 'd-2', topic: 'Unrelated', summary: 'x', status: 'open', requiredRole: null, escalatedAt: null, workItemId: 'wi-other', workItemTitle: null },
    ]),
  };
});
jest.mock('../../providers/projects.js', () => ({
  getProject: jest.fn(async (id: string) => jest.requireActual('./runbook-world').PROJECTS[id] ?? null),
}));

import express from 'express';
import { randomBytes } from 'node:crypto';
import request from '../../test-support/http.js';
import { SERVICE_AUTH_HEADER, signServiceRequest } from '@connorhoehn/service-runtime';
import { LAB_CALLBACK_SERVICE_AUTH, SERVICE_NONCE_HEADER, captureRawBody, resetServiceNonceCache } from '../../lib/service-auth.js';
import { createSessionBriefsRouter } from '../session-briefs.js';
import { RUN_TOKEN_HEADER, mintRunToken } from '../../lib/run-token.js';
import { errorHandler } from '../../lib/async-handler.js';
import { briefLibraryOf, loadSkillLibrary, assembleBrief, type RunbookStore } from '../../lib/runbooks/index.js';
import { USERS, seededStore, type TestUser } from './runbook-world.js';
import { RowsRunReportStore, privateRunReportSources, type RunReport, type RunReportStore } from '../../lib/run-reports/index.js';
import { freezeBrief } from '../../lib/run-brief.js';

const SECRET = 'lab-secret';
let store: RunbookStore;
let reports: RunReportStore;

/** A stored report of an earlier run of a work item. */
function report(over: Partial<RunReport> & Pick<RunReport, 'runRef' | 'outcome' | 'endedAt'>): RunReport {
  return {
    workItemId: 'wi-auth-1', initiativeId: 'p-auth', executor: 'local', model: null, startedAt: null,
    failureCode: null, summary: '', changes: { files: [], changeRequestId: null }, verification: [], obstacles: [],
    runbooksOffered: [], runbooksUsed: [], cost: { billedUsd: 0, reportedUsd: null, basis: 'unknown' }, kept: [],
    selfReport: 'ok', briefId: null, createdAt: over.endedAt, ...over,
  };
}

function appAs(user: TestUser | null) {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.use((req, _res, next) => {
    if (user) (req as unknown as { session: unknown }).session = { sub: user.sub, role: user.role, tenant: user.tenant, grants: { [user.tenant]: [user.role] }, iat: 0 };
    else (req as unknown as { sessionInvalid: boolean }).sessionInvalid = true;
    next();
  });
  app.use('/api', createSessionBriefsRouter({ store: () => store, reports: () => reports }));
  app.use(errorHandler);
  return app;
}

function boxHeaders(method: string, target: string, over: { secret?: string; nonce?: string; runToken?: string } = {}): Record<string, string> {
  const nonce = over.nonce ?? randomBytes(18).toString('base64url');
  return {
    [SERVICE_AUTH_HEADER]: signServiceRequest({ method, target, body: '' }, { secret: over.secret ?? SECRET, serviceId: 'orgiq-devbox', audience: `orgiq-middleware/lab#${nonce}` }),
    [SERVICE_NONCE_HEADER]: nonce,
    ...(over.runToken ? { [RUN_TOKEN_HEADER]: over.runToken } : {}),
  };
}

async function freeze(runRef: string) {
  const brief = assembleBrief({
    run_ref: runRef, assembled_at: '2026-10-14T00:00:00.000Z', framing: '',
    work_item: { id: 'wi-auth-1', title: 'Cut one tenant over', description: 'x', labels: [] },
    initiative: { id: 'p-auth', name: 'Auth Migration' }, decisions: [], skill_library: briefLibraryOf(await loadSkillLibrary(store)),
  });
  await store.putBrief(brief);
  return brief;
}

beforeEach(() => {
  store = seededStore();
  reports = new RowsRunReportStore(privateRunReportSources());
  process.env[LAB_CALLBACK_SERVICE_AUTH.envVar] = SECRET;
  resetServiceNonceCache();
});
afterEach(() => { delete process.env[LAB_CALLBACK_SERVICE_AUTH.envVar]; });

describe('GET /api/runs/:ref/brief', () => {
  it('a box with a valid envelope gets the frozen bytes, and the sha matches', async () => {
    const brief = await freeze('job-1');
    const runToken = await mintRunToken('job-1');
    const target = '/api/runs/job-1/brief?format=markdown';
    const res = await request(appAs(null)).get(target).set(boxHeaders('GET', target, { runToken }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['x-brief-sha256']).toBe(brief.sha256);
    expect(res.text).toBe(brief.markdown);

    const jsonTarget = '/api/runs/job-1/brief';
    const json = await request(appAs(null)).get(jsonTarget).set(boxHeaders('GET', jsonTarget, { runToken }));
    expect(json.body.brief.sha256).toBe(brief.sha256);
    expect(json.body.brief.sections.some((s: { kind: string; ref: string }) => s.kind === 'skill_library')).toBe(true);
  });

  it('a box without a valid envelope is refused: none, wrong secret, wrong target, replayed', async () => {
    await freeze('job-1');
    await freeze('job-2');
    const anon = appAs(null);
    expect((await request(anon).get('/api/runs/job-1/brief')).status).toBe(401);
    const wrongSecret = '/api/runs/job-1/brief';
    expect((await request(anon).get(wrongSecret).set(boxHeaders('GET', wrongSecret, { secret: 'not-it' }))).status).toBe(401);
    // An envelope signed for job-2 cannot read job-1.
    expect((await request(anon).get('/api/runs/job-1/brief').set(boxHeaders('GET', '/api/runs/job-2/brief'))).status).toBe(401);
    // A spent nonce is spent.
    const headers = boxHeaders('GET', wrongSecret, { runToken: await mintRunToken('job-1') });
    expect((await request(anon).get(wrongSecret).set(headers)).status).toBe(200);
    expect((await request(anon).get(wrongSecret).set(headers)).status).toBe(401);
    // The legacy static header does not unlock a read of a run's brief when the transition is closed.
    process.env['SERVICE_AUTH_LEGACY_HEADERS'] = 'refuse';
    try {
      expect((await request(anon).get(wrongSecret).set('x-lab-auth', SECRET)).status).toBe(401);
    } finally { delete process.env['SERVICE_AUTH_LEGACY_HEADERS']; }
  });

  it('with no secret configured a box is NOT let in (the route never opens)', async () => {
    await freeze('job-1');
    delete process.env[LAB_CALLBACK_SERVICE_AUTH.envVar];
    const target = '/api/runs/job-1/brief';
    expect((await request(appAs(null)).get(target).set(boxHeaders('GET', target))).status).toBe(401);
  });

  it('a person with ViewSessionBrief reads it (every orgiq role holds it); one without is refused', async () => {
    const brief = await freeze('job-1');
    for (const who of [USERS.member!, USERS.smeAuth!, USERS.programOwner!, USERS.leader!, USERS.hr!, USERS.admin!]) {
      const res = await request(appAs(who)).get('/api/runs/job-1/brief');
      expect(res.status).toBe(200);
      expect(res.body.brief.sha256).toBe(brief.sha256);
    }
    const denied = await request(appAs(USERS.strayAssessor!)).get('/api/runs/job-1/brief');
    expect(denied.status).toBe(403);
    expect(denied.body.action).toBe('ViewSessionBrief');
    expect((await request(appAs(USERS.assessor!)).get('/api/runs/job-1/brief')).status).toBe(403); // another tenant
    expect((await request(appAs(null)).get('/api/runs/job-1/brief')).status).toBe(401);
  });

  it('serves markdown on Accept, 404s a run with no frozen brief, and marks the response immutable', async () => {
    const brief = await freeze('job-1');
    const md = await request(appAs(USERS.member!)).get('/api/runs/job-1/brief').set('accept', 'text/markdown');
    expect(md.text).toBe(brief.markdown);
    expect(md.headers['etag']).toBe(`"${brief.sha256}"`);
    expect(md.headers['cache-control']).toContain('immutable');
    const none = await request(appAs(USERS.member!)).get('/api/runs/job-none/brief');
    expect(none.status).toBe(404);
    expect(none.body.code).toBe('NO_BRIEF');
  });
});

describe('GET /api/work-items/:id/brief-preview', () => {
  it('assembles what a box would get, without storing it', async () => {
    const res = await request(appAs(USERS.member!)).get('/api/work-items/wi-auth-1/brief-preview');
    expect(res.status).toBe(200);
    expect(res.body.stored).toBe(false);
    const { brief } = res.body;
    expect(brief.run_ref).toBe('preview-wi-auth-1');
    expect(brief.markdown).toContain('Cut one tenant over from SAML to Cognito');
    expect(brief.markdown).toContain('Cutover order'); // the settled project decision binds
    expect(brief.markdown).not.toContain('Unrelated'); // another work item's open decision does not
    expect(brief.markdown).toContain('Retire the SAML shim'); // the parent epic
    // Stage 4: the chosen runbook is given as text, with its reason; the library is still installed.
    expect(res.body.offer.runbooks).toEqual([expect.objectContaining({ id: 'rb-tenant-cutover', version: 1, pinned: false, reason: expect.stringMatching(/^labels cutover; shares .*tenant/) })]);
    expect(brief.offer).toEqual(res.body.offer);
    expect(brief.sections.filter((s: { kind: string }) => s.kind === 'runbook').map((s: { ref: string }) => s.ref)).toEqual(['rb-tenant-cutover']);
    expect(brief.markdown).toMatch(/<untrusted-[0-9a-f]{32} kind="runbook" source="rb-tenant-cutover v1">\n# Cut one tenant over from SAML to Cognito/);
    expect(brief.markdown).toContain('installed in `~/.claude/skills`');
    expect(brief.skill_library.skills.map((k: { name: string }) => k.name)).toContain('rb-tenant-cutover');
    expect(res.body.pins).toEqual([]);
    expect(res.body.previous_attempts).toEqual([]);
    expect(await store.getBrief('preview-wi-auth-1')).toBeNull();
    // The same bytes for the same world, but for the fence token, which every preview draws afresh.
    const again = await request(appAs(USERS.member!)).get('/api/work-items/wi-auth-1/brief-preview');
    const untokened = (md: string) => md.replace(/untrusted-[0-9a-f]{32}/g, 'untrusted-T');
    expect(untokened(again.body.brief.markdown)).toBe(untokened(brief.markdown));
    expect(again.body.brief.markdown.match(/untrusted-([0-9a-f]{32})/)![1]).not.toBe(brief.markdown.match(/untrusted-([0-9a-f]{32})/)![1]);
  });

  it('lists in-scope runbooks that were passed over, never the ones given', async () => {
    const res = await request(appAs(USERS.member!)).get('/api/work-items/wi-auth-1/brief-preview');
    const given = res.body.offer.runbooks.map((r: { id: string }) => r.id);
    expect(Array.isArray(res.body.passed_over)).toBe(true);
    for (const p of res.body.passed_over) {
      expect(given).not.toContain(p.id);
      expect(p).toEqual({ id: expect.any(String), name: expect.any(String), kind: expect.stringMatching(/^(no_match|limit|budget|drifting_excluded)$/), reason: expect.stringMatching(/\.$/) });
    }
  });

  it("a person's pin comes first, ahead of the selector's own choice", async () => {
    const res = await request(appAs(USERS.member!)).get('/api/work-items/wi-auth-2/brief-preview');
    expect(res.body.pins).toEqual(['rb-flaky-test-rerun-diff']);
    expect(res.body.offer.runbooks.map((r: { id: string; pinned: boolean }) => [r.id, r.pinned])).toEqual([['rb-flaky-test-rerun-diff', true], ['rb-tenant-cutover', false]]);
    expect(res.body.offer.runbooks[0].reason).toMatch(/^pinned on the work item/);
  });

  it('carries the previous attempts that failed, were cancelled or were sent back, newest first, fenced in the markdown', async () => {
    await reports.putReport(report({ runRef: 'job-a', outcome: 'failed', failureCode: 'exit_1', endedAt: '2026-10-10T00:00:00.000Z', summary: 'Stopped at the flip.', obstacles: ['The callback URL was missing from the app client.'] }));
    await reports.putReport(report({ runRef: 'job-b', outcome: 'done', endedAt: '2026-10-11T00:00:00.000Z', summary: 'Done.' }));
    await reports.putReport(report({ runRef: 'job-c', outcome: 'cancelled', failureCode: 'claim_lost', endedAt: '2026-10-12T00:00:00.000Z' }));
    await reports.putReport(report({ runRef: 'job-z', workItemId: 'wi-other', outcome: 'failed', endedAt: '2026-10-13T00:00:00.000Z' }));
    const res = await request(appAs(USERS.member!)).get('/api/work-items/wi-auth-1/brief-preview');
    expect(res.body.previous_attempts.map((a: { run_ref: string; outcome: string }) => [a.run_ref, a.outcome])).toEqual([['job-c', 'cancelled'], ['job-a', 'failed']]);
    expect(res.body.previous_attempts[1]).toEqual({
      run_ref: 'job-a', outcome: 'failed', failure_code: 'exit_1', ended_at: '2026-10-10T00:00:00.000Z',
      summary: 'Stopped at the flip.', obstacles: ['The callback URL was missing from the app client.'], requested_changes: null,
    });
    expect(res.body.brief.previous_attempts.map((a: { run_ref: string }) => a.run_ref)).toEqual(['job-c', 'job-a']);
    expect(res.body.brief.markdown).toMatch(/### 2\. Failed, 2026-10-10 \(run job-a\)\n<untrusted-[0-9a-f]{32} kind="previous-attempt" source="job-a">\nFailure code: exit_1\nSummary: Stopped at the flip\.\nObstacles:\n- The callback URL was missing/);
  });

  it('preview and freeze agree: one function computes both (the offer, the attempts, the bytes)', async () => {
    await reports.putReport(report({ runRef: 'job-a', outcome: 'failed', endedAt: '2026-10-10T00:00:00.000Z', obstacles: ['Sign-in failed on the shim.'] }));
    const preview = (await request(appAs(USERS.member!)).get('/api/work-items/wi-auth-2/brief-preview')).body;
    const frozen = await freezeBrief({ run_ref: 'job-new', box: 'devbox', work_item_id: 'wi-auth-2' }, { store, reports });
    expect(frozen.offer).toEqual(preview.offer);
    expect(frozen.previous_attempts).toEqual(preview.brief.previous_attempts);
    expect(frozen.omitted).toEqual(preview.brief.omitted);
    const norm = (md: string, ref: string) => md.replace(/untrusted-[0-9a-f]{32}/g, 'untrusted-T').split(ref).join('RUN')
      .replace(/ · [\d,]+ of /, ' · N of ');
    expect(norm(frozen.markdown, 'job-new')).toBe(norm(preview.brief.markdown, 'preview-wi-auth-2'));
    expect(await store.getBrief('job-new')).toEqual(frozen);
  });

  it('every published skill reaches every box: the preview records the whole library, whatever the work item', async () => {
    const res = await request(appAs(USERS.smeAuth!)).get('/api/work-items/wi-auth-1/brief-preview');
    const published = (await store.listRunbooks({ status: ['published'], limit: 200 })).items.map((r) => r.id).sort();
    expect(res.body.brief.skill_library.skills.map((k: { name: string }) => k.name).sort()).toEqual(published);
  });

  it('404s an unknown work item; refuses an anonymous caller, a box envelope, and a role without ViewSessionBrief', async () => {
    expect((await request(appAs(USERS.member!)).get('/api/work-items/wi-nope/brief-preview')).status).toBe(404);
    expect((await request(appAs(null)).get('/api/work-items/wi-auth-1/brief-preview')).status).toBe(401);
    const target = '/api/work-items/wi-auth-1/brief-preview';
    expect((await request(appAs(null)).get(target).set(boxHeaders('GET', target))).status).toBe(401); // people only
    expect((await request(appAs(USERS.strayAssessor!)).get(target)).status).toBe(403);
  });
});

