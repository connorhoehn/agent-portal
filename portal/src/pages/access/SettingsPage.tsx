// /access/settings — delegation (2026-10-14; docs/access-tenant-api.md
// § "Escalation timers and delegation"). An approver about to be away hands
// their decisions to another approver for a window: the delegate sees the
// delegator's steps in Approvals, marked "for <delegator>", and decides them
// on their behalf. The server resolves every rule live (no self-delegation,
// never a request the delegate is a party to, an access-admin step only to an
// access admin, never passed on); the form refuses what it can before sending
// and shows the server's refusal otherwise.
//
// Everyone in Access reads the delegations they are part of (an access admin
// reads all); only DecideAccess holders delegate. Library composites only:
// the delegate is chosen with PersonPicker over GET /api/access/delegates.

import {
  Button,
  Chip,
  CloseIcon,
  DataTable,
  FormField,
  IconButton,
  Inline,
  InlineAlert,
  LoadingState,
  PageFrame,
  PageSection,
  PersonPicker,
  RadioGroup,
  Stack,
  T,
  Textarea,
  Tooltip,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { useState } from 'react';
import { useFlushTrailItems } from '../../components/shell/FlushPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import {
  ACCESS_API,
  DELEGATION_REASON_MIN,
  DELEGATION_STATE_TONE,
  DELEGATION_WINDOWS,
  EMPTY_DELEGATION,
  delegationBody,
  delegationProblem,
  delegationWindowLabel,
  type AccessDelegation,
  type AccessPerson,
  type DelegationDraft,
  type ItemsResponse,
} from '../../lib/accessRequests';
import { ACCESS_SURFACES } from './accessSurfaces';

export default function SettingsPage() {
  const { session } = useSession();
  return <DelegationSettings key={`${session?.sub}:${session?.role}`} />;
}

function DelegationSettings() {
  const { session } = useSession();
  const { can, ready } = useCapabilities();
  const mayDelegate = ready && can('DecideAccess');
  const page = ACCESS_SURFACES.settings;
  const trail = useFlushTrailItems();
  const list = useFetch<ItemsResponse<AccessDelegation>>(`${ACCESS_API}/delegations`);
  const delegates = useFetch<ItemsResponse<AccessPerson>>(mayDelegate ? `${ACCESS_API}/delegates` : null);
  const [draft, setDraft] = useState<DelegationDraft>(EMPTY_DELEGATION);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<DelegationDraft>) => { setDraft((d) => ({ ...d, ...patch })); setError(null); };
  const problem = delegationProblem(draft);
  const rows = list.data?.items ?? [];

  async function delegate() {
    setBusy(true);
    const res = await writeJson<AccessDelegation>(`${ACCESS_API}/delegations`, 'POST', delegationBody(draft));
    setBusy(false);
    if (res.ok && res.data) {
      toastSuccess(null, 'Decisions delegated', `${res.data.delegate.displayName} decides your steps until ${new Date(res.data.endsAt).toLocaleString()}.`);
      setDraft(EMPTY_DELEGATION);
      list.refresh();
      return;
    }
    setError(res.error ?? `The delegation was not recorded (HTTP ${res.status}).`);
  }

  async function end(d: AccessDelegation) {
    setBusy(true);
    const res = await writeJson<AccessDelegation>(`${ACCESS_API}/delegations/${encodeURIComponent(d.id)}/end`, 'POST', { reason: 'Ended early from Settings' });
    setBusy(false);
    if (res.ok) { toastSuccess(null, 'Delegation ended', `${d.delegate.displayName} no longer decides your steps.`); list.refresh(); }
    else toastError(null, 'Could not end the delegation', res.error ?? undefined);
  }

  const columns: DataTableColumn<AccessDelegation>[] = [
    { key: 'delegator', header: 'From', render: (d) => (d.delegator.id === session?.sub ? `${d.delegator.displayName} (you)` : d.delegator.displayName) },
    { key: 'delegate', header: 'To', render: (d) => (d.delegate.id === session?.sub ? `${d.delegate.displayName} (you)` : d.delegate.displayName) },
    { key: 'window', header: 'Window', render: (d) => delegationWindowLabel(d) },
    { key: 'state', header: 'State', width: '112px', render: (d) => <Chip tone={DELEGATION_STATE_TONE[d.state]} size="xs">{d.state}</Chip> },
    { key: 'reason', header: 'Reason', render: (d) => <T size="sm" tone="secondary" title={d.reason} className="block max-w-[20rem] truncate">{d.reason}</T> },
  ];
  // Ending is the row's one action (the delegator's or an access admin's): an icon, as every access table's row action.
  const rowActions = (d: AccessDelegation) => (d.can.end ? (
    <Tooltip content={`End this delegation: ${d.delegate.displayName} stops deciding for ${d.delegator.displayName}`}>
      <IconButton size="sm" aria-label={`End the delegation from ${d.delegator.displayName} to ${d.delegate.displayName}`} icon={<CloseIcon />} disabled={busy} onClick={() => void end(d)} data-testid={`access-delegation-end-${d.id}`} />
    </Tooltip>
  ) : null);

  return (
    <PageFrame title={page.title} description={page.description} breadcrumbs={trail} data-testid="access-settings">
      <Stack gap="lg">
        <PageSection size="sm" title="Delegate my decisions"
          description="While you are away, another approver decides the steps that wait on you, on your behalf. They never decide a request they made or benefit from, and an access-admin step only if they are an access admin.">
          {!ready ? <LoadingState label="Loading your permissions…" /> : !mayDelegate ? (
            <InlineAlert tone="info" data-testid="access-delegation-not-approver">Only approvers and access admins decide requests, so only they delegate. Delegations you are part of are listed below.</InlineAlert>
          ) : (
            <Stack gap="sm" className="max-w-xl" data-testid="access-delegation-form">
              <FormField label="Decides for you" hint="Approvers and access admins in Access." required>
                {(w) => <PersonPicker {...w} size="sm" people={(delegates.data?.items ?? []).map((p) => ({ id: p.id, name: p.displayName }))}
                  loading={!delegates.data && !delegates.error} value={draft.delegateId} onChange={(v) => set({ delegateId: v })}
                  emptyMessage="No other approver matches" data-testid="access-delegation-delegate" />}
              </FormField>
              <RadioGroup name="access-delegation-window" aria-label="For how long" orientation="horizontal" value={draft.window}
                onChange={(v) => set({ window: v })} options={DELEGATION_WINDOWS.map((w) => ({ value: w.value, label: w.label }))} data-testid="access-delegation-window" />
              <FormField label="Why" hint={`${draft.reason.trim().length} of at least ${DELEGATION_REASON_MIN} characters. Recorded in the audit trail.`} required>
                {(w) => <Textarea {...w} rows={2} value={draft.reason} onChange={(e) => set({ reason: e.target.value })} data-testid="access-delegation-reason" />}
              </FormField>
              {error && <InlineAlert tone="error" data-testid="access-delegation-error">{error}</InlineAlert>}
              <Inline gap="sm">
                <Button size="sm" variant="primary" disabled={busy || !!problem} title={problem ?? undefined} onClick={() => void delegate()} data-testid="access-delegation-submit">Delegate</Button>
              </Inline>
            </Stack>
          )}
        </PageSection>
        <PageSection size="sm" title="Delegations" description="Yours and those handed to you; an access admin sees every delegation.">
          {list.error ? (
            <UnavailableNotice error={list.error} what="delegations" source="Delegations are read from access_delegations" onRetry={list.refresh} />
          ) : !list.data ? <LoadingState label="Loading delegations…" /> : (
            <DataTable narrow data-testid="access-delegations" data={rows} columns={columns} keyField={(d) => d.id} rowActions={rowActions}
              emptyMessage="No delegations yet." staticRows="Each delegation is read in place and ended from its row; it has no page of its own." />
          )}
        </PageSection>
      </Stack>
    </PageFrame>
  );
}
