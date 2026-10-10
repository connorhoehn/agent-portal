// A read-only conversation overview. Posting belongs to the Social workspace;
// this dialog never mounts a composer or creates a conversation.
import { useEffect, useState } from 'react';
import { Avatar, Button, ChatIcon, Chip, CloseIcon, ExternalLinkIcon, IconButton, Inline, Modal, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime';

export interface ConversationPreview {
  id: string;
  title: string;
  avatarUrl?: string;
  preview: string | null;
  at: string | null;
  unread: number;
}

export function MessagesOverviewDialog({ open, onClose, title, context, conversations, loading, error, onOpenSocial, socialLabel = 'Open Social', accessHint, onRefresh, preferredId = null, testId }: {
  open: boolean;
  onClose(): void;
  title: string;
  context?: string;
  conversations: readonly ConversationPreview[];
  loading: boolean;
  error: string | null;
  onOpenSocial(id: string | null): void | Promise<void>;
  socialLabel?: string;
  accessHint?: string;
  onRefresh?: () => void;
  preferredId?: string | null;
  testId: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(preferredId);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => { setSelectedId(preferredId); }, [preferredId]);
  const selected = conversations.find(row => row.id === selectedId) ?? conversations[0] ?? null;
  return <Modal open={open} onClose={onClose} ariaLabel="Conversation overview" maxWidth={800}
    rawChildren cardClassName="!p-0 overflow-hidden"
    backdropTestId={`${testId}-backdrop`}
    backdropStyle={{ background: 'radial-gradient(ellipse at 22% 90%, color-mix(in srgb, var(--color-primary) 22%, transparent), transparent 65%), rgba(15, 23, 42, 0.3)', backdropFilter: 'blur(5px)' }}>
    <Stack gap="none" data-testid={testId}>
      <Inline gap="sm" justify="between" align="center" className="px-5 py-3">
        <T size="sm" weight="semibold">Messages</T>
        <IconButton variant="ghost" size="sm" icon={<CloseIcon size={16} />} aria-label="Close conversation overview" onClick={onClose} />
      </Inline>
      <Stack gap="xs" className="messages-overview-sky border-b border-border px-5 py-4">
        <Inline gap="sm" justify="between" align="center"><T size="xs" weight="semibold" tone="secondary">{title} · Conversation overview</T>
          {onRefresh && <Button variant="link" size="sm" className="text-xs" onClick={onRefresh} disabled={loading} data-testid="embedded-social-refresh">Refresh</Button>}
        </Inline>
        <T size="sm" tone="secondary" wrap>Catch up here. Open Social to join the conversation.</T>
        {context && <Inline gap="xs" className="mt-1"><ChatIcon size={13} /><T size="xs" weight="medium" wrap>{context}</T></Inline>}
      </Stack>
      {error && <T role="status" size="xs" tone="secondary" wrap className="px-5 pt-3">{error}</T>}
      {selected ? <div className="grid min-h-0 grid-cols-1 sm:grid-cols-[260px_1fr]">
        <Stack gap="none" className="max-h-80 overflow-y-auto border-b border-border sm:border-b-0 sm:border-r" aria-label="Conversations">
          {conversations.map(row => <button key={row.id} type="button" onClick={() => setSelectedId(row.id)} aria-pressed={selected.id === row.id}
            className={`flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-surface-hover ${selected.id === row.id ? 'bg-primary-soft' : ''}`}>
            <Avatar name={row.title} size={28} {...(row.avatarUrl ? { src: row.avatarUrl } : {})} />
            <Stack gap="xs" className="min-w-0 flex-1">
              <Inline gap="xs" justify="between" align="center" wrap={false}><T size="sm" weight="medium" className="truncate">{row.title}</T>{row.unread > 0 && <Chip size="xs" tone="info">{row.unread}</Chip>}</Inline>
              <T size="xs" tone="secondary" className="truncate">{row.preview ?? 'No message preview'}</T>
              {row.at && <T size="xs" tone="tertiary">{relativeTime(row.at)}</T>}
            </Stack>
          </button>)}
        </Stack>
        <Stack gap="md" className="min-h-48 px-5 py-5" data-testid={`${testId}-preview`}>
          <Inline gap="sm" align="center"><Avatar name={selected.title} size={32} {...(selected.avatarUrl ? { src: selected.avatarUrl } : {})} /><T size="sm" weight="semibold" wrap>{selected.title}</T></Inline>
          <Stack gap="xs" className="rounded-xl border border-border bg-surface-muted px-4 py-3">
            <T size="xs" tone="tertiary">Latest message{selected.at ? ` · ${relativeTime(selected.at)}` : ''}</T>
            <T size="sm" wrap className="whitespace-pre-wrap break-words">{selected.preview ?? 'There is no message preview for this conversation.'}</T>
          </Stack>
          <T size="xs" tone="secondary" wrap>This is a preview. Replies and the full conversation live in Social.</T>
        </Stack>
      </div> : <Stack gap="xs" className="px-5 py-7" data-testid={`${testId}-empty`}>
        <T size="sm" weight="semibold">{loading ? 'Loading conversations…' : error ? 'Conversations are unavailable' : 'No recent conversations'}</T>
        <T size="sm" tone="secondary" wrap>{error ? 'Try opening the workspace again.' : 'Your recent conversations will appear here. Use Social to find people and participate.'}</T>
      </Stack>}
      <Inline gap="md" justify="between" align="center" className="border-t border-border px-5 py-3">
        <T size="xs" tone="secondary" wrap className={`min-w-0 ${openError ? 'text-danger' : ''}`} {...(openError ? { role: 'alert' } : {})}>{openError ?? accessHint ?? 'Read-only overview'}</T>
        <Button size="sm" variant="primary" disabled={opening} onClick={() => {
          if (opening) return;
          setOpening(true); setOpenError(null);
          void Promise.resolve().then(() => onOpenSocial(selected?.id ?? null)).catch(cause => {
            setOpenError(cause instanceof Error ? cause.message : 'Social could not be opened.');
          }).finally(() => setOpening(false));
        }} data-testid={`${testId}-open-social`}>
          {opening ? 'Opening…' : socialLabel}<ExternalLinkIcon size={14} />
        </Button>
      </Inline>
    </Stack>
  </Modal>;
}
