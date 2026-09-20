import { useRef, useState } from 'react';
import { ChatComposer, InlineAlert, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { ChatPanel, QuoteBlock } from '@connorhoehnslalom/ui-components/social';
import { commentQuote, type KnowledgeCommentItem, type StoredReaction } from './knowledgeFormat';

interface Props {
  title: string;
  comments: KnowledgeCommentItem[];
  reactions: StoredReaction[];
  userId?: string;
  userName?: string;
  onSend: (body: string, parentId?: string) => Promise<void>;
  onEdit: (message: { id?: string }, body: string) => Promise<void>;
  onDelete: (message: { id?: string }) => Promise<void>;
  onReact: (id: string, emoji: string) => void;
}

/** Mounted with the document ID as its key: drafts never cross documents. */
export function DocumentCommentThread({ title, comments, reactions, userId, userName, onSend, onEdit, onDelete, onReact }: Props) {
  const [draft, setDraft] = useState('');
  const [replyId, setReplyId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const composerRoot = useRef<HTMLElement>(null);
  const parent = comments.find((comment) => comment.id === replyId);
  const invalidReply = !!replyId && (!parent || !!parent.deletedAt);

  async function submit(text: string) {
    if (sending.current || !text.trim() || !userId || invalidReply) return;
    sending.current = true;
    setPending(true);
    setError(null);
    try {
      await onSend(text.trim(), replyId ?? undefined);
      setDraft('');
      setReplyId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your comment could not be saved. Try again.');
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  return <Stack gap="sm">
    {error && <InlineAlert tone="error" onDismiss={() => setError(null)}>{error}</InlineAlert>}
    <ChatPanel
      messages={comments.map((comment) => ({
        ...comment,
        ...(comment.parentId ? { metadata: { replyTo: commentQuote(comments, comment.parentId) } } : {}),
      }))}
      onSend={(text) => void submit(text)}
      composer={<Stack gap="xs" ref={composerRoot} data-testid="document-comment-composer">
        {replyId && <QuoteBlock quote={commentQuote(comments, replyId)}
          onDismiss={pending ? undefined : () => {
            setReplyId(null);
            composerRoot.current?.querySelector('textarea')?.focus();
          }} />}
        {invalidReply && <InlineAlert tone="warning">The original comment is no longer available. Cancel the reply to post your text as a new comment.</InlineAlert>}
        <ChatComposer value={draft} onChange={setDraft} onSubmit={() => void submit(draft)}
          disabled={pending || !userId || invalidReply} multiline
          aria-label={replyId ? 'Reply to comment' : 'Add a comment'}
          placeholder={replyId ? 'Write a reply…' : 'Add a comment…'}
          submitLabel={pending ? 'Posting…' : replyId ? 'Reply' : 'Post'} />
      </Stack>}
      onReply={userId ? (message) => {
        if (!message.id || message.deletedAt || sending.current) return;
        setReplyId(message.id);
        setError(null);
        composerRoot.current?.querySelector('textarea')?.focus();
      } : undefined}
      onEditMessage={onEdit}
      onDeleteMessage={onDelete}
      reactionsFor={(id) => reactions.filter((reaction) => reaction.target_id === id)
        .map((reaction) => ({ emoji: reaction.emoji, userId: reaction.actor, displayName: reaction.actor }))}
      onToggleReaction={onReact}
      currentUserId={userId}
      currentActor={userName}
      emptyState={<Stack gap="xs">
        <T className="text-[13px] font-medium text-text-primary">No comments on this document yet</T>
        <T className="text-[12px] text-text-secondary leading-snug">{`Comments are attached to ${title} and everyone with access to it sees them. Ask a question or explain a change.`}</T>
      </Stack>}
      showHeader={false}
      fill
    />
  </Stack>;
}
