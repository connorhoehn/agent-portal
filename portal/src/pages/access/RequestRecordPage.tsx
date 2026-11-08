// /access/requests/:id — one request (docs/access-tenant-design.md §4.2): its
// approval chain, the decision controls the actor may use NOW (`can.decide`,
// computed by the server from the live approver resolver and the two row rules:
// nobody decides their own request, a step is decided once), Withdraw for the
// requester or beneficiary (`can.withdraw`), the separation-of-duties check and
// the request's audit events.
//
// The conversation (decision A8) is the request's thread `access:req:<id>`,
// shown in the shell's right pane with ONE composer docked at the bottom of the
// content column — the team scorecard's arrangement (docs/layout-cascade.md
// "The pane and rail contracts"). The gateway admits the thread to whoever
// passes this record's read rule now (the requester, the beneficiary, the
// beneficiary's manager, live approvers and past deciders, access admins —
// middleware lib/access/thread.ts) standing in `access`, and posts under
// ViewAccess, the same authority as reading. The page mounts the conversation
// only once the record has loaded, so it never subscribes to a request the
// server answered 404.
//
// Lane A2: when a blocking separation-of-duties conflict applies now and no
// override is recorded, an access admin (`can.overrideSod`, ManageAccessPolicy,
// never a party) records one with a reason of at least 20 characters — an
// approved request then provisions. An active grant shows Revoke to whoever
// holds ProvisionAccess (`can.revoke`). Both go through ConfirmDialog. A
// revocation created by an access review says which campaign it came from.

import { SidePane } from '@connorhoehn/ui-components';
import {
  Button,
  CheckIcon,
  Chip,
  CloseIcon,
  CommentIcon,
  ConfirmDialog,
  DataTable,
  DetailSection,
  EmptyState,
  FormField,
  Inline,
  InlineAlert,
  KeyValue,
  LoadingState,
  PageHeader,
  Stack,
  T,
  Textarea,
  WorkflowStepper,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { isNotFoundError, UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { ConversationComposer } from '../../lib/conversationComposer';
import { ConversationOwner, ConversationThread, type ConversationRuntime } from '../../components/chat/ConversationThread';
import { OFFLINE_REASON } from '../../components/chat/chatConnection';
import { useCapabilities } from '../../lib/capabilities';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { relativeTime } from '../../lib/relativeTime';
import { writeJson } from '../../lib/writeJson';
import {
  ACCESS_API,
  DURATION_LABELS,
  KIND_LABELS,
  STEP_KIND_LABELS,
  TENANT_LABELS,
  chainSteps,
  currentStep,
  eligibleLabel,
  escalationLabel,
  requestTitle,
  statusLabel,
  statusTone,
  stepTone,
  type AccessEvent,
  type AccessRequest,
  type Decision,
  type ItemsResponse,
  type RequestStep,
  overrideProblem,
  reviewHref,
} from '../../lib/accessRequests';
import { EVENT_COLUMNS } from './accessColumns';

/** Why a reader cannot post: ViewAccess is the thread's write authority. */
export const THREAD_READ_ONLY = 'Your current role cannot post to request discussions.';
/** Said on the composer while the record (and so the thread) is still loading. */
export const THREAD_LOADING = 'The discussion opens once the request has loaded.';

const stepColumns = (status: AccessRequest['status']): DataTableColumn<RequestStep>[] => [
  { key: 'step', header: 'Step', numeric: true, width: '64px', render: (s) => s.step },
  { key: 'kind', header: 'Approver', render: (s) => STEP_KIND_LABELS[s.kind] ?? s.kind },
  { key: 'status', header: 'Status', width: '128px', render: (s) => <Chip tone={stepTone(s.status)} size="xs">{statusLabel(s.status)}</Chip> },
  {
    key: 'who', header: 'Decided by / eligible',
    render: (s) => (
      <Inline gap="xs" align="center" wrap={false}>
        <T size="sm" title={eligibleLabel(s, status)} className="block max-w-[16rem] truncate">{eligibleLabel(s, status)}</T>
        {s.escalated && !s.decidedBy && <Chip tone="caution" size="xs" title={s.escalated}>escalated</Chip>}
      </Inline>
    ),
  },
  { key: 'decidedAt', header: 'Decided', numeric: true, render: (s) => (s.decidedAt ? relativeTime(s.decidedAt) : '—') },
  { key: 'comment', header: 'Comment', render: (s) => (s.comment ? <T size="sm" tone="secondary" title={s.comment} className="block max-w-[20rem] truncate">{s.comment}</T> : <T size="xs" tone="tertiary">—</T>) },
];

const DECISION_COPY: Record<Decision, { label: string; title: string; tone: 'info' | 'destructive' | 'caution'; needsComment: boolean }> = {
  approve: { label: 'Approve', title: 'Approve this step?', tone: 'info', needsComment: false },
  reject: { label: 'Reject', title: 'Reject this request?', tone: 'destructive', needsComment: true },
  info: { label: 'Request information', title: 'Ask the requester for more information?', tone: 'caution', needsComment: true },
};

export default function RequestRecordPage() {
  const { id } = useParams();
  const { session } = useSession();
  // A new identity or request is a new page: no comment or dialog carries across.
  return <RequestRecord key={`${session?.sub}:${session?.role}:${id}`} id={id ?? ''} />;
}

function RequestRecord({ id }: { id: string }) {
  const navigate = useNavigate();
  const { session } = useSession();
  const { data: request, error, isLoading, refresh } = useFetch<AccessRequest>(id ? `${ACCESS_API}/requests/${encodeURIComponent(id)}` : null);
  const audit = useFetch<ItemsResponse<AccessEvent>>(request?.can.viewAudit ? `${ACCESS_API}/audit?requestId=${encodeURIComponent(id)}` : null);
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState<Decision | 'withdraw' | 'override' | 'revoke' | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [revokeReason, setRevokeReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { can } = useCapabilities();
  const maySend = can('ViewAccess');
  const [conversation, setConversationState] = useState<ConversationRuntime | null>(null);
  const setConversation = useCallback((next: ConversationRuntime | null) => setConversationState(next), []);
  useCrumbLabel(id, request ? requestTitle(request) : null);
  const back = { label: 'Requests', to: '/access/requests', onClick: (e: { preventDefault: () => void }) => { e.preventDefault(); navigate('/access/requests'); } };

  const thread = request?.thread ?? `access:req:${id}`;
  const title = request ? `${requestTitle(request)} discussion` : 'Request discussion';
  const pane = (
    <SidePane title="Discussion" subtitle={request ? requestTitle(request) : 'This request'} paneId="access-request" closeLabel="Collapse request discussion" data-testid="access-request-thread-pane">
      <Stack gap="none" className="min-h-0 flex-1" data-testid="access-request-thread">
        {conversation ? (
          <ConversationThread key={conversation.channel} conversation={conversation} title={title} input="below" notices
            readOnlyReason={maySend ? null : THREAD_READ_ONLY} reactions={maySend}
            emptyState={<EmptyState testId="access-request-thread-empty" align="start" title="No messages yet"
              description="One thread per request, for the requester, the beneficiary, the approvers and access admins." />}
            data-testid="access-request-thread-panel" />
        ) : <LoadingState label="Loading discussion…" />}
      </Stack>
    </SidePane>
  );
  const composer = conversation ? (
    <ConversationComposer channel={conversation.channel} chat={conversation.chat} context={{ kind: 'conversation', id: thread, title }}
      capabilities={{ maySend, readOnlyReason: THREAD_READ_ONLY }}
      offline={conversation.connected ? null : OFFLINE_REASON}
      identity={{ userId: conversation.userId, displayName: conversation.displayName }} reply={conversation.quote}
      offModes={{ agent: 'Requests have no agent', terminal: 'Requests have no terminal' }}
      label="Request discussion" inputLabel="Message the request discussion" presentation="compact"
      modePlaceholders={{ chat: 'Message the request discussion…' }}
      data-testid="access-request-composer-dock" composerTestId="access-request-composer" />
  ) : (
    <ConversationComposer channel={null} context={{ kind: 'conversation', id: thread, title }}
      capabilities={{ maySend: false, readOnlyReason: THREAD_LOADING }} disabled persistDraft={false}
      offModes={{ agent: 'Requests have no agent', terminal: 'Requests have no terminal' }}
      label="Request discussion" inputLabel="Message the request discussion" presentation="compact"
      modePlaceholders={{ chat: THREAD_LOADING }}
      data-testid="access-request-composer-dock" composerTestId="access-request-composer" />
  );

  if (error && !request) {
    return (
      <Stack gap="md" data-testid="access-request-missing">
        <PageHeader density="compact" title="Request" back={back} />
        {isNotFoundError(error) || /404|not found/i.test(error) ? (
          <EmptyState testId="access-request-unavailable" align="start" title="Request not found"
            description={`There is no request here that you may read. You can read a request you made or benefit from, one you may decide, or any as an access admin.`} />
        ) : (
          <UnavailableNotice error={error} what="this request" source="Requests are read from access_requests" onRetry={refresh} />
        )}
      </Stack>
    );
  }
  if (!request) return <LoadingState label={isLoading ? 'Loading request…' : 'Loading…'} />;

  const step = currentStep(request);
  const mayDecide = request.can.decide && !!step;
  // A delegate decides for their delegator (2026-10-14): the hint says for whom.
  const onBehalfOf = step?.eligible.find((p) => p.id === session?.sub)?.onBehalfOf ?? null;

  async function act(kind: Decision | 'withdraw' | 'override' | 'revoke') {
    setPending(null); setBusy(true); setWriteError(null); setNotice(null);
    const base = `${ACCESS_API}/requests/${encodeURIComponent(request!.id)}`;
    const res = kind === 'withdraw' ? await writeJson<AccessRequest>(`${base}/withdraw`, 'POST')
      : kind === 'override' ? await writeJson<AccessRequest>(`${base}/sod-override`, 'POST', { reason: overrideReason.trim() })
      : kind === 'revoke' ? await writeJson<AccessRequest>(`${base}/revoke`, 'POST', { reason: revokeReason.trim() })
      : await writeJson<AccessRequest>(`${base}/steps/${step!.step}/decide`, 'POST', { decision: kind, comment: comment.trim() });
    setBusy(false);
    if (!res.ok) { setWriteError(res.error ?? `The server refused (HTTP ${res.status}). Nothing changed.`); refresh(); return; }
    if (kind === 'override') {
      setOverrideReason('');
      setNotice(res.data?.status === 'active' ? 'Override recorded; the request is provisioned.' : 'Override recorded.');
    } else if (kind === 'revoke') {
      setRevokeReason('');
      setNotice('Access revoked. Every session the beneficiary holds is signed out at its next request.');
    } else {
      setComment('');
      setNotice(kind === 'withdraw' ? 'Request withdrawn.' : `Recorded: ${DECISION_COPY[kind].label.toLowerCase()} on step ${step!.step}.`);
    }
    refresh(); audit.refresh();
  }

  const confirm = pending === 'approve' || pending === 'reject' || pending === 'info' ? DECISION_COPY[pending] : null;
  const overrideBlocked = overrideProblem(overrideReason);
  const headerActions = [
    request.can.revoke && <Button key="revoke" size="sm" variant="danger" disabled={busy} onClick={() => setPending('revoke')} data-testid="access-request-revoke">Revoke</Button>,
    request.can.withdraw && <Button key="withdraw" size="sm" variant="secondary" disabled={busy} onClick={() => setPending('withdraw')} data-testid="access-request-withdraw">Withdraw</Button>,
  ].filter(Boolean);

  return (
    <Stack gap="none" className="h-full min-h-0 min-w-0" data-testid="access-request-record">
      <Stack gap="md" className="min-h-0 flex-1 overflow-auto">
        <PageHeader density="compact" title={requestTitle(request)} back={back}
          description={`Requested by ${request.requester.displayName} ${relativeTime(request.submittedAt)}`}
          badge={<Chip tone={statusTone(request.status)} size="xs">{statusLabel(request.status)}</Chip>}
          {...(headerActions.length ? { actions: <Inline gap="sm">{headerActions}</Inline> } : {})} />
        {writeError && <InlineAlert tone="error" onDismiss={() => setWriteError(null)}>{writeError}</InlineAlert>}
        {notice && <InlineAlert tone="success" onDismiss={() => setNotice(null)}>{notice}</InlineAlert>}

        <DetailSection variant="heading" first title="Request" data-testid="access-request-summary">
          {/* grid: 12px labels over 14px values (T size="sm"), the app's 12/14 scale. */}
          <KeyValue layout="grid" items={[
            { label: 'For', value: <T size="sm">{request.beneficiary.displayName}</T> },
            { label: request.kind === 'revocation' ? 'Revoked by' : 'Asked by', value: <T size="sm">{request.requester.displayName}</T> },
            { label: request.kind === 'revocation' ? 'Grant' : 'Item', value: <T size="sm">{`${request.item.title} · ${KIND_LABELS[request.item.kind]} · ${TENANT_LABELS[request.item.tenant] ?? request.item.tenant}`}</T> },
            ...(request.kind === 'revocation' ? [{
              label: 'From review',
              value: request.reviewId
                ? <Button size="sm" variant="link" onClick={() => navigate(reviewHref(request.reviewId!))} data-testid="access-request-review-link">Open the review campaign</Button>
                : <T size="sm" tone="tertiary">—</T>,
            }] : [
              { label: 'Duration', value: <T size="sm">{DURATION_LABELS[request.duration] ?? request.duration}</T> },
              { label: 'Expires', value: <T size="sm" tone={request.expiresAt ? undefined : 'tertiary'}>{request.expiresAt ? relativeTime(request.expiresAt) : request.duration === 'standing' ? 'Standing' : 'When provisioned'}</T> },
            ]),
            // The justification is prose an approver reads first: it wraps
            // inside its cell (KeyValue's value cell truncates by default,
            // which cut it off mid-word at the Discussion pane's edge).
            { label: 'Why', value: <T as="p" size="sm" wrap className="m-0 whitespace-normal break-words" data-testid="access-request-justification">{request.justification}</T> },
          ]} />
        </DetailSection>

        <DetailSection variant="heading" title="Approval chain" hint={`${request.steps.length} steps`} data-testid="access-request-chain">
          <Stack gap="md">
            <WorkflowStepper size="compact" steps={chainSteps(request.steps)} aria-label={step ? `Waiting on step ${step.step} of ${request.steps.length}` : `Chain of ${request.steps.length} steps`} />
            <DataTable data-testid="access-request-steps" data={request.steps} columns={stepColumns(request.status)} keyField={(s) => String(s.step)}
              staticRows="The request's approval steps, read in place; each is decided on this record"
              emptyMessage="No approval steps were computed for this request." />
            {request.steps.filter((s) => s.escalated && !s.decidedBy).map((s) => (
              <T key={s.step} size="xs" tone="secondary" data-testid={`access-request-escalated-${s.step}`}>{`Step ${s.step} (${STEP_KIND_LABELS[s.kind]}): ${s.escalated}`}</T>
            ))}
            {step && escalationLabel(step) && (
              // The escalation timer (2026-10-14): where the waiting step stands and when it moves to the next tier.
              <T size="xs" tone="secondary" data-testid="access-request-escalation-timer">{`Step ${step.step} (${STEP_KIND_LABELS[step.kind]}): ${escalationLabel(step)}`}</T>
            )}
          </Stack>
        </DetailSection>

        {mayDecide && (
          <DetailSection variant="heading" title="Your decision" hint={`Step ${step!.step} · ${STEP_KIND_LABELS[step!.kind]}${onBehalfOf ? ` · for ${onBehalfOf.displayName}` : ''}`} data-testid="access-request-decision">
            <Stack gap="sm">
              <FormField label="Comment" hint="Recorded on the step and in the audit trail. Required to reject or to ask for information.">
                {(wiring) => <Textarea {...wiring} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} data-testid="access-request-comment" />}
              </FormField>
              <Inline gap="sm">
                <Button size="sm" variant="primary" disabled={busy} onClick={() => setPending('approve')} data-testid="access-request-approve"><CheckIcon />Approve</Button>
                <Button size="sm" variant="danger" disabled={busy || !comment.trim()} onClick={() => setPending('reject')} data-testid="access-request-reject"><CloseIcon />Reject</Button>
                <Button size="sm" variant="secondary" disabled={busy || !comment.trim()} onClick={() => setPending('info')} data-testid="access-request-info"><CommentIcon />Request information</Button>
              </Inline>
            </Stack>
          </DetailSection>
        )}

        <DetailSection variant="heading" title="Policy check" hint={request.sod.verdict} data-testid="access-request-sod">
          {request.sod.conflicts.length === 0 ? (
            <T size="sm" tone="secondary">No separation-of-duties conflict for {request.beneficiary.displayName}.</T>
          ) : (
            <Stack gap="sm">
              {request.sod.conflicts.map((c) => (
                <InlineAlert key={c.policyId} tone={c.severity === 'block' ? 'error' : 'warning'}>{`${c.title ?? 'Separation of duties'}: ${c.reason}`}</InlineAlert>
              ))}
              {request.sod.overriddenBy && (
                <T size="sm" tone="secondary">{`Overridden by ${request.sod.overriddenBy.displayName}: ${request.sod.overrideReason ?? 'no reason recorded'}`}</T>
              )}
              {!request.sod.overriddenBy && request.sod.verdict === 'block' && !request.can.overrideSod && (
                <T size="sm" tone="secondary">{request.status === 'approved'
                  ? 'Approved, but not provisioned: an access admin must record an override before the grant is written.'
                  : 'An access admin must record an override before this can be provisioned.'}</T>
              )}
              {request.can.overrideSod && (
                <Stack gap="sm" data-testid="access-request-override">
                  <FormField label="Override reason" hint={`Recorded on the request and in the audit trail. At least 20 characters.${request.status === 'approved' ? ' The request is provisioned once the override is recorded.' : ''}`}>
                    {(wiring) => <Textarea {...wiring} rows={2} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} data-testid="access-request-override-reason" />}
                  </FormField>
                  <Inline gap="sm" align="center">
                    <Button size="sm" variant="secondary" disabled={busy || !!overrideBlocked} onClick={() => setPending('override')} data-testid="access-request-override-submit">Record override</Button>
                    {overrideBlocked && overrideReason.trim() && <T size="xs" tone="secondary">{overrideBlocked}</T>}
                  </Inline>
                </Stack>
              )}
            </Stack>
          )}
        </DetailSection>

        {request.can.viewAudit && (
          <DetailSection variant="heading" title="Audit" hint={audit.data ? `${audit.data.items.length} events` : undefined} data-testid="access-request-audit">
            {audit.error ? (
              <UnavailableNotice error={audit.error} what="this request's events" source="Events are read from access_events" onRetry={audit.refresh} />
            ) : (
              <DataTable data-testid="access-request-events" data={audit.data?.items ?? []} columns={EVENT_COLUMNS.filter((c) => c.key !== 'requestId')}
                keyField={(e) => e.id} loading={audit.isLoading && !audit.data}
                staticRows="This request's audit events, read in place; the Audit page holds the full trail" emptyMessage="No events recorded for this request yet." />
            )}
          </DetailSection>
        )}
      </Stack>
      {/* The thread's ONE runtime, shared by the pane and the docked composer; mounted only for a loaded record. */}
      <ConversationOwner key={request.thread} channel={request.thread} maySend={maySend} onChange={setConversation} />
      <Stack gap="none" className="shrink-0 min-w-0" data-testid="access-request-composer-column">{composer}</Stack>
      {pane}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        body={confirm ? `${confirm.label} step ${step?.step ?? ''} (${step ? STEP_KIND_LABELS[step.kind] : ''}) of ${requestTitle(request)}.${comment.trim() ? ` Comment: “${comment.trim()}”` : ''}` : ''}
        confirmLabel={confirm?.label}
        cancelLabel="Keep it"
        tone={confirm?.tone}
        onConfirm={() => { if (confirm && pending) void act(pending); }}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === 'override'}
        title="Override the separation-of-duties block?"
        body={`${request.beneficiary.displayName} will hold ${request.item.title} despite ${request.sod.conflicts.filter((c) => c.severity === 'block').map((c) => c.title ?? 'the policy').join(', ')}. Reason: “${overrideReason.trim()}”${request.status === 'approved' ? ' The grant is written as soon as the override is recorded.' : ''}`}
        confirmLabel="Record override"
        cancelLabel="Keep it blocked"
        tone="caution"
        onConfirm={() => void act('override')}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === 'revoke'}
        title="Revoke this access now?"
        body={`${request.item.title} is removed from ${request.beneficiary.displayName} at once, and every session they hold is signed out at its next request.`}
        confirmLabel="Revoke"
        confirmDisabled={!revokeReason.trim()}
        cancelLabel="Keep it"
        tone="destructive"
        onConfirm={() => void act('revoke')}
        onCancel={() => setPending(null)}
      >
        <FormField label="Reason" hint="Sent to the beneficiary and the requester, and recorded in the audit trail." required>
          {(wiring) => <Textarea {...wiring} rows={2} value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} data-testid="access-request-revoke-reason" />}
        </FormField>
      </ConfirmDialog>
      <ConfirmDialog
        open={pending === 'withdraw'}
        title="Withdraw this request?"
        body={`This request stops here: no approver can decide it and nothing is provisioned. You can submit a new request later.`}
        confirmLabel="Withdraw"
        cancelLabel="Keep it"
        tone="destructive"
        onConfirm={() => void act('withdraw')}
        onCancel={() => setPending(null)}
      />
    </Stack>
  );
}
