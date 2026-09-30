// /social/contacts — the people in this workspace, and who is here now
// (docs/social-tenant-design.md §4.5, lane S2).
//
// The roster is the tenant's (`GET /api/social/people`: everyone holding a
// social grant, from the identity store). Presence is the workspace's own
// channel, `social:lobby`, which every social page joins (SocialLayout), read
// here with realtime-modules' `usePresence` and drawn with the library's
// `PresenceAvatars`. From a person: Message opens (or reopens) your DM with
// them; Call rings them into `social:dm:<ids>` through the shell's call host.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { usePresence } from '@connorhoehnslalom/realtime-modules/client';
import {
  Button, Chip, DataTable, EmptyState, ErrorState, Inline, InlineAlert, LoadingState, PageHeader, PageSection, PresenceAvatars, Stack, Text,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { writeJson } from '../../lib/writeJson';
import { presenceAvatarUsers } from '../assessment/knowledge/knowledgeFormat';
import { dmHref, type SocialPerson } from './socialChat';
import { contactRows, roleLabel, SOCIAL_PRESENCE_CHANNEL, type ContactRow } from './socialPlatform';
import { useSocialCall } from './useSocialCall';

export default function ContactsPage() {
  const { session } = useSession();
  const me = session?.sub ?? '';
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const mayMessage = ready && can('PostMessage');
  const mayCall = ready && can('StartCall');
  const { data, isLoading, error, refresh } = useFetch<{ people: SocialPerson[] }>('/api/social/people');
  const { roster } = usePresence(SOCIAL_PRESENCE_CHANNEL);
  const here = useMemo(() => presenceAvatarUsers(roster), [roster]);
  const rows = useMemo(() => contactRows(data?.people ?? [], here, me), [data, here, me]);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const call = useSocialCall();

  async function message(row: ContactRow) {
    setBusy(row.userId);
    setProblem(null);
    const res = await writeJson<{ channel: string }>('/api/social/dms', 'POST', { userId: row.userId });
    setBusy(null);
    if (!res.ok || !res.data) { setProblem(res.error ?? `Could not open a conversation with ${row.displayName}.`); return; }
    navigate(dmHref(res.data.channel));
  }

  const columns: DataTableColumn<ContactRow>[] = [
    {
      key: 'displayName', header: 'Name', sortable: true,
      render: (r) => (
        <Inline gap="sm" align="center">
          <PresenceAvatars size={24} maxVisible={1} users={[{ id: r.userId, name: r.displayName, ...(r.online && !r.idle ? {} : { idle: true }) }]} />
          <Text>{r.displayName}{r.userId === me ? ' (you)' : ''}</Text>
        </Inline>
      ),
    },
    { key: 'roles', header: 'Role', width: '160px', render: (r) => r.roles.map(roleLabel).join(', ') },
    {
      key: 'online', header: 'Status', width: '120px', sortable: true,
      compare: (a, b) => Number(a.online) - Number(b.online),
      render: (r) => <Chip tone={r.online ? (r.idle ? 'warning' : 'success') : 'neutral'} size="xs" dot="static">{r.online ? (r.idle ? 'Away' : 'Here now') : 'Offline'}</Chip>,
    },
  ];

  return (
    <Stack gap="lg" data-testid="social-contacts-page">
      <PageHeader title="Contacts" description="The people in this workspace, and who is around right now." />
      {(problem || call.notice) && (
        <InlineAlert tone="warning" onDismiss={() => { setProblem(null); call.clearNotice(); }}>{problem ?? call.notice}</InlineAlert>
      )}
      {isLoading && !data ? <LoadingState label="Loading people…" /> : error && !data ? (
        <ErrorState title="People could not be loaded" description={error} actionLabel="Try again" onAction={refresh} />
      ) : rows.length === 0 ? (
        <EmptyState testId="social-empty-contacts" align="start" title="Nobody here yet"
          description="People appear here once they hold a role in this workspace. An admin grants that from Identity." />
      ) : (
        <Stack gap="md">
          <PageSection title="Here now" count={here.length} data-testid="social-contacts-here">
            {here.length
              ? <PresenceAvatars size={32} maxVisible={12} users={here} />
              : <EmptyState align="start" title="Nobody else is here" description="People show up here while they have a social page open." />}
          </PageSection>
          <DataTable
            data={rows}
            columns={columns}
            keyField={(r) => r.userId}
            searchable
            searchPlaceholder="Find a person"
            rowActions={(r) => r.userId === me ? null : (
              <Inline gap="xs">
                {mayMessage && (
                  <Button variant="ghost" size="sm" disabled={busy === r.userId} onClick={() => void message(r)} data-testid="social-contact-message">Message</Button>
                )}
                {mayCall && (
                  <Button variant="ghost" size="sm" disabled={!!call.unavailable} onClick={() => call.callPeople([{ userId: r.userId, displayName: r.displayName }])} data-testid="social-contact-call">Call</Button>
                )}
              </Inline>
            )}
            data-testid="social-contacts-table"
          />
        </Stack>
      )}
    </Stack>
  );
}
