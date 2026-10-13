// /social/configuration — how this workspace is set up
// (docs/social-tenant-design.md §4.1, §4.5 — lane S2).
//
// Read-only for now, and says so: nothing in the social tenant has an
// editable setting yet (retention and room policy are platform-api's
// defaults). What it shows is real — who holds which role here
// (`GET /api/social/summary`, counted from the identity store), what each role
// may do, and where each surface's data lives (the `source` each
// `/api/social/*` read reports: platform-api, or dev:mock's fixtures).
// ManageSocialConfig — community-admin only — is what editing will need.
//
// The capability table is one full-width DataTable: a row per capability, a
// column per role. The caller's own column is the session's capabilities (the
// same Cedar answer every control on these pages reads). The other roles'
// columns come from the role registry (`GET /api/identity/roles?tenant=social`,
// derived from the enforced Cedar seed files — there is no second list here),
// which only a holder of ManageUsers / ViewIdentityAdmin may read; anyone else
// sees their own column and a line saying who can see the rest.

import { useMemo } from 'react';
import {
  Chip, DataTable, EmptyState, ErrorState, Inline, InlineAlert, KeyValue, LoadingState, PageHeader, PageSection, Stack,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities, type Action } from '../../lib/capabilities';
import { roleLabel, type SocialSource } from './socialPlatform';

interface Summary { tenant: string; members: { total: number; byRole: Record<string, number> } }
interface RoleDefinition { id: string; tenant: string | null; capabilities: string[] }

const ACTIONS: Array<{ action: Action; label: string }> = [
  { action: 'ViewSocial', label: 'Read channels, rooms, teams and recordings' },
  { action: 'PostMessage', label: 'Post in channels and direct messages' },
  { action: 'StartCall', label: 'Start and join calls' },
  { action: 'ManageChannels', label: 'Create channels and rooms' },
  { action: 'ManageTeams', label: 'Create teams and change who is on them' },
  { action: 'ManageRecordings', label: 'Share and delete recordings' },
  { action: 'ManageSocialConfig', label: 'Change this workspace\'s configuration' },
];
/** The social tenant's roles in rank order, then the cross-tenant admin. */
const ROLE_ORDER = ['participant', 'moderator', 'community-admin', 'admin'];

const SOURCE_LABEL: Record<SocialSource, string> = { platform: 'platform-api', mock: 'dev:mock fixtures' };

function Source({ url }: { url: string }) {
  const { data, error } = useFetch<{ source: SocialSource }>(url);
  if (error) return <Chip tone="danger" size="xs">unreachable</Chip>;
  if (!data) return <Chip tone="neutral" size="xs">…</Chip>;
  return <Chip tone={data.source === 'platform' ? 'success' : 'info'} size="xs">{SOURCE_LABEL[data.source] ?? data.source}</Chip>;
}

const answer = (yes: boolean | null) => (yes === null
  ? <Chip tone="neutral" size="xs">…</Chip>
  : <Chip tone={yes ? 'success' : 'neutral'} size="xs">{yes ? 'Yes' : 'No'}</Chip>);

export default function ConfigurationPage() {
  const { can, ready } = useCapabilities();
  const role = useSession().session?.role ?? null;
  const mayConfigure = ready && can('ManageSocialConfig');
  const mayReadRoles = ready && (can('ManageUsers') || can('ViewIdentityAdmin'));
  const summary = useFetch<Summary>('/api/social/summary');
  const registry = useFetch<RoleDefinition[]>(mayReadRoles ? '/api/identity/roles?tenant=social' : null);

  // Columns: every social role (plus admin) when the registry is readable, else the caller's own.
  const roles = useMemo(() => {
    const known = (registry.data ?? []).filter((r) => r.tenant === 'social' || r.id === 'admin');
    const ids = known.length ? known.map((r) => r.id) : role ? [role] : [];
    return ids.sort((a, b) => (ROLE_ORDER.indexOf(a) + 1 || 99) - (ROLE_ORDER.indexOf(b) + 1 || 99))
      .map((id) => ({ id, caps: id === role ? null : new Set(known.find((r) => r.id === id)?.capabilities ?? []) }));
  }, [registry.data, role]);

  type Row = { action: Action; label: string };
  const columns: DataTableColumn<Row>[] = [
    { key: 'label', header: 'Capability' },
    ...roles.map(({ id, caps }): DataTableColumn<Row> => ({
      key: `role:${id}`,
      header: id === role ? `${roleLabel(id)} (you)` : roleLabel(id),
      width: '160px',
      align: 'center',
      // Your own column is the session's answer; another role's is its Cedar seed ('*' is admin's blanket permit).
      render: (r) => answer(caps === null ? (ready ? can(r.action) : null) : caps.has('*') || caps.has(r.action)),
    })),
  ];

  return (
    <Stack gap="lg" data-testid="social-configuration-page">
      <PageHeader title="Configuration" description="How this workspace is set up: who is in it, what each role may do, and where its data lives." />
      <InlineAlert tone="info" data-testid="social-configuration-readonly">
        {mayConfigure
          ? 'Nothing here is editable yet — retention and room policy use platform-api\'s defaults. Your role may configure this workspace, so you will be one of the people who changes them.'
          : 'Only a community admin can change this workspace\'s configuration. You can see how it is set up.'}
      </InlineAlert>
      {summary.isLoading && !summary.data ? <LoadingState label="Loading the workspace…" /> : summary.error && !summary.data ? (
        <ErrorState title="The workspace could not be loaded" description={summary.error} actionLabel="Try again" onAction={summary.refresh} />
      ) : !summary.data || summary.data.members.total === 0 ? (
        <EmptyState align="start" testId="social-empty-configuration" title="Nobody holds a role here yet" description="An admin grants roles in this workspace from Identity." />
      ) : (
        <>
          <PageSection title="What each role can do" data-testid="social-configuration-abilities">
            <Stack gap="sm">
              <DataTable data={ACTIONS} columns={columns} keyField={(r) => r.action} data-testid="social-configuration-matrix"
                staticRows="A permission matrix: each row is an action and each cell is the decision; there is no record behind a row." />
              {!mayReadRoles && (
                <InlineAlert tone="info" data-testid="social-configuration-own-column">
                  This is what your role may do. The other roles' permissions are shown to people who manage this workspace's users.
                </InlineAlert>
              )}
            </Stack>
          </PageSection>
          <PageSection title="People" count={summary.data.members.total} data-testid="social-configuration-people">
            <Inline gap="sm" wrap>
              {Object.entries(summary.data.members.byRole)
                .sort(([a], [b]) => (ROLE_ORDER.indexOf(a) + 1 || 99) - (ROLE_ORDER.indexOf(b) + 1 || 99))
                .map(([r, n]) => <Chip key={r} tone={r === role ? 'info' : 'neutral'} size="sm">{roleLabel(r)} · {n} {n === 1 ? 'person' : 'people'}</Chip>)}
            </Inline>
          </PageSection>
          <PageSection title="Where the data lives" data-testid="social-configuration-sources">
            <KeyValue items={[
              { label: 'Rooms', value: <Source url="/api/social/rooms" /> },
              { label: 'Teams', value: <Source url="/api/social/teams" /> },
              { label: 'Recordings', value: <Source url="/api/social/recordings" /> },
              { label: 'Call log', value: <Source url="/api/social/calls" /> },
            ]} />
          </PageSection>
        </>
      )}
    </Stack>
  );
}
