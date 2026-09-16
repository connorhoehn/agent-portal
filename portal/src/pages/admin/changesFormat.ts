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
