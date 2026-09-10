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
// invocationId is intentionally a prop, not derived here: at the AG-UI
// streaming path InvokePage.tsx uses (useAgentStream), no invocationId for
// the just-completed turn is currently threaded to the client — RUN_STARTED's
// runId is a middleware-minted id unrelated to the agent's
// ctx.invocation_id (the id observability.invocation_traces rows key on and
// the one /feedback requires as a UUID). See InvokePage.tsx for the caller
// wiring and the report from this change for the full trace of that gap.
// Until a future event/field carries the real id, `invocationId` will be
// undefined for every answer and this component correctly renders nothing —
// exactly the "no invocationId → no control" behavior an errored turn also
// needs.

import { useState } from 'react';
import { useCapabilities } from '../../lib/capabilities';
import { buildFeedbackBody, type AskFeedbackLabel } from './feedbackBody';
import { Button, Inline, MetaLine } from '@connorhoehnslalom/ui-components/shared';

type Status = 'idle' | 'submitting' | 'submitted' | 'error';

export function FeedbackControl({ invocationId }: { invocationId?: string }) {
  const { can } = useCapabilities();
  const [status, setStatus] = useState<Status>('idle');
  const [selected, setSelected] = useState<AskFeedbackLabel | null>(null);

  // No invocationId (errored/incomplete turn, or — currently — every turn
  // until the streaming path threads one through) → nothing to label.
  if (!invocationId) return null;
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
        body: JSON.stringify(buildFeedbackBody(invocationId as string, label)),
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
