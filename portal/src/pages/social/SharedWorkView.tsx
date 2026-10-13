// The open conversation's Shared work view (`?view=shared`,
// docs/communication-plane-goal.md §2): everything shared INTO this
// conversation — its work graph (the same provider as Social's `?view=graph`,
// on the plane behind the caller's current Social grants) as the library
// `WorkGraph`, and beneath it the shared items as a library `ActionRowList`
// (`size="sm"`), read from ONE route: `GET <api>/conversations/:id/shared-work`
// (middleware lib/work-graph/shared-work.ts, the one shared-work notion). Page
// references, deck shares, files and sharing grants arrive already folded
// through this reader's authority; a row the reader may not open is
// `unavailable` with no title. Nothing is resolved client-side, and nothing
// fans out per row. Opening a row or a node hands it to the host, which shows
// detail in the far-right pane first ("Open page" on demand).

import { useEffect } from 'react';
import { ActionRowList, type ActionRowItem } from '@connorhoehnslalom/ui-components';
import { InlineAlert, SectionLabel, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { WorkGraphActivity } from '../../components/work-graph/WorkGraphActivity';
import { useSocialPlane } from './socialPlane';
import { readSharedWork, sharedRowLine, sharedUnavailableReason, sharedKindLabel, sharedWorkUrl, type SharedWorkItem, type SharedWorkMessage } from './sharedWorkModel';

export type { SharedWorkMessage } from './sharedWorkModel';

export interface SharedWorkOpen {
  item: SharedWorkItem;
}

export interface SharedWorkViewProps {
  channel: string;
  name: string;
  /** The thread as the surface holds it: a new message refetches the list (a share may have arrived). */
  messages: readonly SharedWorkMessage[];
  /** Embedded in another tenant: the plane's work-graph route. */
  plane: boolean;
  onOpenItem: (open: SharedWorkOpen) => void;
  onOpenNode?: (node: { id: string; title: string; kind: string }, href: string | null) => void;
}

const when = (iso: string | null | undefined) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
};

export default function SharedWorkView({ channel, name, messages, plane, onOpenItem, onOpenNode }: SharedWorkViewProps) {
  const { api } = useSocialPlane();
  const shared = useFetch<unknown>(sharedWorkUrl(api, channel), 60_000);
  const reply = readSharedWork(shared.data);
  const items = reply?.items ?? [];
  // A message arriving in the thread may be a share: ask the server again rather than deriving anything here.
  const arrivals = messages.length;
  useEffect(() => { if (arrivals > 0) shared.refresh(); }, [arrivals]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows: ActionRowItem[] = items.map((item) => (item.status === 'available' && item.title
    ? { id: item.key, title: item.title, description: sharedRowLine(item), meta: when(item.at) ?? undefined }
    : { id: item.key, title: `${sharedKindLabel(item)} unavailable`, description: sharedRowLine(item), disabled: true, disabledReason: sharedUnavailableReason(item) }));

  return (
    <Stack gap="md" className="min-h-0 min-w-0 flex-1 overflow-auto" data-testid="social-shared-work">
      {/* A floor, never a fixed height (see PersonSharedWork): the plain canvas sizes itself and the list sits below it. */}
      <WorkGraphActivity subject={{ kind: 'conversation', id: channel, plane }} mode="split" title={`Shared in ${name}`}
        className="min-h-[360px] shrink-0" {...(onOpenNode ? { onOpenNode } : {})} />
      <Stack gap="sm">
        <SectionLabel as="h2">Shared here</SectionLabel>
        {shared.error && <InlineAlert tone="warning">{shared.error}</InlineAlert>}
        {reply?.limits.map((limit) => <InlineAlert key={limit} tone="info">{limit}</InlineAlert>)}
        <ActionRowList items={rows} aria-label={`Shared in ${name}`}
          emptyLabel={shared.isLoading && !shared.data ? 'Loading…' : 'Nothing has been shared in this conversation yet.'}
          onOpen={(row) => { const item = items.find((i) => i.key === row.id); if (item) onOpenItem({ item }); }}
          data-testid="social-shared-items" />
      </Stack>
    </Stack>
  );
}
