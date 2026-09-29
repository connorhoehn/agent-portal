// The Comments tab: platform-api threads, the way realtime-examples' page
// editor lays its Comments tab out (DocumentEditorPage `renderShellTab`) — one
// card per group ("On the page" for threads pinned to text, "Whole document"
// for the rest) with "n open · m total", each thread the library's
// `CommentThreadNode` (reply, resolve / reopen, the quote it points at).
// Assessment adds what its earlier thread had: reactions on the document and
// on each thread (kept in the BFF's store, keyed by the same comment ids the
// import preserved), and a notice when earlier comments have not moved yet.

import { useState } from 'react';
import { CommentThreadNode } from '@connorhoehnslalom/ui-components/doc-editor';
import { Button, Card, CardHeader, EmptyState, Inline, InlineAlert, LoadingState, Stack, Textarea } from '@connorhoehnslalom/ui-components/shared';
import { ReactionsBar } from '@connorhoehnslalom/ui-components/social';
import { commentGroups, commentImportNotice, type CommentThreadView } from './documentCommentsModel';
import { summarizeStoredReactions } from './knowledgeFormat';
import type { DocumentCommentsState } from './useDocumentComments';

type ThreadComment = Parameters<typeof CommentThreadNode>[0]['comment'];

export function DocumentComments({ sourceId, title, userId, comments, onBackToPage }: {
  sourceId: string; title: string; userId: string; comments: DocumentCommentsState; onBackToPage: () => void;
}) {
  const [draft, setDraft] = useState('');
  const groups = commentGroups(comments.threads);
  const notice = commentImportNotice(comments.importStatus);
  const post = async () => {
    const text = draft.trim();
    if (!text || comments.pending) return;
    try { await comments.addDocumentComment(text); setDraft(''); } catch { /* shown via comments.error */ }
  };
  const threadCard = (thread: CommentThreadView) => (
    <Stack key={thread.id} gap="xs" data-testid={`document-comment-thread-${thread.id}`}>
      <CommentThreadNode comment={thread as ThreadComment} depth={0} mentionUsers={[]}
        {...(thread.anchor ? { context: { kind: 'quote' as const, text: thread.anchor.quote } } : { context: { kind: 'document' as const } })}
        onReply={(parentId, text) => { void comments.reply(parentId, text).catch(() => undefined); }}
        onResolveThread={id => { void comments.resolve(id, true).catch(() => undefined); }}
        onUnresolveThread={id => { void comments.resolve(id, false).catch(() => undefined); }}
        actions={<ReactionsBar reactions={summarizeStoredReactions(comments.reactions, thread.id, userId || null)}
          onReact={emoji => void comments.react(thread.id, emoji)} />} />
    </Stack>
  );
  return <Stack gap="md" className="min-h-0" data-testid="document-comments">
    <ReactionsBar reactions={summarizeStoredReactions(comments.reactions, sourceId, userId || null)} onReact={emoji => void comments.react(sourceId, emoji)} />
    {comments.error && <InlineAlert tone="error" onDismiss={comments.clearError}>{comments.error}</InlineAlert>}
    {notice && <InlineAlert tone={notice.tone} data-testid="document-comments-import-notice">{notice.text}</InlineAlert>}
    <Card padding="md" data-testid="document-comment-new">
      <Stack gap="sm">
        <Textarea value={draft} onChange={event => setDraft(event.target.value)} rows={2}
          aria-label="Comment on the whole document" placeholder={`Add a comment on ${title}…`}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void post(); } }} />
        <Inline gap="sm" justify="end">
          <Button size="sm" variant="primary" disabled={!draft.trim() || comments.pending || !userId} onClick={() => void post()}>
            {comments.pending ? 'Posting…' : 'Post'}
          </Button>
        </Inline>
      </Stack>
    </Card>
    {comments.loading ? <LoadingState label="Loading comments…" />
      : groups.length === 0 ? <EmptyState title="No comments yet"
        body="Post a comment on the whole document here, or select text on the page and choose Comment — the thread shows up here as well as beside the sentence."
        actionLabel="Back to the page" onAction={onBackToPage} />
      : groups.map(group => (
        <Card key={group.key} padding="md" data-testid={`document-comments-group-${group.key}`}>
          <CardHeader title={group.title} meta={`${group.open} open · ${group.threads.length} total`} />
          <Stack gap="md">{group.threads.map(threadCard)}</Stack>
        </Card>
      ))}
  </Stack>;
}
