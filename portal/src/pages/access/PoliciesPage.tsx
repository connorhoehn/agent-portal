// /access/policies — the separation-of-duties matrix (docs/access-tenant-design.md
// A7, §4.4): two (workspace, role) pairs nobody may hold together, with the
// severity a conflict carries at submit. Read by every access role
// (GET /api/access/policies); an access admin (ManageAccessPolicy) edits the
// severity and reason on the policy's page, `/access/policies/:id` (the matrix
// as the list rail beside it; PUT /api/access/policies/:id) — never a drawer.
// Others see no edit control at all — absent, not disabled.

import {
  Button,
  Chip,
  CollectionToolbar,
  DataTable,
  DetailSection,
  EditIcon,
  FormField,
  IconButton,
  Inline,
  KeyValue,
  RadioGroup,
  Stack,
  T,
  Textarea,
  Tooltip,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { RecordLink } from '../decisions/RecordLink';
import { CollectionRecordFrame } from '../../components/collections/CollectionRecordFrame';
import { RecordNotFound } from '../../components/UnavailableNotice';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { LoadingState } from '@connorhoehn/ui-components/shared';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { ACCESS_API, TENANT_LABELS, filterPolicies, policyHref, roleLabel, type AccessPolicy, type AccessTenant, type ItemsResponse, type SodSeverity } from '../../lib/accessRequests';
import { accessCollectionAdapter, resolveAccessTarget } from './accessCollectionCommands';
import { ACCESS_SURFACES } from './accessSurfaces';

const SEVERITY_OPTIONS = [
  { value: '', label: 'Every severity' },
  { value: 'block', label: 'Blocking' },
  { value: 'warn', label: 'Warning' },
];

const pair = (p: { tenant: string; role: string }) => `${roleLabel(p.role)} · ${TENANT_LABELS[p.tenant as AccessTenant] ?? p.tenant}`;
const severityChip = (s: SodSeverity) => <Chip tone={s === 'block' ? 'danger' : 'warning'} size="xs">{s === 'block' ? 'blocking' : 'warning'}</Chip>;

const COLUMNS: DataTableColumn<AccessPolicy>[] = [
  { key: 'title', header: 'Policy', sortable: true, compare: (a, b) => a.title.localeCompare(b.title),
    render: (p) => <RecordLink to={policyHref(p.id)}><T size="sm" title={p.title} className="block max-w-[18rem] truncate">{p.title}</T></RecordLink> },
  { key: 'left', header: 'Holding', render: (p) => pair(p.left) },
  { key: 'right', header: 'Must not hold', render: (p) => pair(p.right) },
  { key: 'severity', header: 'Severity', width: '104px', render: (p) => severityChip(p.severity) },
  { key: 'reason', header: 'Why', render: (p) => <T size="sm" tone="secondary" title={p.reason} className="block max-w-[24rem] truncate">{p.reason}</T> },
  { key: 'updatedBy', header: 'Changed by', render: (p) => p.updatedBy?.displayName ?? <T size="xs" tone="tertiary">—</T> },
  { key: 'updatedAt', header: 'Updated', numeric: true, sortable: true, compare: (a, b) => a.updatedAt.localeCompare(b.updatedAt), render: (p) => relativeTime(p.updatedAt) },
];

export default function PoliciesPage() {
  const { can, ready } = useCapabilities();
  const mayEdit = ready && can('ManageAccessPolicy');
  const [severity, setSeverity] = useState('');
  const [query, setQuery] = useState('');
  // The open policy is the URL (`/access/policies/:id`).
  const { id: openId = null } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const setOpenId = (id: string | null) => navigate(id ? `/access/policies/${encodeURIComponent(id)}` : '/access/policies');
  const [draft, setDraft] = useState<{ severity: SodSeverity; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<AccessPolicy>>(`${ACCESS_API}/policies`, 60_000);
  const all = data?.items ?? [];
  const rows = filterPolicies(all, query, severity);
  const open = all.find((p) => p.id === openId) ?? null;
  const show = (p: AccessPolicy) => setOpenId(p.id);
  // The draft follows the open policy (a reload, a rail click or a saved version).
  useEffect(() => { setDraft(open ? { severity: open.severity, reason: open.reason } : null); }, [open?.id, open?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const adapter = accessCollectionAdapter('policies', {
    setQuery, setFilter: setSeverity, refresh,
    open(target) {
      if (!data || error) throw new Error('Wait for policies to load before opening one.');
      const p = resolveAccessTarget(target, rows);
      show(p);
      return `Opened ${p.title}. Nothing was changed.`;
    },
  });

  async function save() {
    if (!open || !draft) return;
    setBusy(true);
    const res = await writeJson<AccessPolicy>(`${ACCESS_API}/policies/${encodeURIComponent(open.id)}`, 'PUT',
      { severity: draft.severity, reason: draft.reason.trim() });
    setBusy(false);
    if (res.ok) { toastSuccess(null, 'Policy saved', `${open.title} is now ${draft.severity === 'block' ? 'blocking' : 'a warning'}.`); refresh(); }
    else toastError(null, 'Could not save the policy', res.error ?? undefined);
  }
  const changed = !!open && !!draft && (draft.severity !== open.severity || draft.reason.trim() !== open.reason);

  const page = ACCESS_SURFACES.policies;
  useCrumbLabel(openId ?? undefined, open?.title ?? null);
  if (openId) {
    return (
      <CollectionRecordFrame
        title={page.title}
        listTitle="Policies"
        listLabel="policies"
        {...(data ? { count: rows.length } : {})}
        search={{ value: query, onChange: setQuery, placeholder: 'Find a policy' }}
        groups={[{ id: 'block', title: 'Blocking', count: rows.filter((p) => p.severity === 'block').length }, { id: 'warn', title: 'Warning', count: rows.filter((p) => p.severity === 'warn').length }]}
        rows={rows.map((p) => ({ id: p.id, groupId: p.severity, title: p.title, subline: `${pair(p.left)} ✕ ${pair(p.right)}` }))}
        currentId={openId}
        onOpen={setOpenId}
        loading={isLoading && !data}
        error={error}
        onRetry={refresh}
        footer={<CollectionCommandHost inPlace adapter={adapter} disabled={busy} />}
        railType="app"
        data-testid="access-policy-explorer"
      >
        {open && draft ? (
          // The record on the app's one scale (docs/layout-cascade.md rule 3):
          // the page title stays the view's name ("Policies", 20/600, from the
          // frame's SectionHeader); the policy's own headline is the first
          // 14/600 section heading with its id as 12px meta, its facts 12px
          // labels over 14px values — the request record's shape.
          <Stack gap="md" data-testid="access-policy-record">
            <DetailSection variant="heading" first title={open.title} hint={severityChip(open.severity)} data-testid="access-policy-summary">
              <KeyValue layout="grid" items={[
                { label: 'Holding', value: <T size="sm">{pair(open.left)}</T> },
                { label: 'Must not hold', value: <T size="sm">{pair(open.right)}</T> },
                { label: 'Updated', value: <T size="sm">{`${relativeTime(open.updatedAt)}${open.updatedBy ? ` by ${open.updatedBy.displayName}` : ''}`}</T> },
                ...(mayEdit ? [] : [
                  { label: 'Severity', value: <T size="sm">{open.severity === 'block' ? 'Blocking: stops the request unless an access admin overrides it' : 'Warning: shown to the requester and approvers; does not stop it'}</T> },
                  // Prose: it wraps rather than clipping at the column edge.
                  { label: 'Why', value: <T as="p" size="sm" wrap className="m-0 whitespace-normal break-words">{open.reason}</T> },
                ]),
              ]} />
            </DetailSection>
            {mayEdit && (
              <DetailSection variant="heading" title="Change this policy"
                description="The reason (Why) is shown to anyone whose request meets this conflict." data-testid="access-policy-editor">
                <Stack gap="md">
                  <FormField label="Severity">
                    {() => (
                      <RadioGroup<SodSeverity> name="access-policy-severity" value={draft.severity} onChange={(v) => setDraft({ ...draft, severity: v })}
                        orientation="horizontal"
                        options={[
                          { value: 'block', label: 'Blocking', description: 'Stops the request unless an access admin overrides it' },
                          { value: 'warn', label: 'Warning', description: 'Shown to the requester and approvers; does not stop it' },
                        ]} />
                    )}
                  </FormField>
                  <FormField label="Why">
                    {(wiring) => <Textarea {...wiring} rows={3} value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />}
                  </FormField>
                  <Inline gap="sm" justify="end">
                    <Button size="sm" variant="ghost" disabled={!changed} onClick={() => setDraft({ severity: open.severity, reason: open.reason })}>Discard changes</Button>
                    <Button size="sm" variant="primary" disabled={busy || !changed || !draft.reason.trim()} onClick={() => void save()} data-testid="access-policy-save">Save</Button>
                  </Inline>
                </Stack>
              </DetailSection>
            )}
          </Stack>
        ) : isLoading || !data ? (
          <LoadingState label="Loading policy…" />
        ) : (
          <RecordNotFound heading="Policy" title="Policy not found" body="No separation-of-duties policy is here. It may have been removed."
            backLabel={page.title} onBack={() => setOpenId(null)} />
        )}
      </CollectionRecordFrame>
    );
  }

  return (
    <CollectionCommandPage data-testid="access-policies" title={page.title} description={page.description}>
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Policy filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search policies', 'aria-label': 'Search policies' },
            filters: [{ id: 'severity', label: 'Severity', value: severity, onChange: setSeverity, options: SEVERITY_OPTIONS }],
            summary: data ? `${rows.length} of ${all.length} policies` : undefined,
            notices: [mayEdit
              ? 'A blocking conflict stops a request at submit unless an access admin records an override.'
              : 'Only an access admin changes a policy. A blocking conflict stops a request at submit.'],
            onRefresh: refresh, refreshing: isLoading,
          }} />
          {error ? (
            <UnavailableNotice error={error} what="separation-of-duties policies" source="Policies are read from access_policies" onRetry={refresh} />
          ) : (
            <DataTable
              data-testid="access-policies-table"
              data={rows}
              columns={COLUMNS}
              keyField={(p) => p.id}
              loading={isLoading && !data}
              pageSize={25}
              onRowClick={show}
              {...(mayEdit ? {
                rowActions: (p: AccessPolicy) => (
                  <Tooltip content={`Edit ${p.title}`}>
                    <IconButton size="sm" aria-label={`Edit ${p.title}`} icon={<EditIcon />} onClick={() => show(p)} data-testid={`access-policy-edit-${p.id}`} />
                  </Tooltip>
                ),
              } : {})}
              emptyMessage={query.trim() || severity ? 'No policy matches this search and severity.' : 'No separation-of-duties policies are defined.'}
            />
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} disabled={busy} />
      </Stack>
    </CollectionCommandPage>
  );
}
