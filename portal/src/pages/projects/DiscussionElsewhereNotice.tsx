import { useState } from 'react';
import { useNavigate } from 'react-router';
import { EmptyState } from '@connorhoehn/ui-components';
import { useSession } from '../../lib/auth';
import { useFetch } from '../../hooks/useFetch';
import { grantRequestNextStep } from '../../lib/pageAccess';
import type { AccessRequest } from '../../lib/accessRequests';
import { QuickAccessForm } from './BudgetAccess';
import { mineUrl, openStatusText, quickRequestState, requestHref } from './budgetAccessModel';

// One conversation per initiative, for a viewer with no Social access
// (leftovers 2): where the old initiative thread used to be, a read-only
// notice says the discussion is in the bound channel, with the one next step
// (lib/pageAccess.ts grantRequestNextStep): the quick access request for the
// Social role the catalog offers, its status once filed, else who to ask.
// Nothing of the channel is read here; the server still gates every read.
// It is the pane's empty state (the library's EmptyState, as "Not a member of
// #channel" beside it), so it takes the pane's padding and its action sits
// under the text, never against the pane's edge (walk, 10 November, 390px).

export function DiscussionElsewhereNotice({ reason }: { reason: string }) {
  const navigate = useNavigate();
  const { session } = useSession();
  // The plane answers any session which Social role would let it post (requestItemId), without a Social grant.
  const caps = useFetch<{ actions: Record<string, boolean>; requestItemId?: string }>('/api/social/plane/capabilities', 60_000, { share: true });
  const first = grantRequestNextStep('social', caps.data?.requestItemId);
  const mine = useFetch<{ items: AccessRequest[]; requestable?: false }>(first.kind === 'request' ? mineUrl(first.itemId) : null);
  const [formOpen, setFormOpen] = useState(false);
  const step = first.kind === 'request' && mine.data?.requestable === false ? grantRequestNextStep('social', null) : first;
  const request = step.kind === 'request' ? quickRequestState(mine.data?.items) : null;

  let next: string | null = null;
  let action: { label: string; onClick: () => void } | null = null;
  if (step.kind === 'request' && request) {
    if (request.kind === 'none') action = { label: step.label, onClick: () => setFormOpen(true) };
    else {
      next = request.kind === 'open' ? openStatusText(request) : request.kind === 'approved' ? 'Approved — being provisioned' : 'Granted — reload once it arrives';
      const href = requestHref(request.request.id, session?.grants);
      if (href) action = { label: 'View request', onClick: () => navigate(href) };
    }
  } else if (step.kind === 'ask') next = step.label;

  return (
    <>
      <EmptyState
        title="Discussion is in Social"
        description={next ? `${reason} ${next}.` : reason}
        {...(action ? { actions: [{ label: action.label, onClick: action.onClick, variant: 'secondary' as const }] } : {})}
        testId="initiative-discussion-elsewhere"
        actionTestId="initiative-discussion-elsewhere-action"
      />
      {step.kind === 'request' && (
        <QuickAccessForm
          open={formOpen}
          itemId={step.itemId}
          title={step.label}
          doneTitle="Social access requested"
          intro={`${reason} Your manager, then the role's steward, decide it in Access; once it is granted, the discussion opens here.`}
          testId="social-access"
          onClose={() => setFormOpen(false)}
          onFiled={() => { mine.refresh(); setFormOpen(false); }}
        />
      )}
    </>
  );
}
