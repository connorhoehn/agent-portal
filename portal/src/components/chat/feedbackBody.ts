// feedbackBody — pure request-body builder for POST /api/observability/quality/feedback
// (mounted at qualityRouter.post('/feedback', ...) — see middleware/src/routes/quality.ts).
//
// The endpoint's body contract (read, not owned, from quality.ts):
//   { invocationId: string (UUID), label: 'good' | 'bad' | 'fixed', note?: string }
// `note` is capped server-side at 2000 chars and only meaningful when present
// and non-blank — omit it rather than send an empty string, matching the
// QualityPage.tsx triage UI's own `note || undefined` pattern.
//
// This module intentionally supports only the two labels the Ask-answer thumbs
// control offers. 'fixed' is QualityPage's own triage-note affordance and is
// out of scope here.

export type AskFeedbackLabel = 'good' | 'bad';

export interface FeedbackRequestBody {
  invocationId: string;
  label: AskFeedbackLabel;
  note?: string;
}

/**
 * The by-RUN body (pipelines P1): the Ask page holds the AG-UI run id of the
 * answer it streamed, and the server resolves it to that run's own trace among
 * the caller's own runs (`agui_run_id`, quality.ts).
 */
export interface RunFeedbackRequestBody {
  runId: string;
  label: AskFeedbackLabel;
  note?: string;
}

export function buildRunFeedbackBody(runId: string, label: AskFeedbackLabel, note?: string): RunFeedbackRequestBody {
  const trimmedNote = note?.trim();
  return trimmedNote ? { runId, label, note: trimmedNote } : { runId, label };
}

/**
 * Build the exact JSON body to POST. Trims `note`; a blank/whitespace-only
 * note is dropped rather than sent (the server also trims, but this keeps the
 * wire payload the same shape either way).
 */
export function buildFeedbackBody(
  invocationId: string,
  label: AskFeedbackLabel,
  note?: string,
): FeedbackRequestBody {
  const trimmedNote = note?.trim();
  return trimmedNote ? { invocationId, label, note: trimmedNote } : { invocationId, label };
}
