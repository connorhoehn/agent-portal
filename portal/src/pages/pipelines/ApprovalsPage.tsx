// /pipelines/approvals — every step waiting on a person, as event-catalog
// `pipeline.approval.requested` (docs/pipelines-tenant-goal.md §P2): a job at
// review, a change the policy gates held, an agent's question. Read from
// GET /api/pipelines/approvals. Approve / Reject (ApproveStep holders whose
// role the step names — operator by default, design §8) post to
// /approvals/:id/decide, which routes the decision to the gate's own path;
// the tenant keeps no second approval store. Authors see the queue, not the
// buttons — absent from the DOM, not disabled. A row opens the waiting step
// as a page, `/pipelines/approvals/:approvalId`, the queue as the list rail
// beside it — never a drawer.

import {
  CollectionToolbar,
  Banner,
  BranchIcon,
  Button,
  CheckIcon,
  Chip,
  CloseIcon,
  DataTable,
  DetailHeader,
  IconButton,
  Inline,
  InlineAlert,
  KeyValue,
  ListIcon,
  MetaLine,
  Stack,
  Textarea,
  Tooltip,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CollectionRecordFrame } from '../../components/collections/CollectionRecordFrame';
import { RecordNotFound } from '../../components/UnavailableNotice';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { LoadingState } from '@connorhoehn/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import {
  approvalSourceLabel,
  approverSummary,
  canDecide,
  definitionHref,
  type ApprovalRequest,
} from '../../lib/pipelineDefinitions';
import { runHref } from '../../lib/pipelineRuns';
import { pipelineCollectionAdapter, resolvePipelineCollectionTarget } from './pipelineCollectionCommands';
import { relativeTime } from '../../lib/relativeTime';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';

/** A step id as the step it is: the run's execution, the delivery gate, the human review. */
const STEP_LABELS: Record<string, string> = { execute: 'Running', gate: 'Delivery gate', review: 'Human review' };
const stepLabel = (id: string): string => STEP_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1).replaceAll(/[-_]+/g, ' ');

interface ApprovalsResponse { approvals: ApprovalRequest[]; total: number; unavailable: Array<{ source: string; error: string }> }

const COLUMNS: DataTableColumn<ApprovalRequest>[] = [
  { key: 'title', header: 'Waiting step', render: (a) => a.title },
  { key: 'source', header: 'Asked by', width: '128px', render: (a) => <Chip tone="neutral" size="xs">{approvalSourceLabel(a.source)}</Chip> },
  { key: 'step', header: 'Step', render: (a) => stepLabel(a.stepId) },
  { key: 'approvers', header: 'Approved by', render: (a) => approverSummary(a.requiredRoles, a.rolesDefaulted) },
  {
    key: 'requestedAt', header: 'Waiting since', numeric: true, sortable: true,
    compare: (x, y) => (x.requestedAt ?? '').localeCompare(y.requestedAt ?? ''),
    render: (a) => (a.requestedAt ? relativeTime(a.requestedAt) : '—'),
  },
];

export default function ApprovalsPage() {
  const { session } = useSession();
  return <ApprovalsWorkspace key={`${session?.sub}:${session?.tenant}:${session?.role}`} />;
}

function ApprovalsWorkspace() {
  const navigate = useNavigate();
  const { session } = useSession();
  const { can, ready } = useCapabilities();
  const { data, error, isLoading, refresh } = useFetch<ApprovalsResponse>('/api/pipelines/approvals', 30_000);
  // The open step is the URL (`/pipelines/approvals/:approvalId`).
  const { approvalId } = useParams<{ approvalId?: string }>();
  const openId = approvalId ?? null;
  const setOpenId = (id: string | null) => navigate(id ? `/pipelines/approvals/${encodeURIComponent(id)}` : '/pipelines/approvals');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const all = data?.approvals ?? [];
  const rows = all.filter(a => [a.id, a.title, a.question, a.stepId, a.source, approvalSourceLabel(a.source)]
    .some(value => value.toLowerCase().includes(query.trim().toLowerCase())));
  const open = all.find((a) => a.id === openId) ?? null;
  const holdsApprove = ready && can('ApproveStep');
  const mayDecide = open ? holdsApprove && canDecide(session?.role, open.requiredRoles) : false;

  const adapter = pipelineCollectionAdapter('approvals', {
    setQuery, refresh,
    scopeNote: 'Search the waiting steps by question or source. Open shows one for review; approve and reject happen on its page.',
    open(target) {
      if (!data || isLoading || error) throw new Error('Wait for approvals to load successfully before opening a step.');
      const row = resolvePipelineCollectionTarget(target, rows);
      setOpenId(row.id); setNote('');
      return `Opened ${row.title} for review. No decision was recorded.`;
    },
  });

  async function decide(decision: 'approve' | 'reject') {
    if (!open) return;
    setBusy(true);
    const res = await writeJson<{ outcome: string; decidedThrough: string }>(
      `/api/pipelines/approvals/${encodeURIComponent(open.id)}/decide`, 'POST', { decision, note: note.trim() || null },
    );
    setBusy(false);
    if (res.ok && res.data) {
      toastSuccess(null, decision === 'approve' ? 'Approved' : 'Rejected', `Recorded through ${res.data.decidedThrough}.`);
      setOpenId(null); setNote(''); refresh();
    } else toastError(null, 'Could not record the decision', res.error ?? undefined);
  }

  useCrumbLabel(openId ?? undefined, open ? open.title : null);
  if (openId) {
    const sources = [...new Set(rows.map((a) => a.source))];
    return (
      <CollectionRecordFrame
        title="Approvals"
        listTitle="Waiting"
        listLabel="approvals"
        {...(data ? { count: rows.length } : {})}
        search={{ value: query, onChange: setQuery, placeholder: 'Find a waiting step' }}
        groups={sources.map((src) => ({ id: src, title: approvalSourceLabel(src), count: rows.filter((a) => a.source === src).length }))}
        rows={rows.map((a) => ({ id: a.id, groupId: a.source, title: a.title, subline: `${stepLabel(a.stepId)} · ${a.requestedAt ? relativeTime(a.requestedAt) : 'waiting'}` }))}
        currentId={openId}
        onOpen={(id) => { setNote(''); setOpenId(id); }}
        loading={isLoading && !data}
        error={error}
        onRetry={refresh}
        footer={<CollectionCommandHost adapter={adapter} disabled={busy} />}
        data-testid="pipelines-approval-explorer"
      >
        {open ? (
          <Stack gap="md" data-testid="pipelines-approval-record">
            <DetailHeader title={open.title} description={`${approvalSourceLabel(open.source)}${open.requestedAt ? ` · waiting since ${relativeTime(open.requestedAt)}` : ''}`} />
            <MetaLine size="sm" tone="secondary" items={[open.question]} />
            {open.detail && <MetaLine size="xs" tone="secondary" items={[open.detail]} />}
            <KeyValue
              layout="row"
              items={[
                { label: 'Step', value: stepLabel(open.stepId) },
                { label: 'Run', value: open.runId ?? 'No run is linked', mono: Boolean(open.runId), muted: !open.runId },
                { label: 'Definition', value: open.definitionId ?? 'None known', mono: Boolean(open.definitionId), muted: !open.definitionId },
                { label: 'Approved by', value: approverSummary(open.requiredRoles, open.rolesDefaulted) },
                { label: 'Decided through', value: open.decidedThrough },
                { label: 'Waiting since', value: open.requestedAt ? relativeTime(open.requestedAt) : '—' },
              ]}
            />
            <Inline gap="sm" wrap>
              {open.runId && <Tooltip content="Open run"><IconButton size="sm" aria-label="Open run" icon={<ListIcon />} onClick={() => navigate(runHref('/pipelines/runs', open.runId!))} /></Tooltip>}
              {open.definitionId?.startsWith('bot:') || open.definitionId?.startsWith('runbook:') ? (
                <Tooltip content="Open definition"><IconButton size="sm" aria-label="Open definition" icon={<BranchIcon />} onClick={() => navigate(definitionHref(open.definitionId!))} /></Tooltip>
              ) : null}
            </Inline>
            {mayDecide ? (
              <>
                <Textarea aria-label="Decision note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note for the record (optional)" />
                <Inline gap="sm" justify="end">
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => void decide('reject')} data-testid="pipelines-approval-reject"><CloseIcon />Reject</Button>
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide('approve')} data-testid="pipelines-approval-approve"><CheckIcon />Approve</Button>
                </Inline>
              </>
            ) : (
              <InlineAlert tone="info">
                {holdsApprove
                  ? `This step is approved by ${approverSummary(open.requiredRoles, open.rolesDefaulted)}; your role cannot decide it.`
                  : 'Only an operator or a pipeline admin decides a step. You can see what is waiting.'}
              </InlineAlert>
            )}
          </Stack>
        ) : isLoading || !data ? (
          <LoadingState label="Loading the waiting step…" />
        ) : (
          <RecordNotFound heading="Approval" size="md" title="Nothing is waiting here"
            body={`No waiting step has the id "${openId}" — it may already have been decided.`}
            backLabel="Approvals" onBack={() => setOpenId(null)} />
        )}
      </CollectionRecordFrame>
    );
  }

  return (
    <CollectionCommandPage data-testid="pipelines-approvals" title="Approvals" description="Steps waiting on a person — a job at review, a change the gates held, an agent’s question.">
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
      <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
      <CollectionToolbar {...{ label: 'Approvals filters', search: { value: query, onChange: setQuery, placeholder: 'Search approvals', 'aria-label': 'Search approvals' }, summary: data ? `${rows.length} waiting` : undefined,
        notices: holdsApprove ? [] : ['Operators and pipeline admins decide these.'],
        onRefresh: refresh, refreshing: isLoading,
      }} />

      {data && data.unavailable.length > 0 && (
        <Banner variant="warning">
          {`Not every gate could be read — ${data.unavailable.map((u) => `${u.source}: ${u.error}`).join('; ')}. Steps waiting there are missing below, not absent.`}
        </Banner>
      )}
      {error ? (
        <UnavailableNotice error={error} what="approvals" source="Approvals are read off the job review, change gate and consult queues" onRetry={refresh} />
      ) : (
        <DataTable
          data-testid="pipelines-approvals-table"
          data={rows}
          columns={COLUMNS}
          keyField={(a) => a.id}
          loading={isLoading && !data}
          pageSize={25}
          onRowClick={(a) => { setOpenId(a.id); setNote(''); }}
          emptyMessage={query.trim() ? 'No approvals match this search.' : 'Nothing is waiting on a person.'}
        />
      )}
      </Stack>
      <CollectionCommandHost adapter={adapter} disabled={busy} />
      </Stack>
    </CollectionCommandPage>
  );
}
