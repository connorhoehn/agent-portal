// The three harness writes that had no mock branch: `POST /runs/:runId/results`,
// `PATCH /runs/:id` and `POST /harness/promote`.
//
// All three called `providers/aurora.ts` `exec` unconditionally, so offline
// they threw `UnrecognizedClientException` into a bare 500 — and since the
// runner started checking its own writes, a `dev:mock` harness run reported
// every result as unrecorded. That is the good version of the bug: the gap went
// from invisible to loud. These tests are what keeps it closed.
//
// Note why no existing check caught it. Rule 4's write-half scan only names an
// unmocked leaf in `src/lib/**` or `src/providers/**`, and `exec` is excluded
// everywhere as transport — so a route handler that calls `exec` *itself*, as
// all three did, is structurally invisible to it. There is no ratchet standing
// behind this file; it is the check.
//
// What each test asserts is the property the missing fixture cost, not "a row
// appeared":
//
//   1. A RESULT IS REPLACED, NOT MERGED. The real statement is
//      `ON CONFLICT (run_id, test_id) DO UPDATE` assigning every column from
//      EXCLUDED, so a retry that omits a field NULLs it. A merge here would let
//      a retried case silently inherit the first attempt's cost and rationale,
//      and offline would disagree with Aurora in the one case — a retry — where
//      they most need to agree.
//   2. A PATCH CANNOT ASSERT A COUNT. `completed`/`passed`/`failed`/`passRate`/
//      `totalCases` are selectors over the result rows. A patch claiming 99
//      passes over four rows must not be believed, because that is exactly the
//      "run claims 3/4 above rows that say otherwise" defect the fixture was
//      built to lose.
//   3. PROMOTE IS A DECISION, NOT A RUBBER STAMP. The unknown SHA and the
//      wrong-agent SHA are refused offline for the same reasons they are
//      refused against Aurora — a mock that softened either into a 200 would
//      make the guard look absent exactly where it is load-bearing.
//   4. `reset()` PUTS THE SEED BACK, so an audit's harness run is undone by
//      `POST /api/__mock/reset` rather than warned about in a journal.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true } },
}));

import { freezeClock, fixtureRegistry } from '../core/index.js';
import {
  mockGetResults, mockGetRun, mockListRuns, mockPatchRun, mockUpsertResult,
  testResults, testRuns,
} from '../harness.js';
import {
  mockGetPromptVersion, mockListPromotedVersions, mockPromotePromptVersion,
  mockRegisterPromptVersion, promptVersions,
} from '../prompt-versions.js';

const RUN_A = 'a0000000-0000-4000-8000-00000000a001';
const CASE_SEARCH = 'orgiq-search-kubernetes-experts-a1b2c3';
const CASE_SUPERVISOR = 'orgiq-supervisor-who-knows-auth-d4e5f6';

let restore = () => {};

function freeze(at: string): void {
  restore();
  restore = freezeClock(at);
}

beforeEach(() => {
  fixtureRegistry.resetAll('default');
});

afterEach(() => {
  restore();
  restore = () => {};
  fixtureRegistry.resetAll('default');
});

// ─── POST /runs/:runId/results ───────────────────────────────────────────────

describe('recording a result (mockUpsertResult)', () => {
  it('records a verdict for a run this process just created, stamped from the clock', () => {
    freeze('2026-09-08T09:15:00.000Z');
    // `run_id` carries no foreign key in schema/observability_schema.sql, so a
    // result for a run the fixture never seeded is accepted here exactly as
    // Aurora accepts it.
    mockUpsertResult('run-created-this-process', {
      testId: CASE_SEARCH, passed: true, judgeScore: 0.91, estCostUsd: 0.0021,
    });

    const rows = mockGetResults('run-created-this-process');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ts).toBe('2026-09-08T09:15:00.000Z');
    expect(rows[0]?.judgeScore).toBe(0.91);
    // The case join happens on the way out, not on the way in.
    expect(rows[0]?.agentId).toBe('orgiq-search');
  });

  it('replaces a retried case in place — one row, and the omitted fields go null', () => {
    freeze('2026-09-08T09:15:00.000Z');
    mockUpsertResult(RUN_A, {
      testId: CASE_SEARCH, passed: false, judgeScore: 0.2,
      judgeRationale: 'first attempt', estCostUsd: 0.0021, durationMs: 2100,
    });
    freeze('2026-09-08T09:16:00.000Z');
    mockUpsertResult(RUN_A, { testId: CASE_SEARCH, passed: true, judgeScore: 0.9 });

    const mine = mockGetResults(RUN_A).filter((r) => r.testId === CASE_SEARCH);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.passed).toBe(true);
    expect(mine[0]?.ts).toBe('2026-09-08T09:16:00.000Z');
    // EXCLUDED, not COALESCE: the retry did not carry these, so they are gone.
    expect(mine[0]?.judgeRationale).toBeNull();
    expect(mine[0]?.estCostUsd).toBeNull();
    expect(mine[0]?.durationMs).toBeNull();
  });

  it("moves the run's counters, because they are counted from these rows", () => {
    // The seeded run is 3/4. Flipping the one failure has to move all five.
    expect(mockGetRun(RUN_A)).toMatchObject({ completed: 4, passed: 3, failed: 1, passRate: 0.75 });
    mockUpsertResult(RUN_A, { testId: CASE_SUPERVISOR, passed: true, judgeScore: 0.88 });
    expect(mockGetRun(RUN_A)).toMatchObject({ completed: 4, passed: 4, failed: 0, passRate: 1 });
  });

  it('counts a result that ran but was not judged as neither pass nor failure', () => {
    // `passed: null` is a case that ran and produced no verdict. Counting it
    // either way would be a lie; `completed` is what excludes it.
    mockUpsertResult(RUN_A, { testId: CASE_SUPERVISOR, passed: null, judgeScore: null });
    expect(mockGetRun(RUN_A)).toMatchObject({
      totalCases: 4, completed: 3, passed: 3, failed: 0, passRate: 1,
    });
  });

  it('is undone by reset', () => {
    mockUpsertResult('run-created-this-process', { testId: CASE_SEARCH, passed: true });
    expect(testResults.rows()).toHaveLength(9);
    testResults.reset('default');
    expect(testResults.rows()).toHaveLength(8);
    expect(mockGetResults('run-created-this-process')).toEqual([]);
  });
});

// ─── PATCH /runs/:id ─────────────────────────────────────────────────────────

describe('patching a run (mockPatchRun)', () => {
  it('stores status, finish stamp, notes and agent versions', () => {
    freeze('2026-09-08T09:20:00.000Z');
    expect(mockPatchRun(RUN_A, {
      status: 'failed',
      finishedAt: 'now',
      notes: 'aborted halfway',
      agentVersions: { 'orgiq-search': 'sha-patched' },
    })).toBe(true);

    expect(mockGetRun(RUN_A)).toMatchObject({
      status: 'failed',
      finishedAt: '2026-09-08T09:20:00.000Z',
      notes: 'aborted halfway',
      agentVersions: { 'orgiq-search': 'sha-patched' },
    });
  });

  it('takes an explicit finish stamp, and takes null to clear it', () => {
    mockPatchRun(RUN_A, { finishedAt: '2026-09-07T00:00:00.000Z' });
    expect(mockGetRun(RUN_A)?.finishedAt).toBe('2026-09-07T00:00:00.000Z');
    mockPatchRun(RUN_A, { finishedAt: null });
    expect(mockGetRun(RUN_A)?.finishedAt).toBeNull();
  });

  it('reports an unknown run rather than inventing one — the route\'s 404', () => {
    expect(mockPatchRun('no-such-run', { status: 'done' })).toBe(false);
    expect(mockListRuns(50).some((r) => r.runId === 'no-such-run')).toBe(false);
  });

  it('cannot be told a pass count: the five counters are not in the patch type', () => {
    // MockRunPatch deliberately has no `passed`/`completed`/`failed`/
    // `passRate`/`totalCases`, so a caller asserting 99 passes over four rows
    // has nowhere to put the claim. This is the compile-time half; the runtime
    // half is that the numbers below still come from the result rows.
    mockPatchRun(RUN_A, { status: 'done' });
    expect(mockGetRun(RUN_A)).toMatchObject({
      status: 'done', completed: 4, passed: 3, failed: 1, passRate: 0.75,
    });
  });

  it('is undone by reset', () => {
    mockPatchRun(RUN_A, { status: 'failed', notes: 'scribble' });
    testRuns.reset('default');
    expect(mockGetRun(RUN_A)).toMatchObject({ status: 'done', notes: null });
  });
});

// ─── POST /harness/promote ───────────────────────────────────────────────────

describe('promoting a prompt version (mockPromotePromptVersion)', () => {
  it('blesses a SHA registered in this same process, and the promote list shows it', () => {
    freeze('2026-09-08T09:30:00.000Z');
    const pv = mockRegisterPromptVersion({
      agentId: 'orgiq-search', content: 'You are the OrgIQ search agent, revision under test.',
    });
    expect(mockListPromotedVersions().some((v) => v.promptVersion === pv)).toBe(false);

    expect(mockPromotePromptVersion({
      promptVersion: pv, agentId: 'orgiq-search',
      promotedBy: 'u-operator', notes: 'held the citation rate',
    })).toEqual({ ok: true, promotedAt: '2026-09-08T09:30:00.000Z' });

    const promoted = mockListPromotedVersions();
    // Newest promotion first, so the one just blessed leads the list.
    expect(promoted[0]).toMatchObject({
      promptVersion: pv,
      agentId: 'orgiq-search',
      promotedAt: '2026-09-08T09:30:00.000Z',
      promotedBy: 'u-operator',
      promoteNotes: 'held the citation rate',
    });
    // Promotion must not disturb the content-addressing: the id is still the
    // short SHA of the text sitting beside it.
    expect(mockGetPromptVersion(pv)?.promptVersion).toBe(pv);
  });

  it('refuses a SHA nobody registered', () => {
    expect(mockPromotePromptVersion({
      promptVersion: 'ffffffffffff', agentId: 'orgiq-search',
      promotedBy: 'u-operator', notes: null,
    })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses a SHA that belongs to another agent, and names the owner', () => {
    const pv = mockRegisterPromptVersion({
      agentId: 'orgiq-search', content: 'Search agent revision, owned by search.',
    });
    expect(mockPromotePromptVersion({
      promptVersion: pv, agentId: 'orgiq-advisor',
      promotedBy: 'u-operator', notes: null,
    })).toEqual({ ok: false, reason: 'agent_mismatch', expectedAgentId: 'orgiq-search' });
    expect(mockListPromotedVersions().some((v) => v.promptVersion === pv)).toBe(false);
  });

  it('re-promoting refreshes the stamp instead of refusing', () => {
    const pv = mockRegisterPromptVersion({
      agentId: 'orgiq-search', content: 'Search agent revision, promoted twice.',
    });
    freeze('2026-09-08T09:30:00.000Z');
    mockPromotePromptVersion({ promptVersion: pv, agentId: 'orgiq-search', promotedBy: 'a', notes: null });
    freeze('2026-09-08T10:00:00.000Z');
    expect(mockPromotePromptVersion({
      promptVersion: pv, agentId: 'orgiq-search', promotedBy: 'b', notes: 'second look',
    })).toEqual({ ok: true, promotedAt: '2026-09-08T10:00:00.000Z' });
    expect(mockListPromotedVersions()[0]).toMatchObject({ promotedBy: 'b', promoteNotes: 'second look' });
  });

  it('is undone by reset — including a promotion of a SEEDED row', () => {
    // The register-then-promote case above adds a row, so reset dropping it
    // proves little. This one mutates a row the seed owns, which is the case a
    // reset that only truncated would miss.
    const seeded = mockListPromotedVersions().find((v) => v.agentId === 'orgiq-supervisor');
    expect(seeded?.promotedBy).toBe('operator@orgiq.example');
    mockPromotePromptVersion({
      promptVersion: seeded!.promptVersion, agentId: 'orgiq-supervisor',
      promotedBy: 'someone-else', notes: 'scribble',
    });
    expect(mockListPromotedVersions()[0]?.promotedBy).toBe('someone-else');

    promptVersions.reset('default');
    const back = mockListPromotedVersions().find((v) => v.agentId === 'orgiq-supervisor');
    expect(back).toMatchObject({
      promotedBy: 'operator@orgiq.example',
      promoteNotes: 'Baseline for the first canary comparison.',
    });
  });
});
