// Wire shapes of the org graph's decision layer: `GET /api/graph/decisions`
// (the list), `/:id` (the detail with its participants and history), an
// initiative's `GET /api/graph/projects/:id/decisions` (the escalation columns
// the list and detail do not carry), and the one write, `POST /:id/decide`
// (G54). One table.

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
}

/** POST /api/graph/decisions/:id/decide's body. */
export interface DecideBody { outcome: 'resolved' | 'rejected'; rationale: string }

/** The initiative-scoped row: who it needs, when it escalated, the work it holds up. */
export interface DecisionInitiativeRow {
  id: string;
  requiredRole: string | null;
  escalatedAt: string | null;
  workItemId: string | null;
  workItemTitle: string | null;
}

export interface InitiativeName { id: string; name: string }
