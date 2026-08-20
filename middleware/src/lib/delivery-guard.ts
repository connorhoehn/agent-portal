// The preconditions for delivering a change — kept pure and import-light so the
// ordering can be pinned by a test. Delivery ships the live workspace, so these
// four checks are the difference between shipping the reviewed change and
// shipping something else that happens to be on disk.

export interface DeliveryPreconditions {
  /** The change, or null if it was not found. */
  change: { status: string } | null;
  /** Does the project still have a live workspace session to deliver from? */
  hasSession: boolean;
  /** Has a newer change been captured for the same project since this one? */
  hasNewer: boolean;
}

/**
 * Why this change cannot be delivered, or null if it can.
 *
 * Order matters and is deliberate: existence, then the approved gate, then a
 * live workspace, then — the subtle one — that this is still the latest capture.
 * A newer change means the workspace has moved on, so an approved-but-stale
 * change is refused here even though it cleared every gate; its review vouched
 * for content the workspace no longer holds.
 */
export function deliveryBlockReason(p: DeliveryPreconditions): string | null {
  if (!p.change) return 'change not found';
  if (p.change.status !== 'approved') return `change is ${p.change.status}, not approved`;
  if (!p.hasSession) return 'this project has no live workspace to deliver from — re-run the task first';
  if (p.hasNewer) {
    return 'A newer change has been captured for this project since this one, so its workspace has moved on. Review and deliver the latest change instead.';
  }
  return null;
}
