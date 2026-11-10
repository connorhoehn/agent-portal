// Wire shapes of the org graph's decision layer: `GET /api/graph/decisions`
// (the list), `/:id` (the detail with its participants and history), an
// initiative's `GET /api/graph/projects/:id/decisions` (the escalation columns
// the list and detail do not carry), and the one write, `POST /:id/decide`
// (G54; G57 adds the pre-canned `options` and `optionId`). One table.

export type DecisionStatus = 'open' | 'escalated' | 'resolved' | 'rejected';

export interface DecisionSummary {
  id: string;
  topic: string;
  summary: string | null;
  status: DecisionStatus | string;
  projectId: string | null;
  /** 'YYYY-MM-DD' — a DATE. */
  decidedAt: string | null;
  /** What was decided, once settled (G54); null while it waits. */
  outcome?: string | null;
  participantCount: number;
  /** Who made the call, once settled; null while it waits. Older servers send nothing. */
  decidedBy?: { id: string; name: string } | null;
  /**
   * Who a waiting decision waits on, by the rule the decide route applies:
   * its decider, else its initiative's owner, else the org-leader override
   * (`decider` null). Both null once settled.
   */
  deciderRole?: 'decider' | 'initiative-owner' | 'org-leader' | null;
  decider?: { id: string; name: string } | null;
}

export interface DecisionParticipant {
  avatarUrl?: string | null;
  personId: string;
  name: string;
  title: string | null;
  role: string | null;
  weight: number;
}

/** One entry of the recorded history (G54): a call made in the product, who, when and why. */
export interface DecisionEvent {
  id: string;
  kind: 'resolved' | 'rejected';
  /** ISO timestamp. */
  at: string;
  by: { id: string; name: string };
  rationale: string;
}

export interface DecisionDetail {
  id: string;
  topic: string;
  summary: string | null;
  status: DecisionStatus | string;
  projectId: string | null;
  decidedAt: string | null;
  participants: DecisionParticipant[];
  /** Who decided it (a person id, else an account subject), or null while it waits. */
  decidedBy?: { id: string; name: string } | null;
  /** What was decided, or null while it waits. */
  outcome?: string | null;
  /** The recorded history, newest first. */
  history?: DecisionEvent[];
  /** Whether POST /:id/decide would let this viewer through (decider, initiative owner, org-leader). */
  viewerMayDecide?: boolean;
  /** G57: the pre-canned answers a waiting decision offers, in order (the decision dialogue numbers them). */
  options?: DecisionOption[];
  /**
   * The work it holds (or held) up: `blocked` true while it still waits on
   * this decision, false once deciding it unblocked the item. Older servers
   * send nothing; the record then falls back to the initiative row's work item.
   */
  heldWork?: HeldWork[];
}

/** One work item a decision holds (or held) up. */
export interface HeldWork { id: string; title: string; projectId: string; blocked: boolean }

/** One pre-canned answer to a waiting decision (G57). */
export interface DecisionOption { id: string; label: string; detail?: string }

/**
 * POST /api/graph/decisions/:id/decide's body. With `optionId` (resolving
 * only) the option's label is the recorded outcome and `rationale` is the
 * optional why; without one `rationale` is the outcome and is required.
 */
export interface DecideBody { optionId?: string; outcome: 'resolved' | 'rejected'; rationale?: string }

/** The initiative-scoped row: who it needs, when it escalated, the work it holds up. */
export interface DecisionInitiativeRow {
  id: string;
  requiredRole: string | null;
  escalatedAt: string | null;
  workItemId: string | null;
  workItemTitle: string | null;
}

export interface InitiativeName { id: string; name: string }
