// Delivery, offline — the branch push and the pull request.
//
// `lib/change-delivery.ts` has three steps: check the change is still in the
// workspace, push a branch with a borrowed GitHub token, open a PR. Only the
// last two need anything this process cannot have offline — a credential from
// the vault (`borrowApiKey` throws in mock mode, on purpose) and github.com.
// The first step runs unchanged against `mock/devbox-shell.ts`, so the
// reaped-workspace refusals are still produced by the real code reading a real
// (if imaginary) checkout, not by a fixture asserting them.
//
// So this models exactly the part that is missing: what a push and a PR leave
// behind. A row per delivered change, holding the branch that was pushed and
// the pull request it opened — which is what `markDelivered` writes back onto
// the change and what the work-item PR chip then renders.

import { clock, defineFixture } from './core/index.js';

export interface MockDelivery {
  changeId: string;
  repoFullName: string;
  branch: string;
  baseBranch: string;
  prUrl: string;
  prNumber: number;
  /** The captured commit that was pushed, or null for a working-tree delivery. */
  commitSha: string | null;
  deliveredAt: string;
}

/**
 * Deliveries made in this process.
 *
 * `default` — none. A delivery is an event, not a corpus: the seeded change
 *             that already carries a PR url (`mock/sdlc.ts`'s `CHANGE_DASH`)
 *             records it on the change row, where the real schema keeps it, so
 *             re-seeding it here would be a second copy that can disagree.
 *             `POST /api/__mock/reset` drops everything delivered since boot.
 */
export const devboxDeliveries = defineFixture<MockDelivery>({
  key: 'devbox-deliveries',
  scenarios: { default: () => [] },
});

/**
 * The next pull-request number for a repository.
 *
 * Derived from the rows, never stored beside them. The floor of 100 is
 * deliberate: a seeded change claims PR 41 on the observability repo, and an
 * offline delivery that also produced 41 would look like the same pull
 * request. Anything at 101 or above was opened by this process.
 */
function nextPrNumber(repoFullName: string): number {
  const mine = devboxDeliveries.rows().filter((d) => d.repoFullName === repoFullName);
  return Math.max(100, ...mine.map((d) => d.prNumber)) + 1;
}

export interface MockDeliveryResult {
  ok: boolean;
  branch?: string;
  prUrl?: string;
  error?: string;
}

/**
 * Push the branch and open the pull request — offline.
 *
 * Idempotent on the branch, the way the real path is: `openPullRequest`
 * answers a 422 ("a pull request already exists for this head") by finding and
 * returning the existing PR rather than failing, so a second delivery of the
 * same change returns the same url instead of minting a second one.
 */
export function mockDeliverChange(input: {
  changeId: string;
  repoFullName: string;
  branch: string;
  baseBranch: string;
  commitSha: string | null;
}): MockDeliveryResult {
  const rows = devboxDeliveries.rows();
  const existing = rows.find((d) => d.repoFullName === input.repoFullName && d.branch === input.branch);
  if (existing) return { ok: true, branch: existing.branch, prUrl: existing.prUrl };

  const prNumber = nextPrNumber(input.repoFullName);
  const delivery: MockDelivery = {
    changeId: input.changeId,
    repoFullName: input.repoFullName,
    branch: input.branch,
    baseBranch: input.baseBranch,
    prUrl: `https://github.com/${input.repoFullName}/pull/${prNumber}`,
    prNumber,
    commitSha: input.commitSha,
    deliveredAt: clock.nowIso(),
  };
  rows.push(delivery);
  return { ok: true, branch: delivery.branch, prUrl: delivery.prUrl };
}
