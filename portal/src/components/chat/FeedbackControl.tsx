// FeedbackControl — the member-facing surface for the LabelFeedback grant
// (audit finding M7). A member holds LabelFeedback + ViewObservability in
// Cedar, but until this control existed the only page that labeled feedback
// (Quality triage, observability/QualityPage.tsx) sat behind an org-leader /
// hr-admin-only route, so a plain member could never exercise the grant. The
// natural surface is the answer they just received.
//
// POSTs to the same endpoint QualityPage.tsx already uses —
// POST /api/observability/quality/feedback, gated server-side by
// requireAction('LabelFeedback') (middleware/src/routes/quality.ts). This
// component adds the client-side capability gate so the control doesn't
// render an affordance a member's session will 403 on, and never blocks the
// answer itself on feedback success/failure.
//
// WHICH ID. Either the trace's `invocationId` (a caller that has the trace
// row) or the answer's AG-UI `runId`. The streaming Ask path has the run id
// only: the middleware mints it, the agent stamps it on its trace bundle
// (`agui_run_id`, pipelines P1), and /feedback resolves a run to that run's
// own trace among the caller's own runs. That join is what unblocked this
// control — before P1 the run id and the trace uuid were disjoint and every
// answer rendered nothing. With neither id (an errored or incomplete turn)
// there is nothing to label and the control renders nothing.
//
// A thumb pressed before the agent's bundle has landed (the CloudWatch
// poller lags ~30s) gets a 404 that says so; the control reports it quietly
// and a later press succeeds.

import { useState } from 'react';
import { useCapabilities } from '../../lib/capabilities';
import { buildFeedbackBody, buildRunFeedbackBody, type AskFeedbackLabel } from './feedbackBody';
import { Button, Inline, MetaLine } from '@connorhoehnslalom/ui-components/shared';

type Status = 'idle' | 'submitting' | 'submitted' | 'error';

export function FeedbackControl({ invocationId, runId }: { invocationId?: string; runId?: string }) {
  const { can } = useCapabilities();
  const [status, setStatus] = useState<Status>('idle');
  const [selected, setSelected] = useState<AskFeedbackLabel | null>(null);

  // Neither id (errored/incomplete turn) → nothing to label.
  if (!invocationId && !runId) return null;
  // Not gated at all if the caller lacks the grant (member/SME/org-leader/
  // hr-admin/admin hold it; a bare reader does not).
  if (!can('LabelFeedback')) return null;

  const submitting = status === 'submitting';

  async function submit(label: AskFeedbackLabel) {
    if (submitting) return;
    setSelected(label);
    setStatus('submitting');
    try {
      const res = await fetch('/api/observability/quality/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(invocationId ? buildFeedbackBody(invocationId, label) : buildRunFeedbackBody(runId as string, label)),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setStatus('submitted');
    } catch {
      // Never block the answer on a feedback failure — just say so, quietly,
      // and let the member try the other thumb or leave it.
      setStatus('error');
    }
  }

  return (
    <Inline gap="xs" wrap={false} className="mt-1.5">
      <Button
        variant={selected === 'good' && status === 'submitted' ? 'primary' : 'secondary'}
        size="sm"
        aria-label="Good answer"
        aria-pressed={selected === 'good' && status === 'submitted'}
        disabled={submitting}
        onClick={() => submit('good')}
      >
        👍
      </Button>
      <Button
        variant={selected === 'bad' && status === 'submitted' ? 'primary' : 'secondary'}
        size="sm"
        aria-label="Bad answer"
        aria-pressed={selected === 'bad' && status === 'submitted'}
        disabled={submitting}
        onClick={() => submit('bad')}
      >
        👎
      </Button>
      {status === 'submitted' && <MetaLine size="xs" items={['Thanks — feedback recorded.']} />}
      {status === 'error' && <MetaLine size="xs" items={['Couldn’t record feedback — try again.']} />}
    </Inline>
  );
}

export default FeedbackControl;
