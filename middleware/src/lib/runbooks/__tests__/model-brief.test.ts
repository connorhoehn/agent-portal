// selectRunbooks + assembleBrief + runbookHealth + similarity: the
// deterministic selection rule (design §3.2), the 6,000-token whole-runbook
// budget (decisions 2026-10-14) and the brief's bytes.
import {
  assembleBrief, CONTEXT_CAP_TOKENS, DEFAULT_BRIEF_BUDGET, estimateTokens, findSimilar, MAX_FULL_RUNBOOKS, runbookHealth,
  selectRunbooks, sha256Hex, similarity, versionOf, briefBudget,
} from '../index.js';
import type { AssembleBriefInput, RunbookCandidate, WorkItemContext } from '../index.js';
import type { RunbookApplication, RunbookDoc, RunbookHealth } from '../types.js';
import { flakyRerunDiff, runbookRow, ssoNewOrigin, tenantCutoverV1, tenantCutoverV2 } from './fixtures/good.js';

const NOW = Date.parse('2026-10-14T09:00:00.000Z');
const PROVEN: RunbookHealth = { status: 'proven', reason: 'proven on 2 of 2 runs of v1 (last 2026-10-13).', warning: null };
const UNPROVEN: RunbookHealth = { status: 'unproven', reason: 'v1 has not been run yet.', warning: null };
const DRIFTING: RunbookHealth = { status: 'drifting', reason: 'v1 was followed on 2026-10-10; since then 1 run failed or deviated.', warning: 'Last run failed at step 2: sign-in still pointed to the old service — check that step before relying on it.' };

const idleTeardown: RunbookDoc = {
  ...flakyRerunDiff,
  title: 'Propose an idle-capacity teardown that gets approved',
  summary: 'Write a teardown proposal that names the floor removed and the initiative billed.',
  use_when: ['Idle capacity is costing an initiative money every month.'],
  triggers: { work_item_labels: ['cost', 'teardown'], repos: [], tools: [], keywords: ['idle', 'teardown', 'capacity', 'spend'] },
};

const cand = (id: string, doc: RunbookDoc, scope: RunbookCandidate['runbook']['scope'], health: RunbookHealth, over: Partial<RunbookCandidate['runbook']> = {}, version = 1): RunbookCandidate => ({
  runbook: runbookRow(id, scope, { current_version: version, ...over }),
  version: versionOf({ runbook_id: id, version, doc, author: { kind: 'migration', id: 'migrate-distillation' } }),
  health,
});

const CANDIDATES: RunbookCandidate[] = [
  cand('rb-tenant-cutover', tenantCutoverV1, { kind: 'initiative', ref: 'p-auth-migration' }, DRIFTING),
  cand('rb-sso-new-origin', ssoNewOrigin, { kind: 'initiative', ref: 'p-auth-migration' }, PROVEN),
  cand('rb-flaky-test-rerun-diff', flakyRerunDiff, { kind: 'repo', ref: 'orgiq-observability' }, PROVEN),
  cand('rb-idle-teardown-proposal', idleTeardown, { kind: 'initiative', ref: 'p-cost-opt' }, UNPROVEN),
  cand('rb-draft', tenantCutoverV2, { kind: 'initiative', ref: 'p-auth-migration' }, UNPROVEN, { status: 'draft' }),
  cand('rb-retired', tenantCutoverV2, { kind: 'org', ref: null }, PROVEN, { status: 'retired' }),
];

const WI: WorkItemContext = {
  id: 'wi-auth-e2-s2',
  title: 'Tenant-by-tenant cutover runbook with rollback',
  description: 'Cannot be written until the cutover order is settled — smallest tenant first or riskiest first is still escalated.',
  labels: ['decom', 'runbook', 'blocked'],
  repo: 'connorhoehnslalom/orgiq-auth-service',
  initiative_id: 'p-auth-migration',
  pinned_runbook_ids: [],
};

const briefInput = (over: Partial<AssembleBriefInput> = {}): AssembleBriefInput => ({
  run_ref: 'job-0001',
  assembled_at: '2026-10-14T09:00:00.000Z',
  framing: 'You are running non-interactively. Nobody will answer a question; decide, note the decision, and continue.',
  work_item: { id: WI.id, title: WI.title, kind: 'story', points: 5, description: WI.description, labels: WI.labels, parent_epic: { title: 'Legacy SSO decommission', goal: 'The SAML shim serves zero tenants and is deleted, not paused' } },
  initiative: { id: 'p-auth-migration', name: 'Auth Migration', repo: 'connorhoehnslalom/orgiq-auth-service' },
  decisions: [
    { id: 'd-legacy-auth', title: 'Sunset legacy auth service', status_line: 'resolved 2026-01-30: migrate remaining services off the v1 auth gateway before Q3 2026.', at: '2026-01-30T00:00:00.000Z' },
    { id: 'd-cognito-cutover', title: 'Cutover order for legacy SSO tenants', status_line: 'escalated to an org-leader 2 days ago; not decided. Do not choose an order; write the runbook so the order is a parameter.', at: '2026-10-12T00:00:00.000Z' },
  ],
  runbooks: selectRunbooks(WI, CANDIDATES).selected,
  ...over,
});

describe('selectRunbooks', () => {
  it('picks published, in-scope runbooks and orders them by the design rule', () => {
    const s = selectRunbooks(WI, CANDIDATES);
    expect(s.selected.map((r) => r.runbook_id)).toEqual(['rb-tenant-cutover', 'rb-sso-new-origin']);
    expect(s.excluded).toEqual([
      { runbook_id: 'rb-draft', reason: 'status' },
      { runbook_id: 'rb-flaky-test-rerun-diff', reason: 'scope' },
      { runbook_id: 'rb-idle-teardown-proposal', reason: 'scope' },
      { runbook_id: 'rb-retired', reason: 'status' },
    ]);
    const cut = s.selected[0]!;
    // initiative 2 + 2 × (labels decom, runbook + repo trigger) + 3 × jaccard − 1 drifting
    expect(cut.reasons.slice(0, 3)).toEqual(['initiative p-auth-migration', 'labels decom, runbook', 'triggers on repo orgiq-auth-service']);
    expect(cut.reasons[3]).toMatch(/^keywords .*tenant/);
    expect(cut.score).toBeGreaterThan(s.selected[1]!.score);
  });

  it('pinned runbooks come first even when they score lower, and bypass scope (not status)', () => {
    const s = selectRunbooks({ ...WI, pinned_runbook_ids: ['rb-flaky-test-rerun-diff', 'rb-draft'] }, CANDIDATES);
    expect(s.selected.map((r) => r.runbook_id)).toEqual(['rb-flaky-test-rerun-diff', 'rb-tenant-cutover', 'rb-sso-new-origin']);
    expect(s.selected[0]!.reasons[0]).toBe('pinned on the work item');
    expect(s.excluded.find((e) => e.runbook_id === 'rb-draft')?.reason).toBe('status');
  });

  it('drops an in-scope runbook with no keyword, label or repo hit', () => {
    const s = selectRunbooks({ ...WI, title: 'Rotate the Grafana API key', description: 'Quarterly key rotation.', labels: ['ops'], repo: null }, CANDIDATES);
    expect(s.selected).toEqual([]);
    expect(s.excluded.filter((e) => e.reason === 'no_match').map((e) => e.runbook_id)).toEqual(['rb-sso-new-origin', 'rb-tenant-cutover']);
  });

  it('matches repo scope by basename and tool scope by label', () => {
    const repoWi = { ...WI, repo: 'connorhoehnslalom/orgiq-observability', initiative_id: null, title: 'Flaky test in the trace sink', description: 'Rerun failed once.', labels: ['flaky'] };
    expect(selectRunbooks(repoWi, CANDIDATES).selected.map((r) => r.runbook_id)).toEqual(['rb-flaky-test-rerun-diff']);
    const tool = cand('rb-tool', flakyRerunDiff, { kind: 'tool', ref: 'jest' }, PROVEN);
    expect(selectRunbooks({ ...repoWi, repo: null, labels: ['jest', 'flaky'] }, [tool]).selected.map((r) => r.reasons[0])).toEqual(['tool jest']);
  });

  it('pure: selectRunbooks — same input twice → same sha256, regardless of candidate order', () => {
    const a = sha256Hex(JSON.stringify(selectRunbooks(WI, CANDIDATES)));
    const b = sha256Hex(JSON.stringify(selectRunbooks(WI, [...CANDIDATES].reverse())));
    expect(b).toBe(a);
  });
});

describe('assembleBrief', () => {
  it('assembles task, project, decisions newest first, runbooks whole and how to report back', () => {
    const b = assembleBrief(briefInput());
    expect(b.sections.map((s) => [s.kind, s.ref, s.version ?? null])).toEqual([
      ['framing', null, null], ['work_item', 'wi-auth-e2-s2', null], ['initiative', 'p-auth-migration', null],
      ['decisions', 'd-cognito-cutover,d-legacy-auth', null],
      ['runbook', 'rb-tenant-cutover', 1], ['runbook', 'rb-sso-new-origin', 1], ['how_to_report', null, null],
    ]);
    expect(b.omitted).toEqual([]);
    expect(b.id).toBe('brief-job-0001');
    expect(b.used_tokens).toBe(estimateTokens(b.markdown));
    expect(b.sha256).toBe(sha256Hex(b.markdown));
    expect(b.markdown).toContain(`> Assembled 2026-10-14 for run job-0001 · ${b.used_tokens.toLocaleString('en-US')} of 6,000 tokens · brief-job-0001`);
    expect(b.markdown).toContain('**Tenant-by-tenant cutover runbook with rollback** (story, 5 pts, Auth Migration)');
    expect(b.markdown).toContain('Parent epic: Legacy SSO decommission ("The SAML shim serves zero tenants and is deleted, not paused").');
    expect(b.markdown.indexOf('Cutover order for legacy SSO tenants')).toBeLessThan(b.markdown.indexOf('Sunset legacy auth service'));
    expect(b.markdown).toContain('### 1. Cut one tenant over from SAML to Cognito (rb-tenant-cutover v1)');
    expect(b.markdown).toContain('⚠ Last run failed at step 2: sign-in still pointed to the old service');
    expect(b.markdown).toContain('`lab applied rb-tenant-cutover followed`');
  });

  it('pure: assembleBrief — same input twice → same sha256', () => {
    expect(assembleBrief(briefInput()).sha256).toBe(assembleBrief(briefInput()).sha256);
    expect(JSON.stringify(assembleBrief(briefInput()))).toBe(JSON.stringify(assembleBrief(briefInput())));
  });

  it('brief: never exceeds its budget — at the default, at a tight budget, and with sixty candidates', () => {
    const many: RunbookCandidate[] = Array.from({ length: 60 }, (_, k) => cand(`rb-gen-${String(k).padStart(2, '0')}`, { ...tenantCutoverV2, title: `Cut tenant ${k} over from SAML to Cognito` }, { kind: 'initiative', ref: 'p-auth-migration' }, PROVEN));
    for (const input of [
      briefInput(),
      briefInput({ budget_tokens: 1_200 }),
      briefInput({ runbooks: selectRunbooks(WI, many).selected }),
      briefInput({ runbooks: selectRunbooks(WI, many).selected, budget_tokens: 3_000 }),
    ]) {
      const b = assembleBrief(input);
      expect(b.used_tokens).toBeLessThanOrEqual(b.budget_tokens);
      expect(estimateTokens(b.markdown)).toBe(b.used_tokens);
      expect(b.sections.filter((s) => s.kind === 'runbook').length).toBeLessThanOrEqual(MAX_FULL_RUNBOOKS);
      expect(b.sections.filter((s) => s.kind === 'runbook').length + b.omitted.length).toBe(input.runbooks.length);
    }
    expect(assembleBrief(briefInput({ runbooks: selectRunbooks(WI, many).selected })).sections.filter((s) => s.kind === 'runbook')).toHaveLength(MAX_FULL_RUNBOOKS);
  });

  it('brief: whole runbooks only — an included runbook is verbatim, an omitted one is a pointer', () => {
    const input = briefInput({ budget_tokens: 1_200 });
    const b = assembleBrief(input);
    for (const r of input.runbooks) {
      const included = b.sections.some((s) => s.kind === 'runbook' && s.ref === r.runbook_id);
      if (included) expect(b.markdown).toContain(r.markdown.trimEnd());
      else {
        expect(b.markdown).not.toContain(r.markdown.split('\n')[0]!);
        expect(b.markdown).toContain(`- ${r.title} — \`lab runbook ${r.runbook_id}\``);
        expect(b.omitted).toContainEqual({ runbook_id: r.runbook_id, reason: 'budget' });
      }
    }
    expect(b.omitted.length).toBeGreaterThan(0);
  });

  it('a runbook exactly at the boundary is included; one token less and it is not', () => {
    const one = briefInput({ runbooks: briefInput().runbooks.slice(0, 1) });
    // The header prints the budget, so measure at a budget of the same width.
    let exact = assembleBrief({ ...one, budget_tokens: 100_000 }).used_tokens;
    exact = assembleBrief({ ...one, budget_tokens: exact }).used_tokens;
    const at = assembleBrief({ ...one, budget_tokens: exact });
    expect(at.omitted).toEqual([]);
    expect(at.used_tokens).toBe(exact);
    const under = assembleBrief({ ...one, budget_tokens: exact - 1 });
    expect(under.omitted).toEqual([{ runbook_id: 'rb-tenant-cutover', reason: 'budget' }]);
  });

  it('a pinned runbook too large for the budget is listed, and a later smaller one still fits', () => {
    const big = cand('rb-big', { ...tenantCutoverV2, notes: 'Background.\n\n' + 'Long context line about the cutover. '.repeat(200).trim() }, { kind: 'org', ref: null }, PROVEN);
    const runbooks = selectRunbooks({ ...WI, pinned_runbook_ids: ['rb-big'] }, [...CANDIDATES, big]).selected;
    expect(runbooks[0]!.runbook_id).toBe('rb-big');
    const b = assembleBrief(briefInput({ runbooks, budget_tokens: 2_600 }));
    expect(b.omitted.map((o) => o.runbook_id)).toContain('rb-big');
    expect(b.sections.some((s) => s.kind === 'runbook')).toBe(true);
  });

  it('an empty selection says so', () => {
    const b = assembleBrief(briefInput({ runbooks: [] }));
    expect(b.markdown).toContain('## Runbooks for this work\n\nNo runbooks matched this work.');
    expect(b.sections.some((s) => s.kind === 'runbook')).toBe(false);
  });

  it('context is capped at 1,800 tokens: decisions are dropped whole, oldest first, and the drop is stated', () => {
    const decisions = Array.from({ length: 80 }, (_, k) => ({ id: `d-${String(k).padStart(2, '0')}`, title: `Decision ${k}`, status_line: 'resolved: keep the per-tenant flag until the last tenant is cut over, then delete the shim.', at: `2026-0${1 + (k % 9)}-${String(1 + (k % 28)).padStart(2, '0')}T00:00:00.000Z` }));
    const b = assembleBrief(briefInput({ decisions }));
    const ctx = b.sections.filter((s) => ['framing', 'work_item', 'initiative', 'decisions'].includes(s.kind)).reduce((n, s) => n + s.tokens, 0);
    expect(ctx).toBeLessThanOrEqual(CONTEXT_CAP_TOKENS);
    expect(b.markdown).toMatch(/- \(\d+ older decisions not shown; see the work item\.\)/);
  });

  it('BRIEF_BUDGET_TOKENS overrides the 6,000 default', () => {
    expect(briefBudget({})).toBe(DEFAULT_BRIEF_BUDGET);
    expect(briefBudget({ BRIEF_BUDGET_TOKENS: '4000' })).toBe(4000);
    expect(briefBudget({ BRIEF_BUDGET_TOKENS: 'lots' })).toBe(DEFAULT_BRIEF_BUDGET);
  });
});

describe('runbookHealth', () => {
  const app = (id: string, at: string, outcome: RunbookApplication['outcome'], version = 1, step: number | null = null, note: string | null = null): RunbookApplication =>
    ({ id, runbook_id: 'rb-tenant-cutover', version, run_ref: `job-${id}`, brief_id: `brief-job-${id}`, outcome, failed_at_step: step, note, at });

  it('unproven until a run follows this version to the end', () => {
    expect(runbookHealth([], 1, NOW).status).toBe('unproven');
    const h = runbookHealth([app('a', '2026-10-13T00:00:00Z', 'failed', 1, 2, 'flag flipped but the redirect still resolved to the old domain')], 1, NOW);
    expect(h).toEqual({ status: 'unproven', reason: 'v1: 1 run, none followed it to the end.', warning: 'Last run failed at step 2: flag flipped but the redirect still resolved to the old domain — check that step before relying on it.' });
  });

  it('drifting after a later failure (art-010: succeeded once, then failed at the flip)', () => {
    const h = runbookHealth([app('a', '2026-10-10T00:00:00Z', 'followed'), app('b', '2026-10-13T00:00:00Z', 'failed', 1, 2, 'sign-in still pointed to the old service')], 1, NOW);
    expect(h.status).toBe('drifting');
    expect(h.warning).toBe('Last run failed at step 2: sign-in still pointed to the old service — check that step before relying on it.');
  });

  it('proven inside the window; drifting past it; counted per version', () => {
    const apps = [app('a', '2026-10-01T00:00:00Z', 'failed', 1, 1), app('b', '2026-10-12T00:00:00Z', 'followed'), app('c', '2026-10-13T00:00:00Z', 'followed'), app('d', '2026-10-14T00:00:00Z', 'not_used')];
    expect(runbookHealth(apps, 1, NOW)).toEqual({ status: 'proven', reason: 'proven on 2 of 3 runs of v1 (last 2026-10-13).', warning: null });
    expect(runbookHealth(apps, 1, Date.parse('2026-12-01T00:00:00Z')).status).toBe('drifting');
    expect(runbookHealth(apps, 2, NOW).status).toBe('unproven');
  });
});

describe('similarity', () => {
  it('Jaccard over normalised tokens, symmetric, 1 for identical text, 0 for disjoint', () => {
    expect(similarity('Cut one tenant over', 'cutting over one tenant')).toBe(1);
    expect(similarity('alpha beta', 'gamma delta')).toBe(0);
    expect(similarity('tenant cutover cognito', 'tenant cutover saml')).toBe(similarity('tenant cutover saml', 'tenant cutover cognito'));
  });

  it('flags a near-duplicate new proposal in an overlapping scope, with the shared terms as the reason', () => {
    const near: RunbookDoc = { ...tenantCutoverV1, title: 'Cut a single tenant over to Cognito from SAML' };
    const existing = [
      { runbook_id: 'rb-tenant-cutover', scope: { kind: 'initiative' as const, ref: 'p-auth-migration' }, doc: tenantCutoverV1 },
      { runbook_id: 'rb-sso-new-origin', scope: { kind: 'initiative' as const, ref: 'p-auth-migration' }, doc: ssoNewOrigin },
      { runbook_id: 'rb-elsewhere', scope: { kind: 'initiative' as const, ref: 'p-cost-opt' }, doc: tenantCutoverV1 },
    ];
    const hits = findSimilar(near, { kind: 'initiative', ref: 'p-auth-migration' }, existing);
    expect(hits.map((h) => h.runbook_id)).toEqual(['rb-tenant-cutover']);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(0.5);
    expect(hits[0]!.reason).toMatch(/^shares .*tenant.*cognito|^shares .*cognito.*tenant/);
  });
});
