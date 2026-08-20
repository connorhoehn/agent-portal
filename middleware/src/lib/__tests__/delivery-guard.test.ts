// Delivery preconditions — the four checks that stand between an approved
// change and a push. The subtle one is the last: an approved change with a
// newer sibling must not deliver, because delivery ships the live workspace and
// the workspace has moved on. These pin the ordering so it cannot regress.

import { deliveryBlockReason } from '../delivery-guard.js';

const approved = { status: 'approved' };

describe('deliveryBlockReason', () => {
  it('allows an approved, sole, live change through', () => {
    expect(deliveryBlockReason({ change: approved, hasSession: true, hasNewer: false })).toBeNull();
  });

  it('refuses a missing change', () => {
    expect(deliveryBlockReason({ change: null, hasSession: true, hasNewer: false }))
      .toBe('change not found');
  });

  it('refuses a change that is not approved', () => {
    expect(deliveryBlockReason({ change: { status: 'needs_approval' }, hasSession: true, hasNewer: false }))
      .toMatch(/not approved/);
  });

  it('refuses when the workspace session is gone', () => {
    expect(deliveryBlockReason({ change: approved, hasSession: false, hasNewer: false }))
      .toMatch(/no live workspace/);
  });

  it('refuses an approved change once a newer one exists — the governance-critical case', () => {
    // The change cleared every gate, has a live session, and is still approved.
    // It must still be refused: the workspace now holds the newer change's
    // content, which this change's review never saw.
    const reason = deliveryBlockReason({ change: approved, hasSession: true, hasNewer: true });
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/newer change/i);
  });

  it('checks status before the newer-change refusal — a stale non-approved change reports the plainer reason', () => {
    // Ordering: a change that is both non-approved and stale should surface the
    // approval problem first, not the subtler staleness one.
    expect(deliveryBlockReason({ change: { status: 'blocked' }, hasSession: true, hasNewer: true }))
      .toMatch(/not approved/);
  });
});
