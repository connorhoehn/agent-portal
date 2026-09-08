// Wire contracts for /api/designs — the Design phase's ADR threads.

export type DesignStatus =
  | 'ideating' | 'awaiting_input' | 'proposed' | 'approved' | 'rejected' | 'superseded';

export type PostKind =
  | 'problem' | 'analysis' | 'option' | 'question' | 'answer'
  | 'artifact' | 'revision' | 'decision';

export interface DesignPost {
  id: string;
  authorKind: 'agent' | 'human';
  authorName: string;
  kind: PostKind;
  body: string;
  resolvedBy: string | null;
  artifact: { name: string; type: string; url: string | null } | null;
  createdAt: string;
}

export interface DesignSignoff {
  personName: string;
  role: string;
  decision: 'approve' | 'reject';
  at: string;
}

export interface DesignReview {
  id: string;
  orgProjectId: string;
  orgProjectName: string;
  title: string;
  status: DesignStatus;
  /** Agent-maintained executive summary of the decision + where it stands. */
  summary: string;
  /** Blast radius — every initiative this decision touches. */
  affected: Array<{ orgProjectId: string; orgProjectName: string; impact: string }>;
  dependsOn: string[];
  kbSynced: boolean;
  openQuestions: number;
  signoffs: DesignSignoff[];
  postCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DesignThread extends DesignReview {
  posts: DesignPost[];
  gates: Array<{ id: string; title: string; status: DesignStatus }>;
}
