// R8 over HTTP: a runbook that carries files (scripts/, data/) and becomes a
// skill in the ONE org-wide library.
//
//   proposing   files are untrusted: traversal/absolute paths and oversize bundles
//               are refused (422 FILES); a SKILL.md-shaped draft parses; secrets in
//               file contents block an accept (lint R-secrets).
//   reviewing   GET /api/runbooks/proposals/:pid shows the file diff (git-style, as
//               text); accept writes a version carrying the files and a bundle sha.
//   stewards    a captured tool is org scope with an AREA (the initiative it came
//               from): the org-leader, or an SME on that area, accepts; an SME
//               elsewhere does not; the run's dispatcher never does.
//   delivery    GET /api/runs/:ref/skills: envelope + this run's token, the whole
//               library with every file, 304 on an unchanged sha; GET /api/skill-library
//               is the manifest for people, without file bytes.

jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../providers/identity.js', () => ({
  getUser: jest.fn(async (sub: string) => {
    const { personOf } = jest.requireActual('./runbook-world');
    return { personId: personOf(sub) };
  }),
}));
jest.mock('../../providers/projects.js', () => ({
  getProject: jest.fn(async (id: string) => jest.requireActual('./runbook-world').PROJECTS[id] ?? null),
}));
jest.mock('../../providers/work-items.js', () => ({
  getWorkItem: jest.fn(async (id: string) => (id === 'wi-auth-1' ? { id, projectId: 'p-auth' } : null)),
  getProjectDecisions: jest.fn(async () => []),
}));

import express from 'express';
import { randomBytes } from 'node:crypto';
import request from '../../test-support/http.js';
import { SERVICE_AUTH_HEADER, signServiceRequest } from '@connorhoehn/service-runtime';
import { LAB_CALLBACK_SERVICE_AUTH, SERVICE_NONCE_HEADER, captureRawBody, resetServiceNonceCache } from '../../lib/service-auth.js';
import { RUN_TOKEN_HEADER, mintRunToken } from '../../lib/run-token.js';
import { createRunbooksRouter } from '../runbooks.js';
import { createSessionBriefsRouter } from '../session-briefs.js';
import { errorHandler } from '../../lib/async-handler.js';
import { assembleBrief, briefLibraryOf, loadSkillLibrary, renderSkill, type RunbookStore } from '../../lib/runbooks/index.js';
import { USERS, seededStore, type TestUser } from './runbook-world.js';
import { cdpWebsocketDoc, bundleFiles, CDP_RUNBOOK_ID } from '../../mock/runbook-bundles.js';

const SECRET = 'lab-secret';
let store: RunbookStore;

function appAs(user: TestUser | null) {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.use((req, _res, next) => {
    if (user) (req as unknown as { session: unknown }).session = { sub: user.sub, role: user.role, tenant: user.tenant, grants: { [user.tenant]: [user.role] }, iat: 0 };
    else (req as unknown as { sessionInvalid: boolean }).sessionInvalid = true;
    next();
  });
  app.use('/api/runbooks', createRunbooksRouter({ store: () => store }));
  app.use('/api', createSessionBriefsRouter({ store: () => store }));
  app.use(errorHandler);
  return app;
}

function boxHeaders(method: string, target: string, body = '', runToken?: string): Record<string, string> {
  const nonce = randomBytes(18).toString('base64url');
  return {
    [SERVICE_AUTH_HEADER]: signServiceRequest({ method, target, body }, { secret: SECRET, serviceId: 'orgiq-devbox', audience: `orgiq-middleware/lab#${nonce}` }),
    [SERVICE_NONCE_HEADER]: nonce,
    'content-type': 'application/json',
    ...(runToken ? { [RUN_TOKEN_HEADER]: runToken } : {}),
  };
}

const NAME = 'rb-ws-frames-harness';
const skillMd = () => renderSkill(NAME, { ...cdpWebsocketDoc, steps: cdpWebsocketDoc.steps.map((s, i) => (i === 0 ? { ...s, command: { lang: 'bash' as const, text: `cd ~/.claude/skills/${NAME}` } } : s)) });
const files = () => bundleFiles(CDP_RUNBOOK_ID).map(({ path, content, mode }) => ({ path, content, mode }));

async function freeze(runRef: string, by: string | null, workItem: string | null = 'wi-auth-1') {
  const lib = await loadSkillLibrary(store);
  await store.putBrief({
    ...assembleBrief({ run_ref: runRef, assembled_at: '2026-10-15T00:00:00.000Z', framing: '', work_item: workItem ? { id: workItem, title: 'Debug the realtime page', description: 'x', labels: [] } : null, initiative: null, decisions: [], skill_library: briefLibraryOf(lib) }),
    dispatched_by: by,
  });
}

/** A run keeps the CDP harness and files it (the `lab keep` body), signed and bound to its run. */
async function boxProposes(runRef: string, extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({ kind: 'new', skill_md: skillMd(), files: files(), rationale: 'Kept by the run.', source: { run_ref: runRef, session_id: 's', lab_experience_ids: [] }, ...extra });
  return request(appAs(null)).post('/api/runbooks/proposals').set(boxHeaders('POST', '/api/runbooks/proposals', body, await mintRunToken(runRef))).send(body);
}

beforeEach(() => {
  store = seededStore();
  process.env[LAB_CALLBACK_SERVICE_AUTH.envVar] = SECRET;
  resetServiceNonceCache();
});
afterEach(() => { delete process.env[LAB_CALLBACK_SERVICE_AUTH.envVar]; });

describe('proposing files', () => {
  it('capture: a run files a SKILL.md draft with its files; the proposal carries them and lints clean', async () => {
    await freeze('job-cap-1', 'p-101');
    const res = await boxProposes('job-cap-1');
    expect(res.status).toBe(201);
    expect(res.body.proposal).toEqual(expect.objectContaining({ kind: 'new', proposed_id: NAME, source: expect.objectContaining({ kind: 'run', work_item_id: 'wi-auth-1', dispatched_by: 'p-101' }) }));
    // A list shows the manifest, not the bytes.
    expect(res.body.proposal.proposed_files.map((f: { path: string; content?: string }) => [f.path, f.content])).toEqual([
      ['data/expected-summary.txt', undefined], ['data/sample-frames.jsonl', undefined], ['scripts/cdp-ws-frames.mjs', undefined],
    ]);
    expect(res.body.proposal.lint.filter((f: { severity: string }) => f.severity === 'error')).toEqual([]);
  });

  it.each([
    ['a path that climbs out', [{ path: 'scripts/../../.ssh/authorized_keys', content: 'x' }], 'climbs out'],
    ['an absolute path', [{ path: '/etc/passwd', content: 'x' }], 'absolute'],
    ['a path outside scripts/ and data/', [{ path: 'bin/x', content: 'x' }], 'not under scripts/'],
    ['a hidden file', [{ path: 'data/.env', content: 'x' }], 'segment'],
    ['an oversized file', [{ path: 'data/big.txt', content: 'x'.repeat(33 * 1024) }], 'limit per file'],
    ['a binary file', [{ path: 'data/a.bin', content: 'a\u0000b' }], 'NUL'],
  ])('files: refuses %s with 422 FILES', async (_label, bad, why) => {
    const res = await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({ kind: 'new', skill_md: skillMd(), files: [...files(), ...bad], rationale: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FILES');
    expect(res.body.problems.join(' ')).toContain(why);
  });

  it('files: secrets in a file block the accept (R-secrets over contents)', async () => {
    const leaky = files().map((f) => (f.path === 'data/sample-frames.jsonl' ? { ...f, content: f.content.replace('<redacted>', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LXZlcmEiLCJpYXQiOjE3fQ.c2lnbmF0dXJlc2lnbmF0dXJl') } : f));
    const created = await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({ kind: 'new', skill_md: skillMd(), files: leaky, rationale: 'x', source: { work_item_id: 'wi-auth-1' } });
    expect(created.status).toBe(201);
    expect(created.body.proposal.lint).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'R-secrets', path: 'files[data/sample-frames.jsonl]' })]));
    const accepted = await request(appAs(USERS.leader!)).post(`/api/runbooks/proposals/${created.body.proposal.id}/accept`).send({});
    expect(accepted.status).toBe(422);
    expect(accepted.body.code).toBe('LINT');
  });
});

describe('reviewing and accepting', () => {
  it('review: the detail shows the file diff as git-style text, and the proposed files', async () => {
    await freeze('job-cap-2', 'p-101');
    const pid = (await boxProposes('job-cap-2')).body.proposal.id;
    const res = await request(appAs(USERS.smeAuth!)).get(`/api/runbooks/proposals/${pid}`);
    expect(res.status).toBe(200);
    expect(res.body.files_diff.text).toContain('diff --git a/scripts/cdp-ws-frames.mjs b/scripts/cdp-ws-frames.mjs\nnew file mode 100755\n--- /dev/null\n+++ b/scripts/cdp-ws-frames.mjs');
    expect(res.body.files_diff.files.map((f: { path: string; status: string }) => [f.path, f.status])).toEqual([
      ['data/expected-summary.txt', 'added'], ['data/sample-frames.jsonl', 'added'], ['scripts/cdp-ws-frames.mjs', 'added'],
    ]);
    expect(res.body.proposed_files).toHaveLength(3);
    expect(res.body.can_review).toBe(true); // an SME on the area the tool was captured on
  });

  it('stewards: an SME on the area accepts a captured tool into the org library; the version carries the files', async () => {
    await freeze('job-cap-3', 'p-103');
    const pid = (await boxProposes('job-cap-3')).body.proposal.id;
    // An SME on another initiative is not this skill's steward; the dispatcher never is.
    expect((await request(appAs(USERS.smeOther!)).post(`/api/runbooks/proposals/${pid}/accept`).send({})).status).toBe(403);
    expect((await request(appAs(USERS.proposer!)).post(`/api/runbooks/proposals/${pid}/accept`).send({})).body.code).toBe('SELF_ACCEPT');
    expect((await request(appAs(USERS.member!)).post(`/api/runbooks/proposals/${pid}/accept`).send({})).status).toBe(403);
    const before = (await loadSkillLibrary(store)).sha256;
    const ok = await request(appAs(USERS.smeAuth!)).post(`/api/runbooks/proposals/${pid}/accept`).send({ note: 'Every realtime team wants this.' });
    expect(ok.status).toBe(201);
    expect(ok.body.runbook).toEqual(expect.objectContaining({ id: NAME, scope: { kind: 'org', ref: null }, area: 'p-auth', status: 'published' }));
    expect(ok.body.version.files.map((f: { path: string }) => f.path)).toEqual(['data/expected-summary.txt', 'data/sample-frames.jsonl', 'scripts/cdp-ws-frames.mjs']);
    expect(ok.body.version.bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
    const after = await loadSkillLibrary(store);
    expect(after.sha256).not.toBe(before);
    expect(after.skills.map((k) => k.name)).toContain(NAME);
    // The versions list shows a manifest, not bytes.
    const versions = await request(appAs(USERS.member!)).get(`/api/runbooks/${NAME}/versions`);
    expect(versions.body.versions[0].files[0].content).toBeUndefined();
  });

  it('stewards: the org-leader accepts a captured tool from any area', async () => {
    await freeze('job-cap-4', 'p-101');
    const pid = (await boxProposes('job-cap-4')).body.proposal.id;
    expect((await request(appAs(USERS.leader!)).post(`/api/runbooks/proposals/${pid}/accept`).send({})).status).toBe(201);
  });

  it('files: an edit that sends no files keeps the base\'s; files: [] removes them', async () => {
    await freeze('job-cap-5', 'p-101');
    const pid = (await boxProposes('job-cap-5')).body.proposal.id;
    await request(appAs(USERS.leader!)).post(`/api/runbooks/proposals/${pid}/accept`).send({});
    const md = renderSkill(NAME, { ...cdpWebsocketDoc, notes: `${cdpWebsocketDoc.notes} Keep the capture short.`, steps: cdpWebsocketDoc.steps.map((s, i) => (i === 0 ? { ...s, command: { lang: 'bash' as const, text: `cd ~/.claude/skills/${NAME}` } } : s)) });
    const keep = await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({ kind: 'edit', runbook_id: NAME, skill_md: md, rationale: 'Note.' });
    expect(keep.status).toBe(201);
    expect(keep.body.proposal.proposed_files).toHaveLength(3);
    const detail = await request(appAs(USERS.member!)).get(`/api/runbooks/proposals/${keep.body.proposal.id}`);
    expect(detail.body.files_diff.text).toBe('');
    const drop = await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({ kind: 'edit', runbook_id: NAME, skill_md: md, files: [], rationale: 'No files.' });
    const d2 = await request(appAs(USERS.member!)).get(`/api/runbooks/proposals/${drop.body.proposal.id}`);
    expect(d2.body.files_diff.files.every((f: { status: string }) => f.status === 'deleted')).toBe(true);
    // Without its script, the procedure's commands point at nothing: lint says so.
    expect(drop.body.proposal.lint.map((f: { rule: string }) => f.rule)).toContain('R-command-real');
  });
});

describe('delivery', () => {
  it('library: a box gets every published skill with its files for its own run, and a 304 when unchanged', async () => {
    await freeze('job-lib-1', null);
    const target = '/api/runs/job-lib-1/skills';
    const res = await request(appAs(null)).get(target).set(boxHeaders('GET', target, '', await mintRunToken('job-lib-1')));
    expect(res.status).toBe(200);
    const lib = await loadSkillLibrary(store);
    expect(res.body.sha256).toBe(lib.sha256);
    expect(res.headers['x-skill-library-sha256']).toBe(lib.sha256);
    expect(res.body.files.every((f: { content: string }) => typeof f.content === 'string')).toBe(true);
    const again = await request(appAs(null)).get(target).set({ ...boxHeaders('GET', target, '', await mintRunToken('job-lib-1')), 'if-none-match': `"${lib.sha256}"` });
    expect(again.status).toBe(304);
    // Another run's token, or no envelope, gets nothing.
    expect((await request(appAs(null)).get(target).set(boxHeaders('GET', target, '', await mintRunToken('job-other')))).status).toBe(403);
    expect((await request(appAs(null)).get(target)).status).toBe(401);
  });

  it('library: people read the manifest without file bytes', async () => {
    const res = await request(appAs(USERS.member!)).get('/api/skill-library');
    expect(res.status).toBe(200);
    expect(res.body.skills.length).toBeGreaterThan(0);
    expect(res.body.files.every((f: { content?: string }) => f.content === undefined)).toBe(true);
    expect((await request(appAs(null)).get('/api/skill-library')).status).toBe(401);
  });
});
