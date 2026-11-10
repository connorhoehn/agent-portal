// /social/contacts — the people in this workspace, and who is here now
// (docs/social-tenant-design.md §4.5, lane S2).
//
// The roster is the tenant's (`GET /api/social/people`: everyone holding a
// social grant, from the identity store). Presence is the workspace's own
// channel, `social:lobby`, owned by the persistent shell. Read its shared
// roster here without taking another subscription, drawn with the library's
// `PresenceAvatars`. From a person: Message opens (or reopens) your DM with
// them; Call rings them into `social:dm:<ids>` through the shell's call host.
// A row opens the person as a page, `/social/contacts/:userId`, the roster as
// the list rail beside it (docs/layout-cascade.md "Records open as pages").
// Opening writes nothing: Message and Call are explicit buttons on the record.

import {
  Button,
  CollectionToolbar,
  DetailHeader,
  IconButton,
  KeyValue,
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
  PresenceAvatars,
  Stack,
  T,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
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
import { CollectionRecordFrame } from '../../components/collections/CollectionRecordFrame';
import { PersonSharedWork } from '../../components/communication/PersonSharedWork';
import { RecordNotFound } from '../../components/UnavailableNotice';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { contactCommandExamples, filterContacts, parseContactCommand, presenceTally, resolveContactTarget, type ContactFilters, type ContactPresence } from './contactCommands';

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
  const latest = useRef({ filtered, rows, mayMessage, me, isLoading, error });
  latest.current = { filtered, rows, mayMessage, me, isLoading, error };
  // The open person is the URL (`/social/contacts/:userId`); opening one writes nothing.
  const { userId: openId = null } = useParams<{ userId?: string }>();
  const open = openId ? rows.find(r => r.userId === openId) ?? null : null;
  const openRecord = (id: string | null) => navigate(id ? `/social/contacts/${encodeURIComponent(id)}` : '/social/contacts');
  useCrumbLabel(openId ?? undefined, open ? open.displayName : null);

  /** `fromRecord`: the record's explicit Message button, whose person need not match the table's filters. */
  async function message(target: string, fromRecord = false): Promise<string> {
    const current = latest.current;
    if (messagePending.current) throw new Error('A conversation is already opening.');
    if (current.isLoading || current.error) throw new Error('Wait for the contact table to load successfully before choosing a person.');
    const row = resolveContactTarget(target, fromRecord ? current.rows : current.filtered, current.me, current.mayMessage);
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
        const shown = filterContacts(rows, { query: '', presence: command.presence }).length;
        return { message: `${presenceTally(rows, me)} Presence filter: ${command.presence} (${shown} shown). Your name search and sorting are unchanged.` };
      }
      if (command.kind === 'search') {
        setFilters(current => ({ ...current, query: command.query }));
        return { message: `Searching loaded contact names and user IDs for “${command.query}”. Presence filter and sorting are unchanged.` };
      }
      if (command.kind === 'open') return { message: await message(command.target) };
      throw new Error('This command is not available here.');
    },
  };

  const presenceLabel = (r: ContactRow) => (r.online ? (r.idle ? 'Away' : 'Here now') : 'Offline');
  const presenceTone = (r: ContactRow) => (r.online ? (r.idle ? 'warning' : 'success') : 'neutral') as 'warning' | 'success' | 'neutral';
  const reportProblem = (error: unknown) => { if (alive.current) setProblem(error instanceof Error ? error.message : 'Could not open the conversation.'); };

  const columns: DataTableColumn<ContactRow>[] = [
    {
      key: 'displayName', header: 'Name', sortable: true,
      render: (r) => (
        <Inline gap="sm" align="center">
          <PresenceAvatars size={24} maxVisible={1} users={[{ id: r.userId, name: r.displayName, ...(r.avatarUrl ? { avatarUrl: r.avatarUrl } : {}), ...(r.online && !r.idle ? {} : { idle: true }) }]} />
          <T size="sm" data-record-name={r.displayName}>{r.displayName}{r.userId === me ? ' (you)' : ''}</T>
        </Inline>
      ),
    },
    { key: 'roles', header: 'Role', width: '160px', render: (r) => r.roles.map(roleLabel).join(', ') },
    {
      key: 'online', header: 'Status', width: '120px', sortable: true,
      compare: (a, b) => Number(a.online) - Number(b.online),
      render: (r) => <Chip tone={presenceTone(r)} size="xs" dot="static">{presenceLabel(r)}</Chip>,
    },
  ];

  if (openId) {
    const groups = (['Here now', 'Away', 'Offline'] as const).map(label => ({ id: label, title: label, count: filtered.filter(r => presenceLabel(r) === label).length }));
    return (
      <CollectionRecordFrame
        title="Contacts"
        listTitle="People"
        listLabel="contacts"
        {...(data ? { count: filtered.length } : {})}
        search={{ value: filters.query, onChange: query => setFilters(current => ({ ...current, query })), placeholder: 'Find a person' }}
        groups={groups}
        rows={filtered.map(r => ({ id: r.userId, groupId: presenceLabel(r), title: `${r.displayName}${r.userId === me ? ' (you)' : ''}`, subline: r.roles.map(roleLabel).join(', ') || r.userId }))}
        currentId={openId}
        onOpen={id => openRecord(id)}
        loading={isLoading && !data}
        error={error && !data ? error : null}
        onRetry={refresh}
        footer={<CollectionCommandHost adapter={adapter} disabled={!!busy} />}
        data-testid="social-contact-explorer"
      >
        {(problem || call.notice) && (
          <InlineAlert tone="warning" onDismiss={() => { setProblem(null); call.clearNotice(); }}>{problem ?? call.notice}</InlineAlert>
        )}
        {open ? (
          <Stack gap="md" data-testid="social-contact-record">
            <Inline gap="md" align="center" wrap={false}>
              <PresenceAvatars size={40} maxVisible={1} users={[{ id: open.userId, name: open.displayName, ...(open.avatarUrl ? { avatarUrl: open.avatarUrl } : {}), ...(open.online && !open.idle ? {} : { idle: true }) }]} />
              <DetailHeader className="min-w-0 flex-1" title={`${open.displayName}${open.userId === me ? ' (you)' : ''}`}
                badge={<Chip tone={presenceTone(open)} size="xs" dot="static">{presenceLabel(open)}</Chip>}
                description={open.roles.length ? open.roles.map(roleLabel).join(', ') : 'No role in this workspace'} />
            </Inline>
            {open.userId !== me && (mayMessage || mayCall) && (
              <Inline gap="sm" wrap>
                {mayMessage && (
                  <Button size="sm" variant="secondary" disabled={!!busy || isLoading || !!error} data-testid="social-contact-record-message"
                    onClick={() => void message(open.userId, true).catch(reportProblem)}><ChatIcon />Message</Button>
                )}
                {mayCall && (
                  <Tooltip content={call.unavailable ?? `Call ${open.displayName}`}>
                    <Button size="sm" variant="secondary" disabled={!!call.unavailable} title={call.unavailable ?? undefined} aria-description={call.unavailable ?? undefined} data-testid="social-contact-record-call"
                      onClick={() => call.callPeople([{ userId: open.userId, displayName: open.displayName }])}><PhoneIcon />Call</Button>
                  </Tooltip>
                )}
              </Inline>
            )}
            <KeyValue layout="row" items={[
              { label: 'User ID', value: open.userId, mono: true },
              { label: 'Role', value: open.roles.length ? open.roles.map(roleLabel).join(', ') : 'None', muted: !open.roles.length },
              { label: 'Status', value: presenceLabel(open) },
            ]} />
            {/* The person's work as THIS viewer may see it: GET /api/social/plane/people/:userId/shared-work, filtered on the server. */}
            <PersonSharedWork userId={open.userId} name={open.displayName} self={open.userId === me} online={open.online}
              onOpenNode={(_node, href) => { if (href?.startsWith('/')) navigate(href); }} />
          </Stack>
        ) : isLoading || !data ? (
          <LoadingState label="Loading the person…" />
        ) : (
          <RecordNotFound heading="Contact" title="Nobody here by that id"
            body={`Nobody with the id "${openId}" holds a role in this workspace.`}
            backLabel="Contacts" onBack={() => openRecord(null)} />
        )}
      </CollectionRecordFrame>
    );
  }

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
        notices={[scopeNote]} onRefresh={refresh} refreshing={isLoading}>
        <Inline gap="xs" align="center" data-testid="social-contacts-here">
          <T size="xs" tone="secondary">Here now {here.length}</T>
          {here.length > 0 && <PresenceAvatars size={20} maxVisible={6} users={here} />}
        </Inline>
      </CollectionToolbar>
      {(problem || call.notice) && (
        <InlineAlert tone="warning" onDismiss={() => { setProblem(null); call.clearNotice(); }}>{problem ?? call.notice}</InlineAlert>
      )}
      {isLoading && !data ? <LoadingState label="Loading people…" /> : error && !data ? (
        <ErrorState title="People could not be loaded" description="The workspace contact list is unavailable right now. Try again in a moment." actionLabel="Try again" onAction={refresh} />
      ) : rows.length === 0 ? (
        <EmptyState testId="social-empty-contacts" align="start" title="Nobody here yet"
          description="People appear here once they hold a role in this workspace. An admin grants that from Identity." />
      ) : (
        <Stack gap="md">
          <DataTable
            data={filtered}
            columns={columns}
            keyField={(r) => r.userId}
            onRowClick={(r) => openRecord(r.userId)}
            emptyMessage="No person matches these filters."
            rowActions={(r) => r.userId === me ? null : (
              <Inline gap="xs">
                {mayMessage && (
                  <Tooltip content={`Message ${r.displayName}`}><IconButton variant="ghost" size="sm" aria-label={`Message ${r.displayName}`} icon={<ChatIcon />}
                    disabled={!!busy || isLoading || !!error} onClick={() => void message(r.userId).catch(reportProblem)}
                    data-testid="social-contact-message" /></Tooltip>
                )}
                {mayCall && (
                  <Tooltip content={call.unavailable ?? `Call ${r.displayName}`}><IconButton variant="ghost" size="sm" aria-label={`Call ${r.displayName}`} icon={<PhoneIcon />}
                    disabled={!!call.unavailable} title={call.unavailable ?? undefined} aria-description={call.unavailable ?? undefined}
                    onClick={() => call.callPeople([{ userId: r.userId, displayName: r.displayName }])} data-testid="social-contact-call" /></Tooltip>
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
