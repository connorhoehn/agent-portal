// Change status → Chip tone/label. ChangesPage.tsx (the queue) and
// ChangeReviewPage.tsx (one change, reviewed properly) declared this table
// byte-identically — centralised here so the queue row and the review
// page's own badge can't drift apart on what a status means.

export const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  needs_approval: 'warning', changes_requested: 'warning', in_review: 'neutral',
  captured: 'neutral', approved: 'success', delivering: 'neutral',
  delivered: 'success', blocked: 'danger', rejected: 'danger', failed: 'danger',
};

export const STATUS_LABEL: Record<string, string> = {
  needs_approval: 'needs you', changes_requested: 'changes requested',
  in_review: 'reviewing', captured: 'captured', approved: 'approved',
  delivering: 'delivering', delivered: 'delivered', blocked: 'blocked',
  rejected: 'rejected', failed: 'failed',
};

// ── Which control asks which Cedar action (DE-42) ─────────────────────────────
//
// Each POST under /api/sdlc/changes/:id carries its own action in
// middleware/src/routes/sdlc.ts, and the two pages used to gate every button on
// the coarse ManageDevbox (the READ gate). One table, so the queue card and the
// review page cannot disagree about which button is whose:
//
//   decide    → DecideAgentChange  (sdlc.ts POST /changes/:id/decide)
//   deliver   → DeliverAgentChange (sdlc.ts POST /changes/:id/deliver)
//   address   → RunDevboxTask      (sdlc.ts POST /changes/:id/address)
//   rereview  → RunDevboxTask      (sdlc.ts POST /changes/:id/rereview)
//
// The capability probe answers "may this role ever" (it is asked with
// onInitiative=true, isAuthor=false). The per-instance refusals the route adds
// — 403 NOT_ON_INITIATIVE for a caller off the change's initiative, 409
// self-approval for the change's own author — are not knowable here except
// one: the author. That one is shown disabled with the server's own words,
// so the button explains itself rather than bouncing.

export type ChangeAction = 'decide' | 'deliver' | 'address' | 'rereview';

export const CHANGE_ACTION_CAPABILITY = {
  decide: 'DecideAgentChange',
  deliver: 'DeliverAgentChange',
  address: 'RunDevboxTask',
  rereview: 'RunDevboxTask',
} as const satisfies Record<ChangeAction, string>;

export type ChangeCapability = (typeof CHANGE_ACTION_CAPABILITY)[ChangeAction];

/** The server's self-approval refusal, verbatim (sdlc.ts POST /changes/:id/decide). */
export const SELF_APPROVAL_REASON = 'you caused this change, so someone else must decide it';

export interface ChangeActionGate {
  /** Render the control at all — the role holds the action (or authz is degraded). */
  show: boolean;
  /** The control is rendered but cannot be pressed; `reason` says why. */
  disabled: boolean;
  reason: string | null;
}

/**
 * Whether `action` should render, and whether it should be pressable, for a
 * viewer. `can` is the capability hook's; `viewerSub` the session's `sub`,
 * compared with the change's `requestedBy` for the author rule.
 */
export function changeActionGate(
  action: ChangeAction,
  change: { requestedBy?: string | null },
  viewer: { can: (a: ChangeCapability) => boolean; ready: boolean; sub?: string | null },
): ChangeActionGate {
  const show = viewer.ready && viewer.can(CHANGE_ACTION_CAPABILITY[action]);
  if (!show) return { show: false, disabled: true, reason: null };
  const isAuthor = action === 'decide' && !!change.requestedBy && !!viewer.sub && change.requestedBy === viewer.sub;
  return isAuthor
    ? { show: true, disabled: true, reason: SELF_APPROVAL_REASON }
    : { show: true, disabled: false, reason: null };
}
