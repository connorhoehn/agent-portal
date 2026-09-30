// /social/dms and /social/dms/:lobby — direct messages
// (docs/social-tenant-design.md §4.5). The library's ConversationRail lists the
// caller's conversations (`GET /api/social/dms`, the chat store's
// conversations index); "New message" opens the library's NewConversationPanel
// over the tenant roster (`GET /api/social/people`), and picking someone asks
// the server for the lobby (`POST /api/social/dms`) and opens it. The lobby
// names its members, so the gateway admits exactly those people.

import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ConversationRail, NewConversationPanel } from '@connorhoehnslalom/ui-components/social';
import { Button, EmptyState, ErrorState, InlineAlert, Inline, LoadingState, PageHeader, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { writeJson } from '../../lib/writeJson';
import SocialConversation from './SocialConversation';
import { DM_PREFIX, dmCandidates, dmHref, dmPeers, dmRailItems, dmTitle, type SocialDm, type SocialPeer, type SocialPerson } from './socialChat';

export default function DmsPage() {
  const { lobby: rawLobby } = useParams<{ lobby?: string }>();
  const lobby = rawLobby && rawLobby.startsWith(DM_PREFIX) ? rawLobby : null;
  const navigate = useNavigate();
  const { session } = useSession();
  const dms = useFetch<{ conversations: SocialDm[] }>('/api/social/dms');
  const people = useFetch<{ people: SocialPerson[] }>('/api/social/people');
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const userId = session?.sub ?? '';
  const displayName = session?.name ?? userId;
  const conversations = dms.data?.conversations ?? [];
  const roster: SocialPeer[] = people.data?.people ?? [];
  const rows = dmRailItems(conversations, lobby, userId, roster);
  const listed = lobby ? conversations.find((c) => c.channel === lobby) : undefined;
  const peers = lobby ? dmPeers(lobby, userId, roster, listed?.peers) : [];
  const mine = lobby ? lobby.slice(DM_PREFIX.length).split(':').includes(userId) : false;

  async function startDm(target: string): Promise<void> {
    setBusy(true);
    setOpenError(null);
    const res = await writeJson<{ channel: string; peers: SocialPeer[] }>('/api/social/dms', 'POST', { userId: target });
    setBusy(false);
    if (!res.ok || !res.data) { setOpenError(res.error ?? 'The conversation could not be opened.'); return; }
    setPicking(false);
    dms.refresh();
    navigate(dmHref(res.data.channel));
  }

  // Reading the open DM moves your cursor (its unread count clears); the list
  // is refetched so another conversation's count stays honest.
  const refreshDms = dms.refresh;
  const markRead = useCallback((count: number) => {
    if (!lobby || !mine || count === 0) return;
    void writeJson('/api/social/dms/read', 'POST', { channel: lobby }).then((res) => { if (res.ok) refreshDms(); });
  }, [lobby, mine, refreshDms]);

  const newButton = <Button variant="primary" size="sm" onClick={() => setPicking(true)} data-testid="social-new-dm">New message</Button>;

  return (
    <Stack gap="lg" data-testid="social-dms-page">
      <PageHeader title="Direct messages" description="One-to-one and small-group conversations, visible only to the people in them." actions={newButton} />
      {openError && <InlineAlert tone="error" onDismiss={() => setOpenError(null)}>{openError}</InlineAlert>}
      {dms.isLoading && !dms.data ? <LoadingState label="Loading conversations…" /> : dms.error && !dms.data ? (
        <ErrorState title="Conversations could not be loaded" description={dms.error} actionLabel="Try again" onAction={dms.refresh} />
      ) : (
        <Inline gap="lg" align="stretch" wrap={false} className="min-h-[32rem]">
          <ConversationRail
            className="w-72 shrink-0"
            title="Direct messages"
            grouped={false}
            conversations={rows}
            selected={lobby && !picking ? { kind: 'conversation', channel: lobby } : null}
            onSelect={(selection) => {
              if (selection.kind !== 'conversation') return;
              setPicking(false);
              navigate(dmHref(selection.channel));
            }}
            onNewChat={() => setPicking(true)}
            emptyLabel="No conversations yet"
            data-testid="social-dm-rail"
          />
          {picking ? (
            <NewConversationPanel
              className="min-w-0 flex-1"
              people={dmCandidates(people.data?.people ?? [], userId)}
              peopleError={people.error}
              busy={busy}
              onStartDm={startDm}
              onCancel={() => setPicking(false)}
              data-testid="social-dm-picker"
            />
          ) : !lobby ? (
            <EmptyState
              align="start"
              className="min-w-0 flex-1"
              testId="social-empty-dms"
              title={rows.length ? 'Pick a conversation' : 'No direct messages yet'}
              description={rows.length
                ? 'Choose a conversation on the left, or start a new one.'
                : 'A direct message is visible only to the people in it. You have not started one here.'}
              actionLabel="New message"
              onAction={() => setPicking(true)}
            />
          ) : !mine ? (
            <EmptyState align="start" className="min-w-0 flex-1" testId="social-dm-missing" title="This conversation is not yours" description="A direct message opens only for the people it names." />
          ) : (
            <SocialConversation
              key={lobby}
              channel={lobby}
              name={dmTitle(peers)}
              userId={userId}
              displayName={displayName}
              placeholder={`Message ${dmTitle(peers)}`}
              onMessages={markRead}
            />
          )}
        </Inline>
      )}
    </Stack>
  );
}
