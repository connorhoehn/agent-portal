// Access review campaigns and their items (docs/access-tenant-design.md A10,
// §3; wire shapes docs/access-tenant-api.md §A2).
//
// Live: `access_reviews`, `access_review_items` (schema/access_schema.sql,
// additive, NOT applied to Aurora — lane E). These two registered fixtures
// mirror the seed row for row (parity entities `access reviews`, `access review
// items`); `POST /api/access/reviews` and the item decide route push and mutate
// them, and `POST /api/__mock/reset` restores the seed.
//
// The seeded campaign certifies the four standing `sme` grants in Work (the
// directory's u-nora, u-eli, u-layla and u-caleb — providers/identity.ts):
// two already kept, two still open. A campaign built by the route instead
// takes every (user, role) the directory holds in its tenant at that moment.
//
// Rows only. Progress is counted from the item rows by the route; no number
// is exported here.

import { clock, defineFixture } from './core/index.js';
import type { AccessTenant, ReviewDecision, ReviewStatus } from '../lib/access/types.js';

export interface AccessReviewRow {
  id: string;
  tenant: AccessTenant;
  title: string;
  status: ReviewStatus;
  /** access_reviews.opened_by — the campaign's owner, who decides its items (with any access admin). */
  openedBy: string | null;
  openedAt: string;
  closesAt: string | null;
  closedAt: string | null;
}

export interface AccessReviewItemRow {
  id: string;
  reviewId: string;
  userId: string;
  tenant: AccessTenant;
  role: string;
  decision: ReviewDecision | null;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string | null;
  /** The pre-approved revocation request (access_requests.kind = 'revocation') a `revoke` created. */
  revocationRequestId: string | null;
}

export const accessReviewsFixture = defineFixture<AccessReviewRow>({
  key: 'access.reviews',
  scenarios: {
    default: () => [
      { id: 'rev-0001', tenant: 'orgiq', title: 'Q4 SME certification — Work', status: 'open', openedBy: 'u-priya',
        openedAt: clock.daysAgo(5), closesAt: new Date(clock.now().getTime() + 9 * 86_400_000).toISOString(), closedAt: null },
    ],
    empty: () => [],
  },
});

const item = (id: string, userId: string, decision: ReviewDecision | null = null, decidedAt: string | null = null, comment: string | null = null): AccessReviewItemRow =>
  ({ id, reviewId: 'rev-0001', userId, tenant: 'orgiq', role: 'sme', decision, decidedBy: decision ? 'u-priya' : null, decidedAt, comment, revocationRequestId: null });

export const accessReviewItemsFixture = defineFixture<AccessReviewItemRow>({
  key: 'access.review-items',
  scenarios: {
    default: () => [
      item('ri-0001', 'u-nora', 'keep', clock.daysAgo(2), 'Owns the Observability maintenance bots; still needs dispatch.'),
      item('ri-0002', 'u-eli', 'keep', clock.daysAgo(1), 'Active on two initiatives this sprint.'),
      item('ri-0003', 'u-layla'),
      item('ri-0004', 'u-caleb'),
    ],
    empty: () => [],
  },
});
