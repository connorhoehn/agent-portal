// /social/contacts — the people in this workspace, and who is here now
// (docs/social-tenant-design.md §4.5, lane S2).
//
// The roster is the tenant's (`GET /api/social/people`: everyone holding a
// social grant, from the identity store). Presence is the workspace's own
// channel, `social:lobby`, owned by the persistent shell. Read its shared
// roster here without taking another subscription, drawn with the library's
// `PresenceAvatars`. From a person: Message opens (or reopens) your DM with
// them; Call rings them into `social:dm:<ids>` through the shell's call host.

import {
  CollectionToolbar,
  IconButton,
  Tooltip,
  ChatIcon,
  PhoneIcon,
  Chip,
  DataTable,
  EmptyState,
  ErrorState,
  Inline,
  InlineAlert,
  LoadingState,
  PageSection,
  PresenceAvatars,
  Stack,
  T,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useEmbeddedSocial } from '../../components/shell/EmbeddedSocial';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { writeJson } from '../../lib/writeJson';
import { dmHref, type SocialPerson } from './socialChat';
import { contactRows, roleLabel, type ContactRow } from './socialPlatform';
import { useSocialCall } from './useSocialCall';
import { CollectionCommandHost, type CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { contactCommandExamples, filterContacts, parseContactCommand, resolveContactTarget, type ContactFilters, type ContactPresence } from './contactCommands';

export default function ContactsPage() {
  const { session } = useSession();
  // A role/user change retires its filters, pending command and in-memory draft.
  return <ContactsWorkspace key={`${session?.sub}:${session?.tenant}:${session?.role}`} />;
}

function ContactsWorkspace() {
  const { session } = useSession();
  const me = session?.sub ?? '';
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const mayMessage = ready && can('PostMessage');
  const mayCall = ready && can('StartCall');
  const { data, isLoading, error, refresh } = useFetch<{ people: SocialPerson[] }>('/api/social/people');
  const here = useEmbeddedSocial()?.presencePeople ?? [];
  const rows = useMemo(() => contactRows(data?.people ?? [], here, me), [data, here, me]);
  const [filters, setFilters] = useState<ContactFilters>({ query: '', presence: 'all' });
  const filtered = useMemo(() => filterContacts(rows, filters), [rows, filters]);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const call = useSocialCall();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const messagePending = useRef(false);
  const latest = useRef({ filtered, mayMessage, me, isLoading, error });
  latest.current = { filtered, mayMessage, me, isLoading, error };

  async function message(target: string): Promise<string> {
    const current = latest.current;
    if (messagePending.current) throw new Error('A conversation is already opening.');
    if (current.isLoading || current.error) throw new Error('Wait for the contact table to load successfully before choosing a person.');
    const row = resolveContactTarget(target, current.filtered, current.me, current.mayMessage);
    messagePending.current = true;
    setBusy(row.userId);
    setProblem(null);
    try {
      const res = await writeJson<{ channel: string }>('/api/social/dms', 'POST', { userId: row.userId });
      if (!alive.current || latest.current.me !== current.me || !latest.current.mayMessage) throw new Error('The session changed. Choose the person again in your current workspace.');
      if (!res.ok || !res.data) throw new Error(res.error ?? `Could not open a conversation with ${row.displayName}.`);
      navigate(dmHref(res.data.channel));
      return `Opened the conversation with ${row.displayName}. No message text was sent.`;
    } finally {
      messagePending.current = false;
      if (alive.current) setBusy(null);
    }
  }

  const scopeNote = 'Search and presence filters use the loaded workspace roster across table pages. Here means connected and active; Away means connected and idle. Opening a person opens their direct conversation without sending text. Calling and group messages are not commands.';
  const examples = contactCommandExamples(mayMessage);
  const adapter: CollectionCommandAdapter = {
    id: 'social-contacts-commands', label: 'Contacts', examples, scopeNote,
    placeholder: mayMessage ? 'Show here contacts, search names, or open a conversation…' : 'Show here contacts, search names, or refresh…',
    execute: async text => {
      const command = parseContactCommand(text);
      if (command.kind === 'help') return { message: `Supported: ${examples.join('; ')}. ${scopeNote}` };
      if (command.kind === 'refresh') { refresh(); return { message: 'Refreshing the workspace contacts.' }; }
      if (command.kind === 'reset') { setFilters({ query: '', presence: 'all' }); return { message: 'Contact search and presence filters cleared. Sorting is unchanged.' }; }
      if (command.kind === 'presence') {
        setFilters(current => ({ ...current, presence: command.presence }));
        return { message: `Presence filter: ${command.presence}. Your name search and sorting are unchanged.` };
      }
      if (command.kind === 'search') {
        setFilters(current => ({ ...current, query: command.query }));
        return { message: `Searching loaded contact names and user IDs for “${command.query}”. Presence filter and sorting are unchanged.` };
      }
      if (command.kind === 'open') return { message: await message(command.target) };
      throw new Error('This command is not available here.');
    },
  };

  const columns: DataTableColumn<ContactRow>[] = [
    {
      key: 'displayName', header: 'Name', sortable: true,
      render: (r) => (
        <Inline gap="sm" align="center">
          <PresenceAvatars size={24} maxVisible={1} users={[{ id: r.userId, name: r.displayName, ...(r.avatarUrl ? { avatarUrl: r.avatarUrl } : {}), ...(r.online && !r.idle ? {} : { idle: true }) }]} />
          <T size="sm">{r.displayName}{r.userId === me ? ' (you)' : ''}</T>
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
    <CollectionCommandPage data-testid="social-contacts-page" title="Contacts" description="The people in this workspace, and who is around right now.">
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
      <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
      <CollectionToolbar label="Contact filters" search={{ value: filters.query,
        onChange: query => setFilters(current => ({ ...current, query })), placeholder: 'Find a person', 'aria-label': 'Search contacts' }}
        filters={[{ id: 'presence', label: 'Presence', value: filters.presence, emptyValue: 'all',
          onChange: presence => setFilters(current => ({ ...current, presence: presence as ContactPresence })),
          options: [{ value: 'all', label: 'All people' }, { value: 'here', label: 'Here now' }, { value: 'away', label: 'Away' }, { value: 'offline', label: 'Offline' }] }]}
        summary={data ? `${filtered.length} of ${rows.length} people` : undefined}
        notices={[scopeNote]} onRefresh={refresh} refreshing={isLoading} />
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
              : <EmptyState align="start" title="Nobody else is here" description="People show up here while Social is connected in their workspace." />}
          </PageSection>
          <DataTable
            data={filtered}
            columns={columns}
            keyField={(r) => r.userId}
            emptyMessage="No person matches these filters."
            rowActions={(r) => r.userId === me ? null : (
              <Inline gap="xs">
                {mayMessage && (
                  <Tooltip content={`Message ${r.displayName}`}><IconButton variant="ghost" size="sm" aria-label={`Message ${r.displayName}`} icon={<ChatIcon />}
                    disabled={!!busy || isLoading || !!error} onClick={() => void message(r.userId).catch(error => { if (alive.current) setProblem(error instanceof Error ? error.message : 'Could not open the conversation.'); })}
                    data-testid="social-contact-message" /></Tooltip>
                )}
                {mayCall && (
                  <Tooltip content={call.unavailable ?? `Call ${r.displayName}`}><IconButton variant="ghost" size="sm" aria-label={`Call ${r.displayName}`} icon={<PhoneIcon />}
                    disabled={!!call.unavailable} onClick={() => call.callPeople([{ userId: r.userId, displayName: r.displayName }])} data-testid="social-contact-call" /></Tooltip>
                )}
              </Inline>
            )}
            data-testid="social-contacts-table"
          />
        </Stack>
      )}
      </Stack>
      <CollectionCommandHost adapter={adapter} disabled={!!busy} />
      </Stack>
    </CollectionCommandPage>
  );
}
