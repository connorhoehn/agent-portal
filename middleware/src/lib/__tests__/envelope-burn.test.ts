// A sprint envelope that actually burns down, in `dev:mock`.
//
// The gap this pins closed: `dispatchedSpendInWindow` answered
// `{ spentUsd: 0, attributionAvailable: false }` for every mock call, so
// `loadEnvelope` handed `decideEnvelope` an UNKNOWN burn no matter how much
// the caller had dispatched. In that state the brake can only compare a
// forecast against the envelope's whole SIZE — so an SME with a $15 grant got
// the identical verdict on their first dispatch and their four hundredth, and
// nobody could audit the one thing this gate exists to do.
//
// Nothing about the DECISION changed. `decideEnvelope` is byte-for-byte what
// it was; what changed is that the mock now sums the same rows the Aurora
// statement sums (bot_runs.dispatched_by, attributed by spendPredicateSql,
// inside the sprint window). Where a dispatch below is refused, it is refused
// because the money is really gone.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import {
  loadEnvelope, decideEnvelope, dispatchWorkItem, __setMockDispatchStepMs,
} from '../bot-runner.js';
import { __resetMockRuns, dispatchedSpendInWindow } from '../../providers/bots.js';
import { updateGrant, _resetMockGrants } from '../../providers/grants.js';
import { updateWorkItem, getProjectActivity } from '../../providers/work-items.js';
import { workItemComments } from '../../mock/work-item-comments.js';

// u-nora (app_users) → p-004 (people) → bg-auth-3, her $15 envelope on
// spr-auth-s2, Auth Migration. All four ids are the seed's own.
const NORA = 'u-nora';
const AUTH = 'p-auth-migration';
const GRANT = 'bg-auth-3';
// wi-auth-e2-b3 — an open bug on Auth Migration, so it is dispatchable and
// (because a simulated run hands the item back to `open`) re-dispatchable.
const ITEM = 'wi-auth-e2-b3';

/** What a simulated marketplace run costs — lib/bot-runner.ts's
 *  SIMULATED_RESULT, the one price `dev:mock` quotes for a fake run. */
const SIMULATED_COST = 0.0341;

/** Drive one whole dispatch, progression included, synchronously. */
async function dispatch(): Promise<{ ok: boolean; status?: number }> {
  const result = await dispatchWorkItem({ workItemId: ITEM, model: 'us.amazon.nova-lite-v1:0', actor: NORA });
  return result.ok ? { ok: true } : { ok: false, status: result.status };
}

beforeEach(() => {
  __resetMockRuns();
  _resetMockGrants();
  workItemComments.reset();
  // 0 runs claimed → running → settled inline, so the run has posted its cost
  // by the time dispatch() returns — the test seam, not a shortcut past a gate.
  __setMockDispatchStepMs(0);
});

afterEach(() => {
  __setMockDispatchStepMs(2_000);
  __resetMockRuns();
  _resetMockGrants();
  // The item is handed back to `open` by the settle, but a dispatch that
  // failed mid-way could leave it claimed; put it back so ordering never
  // matters.
  void updateWorkItem(ITEM, { status: 'open' });
});

describe('the sprint envelope burns down in dev:mock', () => {
  it('starts at a KNOWN zero burn, not an unknown one', async () => {
    const envelope = await loadEnvelope(AUTH, NORA);
    expect(envelope).not.toBeNull();
    expect(envelope!.grantId).toBe(GRANT);
    expect(envelope!.allocatedUsd).toBe(15);
    expect(envelope!.attributedSpentUsd).toBe(0);
    // The whole point: zero because nothing was dispatched, not zero because
    // nothing can be counted.
    expect(envelope!.attributionAvailable).toBe(true);
  });

  it('counts a dispatch this caller made, and only theirs', async () => {
    expect(await dispatch()).toEqual({ ok: true });

    const mine = await loadEnvelope(AUTH, NORA);
    expect(mine!.attributedSpentUsd).toBe(SIMULATED_COST);

    // Somebody else's envelope on the same initiative is untouched — a run
    // records who authorized it, and nobody else's grant pays for it.
    // (u-release holds no grant here, so the brake is simply absent for them.)
    expect(await loadEnvelope(AUTH, 'u-release')).toBeNull();
  });

  it('does not count a run dispatched against a DIFFERENT initiative', async () => {
    await dispatch();
    // Same subject, same (unbounded) window, other initiative: the attribution
    // predicate's work-item arm is what keeps this out, exactly as the SQL's
    // `work_item_id IN (SELECT … WHERE project_id = :pid)` does.
    expect(await dispatchedSpendInWindow({
      orgProjectId: 'p-observability', dispatchedBy: NORA, startsOn: null, endsOn: null,
    })).toEqual({ spentUsd: 0, attributionAvailable: true, unknownCount: 0 });
    expect(await dispatchedSpendInWindow({
      orgProjectId: AUTH, dispatchedBy: NORA, startsOn: null, endsOn: null,
    })).toEqual({ spentUsd: SIMULATED_COST, attributionAvailable: true, unknownCount: 0 });
  });

  it('excludes a run that falls outside the sprint window', async () => {
    await dispatch();
    // A window that closed yesterday cannot contain a run recorded a moment
    // ago — ends_on is inclusive, so the exclusive upper bound is the day after.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(await dispatchedSpendInWindow({
      orgProjectId: AUTH, dispatchedBy: NORA, startsOn: null, endsOn: yesterday,
    })).toEqual({ spentUsd: 0, attributionAvailable: true, unknownCount: 0 });
  });

  it('counts nobody else’s dispatch, and no cron firing', async () => {
    await dispatch();
    // The seeded auth-dep-watch history is attributed to this same initiative
    // (bot → org_project_id) and carries dispatched_by NULL, so it burns
    // nobody's envelope; and another subject's sum here is zero.
    expect(await dispatchedSpendInWindow({
      orgProjectId: AUTH, dispatchedBy: 'u-release', startsOn: null, endsOn: null,
    })).toEqual({ spentUsd: 0, attributionAvailable: true, unknownCount: 0 });
  });

  it('burns down across two dispatches and refuses the one that no longer fits', async () => {
    // Re-allocate the envelope to $0.10 so three $0.0341 runs straddle it.
    // This is the release manager's own PATCH /api/grants/:id, not a test
    // backdoor — and the brake reading it at all is the grant-overlay fix in
    // providers/budgets.ts (listGrants used to read the raw seed, so a
    // re-allocated envelope was invisible to this gate offline).
    await updateGrant(GRANT, { amountUsd: 0.1 });

    const verdicts: Array<{ spent: number; remaining: number; kind: string }> = [];
    const judge = async (): Promise<'proceed' | 'confirm'> => {
      const envelope = await loadEnvelope(AUTH, NORA);
      const gate = decideEnvelope(envelope!, { costUsdP75: SIMULATED_COST }, false);
      verdicts.push({
        spent: envelope!.attributedSpentUsd,
        remaining: envelope!.allocatedUsd - envelope!.attributedSpentUsd,
        kind: gate.kind,
      });
      return gate.kind;
    };

    // $0.00 spent, $0.10 left — a $0.0341 run fits.
    expect(await judge()).toBe('proceed');
    expect(await dispatch()).toEqual({ ok: true });

    // $0.0341 spent, $0.0659 left — still fits.
    expect(await judge()).toBe('proceed');
    expect(await dispatch()).toEqual({ ok: true });

    // $0.0682 spent, $0.0318 left — a $0.0341 run no longer fits, so the third
    // is held for confirmation.
    expect(await judge()).toBe('confirm');

    expect(verdicts).toEqual([
      { spent: 0, remaining: 0.1, kind: 'proceed' },
      { spent: 0.0341, remaining: expect.closeTo(0.0659, 6) as unknown as number, kind: 'proceed' },
      { spent: 0.0682, remaining: expect.closeTo(0.0318, 6) as unknown as number, kind: 'confirm' },
    ]);
  });

  it('names the remaining balance in the refusal, and says whose spend it counted', async () => {
    await updateGrant(GRANT, { amountUsd: 0.1 });
    await dispatch();
    await dispatch();

    const envelope = await loadEnvelope(AUTH, NORA);
    const gate = decideEnvelope(envelope!, { costUsdP75: SIMULATED_COST }, false);
    expect(gate.kind).toBe('confirm');
    if (gate.kind !== 'confirm') return;
    expect(gate.reason).toContain('$0.03 left');
    expect(gate.reason).toContain('counting only runs recorded as dispatched by you');
    expect(gate.reason).toContain('confirmOverEnvelope');
  });

  // The other half of what a dispatch leaves behind. settleSimulatedRun hands
  // the item back to `open` and writes a system comment saying why; that
  // comment was dropped on the floor in mock, so the item reverted with no
  // recorded reason and the initiative's history showed nothing at all.
  it('leaves its settle comment on the item, and on the initiative’s activity feed', async () => {
    expect(await dispatch()).toEqual({ ok: true });

    const feed = await getProjectActivity(AUTH, { limit: 100 });
    const settle = feed.find((e) => e.workItemId === ITEM && e.kind === 'status');
    expect(settle).toBeDefined();
    expect(settle!.subject).toContain('Marketplace run completed without a captured change');
    expect(settle!.subject).toContain('no devbox runtime is deployed');
    // Newest event on the initiative: it was written a moment ago.
    expect(feed[0]!.id).toBe(settle!.id);
  });

  it('still proceeds under the seeded $15 envelope — a real burn is not a stricter gate', async () => {
    await dispatch();
    const envelope = await loadEnvelope(AUTH, NORA);
    // $15 allocated, $0.0341 burned: every gate that passed before still
    // passes. The brake only bites when the money is genuinely gone.
    expect(decideEnvelope(envelope!, { costUsdP75: SIMULATED_COST }, false)).toEqual({ kind: 'proceed' });
  });
});
