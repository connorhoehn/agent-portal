// /social/configuration — how this workspace is set up
// (docs/social-tenant-design.md §4.1, §4.5 — lane S2).
//
// Read-only for now, and says so: nothing in the social tenant has an
// editable setting yet (retention and room policy are platform-api's
// defaults). What it shows is real — who holds which role here
// (`GET /api/social/summary`, counted from the identity store), what YOUR role
// may do (the session's capabilities, the same Cedar answer every control on
// these pages reads), and where each surface's data lives (the `source` each
// `/api/social/*` read reports: platform-api, or dev:mock's fixtures).
// ManageSocialConfig — community-admin only — is what editing will need.

import {
  Chip, EmptyState, ErrorState, InlineAlert, KeyValue, LoadingState, PageHeader, PageSection, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities, type Action } from '../../lib/capabilities';
import { roleLabel, type SocialSource } from './socialPlatform';

interface Summary { tenant: string; members: { total: number; byRole: Record<string, number> } }

const ACTIONS: Array<{ action: Action; label: string }> = [
  { action: 'ViewSocial', label: 'Read channels, rooms, teams and recordings' },
  { action: 'PostMessage', label: 'Post in channels and direct messages' },
  { action: 'StartCall', label: 'Start and join calls' },
  { action: 'ManageChannels', label: 'Create channels and rooms' },
  { action: 'ManageTeams', label: 'Create teams and change who is on them' },
  { action: 'ManageRecordings', label: 'Share and delete recordings' },
  { action: 'ManageSocialConfig', label: 'Change this workspace\'s configuration' },
];

const SOURCE_LABEL: Record<SocialSource, string> = { platform: 'platform-api', mock: 'dev:mock fixtures' };

function Source({ url }: { url: string }) {
  const { data, error } = useFetch<{ source: SocialSource }>(url);
  if (error) return <Chip tone="danger" size="xs">unreachable</Chip>;
  if (!data) return <Chip tone="neutral" size="xs">…</Chip>;
  return <Chip tone={data.source === 'platform' ? 'success' : 'info'} size="xs">{SOURCE_LABEL[data.source] ?? data.source}</Chip>;
}

export default function ConfigurationPage() {
  const { can, ready } = useCapabilities();
  const role = useSession().session?.role ?? null;
  const mayConfigure = ready && can('ManageSocialConfig');
  const summary = useFetch<Summary>('/api/social/summary');

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
          <PageSection title="People" count={summary.data.members.total} data-testid="social-configuration-people">
            <KeyValue items={Object.entries(summary.data.members.byRole).map(([r, n]) => ({ label: roleLabel(r), value: `${n} ${n === 1 ? 'person' : 'people'}` }))} />
          </PageSection>
          <PageSection title={`What you can do${role ? ` as ${roleLabel(role)}` : ''}`} data-testid="social-configuration-abilities">
            <KeyValue items={ACTIONS.map(({ action, label }) => ({
              label,
              value: <Chip tone={ready && can(action) ? 'success' : 'neutral'} size="xs">{ready ? (can(action) ? 'Yes' : 'No') : '…'}</Chip>,
            }))} />
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
