// The definition registry (lib/pipeline-definitions.ts) — pure. The judge's
// claim: every source row yields exactly one definition, over the same
// registered fixtures dev:mock serves, and the approval projection reads the
// existing gates without inventing a store.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import {
  deriveDefinitions, definitionIdFor, isRunbookCandidate, runbookSteps, runbookInitiative,
  effectiveApproverRoles, canDecide, validApproverRoles, projectApprovals, latestDryRun, dryRunPrompt,
  consultAnswer, runStatusForJob, commandOwner,
  type DefinitionSources, type PipelineRunRecord,
} from '../pipeline-definitions.js';
import { MOCK_BOTS } from '../../providers/bots.js';
import { AGENT_COMMANDS } from '../../providers/assessment.js';
import { promotionCandidates } from '../../mock/promotions.js';
import { agentFleet } from '../../mock/agent-statuses.js';
import { pipelineDefinitionRows } from '../../mock/pipeline-definitions.js';

// The real launchable set: the nine seeded commands plus the two deck commands.
const EXPECTED_COMMANDS = [
  'classify-transcript', 'develop-jira-story', 'draft-confluence-page', 'draft-review-deck',
  'draw-diagram', 'extract-enterprise-context', 'process-self-assessment', 'revise-review-deck',
  'score-dimensions', 'suggest-confluence-content', 'validate-outputs',
].sort();

function fixtureSources(): DefinitionSources {
  return {
    bots: MOCK_BOTS,
    commands: AGENT_COMMANDS,
    runbooks: promotionCandidates.rows(),
    agents: agentFleet.rows(),
    stored: pipelineDefinitionRows.rows(),
  };
}

describe('deriveDefinitions — every source row yields exactly one definition', () => {
  const src = fixtureSources();
  const defs = deriveDefinitions(src);
  const ids = defs.map((d) => d.id);

  it('the fixtures are not empty (a vacuous pass proves nothing)', () => {
    expect(src.bots.length).toBeGreaterThan(0);
    expect(src.commands.map((c) => c.name).sort()).toEqual(EXPECTED_COMMANDS);
    expect(src.runbooks.filter(isRunbookCandidate).length).toBeGreaterThan(0);
    expect(src.agents.length).toBeGreaterThan(0);
  });

  it('ids are unique', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each bot is exactly one bot definition', () => {
    for (const b of src.bots) expect(ids.filter((i) => i === definitionIdFor.bot(b.id))).toHaveLength(1);
    expect(defs.filter((d) => d.kind === 'bot')).toHaveLength(src.bots.length);
  });

  it('each assessment command is exactly one assessment-command definition', () => {
    for (const c of src.commands) expect(ids.filter((i) => i === definitionIdFor.command(c.name))).toHaveLength(1);
    expect(defs.filter((d) => d.kind === 'assessment-command')).toHaveLength(EXPECTED_COMMANDS.length);
    expect(defs.filter((d) => d.kind === 'assessment-command').every((d) => d.contextTenant === 'assessment')).toBe(true);
  });

  it('each candidate on the RUNBOOK rung is exactly one runbook definition; an insight is none', () => {
    const rung = src.runbooks.filter(isRunbookCandidate);
    for (const c of rung) expect(ids.filter((i) => i === definitionIdFor.runbook(c.id))).toHaveLength(1);
    expect(defs.filter((d) => d.kind === 'runbook')).toHaveLength(rung.length);
    for (const c of src.runbooks.filter((x) => !isRunbookCandidate(x))) {
      expect(ids).not.toContain(definitionIdFor.runbook(c.id));
    }
  });

  it('each agent is exactly one agent definition', () => {
    for (const a of src.agents) expect(ids.filter((i) => i === definitionIdFor.agent(a.id))).toHaveLength(1);
    expect(defs.filter((d) => d.kind === 'agent')).toHaveLength(src.agents.length);
  });

  it('the total is the sum of the sources — nothing added, nothing dropped', () => {
    expect(defs).toHaveLength(src.bots.length + src.commands.length + src.runbooks.filter(isRunbookCandidate).length + src.agents.length);
  });

  it('a recorded version merges over its derived definition by id (the seeded commands are v1, recorded)', () => {
    const cmd = defs.find((d) => d.id === 'assessment:score-dimensions')!;
    expect(cmd.recorded).toBe(true);
    expect(cmd.owner).toBe('u-ines');
    expect(cmd.version).toBe(1);
  });

  it('a recorded row with no source is listed as orphaned, never dropped', () => {
    const out = deriveDefinitions({ ...fixtureSources(), stored: [{
      id: 'bot:gone', contextTenant: 'orgiq', kind: 'bot', title: 'Retired bot', owner: null, version: 3,
      approverRoles: ['pipeline-admin'], sourceTable: 'agent_bots', sourceId: 'gone', updatedBy: 'u-ines', updatedAt: null,
    }] });
    const orphan = out.find((d) => d.id === 'bot:gone');
    expect(orphan).toMatchObject({ orphaned: true, recorded: true, enabled: false, version: 3 });
  });

  it('a cron bot carries its schedule trigger and the manual fire every bot has', () => {
    const cron = src.bots.find((b) => b.trigger === 'cron')!;
    const d = defs.find((x) => x.id === definitionIdFor.bot(cron.id))!;
    expect(d.triggers.map((t) => t.type)).toEqual(['schedule', 'manual']);
    expect(d.triggers[0]!.detail).toContain(String(cron.cronExpr));
    expect(d.steps.map((s) => s.id).slice(0, 4)).toEqual(['trigger', 'enqueue', 'claim', 'execute']);
  });

  it('a pr_watch bot carries a webhook trigger', () => {
    const d = deriveDefinitions({ ...fixtureSources(), bots: [{
      id: 'b1', name: 'PR watcher', prompt: 'Review', model: 'm', trigger: 'pr_watch', cronExpr: null, enabled: true,
      requiresReview: true, orgProjectId: null, agentProjectRepo: 'org/repo', createdBy: null,
    }] }).find((x) => x.id === 'bot:b1')!;
    expect(d.triggers[0]).toEqual({ type: 'webhook', detail: 'pull requests on org/repo' });
    expect(d.steps.at(-1)!.id).toBe('review');
  });
});

describe('runbook steps and money context', () => {
  const c = promotionCandidates.rows().find((x) => x.id === 'promo-aurora-cold-start')!;

  it('its ordered steps are its observations, oldest first', () => {
    const steps = runbookSteps(c);
    expect(steps.map((s) => s.id)).toEqual(['obs-aurora-1', 'obs-aurora-2', 'obs-aurora-3']);
    expect(steps.map((s) => s.detail)).toEqual(['Recognise', 'Decide', 'Apply']);
  });

  it('the initiative the brakes judge is the one most observations name, or none', () => {
    expect(runbookInitiative(c)).toBeNull();
    expect(runbookInitiative({ observations: [
      { id: 'a', kind: 'worked', title: '', createdAt: '', initiativeId: 'p-soc2', repo: null },
      { id: 'b', kind: 'worked', title: '', createdAt: '', initiativeId: 'p-soc2', repo: null },
      { id: 'c', kind: 'worked', title: '', createdAt: '', initiativeId: 'p-finops', repo: null },
    ] })).toBe('p-soc2');
  });

  it('the dry-run prompt forbids writes and lists every step', () => {
    const prompt = dryRunPrompt({ id: 'runbook:x', title: 'X', version: 2, steps: runbookSteps(c) });
    expect(prompt).toMatch(/Do not change files/);
    expect(prompt).toMatch(/PASS/);
    expect(prompt.split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(3);
  });

  it('commands are owned by the agent whose tools they use', () => {
    expect(commandOwner({ name: 'score-dimensions', summary: '', allowed_tools: ['classify_evidence', 'score_dimension'] })).toBe('orgiq-assessment-scorer');
    expect(commandOwner({ name: 'draw-diagram', summary: '', allowed_tools: ['check_story_draft'] })).toBe('orgiq-assessment-drafter');
  });
});

describe('dry-run records', () => {
  const rec = (id: string, status: PipelineRunRecord['status'], startedAt: string, definitionId = 'runbook:a'): PipelineRunRecord => ({
    id, definitionId, contextTenant: 'orgiq', runKind: 'runbook:dry-run', status, jobId: null, triggeredBy: null,
    model: null, estimateUsd: null, costUsd: null, error: null, startedAt, finishedAt: null,
  });

  it('latestDryRun prefers the newest completed run, then the newest of any status, of that definition only', () => {
    const rows = [rec('r1', 'completed', '2026-09-01'), rec('r2', 'failed', '2026-09-02'), rec('r3', 'completed', '2026-09-03', 'runbook:b')];
    expect(latestDryRun(rows, 'runbook:a')?.id).toBe('r1');
    expect(latestDryRun([rec('r2', 'failed', '2026-09-02')], 'runbook:a')?.id).toBe('r2');
    expect(latestDryRun(rows, 'runbook:none')).toBeNull();
  });

  it('a record reads its job through the run crosswalk', () => {
    expect(runStatusForJob('queued')).toBe('pending');
    expect(runStatusForJob('claimed')).toBe('running');
    expect(runStatusForJob('done')).toBe('completed');
    expect(runStatusForJob('failed')).toBe('failed');
    expect(runStatusForJob('cancelled')).toBe('cancelled');
  });
});

describe('approvers — design §8: nobody named means an operator', () => {
  it('an empty approver list falls back to the tenant default', () => {
    expect(effectiveApproverRoles({ approverRoles: [] })).toEqual({ roles: ['operator'], defaulted: true });
    expect(effectiveApproverRoles(null, 'pipeline-admin')).toEqual({ roles: ['pipeline-admin'], defaulted: true });
    expect(effectiveApproverRoles({ approverRoles: ['pipeline-admin'] })).toEqual({ roles: ['pipeline-admin'], defaulted: false });
  });

  it('pipeline-admin and admin decide anything; operator only what names it; author never', () => {
    expect(canDecide('operator', ['operator'])).toBe(true);
    expect(canDecide('operator', ['pipeline-admin'])).toBe(false);
    expect(canDecide('pipeline-admin', ['operator'])).toBe(true);
    expect(canDecide('admin', ['operator'])).toBe(true);
    expect(canDecide('author', ['operator'])).toBe(false);
    expect(canDecide(undefined, ['operator'])).toBe(false);
  });

  it('an approver list may name only roles that hold ApproveStep', () => {
    expect(validApproverRoles(['operator', 'operator'])).toEqual(['operator']);
    expect(validApproverRoles(['author'])).toBeNull();
    expect(validApproverRoles('operator')).toBeNull();
    expect(validApproverRoles([])).toEqual([]);
  });
});

describe('projectApprovals — pipeline.approval.requested off the existing gates', () => {
  const approvals = projectApprovals({
    jobs: [
      { id: 'j1', title: 'Fix flaky test', status: 'awaiting_review', finishedAt: '2026-09-30T10:00:00Z', boxId: 'box-1', createdBy: null },
      { id: 'j2', title: 'Done job', status: 'done', finishedAt: '2026-09-30T09:00:00Z', boxId: null, createdBy: null },
    ],
    changes: [
      { id: 'c1', runId: 'pr-1', title: 'Bump dep', status: 'needs_approval', createdAt: '2026-09-30T11:00:00Z', repoFullName: 'org/repo', filesChanged: 2 },
      { id: 'c2', runId: null, title: 'Delivered', status: 'delivered', createdAt: '2026-09-30T08:00:00Z' },
    ],
    consults: [
      { id: 'k1', question: 'Smallest-first or riskiest-first?', context: 'wi-1', status: 'pending', createdAt: '2026-09-30T12:00:00Z', boxId: 'box-2', repo: null, initiativeId: null },
      { id: 'k2', question: 'Old', context: null, status: 'answered', createdAt: '2026-09-29T12:00:00Z', boxId: null, repo: null, initiativeId: null },
    ],
    runs: [
      { id: 'job:j1', definitionId: 'bot:b1', status: 'awaiting_approval', context: { table: 'agent_jobs', id: 'j1', title: 'nightly bot' } },
      { id: 'project-run:pr-1', definitionId: 'project:p1', status: 'completed', context: { table: 'agent_project_runs', id: 'pr-1', title: 'run' } },
      { id: 'job:j9', definitionId: 'runbook:x', status: 'running', context: { table: 'agent_jobs', id: 'j9', boxId: 'box-2', title: 'dry' } },
    ],
    definitions: [{ id: 'bot:b1', approverRoles: ['pipeline-admin'] }],
  });

  it('lists only what waits on a person — one per gate, newest first', () => {
    expect(approvals.map((a) => a.id)).toEqual(['consult:k1', 'change:c1', 'job:j1']);
    expect(approvals.every((a) => a.type === 'pipeline.approval.requested')).toBe(true);
  });

  it('names the step that asked and the run it belongs to', () => {
    expect(approvals.find((a) => a.id === 'job:j1')).toMatchObject({ runId: 'job:j1', stepId: 'review', definitionId: 'bot:b1' });
    expect(approvals.find((a) => a.id === 'change:c1')).toMatchObject({ runId: 'project-run:pr-1', stepId: 'gate' });
    expect(approvals.find((a) => a.id === 'consult:k1')).toMatchObject({ runId: 'job:j9', stepId: 'execute' });
  });

  it("uses the definition's approvers, else the default operator", () => {
    expect(approvals.find((a) => a.id === 'job:j1')).toMatchObject({ requiredRoles: ['pipeline-admin'], rolesDefaulted: false });
    expect(approvals.find((a) => a.id === 'change:c1')).toMatchObject({ requiredRoles: ['operator'], rolesDefaulted: true });
  });

  it('routes each to its existing decision path', () => {
    expect(approvals.find((a) => a.id === 'job:j1')!.decidedThrough).toBe('the job review');
    expect(approvals.find((a) => a.id === 'change:c1')!.decidedThrough).toBe('the change review');
    expect(approvals.find((a) => a.id === 'consult:k1')!.decidedThrough).toBe('the question put to a person');
  });

  it('a consult answer carries the decision and the note', () => {
    expect(consultAnswer('approve', '  smallest first ')).toBe('Approved — smallest first');
    expect(consultAnswer('reject', null)).toBe('Rejected');
  });
});
