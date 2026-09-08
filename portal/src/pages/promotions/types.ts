// Wire contracts for /api/promotions — the promotion inbox between raw
// lab_experiences observations and the library.

export type ObservationKind = 'worked' | 'failed' | 'gotcha' | 'decision' | 'convention';

export interface Observation {
  id: string;
  kind: ObservationKind;
  title: string;
  body: string;
  repo: string | null;
  initiativeId: string | null;
  sessionId: string;
  createdAt: string;
}

export type ProposedKind = 'insight' | 'runbook' | 'skill';
export type PromotionStatus = 'candidate' | 'approved' | 'dismissed' | 'promoted';

export interface PromotionCandidate {
  id: string;
  proposedKind: ProposedKind;
  title: string;
  rationale: string;
  supportCount: number;
  sessionCount: number;
  observations: Observation[];
  status: PromotionStatus;
  dryRunPassed: boolean | null;
  driftedFrom?: string;
}
