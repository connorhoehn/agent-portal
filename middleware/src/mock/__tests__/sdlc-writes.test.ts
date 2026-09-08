// The SDLC governance pipeline offline — capture → review → gate → decide.
//
// Every write on providers/sdlc.ts called `exec()` raw, and `exec` reaches the
// RDS Data API whatever `config.mock.aurora` says, so in dev:mock the whole
// surface 500'd: creating or deleting a policy, recording a review, re-running
// the gates, deciding a change. Rule 4's GET-only wire capture could not see
// any of it.
//
// These tests go through the PROVIDER, because the provider is where the
// missing branch was, and they assert the floor's contract rather than merely
// that a row appeared:
//
//   1. The mock honours the statement it stands in for — the list query joins
//      no reviews, so the offline list carries none either; the detail query
//      does, in the orders its two ORDER BYs specify.
//   2. Nothing decidable is stored. A seeded change's status and its gates are
//      both the real engine's output over the seeded facts, so the fixture
//      cannot claim a status its own gates contradict — which the fixture it
//      replaces did, along with a gate outcome the schema's CHECK forbids.
//   3. Timestamps are sampled at write time, so freezing the clock moves them.
//   4. A write is undone by the scenario control plane, not by a restart.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true, agentcore: true }, region: 'us-east-1' } }));

import { fixtureRegistry, freezeClock } from '../core/index.js';
import { sdlcChanges, sdlcChangeGates, sdlcChangeReviews, sdlcPolicies } from '../sdlc.js';
import { agentProjects } from '../agent-projects.js';
import {
  createChangeRequest, decideChange, deletePolicy, evaluateChange,
  getChangeRequest, hasNewerChangeForProject, listChangeRequests, listPolicies,
  listReviews, markDelivered, markFailed, markInReview, recordReview,
  seedDefaultPolicies, setCommitSha, upsertPolicy,
} from '../../providers/sdlc.js';

const OBSERVABILITY = '4870e01d-9274-5c4a-91af-ea9acb7f857a';
const NEEDS_APPROVAL = '9f2c17a0-5b64-4de1-8a03-6c1de4f27b58';
const CHANGES_REQUESTED = 'a03d28b1-6c75-4ef2-9b14-7d2ef5083c69';
const DELIVERED = 'b14e39c2-7d86-4f03-ac25-8e3f06194d7a';

/** Every status `agent_change_requests`' CHECK constraint allows. */
const STATUSES = new Set([
  'captured', 'in_review', 'changes_requested', 'blocked', 'needs_approval',
  'approved', 'delivering', 'delivered', 'rejected', 'failed',
]);
/** Every outcome `agent_change_gates`' CHECK constraint allows. */
const GATE_OUTCOMES = new Set(['pass', 'requires_approval', 'block']);
/** Every verdict `agent_change_reviews`' CHECK constraint allows. */
const VERDICTS = new Set(['approve', 'request_changes', 'reject']);

beforeEach(() => {
  sdlcPolicies.reset('default');
  sdlcChanges.reset('default');
  sdlcChangeReviews.reset('default');
  sdlcChangeGates.reset('default');
  agentProjects.reset('default');
});

afterEach(() => { jest.restoreAllMocks(); });

describe('the seeded queue', () => {
  it('only spells values the schema permits', async () => {
    for (const change of await listChangeRequests()) {
      expect(STATUSES.has(change.status)).toBe(true);
      const detail = await getChangeRequest(change.id);
      for (const gate of detail!.gates) expect(GATE_OUTCOMES.has(gate.outcome)).toBe(true);
      for (const review of detail!.reviews) expect(VERDICTS.has(review.verdict)).toBe(true);
    }
  });

  it('points every change at a codebase agent_projects actually links', async () => {
    const linked = new Set(agentProjects.rows().map((p) => p.id));
    for (const change of await listChangeRequests()) {
      expect(linked.has(change.projectId)).toBe(true);
      // The list JOINs agent_projects, so the repo name is resolved, not stored.
      expect(change.repoFullName).toBe('connorhoehnslalom/orgiq-observability');
      expect(change.orgProjectName).toBe('Observability Platform');
    }
  });

  it('gives a status no gate of its own contradicts', async () => {
    // The bug this replaces: a change hand-typed `needs_approval` beside gates
    // that all read `pass`. Re-running the engine over the seeded facts must
    // land on the status the seed already claims.
    for (const id of [NEEDS_APPROVAL, CHANGES_REQUESTED]) {
      const before = await getChangeRequest(id);
      const evaluated = await evaluateChange(id);
      expect(evaluated?.status).toBe(before!.status);
    }
  });

  it('names only policies that exist, and pins each gate to one', async () => {
    const byId = new Map((await listPolicies()).map((p) => [p.id, p]));
    const change = await getChangeRequest(NEEDS_APPROVAL);
    expect(change!.gates.length).toBeGreaterThan(0);
    for (const gate of change!.gates) {
      const named = [...byId.values()].find((p) => p.name === gate.policyName);
      expect(named).toBeDefined();
      expect(gate.kind).toBe(named!.kind);
    }
  });

  it('lists newest capture first, the way ORDER BY cr.created_at DESC does', async () => {
    const stamps = (await listChangeRequests()).map((c) => new Date(c.createdAt).getTime());
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
  });

  it('carries no reviews or gates in the LIST, because the list query joins neither', async () => {
    for (const change of await listChangeRequests()) {
      expect(change.reviews).toEqual([]);
      expect(change.gates).toEqual([]);
    }
    // ...and the detail query does join them.
    expect((await getChangeRequest(NEEDS_APPROVAL))!.reviews).toHaveLength(1);
  });

  it('filters `open` to the states the schema indexes as open', async () => {
    const open = await listChangeRequests({ open: true });
    expect(open.map((c) => c.id)).toEqual([NEEDS_APPROVAL, CHANGES_REQUESTED]);
    expect(open.map((c) => c.id)).not.toContain(DELIVERED);
  });

  it('pins each review finding to a line the diff really contains', async () => {
    // The reviewer surface pins a note to the diff line it names, so a finding
    // aimed at a line the diff lacks silently exercises nothing.
    for (const id of [NEEDS_APPROVAL, CHANGES_REQUESTED]) {
      const change = await getChangeRequest(id);
      for (const finding of change!.reviews[0]!.findings) {
        expect(change!.files).toContain(finding.file);
      }
    }
  });
});

describe('policies offline', () => {
  it('creates, updates in place, and deletes', async () => {
    const before = (await listPolicies()).length;

    const created = await upsertPolicy({
      name: 'Only Nova may ship', enabled: true, kind: 'model_allowlist',
      config: { models: ['amazon.nova-pro-v1:0'] }, action: 'block',
    });
    expect((await listPolicies())).toHaveLength(before + 1);

    const updated = await upsertPolicy({
      id: created.id, name: 'Only Nova may ship', enabled: false,
      kind: 'model_allowlist', config: { models: [] }, action: 'require_approval',
    });
    // An update, not an insert: same id, same count.
    expect(updated.id).toBe(created.id);
    expect(updated.enabled).toBe(false);
    expect(await listPolicies()).toHaveLength(before + 1);

    expect(await deletePolicy(created.id)).toBe(true);
    expect(await deletePolicy(created.id)).toBe(false);
    expect(await listPolicies()).toHaveLength(before);
  });

  it('mints uuids, so the DELETE route can address what the list returned', async () => {
    // `deletePolicy` refuses a non-uuid id before it reaches a row. Under the
    // old `default-0` ids every offline delete 404'd, which read as "the
    // policy is not there" rather than "this id was never deletable".
    for (const policy of await listPolicies()) {
      expect(policy.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('rejects an update to a policy that is not there, as the RETURNING does', async () => {
    await expect(upsertPolicy({
      id: '00000000-0000-4000-8000-000000000000', name: 'ghost', enabled: true,
      kind: 'max_files', config: { max: 1 }, action: 'block',
    })).rejects.toThrow('policy not found');
  });

  it('seeds an empty policy set and is then a no-op', async () => {
    // An operator who deleted every rule — the state `seedDefaultPolicies`
    // exists to repair, and the one the old `return 0` could never leave.
    sdlcPolicies.rows().length = 0;
    expect(await listPolicies()).toEqual([]);
    expect(await seedDefaultPolicies()).toBe(4);
    expect(await listPolicies()).toHaveLength(4);
    expect(await seedDefaultPolicies()).toBe(0);
  });

  it('fails CLOSED with no policies: an unpoliced change is not auto-approved', async () => {
    // `evaluateChange` seeds before evaluating, so the only way to reach the
    // empty-policy arm is a seed that fails — emptied AFTER the seed runs.
    // A fresh array per call, so the seed's writes land nowhere — which is
    // what "seeding raced or failed" looks like from `evaluateChange`.
    jest.spyOn(sdlcPolicies, 'rows').mockImplementation(() => []);
    const evaluated = await evaluateChange(CHANGES_REQUESTED);
    expect(evaluated?.status).toBe('needs_approval');
    expect(evaluated?.evaluation.autoApproved).toBe(false);
    expect(evaluated?.evaluation.gates.map((g) => g.policyName)).toContain('no policies configured');
  });
});

describe('capturing a change offline', () => {
  it('inserts a captured change the queue then shows', async () => {
    const created = await createChangeRequest({
      projectId: OBSERVABILITY, runId: null, title: 'Add a p99 panel',
      diff: 'diff --git a/x.ts b/x.ts\n+one\n', files: ['x.ts'], model: 'us.anthropic.claude-sonnet-5',
    });
    expect(created.status).toBe('captured');
    expect(created.filesChanged).toBe(1);
    // `INSERT ... RETURNING *` returns the row, not the reads' joins.
    expect(created.repoFullName).toBeNull();
    expect(created.orgProjectName).toBeNull();

    // ...but a read joins them.
    const read = await getChangeRequest(created.id);
    expect(read!.repoFullName).toBe('connorhoehnslalom/orgiq-observability');
    expect((await listChangeRequests({ open: true })).map((c) => c.id)).toContain(created.id);
  });

  it('stamps createdAt from the clock, not from wall time', async () => {
    const restore = freezeClock('2026-03-01T09:00:00.000Z');
    const created = await createChangeRequest({
      projectId: OBSERVABILITY, title: 'Frozen', diff: 'd', files: ['a.ts'],
    });
    restore();
    expect(created.createdAt).toBe('2026-03-01T09:00:00.000Z');
  });

  it('truncates an oversized diff rather than refusing the change', async () => {
    const created = await createChangeRequest({
      projectId: OBSERVABILITY, title: 'Huge', diff: 'x'.repeat(200_001), files: ['a.ts', 'b.ts'],
    });
    expect(created.diffTruncated).toBe(true);
    expect(created.diff).toHaveLength(200_000);
    expect(created.filesChanged).toBe(2);
  });

  it('records the capture commit', async () => {
    const created = await createChangeRequest({
      projectId: OBSERVABILITY, title: 'Committed', diff: 'd', files: ['a.ts'],
    });
    await setCommitSha(created.id, 'a'.repeat(40));
    expect((await getChangeRequest(created.id))!.commitSha).toBe('a'.repeat(40));
  });

  it('makes every earlier capture for that codebase undeliverable', async () => {
    // Delivery ships the live workspace and a codebase has one, so only the
    // newest capture matches what is on disk.
    expect(await hasNewerChangeForProject(NEEDS_APPROVAL)).toBe(false);
    expect(await hasNewerChangeForProject(CHANGES_REQUESTED)).toBe(true);

    await createChangeRequest({ projectId: OBSERVABILITY, title: 'Newer', diff: 'd', files: ['a.ts'] });
    expect(await hasNewerChangeForProject(NEEDS_APPROVAL)).toBe(true);
  });
});

describe('review and gate offline', () => {
  it('appends a review rather than overwriting, newest first', async () => {
    await recordReview({
      changeId: CHANGES_REQUESTED, model: 'amazon.nova-pro-v1:0', verdict: 'approve',
      summary: 'Fixed on the second pass.', findings: [],
    });
    const reviews = await listReviews(CHANGES_REQUESTED);
    expect(reviews).toHaveLength(2);
    // ORDER BY created_at DESC — and `evaluateChange` reads reviews[0], so the
    // wrong order here would gate on a stale verdict.
    expect(reviews[0]!.verdict).toBe('approve');
    expect(reviews[1]!.verdict).toBe('request_changes');
  });

  it('re-evaluates on the newest verdict, and rewrites the gates rather than appending', async () => {
    const before = await getChangeRequest(CHANGES_REQUESTED);
    expect(before!.status).toBe('changes_requested');

    await recordReview({
      changeId: CHANGES_REQUESTED, model: 'amazon.nova-pro-v1:0', verdict: 'approve',
      summary: 'Addressed.', findings: [],
    });
    const evaluated = await evaluateChange(CHANGES_REQUESTED);
    expect(evaluated?.status).toBe('approved');

    const after = await getChangeRequest(CHANGES_REQUESTED);
    expect(after!.status).toBe('approved');
    // One row per firing policy — not one per re-evaluation.
    expect(after!.gates).toHaveLength(1);
    expect(after!.gates[0]!.outcome).toBe('pass');
  });

  it('routes a protected-path change to a human even with an approving review', async () => {
    const evaluated = await evaluateChange(NEEDS_APPROVAL);
    expect(evaluated?.status).toBe('needs_approval');
    const gate = evaluated!.evaluation.gates.find((g) => g.kind === 'protected_paths');
    expect(gate?.outcome).toBe('requires_approval');
    expect(gate?.detail).toContain('infra/alerting/inhibit.tf');
  });

  it('returns null for a change that is not there', async () => {
    expect(await evaluateChange('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('the human decision offline', () => {
  it('approves, and the decision is durable in the queue', async () => {
    const restore = freezeClock('2026-03-01T09:00:00.000Z');
    const out = await decideChange(NEEDS_APPROVAL, 'approve', { by: 'u-hr', note: 'Reviewed with on-call.' });
    restore();
    expect(out).toEqual({ ok: true, status: 'approved' });

    // The old offline arm mutated the object it had just READ, so the queue
    // never moved. Re-reading is the whole assertion.
    const change = await getChangeRequest(NEEDS_APPROVAL);
    expect(change!.status).toBe('approved');
    expect(change!.decidedBy).toBe('u-hr');
    expect(change!.decidedAt).toBe('2026-03-01T09:00:00.000Z');
    expect(change!.decisionNote).toBe('Reviewed with on-call.');
  });

  it('lets a human overrule a reviewer that asked for changes', async () => {
    expect(await decideChange(CHANGES_REQUESTED, 'approve', {})).toEqual({ ok: true, status: 'approved' });
  });

  it('refuses a change that is not awaiting one', async () => {
    expect(await decideChange(DELIVERED, 'reject', {})).toEqual({
      ok: false, error: 'change is delivered, not awaiting a decision',
    });
    await decideChange(NEEDS_APPROVAL, 'approve', {});
    expect((await decideChange(NEEDS_APPROVAL, 'approve', {})).ok).toBe(false);
  });

  it('refuses a change that is not there', async () => {
    expect(await decideChange('00000000-0000-4000-8000-000000000000', 'approve', {}))
      .toEqual({ ok: false, error: 'change not found' });
  });
});

describe('the delivery lifecycle offline', () => {
  it('records the branch and PR a delivery produced', async () => {
    await markDelivered(NEEDS_APPROVAL, 'agent/x', 'https://github.com/o/r/pull/9');
    const change = await getChangeRequest(NEEDS_APPROVAL);
    expect(change!.status).toBe('delivered');
    expect(change!.branchName).toBe('agent/x');
    expect(change!.prUrl).toBe('https://github.com/o/r/pull/9');
  });

  it('records a failure on the change rather than losing it', async () => {
    await markInReview(NEEDS_APPROVAL);
    expect((await getChangeRequest(NEEDS_APPROVAL))!.status).toBe('in_review');
    await markFailed(NEEDS_APPROVAL, 'push rejected');
    const change = await getChangeRequest(NEEDS_APPROVAL);
    expect(change!.status).toBe('failed');
    expect(change!.error).toBe('push rejected');
  });

  it('is silent about an id it does not hold, as `UPDATE ... WHERE id` is', async () => {
    await expect(markInReview('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();
  });
});

describe('the scenario control plane owns every write', () => {
  it('puts the seeded world back after a decision, a policy edit and a capture', async () => {
    const policies = (await listPolicies()).length;
    const changes = (await listChangeRequests()).length;

    await decideChange(NEEDS_APPROVAL, 'approve', { by: 'u-hr', note: 'x' });
    await upsertPolicy({ name: 'temp', enabled: true, kind: 'max_files', config: { max: 1 }, action: 'block' });
    await createChangeRequest({ projectId: OBSERVABILITY, title: 'temp', diff: 'd', files: ['a.ts'] });
    await recordReview({ changeId: NEEDS_APPROVAL, verdict: 'reject', summary: null, findings: [] });

    sdlcPolicies.reset();
    sdlcChanges.reset();
    sdlcChangeReviews.reset();
    sdlcChangeGates.reset();

    expect(await listPolicies()).toHaveLength(policies);
    expect(await listChangeRequests()).toHaveLength(changes);
    expect((await getChangeRequest(NEEDS_APPROVAL))!.status).toBe('needs_approval');
    expect(await listReviews(NEEDS_APPROVAL)).toHaveLength(1);
  });

  it('has an empty world to render an empty queue from', async () => {
    // A no-argument `rows()` resolves to the REGISTRY's world, so asking for
    // the empty one is a registry switch — not `reset('empty')`, which only
    // drops that world's materialised rows.
    fixtureRegistry.resetAll('empty');
    try {
      expect(await listChangeRequests()).toEqual([]);
      expect(await getChangeRequest(NEEDS_APPROVAL)).toBeNull();
    } finally {
      fixtureRegistry.resetAll('default');
    }
  });
});
