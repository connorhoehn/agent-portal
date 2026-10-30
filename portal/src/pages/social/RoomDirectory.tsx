// A room directory inside the existing Social/Communication workspace.
// Room data and authority come from the host's BFF read; opening is navigation,
// while joining remains the explicit action in RoomPane/useSocialCall.
import { useState } from 'react';
import { Button, Card, Chip, CollectionToolbar, EmptyState, Inline, KeyValue, PageSection, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import type { NameOf, SocialRoom } from './socialPlatform';
import type { RoomsFetch } from './SocialRoomsSection';
import { SocialReadStatus } from './SocialReadStatus';
import { CollectionCommandHost, type CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost';

export default function RoomDirectory({ rooms, read, nameOf, activeLobby, mayCreate, onCreate, onOpen, inset = false }: {
  rooms: readonly SocialRoom[];
  read: RoomsFetch;
  nameOf: NameOf;
  activeLobby: string | null;
  mayCreate: boolean;
  onCreate(): void;
  onOpen(slug: string): void;
  inset?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [access, setAccess] = useState('');
  const available = rooms.filter((room, index) => room.state === 'active' && rooms.findIndex(r => r.slug === room.slug) === index);
  const matches = available.filter(room => (!access || room.visibility === access)
    && `${room.name} ${room.description ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const commands: CollectionCommandAdapter = {
    id: 'room-directory', label: 'Hangouts', examples: ['Show all hangouts', 'Show private hangouts', 'Refresh hangouts'],
    scopeNote: 'Find hangouts available to you, filter by access, or open a hangout by its exact name. Opening a hangout does not join its call.',
    placeholder: 'Find hangouts, show private hangouts, or open a hangout…',
    execute(text) {
      const input = text.trim(), lower = input.toLocaleLowerCase().replace(/hangouts/g, 'rooms');
      if (/^(show all rooms|reset|clear filters)$/.test(lower)) { setQuery(''); setAccess(''); return { message: 'Showing all hangouts available to you.' }; }
      if (lower === 'show private rooms' || lower === 'show open rooms') { setQuery(''); setAccess(lower.includes('private') ? 'private' : 'org'); return { message: lower.includes('private') ? 'Showing member-only hangouts available to you.' : 'Showing hangouts open to the workspace.' }; }
      if (/^refresh(?: rooms)?$/.test(lower)) { read.refresh(); return { message: 'Refreshing hangouts.' }; }
      const find = /^(?:find|search)\s+(.+)$/i.exec(input);
      if (find) { setQuery(find[1]); return { message: `Finding hangouts matching “${find[1]}”.` }; }
      const open = /^open\s+(.+)$/i.exec(input);
      if (open) {
        const named = matches.filter(room => room.name.toLocaleLowerCase() === open[1].toLocaleLowerCase());
        if (named.length !== 1) throw new Error(named.length ? 'More than one visible hangout has that name. Open its card.' : 'No visible hangout has that exact name. Clear filters or search for it first.');
        onOpen(named[0].slug); return { message: `Opened ${named[0].name}. Join its call when you are ready.` };
      }
      throw new Error('Use Find followed by a name, Show all hangouts, Show private hangouts, Show open hangouts, Refresh hangouts, or Open followed by an exact visible hangout name.');
    },
  };
  return <Stack gap="none" className="min-h-0 min-w-0 flex-1" data-testid="social-room-directory">
    <Stack gap="lg" data-page-body={inset ? "inset" : undefined} className={`min-h-0 min-w-0 flex-1 overflow-y-auto pb-6${inset ? ' px-[var(--ui-page-gutter,1.5rem)] pt-4' : ''}`}>
    <PageSection size={inset ? 'lg' : 'md'} title="Hangouts" description="Choose a hangout for your call, saved room layout, and activity."
      actions={mayCreate ? <Button variant="primary" size="sm" onClick={onCreate} data-testid="social-directory-new-room">New hangout</Button> : undefined} />
    {available.length > 0 && <CollectionToolbar layout="cards" label="Find a hangout" search={{ value: query, onChange: setQuery, placeholder: 'Find a hangout by name or purpose', 'aria-label': 'Find a hangout' }}
      filters={[{ id: 'access', label: 'Who can join', value: access, onChange: setAccess, options: [{ value: '', label: 'All available hangouts' }, { value: 'org', label: 'Open to the workspace' }, { value: 'private', label: 'Members only' }] }]}
      summary={`${matches.length} of ${available.length}${read.data?.cursor ? " loaded" : ""} hangouts`} onRefresh={read.refresh} refreshing={read.isLoading} />}
    {read.error && <SocialReadStatus source="Hangouts" read={read} retry={read.refresh} testId="social-directory-read-status" />}
    {available.length === 0 ? <EmptyState align="start" testId="social-rooms-empty" title="No hangouts available yet"
      description={mayCreate ? 'Create a hangout, then configure its call settings and saved rooms.' : 'Hangouts are ongoing places to meet. A moderator or community admin can create one and add you to a private hangout.'} />
      : matches.length === 0 ? <EmptyState align="start" testId="social-room-search-empty" title="No matching hangouts" description="Try another name or show all hangouts available to you."
        action={<Button variant="secondary" size="sm" onClick={() => { setQuery(''); setAccess(''); }}>Clear filters</Button>} />
        : <Stack gap="md" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))]" data-testid="social-room-cards">
          {matches.map(room => <Card key={room.slug} padding="sm" data-testid="social-room-card"><Stack gap="md" className="h-full">
            <Inline justify="between" gap="sm"><Chip tone={room.visibility === 'private' ? 'warning' : 'neutral'} size="sm">{room.visibility === 'private' ? 'Members only' : 'Open to the workspace'}</Chip>
              {activeLobby === room.lobbyName && <Chip tone="success" size="sm">You’re in this call</Chip>}</Inline>
            <Stack gap="sm"><T size="sm" weight="semibold" wrap>{room.name}</T>{room.description && <T size="sm" tone="secondary" wrap>{room.description}</T>}</Stack>
            <KeyValue items={[{ label: 'Opened by', value: nameOf(room.createdBy) === room.createdBy ? 'Name unavailable' : nameOf(room.createdBy) }, { label: 'Call', value: room.settings.audioOnly ? 'Cameras off on entry' : 'Audio and video' }]} />
            <Button variant="secondary" size="sm" className="mt-auto self-start" aria-label={`Open ${room.name}`} onClick={() => onOpen(room.slug)}>Open hangout</Button>
          </Stack></Card>)}
        </Stack>}
      {read.loadMore && <Button variant="secondary" size="sm" className="self-start" disabled={read.loadingMore} onClick={read.loadMore}>{read.loadingMore ? 'Loading…' : 'Load more hangouts'}</Button>}
    </Stack>
    <CollectionCommandHost adapter={commands} inPlace={inset} />
  </Stack>;
}
