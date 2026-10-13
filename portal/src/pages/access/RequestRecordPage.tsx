// /access/requests/:id — one request (docs/access-tenant-design.md §4.2): its
// approval chain, the decision controls the actor may use NOW (`can.decide`,
// computed by the server from the live approver resolver and the two row rules:
// nobody decides their own request, a step is decided once), Withdraw for the
// requester or beneficiary (`can.withdraw`), the separation-of-duties check and
// the request's audit events.
//
// The conversation (decision A8) is the request's thread `access:req:<id>`,
// shown in the shell's right pane with ONE composer docked at the bottom of the
// content column — the initiative page's arrangement (docs/layout-cascade.md
// "The pane and rail contracts"). The gateway family `access:req:` is lane A1's
// (docs/access-tenant-goal.md §A1), so in A0 the pane says so and the composer
// is mounted disabled with that reason: nothing here posts to a channel the
// gateway would refuse.

import { SidePane } from '@connorhoehnslalom/ui-components';
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
} from '@connorhoehnslalom/ui-components/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { isNotFoundError, UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { ConversationComposer } from '../../lib/conversationComposer';
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
  requestTitle,
  statusLabel,
  statusTone,
  stepTone,
  type AccessEvent,
  type AccessRequest,
  type Decision,
  type ItemsResponse,
  type RequestStep,
} from '../../lib/accessRequests';
import { EVENT_COLUMNS } from './accessColumns';

/** Why the composer is off in A0 — said on the composer and in the pane. */
export const THREAD_PENDING = 'The request discussion opens in lane A1, when the gateway admits access:req: threads to the requester, the current approvers and access admins.';

const STEP_COLUMNS: DataTableColumn<RequestStep>[] = [
  { key: 'step', header: 'Step', numeric: true, width: '64px', render: (s) => s.step },
  { key: 'kind', header: 'Approver', render: (s) => STEP_KIND_LABELS[s.kind] ?? s.kind },
  { key: 'status', header: 'Status', width: '128px', render: (s) => <Chip tone={stepTone(s.status)} size="xs">{statusLabel(s.status)}</Chip> },
  { key: 'who', header: 'Decided by / eligible', render: (s) => <T size="sm" title={eligibleLabel(s)} className="block max-w-[18rem] truncate">{eligibleLabel(s)}</T> },
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
  const { data: request, error, isLoading, refresh } = useFetch<AccessRequest>(id ? `${ACCESS_API}/requests/${encodeURIComponent(id)}` : null);
  const audit = useFetch<ItemsResponse<AccessEvent>>(request?.can.viewAudit ? `${ACCESS_API}/audit?requestId=${encodeURIComponent(id)}` : null);
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState<Decision | 'withdraw' | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useCrumbLabel(id, request ? `${request.id} · ${request.item.title}` : null);
  const back = { label: 'Requests', to: '/access/requests', onClick: (e: { preventDefault: () => void }) => { e.preventDefault(); navigate('/access/requests'); } };

  const thread = request?.thread ?? `access:req:${id}`;
  const pane = (
    <SidePane title="Discussion" subtitle={thread} paneId="access-request" closeLabel="Collapse request discussion" data-testid="access-request-thread-pane">
      <EmptyState testId="access-request-thread-pending" align="start"
        title="The discussion is not open yet"
        description="Each request carries one thread for the requester, the current approvers and access admins."
        details={{ title: 'What comes next', body: THREAD_PENDING }} />
    </SidePane>
  );
  const composer = (
    <ConversationComposer channel={null} context={{ kind: 'conversation', id: thread, title: request ? `${request.id} discussion` : 'Request discussion' }}
      capabilities={{ maySend: false, readOnlyReason: THREAD_PENDING }} disabled persistDraft={false}
      offModes={{ agent: 'Requests have no agent', terminal: 'Requests have no terminal' }}
      label="Request discussion" inputLabel="Message the request discussion" presentation="compact"
      modePlaceholders={{ chat: 'The request discussion opens in lane A1' }}
      data-testid="access-request-composer-dock" composerTestId="access-request-composer" />
  );

  if (error && !request) {
    return (
      <Stack gap="md" data-testid="access-request-missing">
        <PageHeader density="compact" title="Request" back={back} />
        {isNotFoundError(error) || /404|not found/i.test(error) ? (
          <EmptyState testId="access-request-unavailable" align="start" title="Request not found"
            description={`No request ${id} that you may read. You can read a request you made or benefit from, one you may decide, or any as an access admin.`} />
        ) : (
          <UnavailableNotice error={error} what="this request" source="Requests are read from access_requests" onRetry={refresh} />
        )}
      </Stack>
    );
  }
  if (!request) return <LoadingState label={isLoading ? 'Loading request…' : 'Loading…'} />;

  const step = currentStep(request);
  const mayDecide = request.can.decide && !!step;

  async function act(kind: Decision | 'withdraw') {
    setPending(null); setBusy(true); setWriteError(null); setNotice(null);
    const res = kind === 'withdraw'
      ? await writeJson<AccessRequest>(`${ACCESS_API}/requests/${encodeURIComponent(request!.id)}/withdraw`, 'POST')
      : await writeJson<AccessRequest>(`${ACCESS_API}/requests/${encodeURIComponent(request!.id)}/steps/${step!.step}/decide`, 'POST',
        { decision: kind, comment: comment.trim() });
    setBusy(false);
    if (!res.ok) { setWriteError(res.error ?? `The server refused (HTTP ${res.status}). Nothing changed.`); refresh(); return; }
    setComment('');
    setNotice(kind === 'withdraw' ? 'Request withdrawn.' : `Recorded: ${DECISION_COPY[kind].label.toLowerCase()} on step ${step!.step}.`);
    refresh(); audit.refresh();
  }

  const confirm = pending && pending !== 'withdraw' ? DECISION_COPY[pending] : null;

  return (
    <Stack gap="none" className="h-full min-h-0 min-w-0" data-testid="access-request-record">
      <Stack gap="md" className="min-h-0 flex-1 overflow-auto">
        <PageHeader density="compact" title={requestTitle(request)} back={back}
          description={`${request.id} · requested by ${request.requester.displayName} ${relativeTime(request.submittedAt)}`}
          badge={<Chip tone={statusTone(request.status)} size="xs">{statusLabel(request.status)}</Chip>}
          {...(request.can.withdraw ? {
            actions: <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPending('withdraw')} data-testid="access-request-withdraw">Withdraw</Button>,
          } : {})} />
        {writeError && <InlineAlert tone="error" onDismiss={() => setWriteError(null)}>{writeError}</InlineAlert>}
        {notice && <InlineAlert tone="success" onDismiss={() => setNotice(null)}>{notice}</InlineAlert>}

        <DetailSection first title="Request" data-testid="access-request-summary">
          <KeyValue items={[
            { label: 'For', value: request.beneficiary.displayName },
            { label: 'Asked by', value: request.requester.displayName },
            { label: 'Item', value: `${request.item.title} · ${KIND_LABELS[request.item.kind]} · ${TENANT_LABELS[request.item.tenant] ?? request.item.tenant}` },
            { label: 'Duration', value: DURATION_LABELS[request.duration] ?? request.duration },
            { label: 'Expires', value: request.expiresAt ? relativeTime(request.expiresAt) : request.duration === 'standing' ? 'Standing' : 'When provisioned', muted: !request.expiresAt },
            { label: 'Why', value: request.justification },
          ]} />
        </DetailSection>

        <DetailSection title="Approval chain" hint={`${request.steps.length} steps`} data-testid="access-request-chain">
          <Stack gap="md">
            <WorkflowStepper steps={chainSteps(request.steps)} aria-label={step ? `Waiting on step ${step.step} of ${request.steps.length}` : `Chain of ${request.steps.length} steps`} />
            <DataTable data-testid="access-request-steps" data={request.steps} columns={STEP_COLUMNS} keyField={(s) => String(s.step)}
              emptyMessage="No approval steps were computed for this request." />
          </Stack>
        </DetailSection>

        {mayDecide && (
          <DetailSection title="Your decision" hint={`Step ${step!.step} · ${STEP_KIND_LABELS[step!.kind]}`} data-testid="access-request-decision">
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

        <DetailSection title="Policy check" hint={request.sod.verdict} data-testid="access-request-sod">
          {request.sod.conflicts.length === 0 ? (
            <T size="sm" tone="secondary">No separation-of-duties conflict for {request.beneficiary.displayName}.</T>
          ) : (
            <Stack gap="sm">
              {request.sod.conflicts.map((c) => (
                <InlineAlert key={c.policyId} tone={c.severity === 'block' ? 'error' : 'warning'}>{`${c.policyId}: ${c.reason}`}</InlineAlert>
              ))}
              {request.sod.overriddenBy && (
                <T size="sm" tone="secondary">{`Overridden by ${request.sod.overriddenBy.displayName}: ${request.sod.overrideReason ?? 'no reason recorded'}`}</T>
              )}
            </Stack>
          )}
        </DetailSection>

        {request.can.viewAudit && (
          <DetailSection title="Audit" hint={audit.data ? `${audit.data.items.length} events` : undefined} data-testid="access-request-audit">
            {audit.error ? (
              <UnavailableNotice error={audit.error} what="this request's events" source="Events are read from access_events" onRetry={audit.refresh} />
            ) : (
              <DataTable data-testid="access-request-events" data={audit.data?.items ?? []} columns={EVENT_COLUMNS.filter((c) => c.key !== 'requestId')}
                keyField={(e) => e.id} loading={audit.isLoading && !audit.data} emptyMessage="No events recorded for this request yet." />
            )}
          </DetailSection>
        )}
      </Stack>
      <Stack gap="none" className="shrink-0 min-w-0" data-testid="access-request-composer-column">{composer}</Stack>
      {pane}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        body={confirm ? `${confirm.label} step ${step?.step ?? ''} (${step ? STEP_KIND_LABELS[step.kind] : ''}) of ${request.id}.${comment.trim() ? ` Comment: “${comment.trim()}”` : ''}` : ''}
        confirmLabel={confirm?.label}
        cancelLabel="Keep it"
        tone={confirm?.tone}
        onConfirm={() => { if (pending && pending !== 'withdraw') void act(pending); }}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog
        open={pending === 'withdraw'}
        title="Withdraw this request?"
        body={`${request.id} stops here: no approver can decide it and nothing is provisioned. You can submit a new request later.`}
        confirmLabel="Withdraw"
        cancelLabel="Keep it"
        tone="destructive"
        onConfirm={() => void act('withdraw')}
        onCancel={() => setPending(null)}
      />
    </Stack>
  );
}
