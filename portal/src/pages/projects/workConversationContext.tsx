import type { WrappedChatPanelProps } from '@connorhoehn/ui-components/integrations/realtime';
import { Button, Chip, Inline, T } from '@connorhoehn/ui-components/shared';
import type { WorkItem } from '../project-detail/types';

/** References name a record only; its key/title are resolved under this viewer's access. */
function WorkContext({ item, loading, onOpen, comment }: { item: WorkItem | undefined; loading: boolean; onOpen: (id: string) => void; comment: boolean }) {
  if (!item) return <T size="xs" tone="secondary">{loading ? 'Loading work context…' : 'Work context unavailable'}</T>;
  return <Button variant="link" size="sm" className="max-w-full !px-0" onClick={() => onOpen(item.id)} title={item.title}>
    <Inline gap="xs" align="center" wrap={false} className="min-w-0">
      <Chip size="xs" tone="neutral" mono>{item.key ?? item.id}</Chip>
      <T size="xs" tone="secondary" className="truncate">{comment ? 'Comment · ' : ''}{item.title}</T>
    </Inline>
  </Button>;
}

export function workConversationReferences(projectId: string, onOpen: (id: string) => void, items: readonly WorkItem[] | null): NonNullable<WrappedChatPanelProps['renderMessageReferences']> {
  // Reuse the initiative's authorized work-tree response; each message does
  // not need another request, and client-supplied titles are never trusted.
  const byId = new Map(items?.filter(item => item.projectId === projectId).map(item => [item.id, item]));
  return message => {
    const page = message.metadata?.pageReference as { kind?: string; id?: string } | undefined;
    if (page?.kind !== 'work-item' || typeof page.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(page.id)) return null;
    return <WorkContext item={byId.get(page.id)} loading={items === null} onOpen={onOpen} comment={message.metadata?.workComment === true} />;
  };
}
