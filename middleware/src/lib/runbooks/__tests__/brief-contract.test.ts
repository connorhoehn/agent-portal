// Contract briefs: three composed briefs pinned byte for byte, so any change to
// what a run is told is a reviewed diff of a file under fixtures/briefs/, not a
// side effect nobody reads (docs/learning-loop-design.md stage 4).
//
//   given-two-runbooks.md   a pinned runbook first, then a drifting one with its warning
//   given-none.md           nothing matched: the brief says so and why
//   previous-attempts.md    a failed earlier run's outcome and obstacles, fenced
//
// The inputs are pure (fixtures/good.ts, a fixed clock and a fixed fence token).
// A deliberate change to the brief: re-record with
//   UPDATE_BRIEF_CONTRACTS=1 npx jest src/lib/runbooks/__tests__/brief-contract.test.ts
// and review the diff of the .md files like any other change.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBrief, noneReason, selectRunbooks, versionOf, type AssembleBriefInput, type RunbookCandidate, type WorkItemContext } from '../index.js';
import type { RunbookDoc, RunbookHealth } from '../types.js';
import { flakyRerunDiff, runbookRow, ssoNewOrigin, tenantCutoverV1 } from './fixtures/good.js';

const DIR = join(__dirname, 'fixtures', 'briefs');
const AT = '2026-10-14T09:00:00.000Z';
const TOKEN = '5f0c1e9a2b7d4c3e8a6f1b0d9c2e7a4b';
const LIB = { sha256: 'c'.repeat(64), dir: '~/.claude/skills', skills: [{ name: 'rb-flaky-test-rerun-diff', version: 1 }, { name: 'rb-sso-new-origin', version: 1 }, { name: 'rb-tenant-cutover', version: 1 }] };
const PROVEN: RunbookHealth = { status: 'proven', reason: 'proven on 2 of 2 runs of v1 (last 2026-10-13).', warning: null };
const DRIFTING: RunbookHealth = { status: 'drifting', reason: 'v1 was followed on 2026-10-10; since then 1 run failed or deviated.', warning: 'Last run failed at step 2: the hosted-UI redirect still pointed at the old domain — check that step before relying on it.' };

const cand = (id: string, doc: RunbookDoc, scope: RunbookCandidate['runbook']['scope'], health: RunbookHealth): RunbookCandidate => ({
  runbook: runbookRow(id, scope, { current_version: 1 }),
  version: versionOf({ runbook_id: id, version: 1, doc, author: { kind: 'migration', id: 'contract' } }),
  health,
});
const LIBRARY: RunbookCandidate[] = [
  cand('rb-tenant-cutover', tenantCutoverV1, { kind: 'initiative', ref: 'p-auth-migration' }, DRIFTING),
  cand('rb-sso-new-origin', ssoNewOrigin, { kind: 'initiative', ref: 'p-auth-migration' }, PROVEN),
  cand('rb-flaky-test-rerun-diff', flakyRerunDiff, { kind: 'repo', ref: 'orgiq-observability' }, PROVEN),
];

function compose(runRef: string, work: WorkItemContext & { kind: string; points: number }, rest: Pick<AssembleBriefInput, 'initiative' | 'decisions'> & Partial<AssembleBriefInput>): string {
  const selection = selectRunbooks(work, LIBRARY);
  return assembleBrief({
    run_ref: runRef, assembled_at: AT, framing: '', fence_token: TOKEN, skill_library: LIB,
    work_item: { id: work.id, title: work.title, kind: work.kind, points: work.points, description: work.description, labels: work.labels },
    runbooks: selection.selected, none_reason: noneReason(selection, LIBRARY.length),
    ...rest,
  }).markdown;
}

const CASES: Record<string, () => string> = {
  'given-two-runbooks': () => compose('job-0101', {
    id: 'wi-auth-e2-s2', kind: 'story', points: 5,
    title: 'Tenant-by-tenant cutover runbook with rollback',
    description: 'Write down the order the remaining customer tenants move in, and the rollback for each. Each tenant moves with the single-tenant cutover procedure.',
    labels: ['decom', 'runbook'], repo: 'connorhoehn/orgiq-auth-service', initiative_id: 'p-auth-migration',
    pinned_runbook_ids: ['rb-sso-new-origin'],
  }, {
    initiative: { id: 'p-auth-migration', name: 'Auth Migration', repo: 'connorhoehn/orgiq-auth-service' },
    decisions: [{ id: 'd-cognito-cutover', title: 'Cutover order for legacy SSO tenants', status_line: 'escalated: not decided. Write the plan so the order is a parameter.', at: '2026-10-12T00:00:00.000Z' }],
  }),
  'given-none': () => compose('job-0102', {
    id: 'wi-obs-e2-s3', kind: 'story', points: 3,
    title: 'Error-budget dashboard per team',
    description: "Show each team's remaining error budget for the month on one page.",
    labels: ['slo'], repo: 'connorhoehn/orgiq-observability', initiative_id: 'p-observability', pinned_runbook_ids: [],
  }, {
    initiative: { id: 'p-observability', name: 'Observability Platform', repo: 'connorhoehn/orgiq-observability' },
    decisions: [],
  }),
  'previous-attempts': () => compose('job-0104', {
    id: 'wi-inf-e1-b3', kind: 'bug', points: 3,
    title: 'Cold-start p99 breaches SLA after scale-to-zero',
    description: 'The first request after scale-to-zero waits 40 to 90 seconds for the model to load.',
    labels: ['latency'], repo: null, initiative_id: 'p-inference-platform', pinned_runbook_ids: [],
  }, {
    initiative: { id: 'p-inference-platform', name: 'Inference Platform', repo: null },
    decisions: [],
    previous_attempts: [{
      run_ref: 'job-0103', outcome: 'failed', failure_code: 'needs_gpu_pool', ended_at: '2026-10-13T16:20:00.000Z',
      summary: 'Stopped before changing anything: reproducing the cold start needs a GPU node pool that scales to zero, and the test account has none.',
      obstacles: ['The cold-start test waits for a GPU node to report ready and times out after ten minutes.'],
      requested_changes: null,
    }],
  }),
};

describe('contract briefs (fixtures/briefs/*.md)', () => {
  for (const [name, make] of Object.entries(CASES)) {
    it(`${name}: the composed brief is byte for byte the recorded one`, () => {
      const file = join(DIR, `${name}.md`);
      const got = make();
      if (process.env['UPDATE_BRIEF_CONTRACTS'] === '1') writeFileSync(file, got);
      const want = readFileSync(file, 'utf8');
      // On a deliberate change, re-record (see the header) and review the .md diff.
      expect(got).toBe(want);
    });
  }

  it('the recorded briefs say what each case is about', () => {
    expect(CASES['given-two-runbooks']!()).toMatch(/### 1\. .*\(rb-sso-new-origin v1\)\nGiven because: pinned on the work item;[\s\S]*### 2\. .*\(rb-tenant-cutover v1\)[\s\S]*Health: drifting\./);
    expect(CASES['given-none']!()).toContain('## Runbooks for this run\nNone were given.');
    expect(CASES['previous-attempts']!()).toMatch(/## Previous attempts on this work item[\s\S]*### 1\. Failed, 2026-10-13 \(run job-0103\)\n<untrusted-5f0c1e9a2b7d4c3e8a6f1b0d9c2e7a4b kind="previous-attempt" source="job-0103">\nFailure code: needs_gpu_pool/);
  });
});
