// Wire shapes of the org graph's decision layer: `GET /api/graph/decisions`
// (the list), `/:id` (the detail with its participants) and an initiative's
// `GET /api/graph/projects/:id/decisions` (the escalation columns the list
// and detail do not carry). One table, three reads.

export type DecisionStatus = 'open' | 'escalated' | 'resolved' | 'rejected';

export interface DecisionSummary {
  id: string;
  topic: string;
  summary: string | null;
  status: DecisionStatus | string;
  projectId: string | null;
  /** 'YYYY-MM-DD' — a DATE. */
  decidedAt: string | null;
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

export interface DecisionDetail {
  id: string;
  topic: string;
  summary: string | null;
  status: DecisionStatus | string;
  projectId: string | null;
  decidedAt: string | null;
  participants: DecisionParticipant[];
}

/** The initiative-scoped row: who it needs, when it escalated, the work it holds up. */
export interface DecisionInitiativeRow {
  id: string;
  requiredRole: string | null;
  escalatedAt: string | null;
  workItemId: string | null;
  workItemTitle: string | null;
}

export interface InitiativeName { id: string; name: string }
