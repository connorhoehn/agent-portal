// /pipelines/approvals — every step waiting on a person, as event-catalog
// `pipeline.approval.requested` (docs/pipelines-tenant-goal.md §P2): a job at
// review, a change the policy gates held, an agent's question. Read from
// GET /api/pipelines/approvals. Approve / Reject (ApproveStep holders whose
// role the step names — operator by default, design §8) post to
// /approvals/:id/decide, which routes the decision to the gate's own path;
// the tenant keeps no second approval store. Authors see the queue, not the
// buttons — absent from the DOM, not disabled.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CheckIcon, CloseIcon, ListIcon, BranchIcon, Toolbar, IconButton, Tooltip, RepeatIcon,
  Banner, Button, Chip, DataTable, Drawer, InlineAlert, Inline, KeyValue, MetaLine, PageHeader, Stack, Textarea,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { useSession } from '../../lib/auth';
import { relativeTime } from '../../lib/relativeTime';
import { writeJson } from '../../lib/writeJson';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { runHref } from '../../lib/pipelineRuns';
import {
  approvalSourceLabel, approverSummary, canDecide, definitionHref, type ApprovalRequest,
} from '../../lib/pipelineDefinitions';

interface ApprovalsResponse { approvals: ApprovalRequest[]; total: number; unavailable: Array<{ source: string; error: string }> }

const COLUMNS: DataTableColumn<ApprovalRequest>[] = [
  { key: 'title', header: 'Waiting step', render: (a) => a.title },
  { key: 'source', header: 'Asked by', width: '128px', render: (a) => <Chip tone="neutral" size="xs">{approvalSourceLabel(a.source)}</Chip> },
  { key: 'step', header: 'Step', render: (a) => a.stepId },
  { key: 'approvers', header: 'Approved by', render: (a) => approverSummary(a.requiredRoles, a.rolesDefaulted) },
  {
    key: 'requestedAt', header: 'Waiting since', numeric: true, sortable: true,
    compare: (x, y) => (x.requestedAt ?? '').localeCompare(y.requestedAt ?? ''),
    render: (a) => (a.requestedAt ? relativeTime(a.requestedAt) : '—'),
  },
];

export default function ApprovalsPage() {
  const navigate = useNavigate();
  const { session } = useSession();
  const { can, ready } = useCapabilities();
  const { data, error, isLoading, refresh } = useFetch<ApprovalsResponse>('/api/pipelines/approvals', 30_000);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = data?.approvals ?? [];
  const open = rows.find((a) => a.id === openId) ?? null;
  const holdsApprove = ready && can('ApproveStep');
  const mayDecide = open ? holdsApprove && canDecide(session?.role, open.requiredRoles) : false;

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

  return (
    <Stack gap="md" className="min-w-0" data-testid="pipelines-approvals">
      <PageHeader density="compact" title="Approvals" description="Steps waiting on a person — a job at review, a change the gates held, an agent's question." />
      <Toolbar aria-label="Approvals summary" wrap className="px-0" end={<Tooltip content="Refresh"><IconButton size="sm" aria-label="Refresh" icon={<RepeatIcon />} onClick={refresh} disabled={isLoading} /></Tooltip>}>
      {data && (
        <MetaLine size="xs" tone="tertiary" items={[
          `${rows.length} waiting`,
          holdsApprove ? null : 'operators and pipeline admins decide these',
        ]} />
      )}
      </Toolbar>
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
          size="sm"
          data={rows}
          columns={COLUMNS}
          keyField={(a) => a.id}
          loading={isLoading && !data}
          pageSize={25}
          onRowClick={(a) => { setOpenId(a.id); setNote(''); }}
          emptyMessage="Nothing is waiting on a person."
        />
      )}
      <Drawer
        open={open !== null}
        onClose={() => setOpenId(null)}
        title={open ? approvalSourceLabel(open.source) : 'Approval'}
        subtitle={open?.id}
        width={560}
        data-testid="pipelines-approval-drawer"
        footer={open && mayDecide ? (
          <Inline gap="sm" justify="end">
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void decide('reject')} data-testid="pipelines-approval-reject"><CloseIcon />Reject</Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide('approve')} data-testid="pipelines-approval-approve"><CheckIcon />Approve</Button>
          </Inline>
        ) : undefined}
      >
        {open && (
          <Stack gap="md">
            <MetaLine size="sm" tone="secondary" items={[open.question]} />
            {open.detail && <MetaLine size="xs" tone="secondary" items={[open.detail]} />}
            <KeyValue
              layout="row"
              items={[
                { label: 'Step', value: open.stepId, mono: true },
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
              <Textarea aria-label="Decision note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note for the record (optional)" />
            ) : (
              <InlineAlert tone="info">
                {holdsApprove
                  ? `This step is approved by ${approverSummary(open.requiredRoles, open.rolesDefaulted)}; your role cannot decide it.`
                  : 'Only an operator or a pipeline admin decides a step. You can see what is waiting.'}
              </InlineAlert>
            )}
          </Stack>
        )}
      </Drawer>
    </Stack>
  );
}
