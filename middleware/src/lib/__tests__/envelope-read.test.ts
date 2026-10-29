// The read behind the third dispatch brake — GET /api/sprints/envelopes.
//
// `decideEnvelope` can 409 an SME for overrunning a sprint envelope, and until
// `listActiveEnvelopes` existed there was nowhere to look the envelope up
// first. The grants table on /admin/budgets is gated to the roles that ALLOCATE
// money, and the figure it reports (`initiativeSpendInWindowUsd`) is the
// INITIATIVE's window spend, not the caller's burn — a different number. So an
// SME could be stopped by an amount they had no way to have seen.
//
// What these cases pin is that the read resolves EXACTLY what the brake
// resolves — same grants, same active predicate, same dispatched_by sum — and
// that a burn nobody can attribute stays UNKNOWN rather than becoming a
// headroom-shaped zero.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { listActiveEnvelopes, loadEnvelope, dispatchWorkItem, __setMockDispatchStepMs } from '../bot-runner.js';
import { __resetMockRuns } from '../../providers/bots.js';
import * as bots from '../../providers/bots.js';
import { _resetMockGrants } from '../../providers/grants.js';
import { updateWorkItem } from '../../providers/work-items.js';
import { workItemComments } from '../../mock/work-item-comments.js';

// The seed's own ids. u-nora (app_users) → p-004 (people) → bg-auth-3, her $15
// envelope on the active sprint spr-auth-s2 of Auth Migration.
const NORA = 'u-nora';
const GRANT = 'bg-auth-3';
const AUTH = 'p-auth-migration';
// u-eli → p-011, an `sme` the seed grants no envelope to at all.
const ELI = 'u-eli';
// u-hr → no person_id: a platform account is not an SME.
const HR = 'u-hr';
// wi-auth-e2-b3 — an open bug on Auth Migration, so it is dispatchable.
const ITEM = 'wi-auth-e2-b3';
/** lib/bot-runner.ts's SIMULATED_RESULT — the one price dev:mock quotes. */
const SIMULATED_COST = 0.0341;

beforeEach(() => {
  __resetMockRuns();
  _resetMockGrants();
  workItemComments.reset();
  __setMockDispatchStepMs(0);
});

afterEach(async () => {
  __setMockDispatchStepMs(2_000);
  __resetMockRuns();
  _resetMockGrants();
  await updateWorkItem(ITEM, { status: 'open' });
  jest.restoreAllMocks();
});

describe('listActiveEnvelopes', () => {
  it('reports the granted amount, the burn and what is left for a grant-holding SME', async () => {
    const rows = await listActiveEnvelopes(NORA);
    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(1);
    const e = rows![0]!;
    expect(e.grantId).toBe(GRANT);
    expect(e.orgProjectId).toBe(AUTH);
    expect(e.sprintId).toBe('spr-auth-s2');
    expect(e.allocatedUsd).toBe(15);
    expect(e.attributionAvailable).toBe(true);
    // Nothing dispatched yet, and the seeded cron history is dispatched by
    // nobody — a cron firing is authorized from inside no envelope.
    expect(e.attributedSpentUsd).toBe(0);
  });

  it('is EMPTY, not null, for an SME who holds no grant — no grant is "not braked", not "no money"', async () => {
    await expect(listActiveEnvelopes(ELI)).resolves.toEqual([]);
  });

  it('is null for an account with no linked person — a platform operator is not an SME', async () => {
    await expect(listActiveEnvelopes(HR)).resolves.toBeNull();
  });

  it('is null with no session at all', async () => {
    await expect(listActiveEnvelopes(undefined)).resolves.toBeNull();
  });

  // The point of the whole slice: the number the read shows and the number the
  // brake judges are the same resolution, so they cannot drift apart.
  it('agrees with loadEnvelope — the brake\'s own input — after a real dispatch', async () => {
    const before = await listActiveEnvelopes(NORA);
    expect(before![0]!.attributedSpentUsd).toBe(0);

    const run = await dispatchWorkItem({ workItemId: ITEM, model: 'us.amazon.nova-lite-v1:0', actor: NORA });
    expect(run.ok).toBe(true);

    const after = await listActiveEnvelopes(NORA);
    expect(after![0]!.attributedSpentUsd).toBeCloseTo(SIMULATED_COST, 4);

    const braked = await loadEnvelope(AUTH, NORA);
    expect(braked).not.toBeNull();
    expect(braked!.grantId).toBe(after![0]!.grantId);
    expect(braked!.allocatedUsd).toBe(after![0]!.allocatedUsd);
    expect(braked!.attributedSpentUsd).toBe(after![0]!.attributedSpentUsd);
    expect(braked!.attributionAvailable).toBe(after![0]!.attributionAvailable);
  });

  // Unknown is not zero. On a cluster without schema/agent_run_attribution
  // _schema.sql the sum means nothing, and a 0 there would render as a full
  // envelope on a surface whose whole job is to say how much is left.
  it('carries attributionAvailable:false rather than a zero burn when nothing records the dispatcher', async () => {
    jest.spyOn(bots, 'dispatchedSpendInWindow')
      .mockResolvedValue({ spentUsd: 0, attributionAvailable: false, unknownCount: 0 });

    const rows = await listActiveEnvelopes(NORA);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.attributionAvailable).toBe(false);
    expect(rows![0]!.allocatedUsd).toBe(15);
  });

  // A grant on a `planned` sprint is not in force, and the read must not offer
  // its money — the same predicate decideGrantScopedDispatch denies on.
  it('only reports ACTIVE grants', async () => {
    const rows = await listActiveEnvelopes(NORA);
    for (const e of rows ?? []) {
      expect(e.sprintStatus === 'active' || e.sprintId == null).toBe(true);
    }
  });
});
