// The assessment document's comments, participants and call — as data. Pure
// (no React, no library runtime) so node --test covers the thread assembly,
// the Comments tab's groups, who the byline shows and the call lobby.
//
// Comments are platform-api's document comments, read through the BFF
// (`/api/assessment/knowledge/doc/workflows/comments?id=<source id>`): a root is
// document-wide (`scope: 'document'`) or anchored to a span of the page (a Y.js
// relative position in `anchor`); a reply names its parent. The earlier Aurora
// thread was imported once, keeping its ids, authors and timestamps
// (middleware providers/document-comment-import.ts) — the `import` block on
// the list response says how that went.

export interface PlatformCommentAnchor { v: number; key: string; start: string; end: string; quote: string }

/** One row as `GET …/doc/workflows/comments` returns it (platform-api's item shape). */
export interface PlatformComment {
  documentId: string;
  commentId: string;
  text: string;
  userId: string;
  displayName: string;
  color: string;
  timestamp: string;
  scope?: 'document';
  sectionId?: string;
  parentCommentId?: string;
  anchor?: PlatformCommentAnchor;
  resolved?: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  editedAt?: string;
  deletedAt?: string;
  importedFrom?: string;
}

export interface CommentImportStatus {
  state: 'imported' | 'none' | 'unconfigured' | 'failed';
  imported: number;
  legacy: number;
  importedAt?: string;
  reason?: string;
}

export interface DocumentCommentsResponse {
  documentId: string;
  comments: PlatformComment[];
  import: CommentImportStatus;
}

/** The library's CommentThread (doc-editor `CommentThreadNode`'s `comment`), plus where the root points. */
export interface CommentThreadView {
  id: string;
  text: string;
  userId: string;
  displayName: string;
  color: string;
  timestamp: string;
  parentCommentId: string | null;
  resolved?: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  replies: CommentThreadView[];
  /** Roots only. */
  anchor?: PlatformCommentAnchor;
  scope?: 'document';
  imported?: boolean;
}

function view(c: PlatformComment, names: ReadonlyMap<string, string>): CommentThreadView {
  return {
    id: c.commentId, text: c.text, userId: c.userId, displayName: c.displayName || c.userId,
    color: c.color, timestamp: c.timestamp, parentCommentId: c.parentCommentId ?? null,
    ...(c.resolved ? { resolved: true } : {}),
    // The banner says "Resolved by <resolvedBy>": a person, not a user id, when anyone on the page knows them.
    ...(c.resolvedBy ? { resolvedBy: names.get(c.resolvedBy) ?? c.resolvedBy } : {}),
    ...(c.resolvedAt ? { resolvedAt: c.resolvedAt } : {}),
    ...(c.anchor ? { anchor: c.anchor } : {}),
    ...(c.scope ? { scope: c.scope } : {}),
    ...(c.importedFrom ? { imported: true } : {}),
    replies: [],
  };
}

/**
 * Roots with their replies nested, oldest first at every level. A reply
 * whose parent is not in the list is shown as a root rather than dropped —
 * the words exist, and hiding them would be the worse error.
 */
export function commentThreads(comments: readonly PlatformComment[]): CommentThreadView[] {
  const sorted = [...comments].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.commentId.localeCompare(b.commentId));
  const names = new Map(sorted.filter(c => c.displayName && c.displayName !== c.userId).map(c => [c.userId, c.displayName]));
  const nodes = new Map(sorted.map(c => [c.commentId, view(c, names)]));
  const roots: CommentThreadView[] = [];
  for (const c of sorted) {
    const node = nodes.get(c.commentId)!;
    const parent = c.parentCommentId ? nodes.get(c.parentCommentId) : undefined;
    if (parent && parent !== node) parent.replies.push(node);
    else roots.push(node);
  }
  return roots;
}

export interface CommentGroup { key: 'page' | 'document'; title: string; threads: CommentThreadView[]; open: number }

/**
 * The Comments tab's cards, as realtime-examples groups a canvas page's
 * threads: the ones pinned to text ("On the page") and the document-wide ones.
 * An empty group is left out.
 */
export function commentGroups(threads: readonly CommentThreadView[]): CommentGroup[] {
  const page = threads.filter(t => !!t.anchor);
  const document = threads.filter(t => !t.anchor);
  return ([
    { key: 'page', title: 'On the page', threads: page },
    { key: 'document', title: 'Whole document', threads: document },
  ] as const).filter(g => g.threads.length > 0).map(g => ({ ...g, threads: [...g.threads], open: g.threads.filter(t => !t.resolved).length }));
}

export function openThreadCount(threads: readonly CommentThreadView[]): number {
  return threads.filter(t => !t.resolved).length;
}

/** What the tab says about the one-time move of the earlier thread, or null when there is nothing to say. */
export function commentImportNotice(status: CommentImportStatus | undefined): { tone: 'info' | 'warning'; text: string } | null {
  if (!status) return null;
  if (status.state === 'unconfigured' && status.legacy > 0) {
    return { tone: 'warning', text: `${status.legacy} earlier ${status.legacy === 1 ? 'comment is' : 'comments are'} still in the accelerator's own store and ${status.legacy === 1 ? 'has' : 'have'} not been moved to this document yet.` };
  }
  if (status.state === 'failed') return { tone: 'warning', text: status.reason ?? 'Earlier comments could not be moved yet.' };
  return null;
}

// ── who is here (canvas awareness) ─────────────────────────────────────────

export interface AwarenessPerson {
  /** The OrgIQ user id — what a call rings and what the byline keys on. */
  id: string;
  name: string;
  /** A CSS colour when the awareness carries one; the avatar computes its own otherwise. */
  color?: string;
  /** Yjs client ids for this person (one per open tab). */
  clientIds: number[];
}

const CSS_COLOR = /^(#[0-9a-f]{3,8}|rgb|hsl)/i;

/**
 * Everyone else on the canvas right now, one entry per person (several tabs
 * collapse), in the order they joined. The reader themself is left out: the
 * byline and the call are about the others.
 */
export function awarenessPeople(states: Iterable<[number, unknown]>, selfUserId: string): AwarenessPerson[] {
  const people = new Map<string, AwarenessPerson>();
  for (const [clientId, state] of states) {
    const user = (state as { user?: { id?: unknown; name?: unknown; color?: unknown } } | null)?.user;
    const id = typeof user?.id === 'string' ? user.id : '';
    if (!id || id === selfUserId) continue;
    const name = typeof user?.name === 'string' && user.name ? user.name : id;
    const color = typeof user?.color === 'string' && CSS_COLOR.test(user.color) ? user.color : undefined;
    const existing = people.get(id);
    if (existing) existing.clientIds.push(clientId);
    else people.set(id, { id, name, ...(color ? { color } : {}), clientIds: [clientId] });
  }
  return [...people.values()];
}

// ── the document's call ─────────────────────────────────────────────────────

const DOC_CALL_CHANNEL = 'assessment-document:';

/**
 * The call lobby for a document: tenant-prefixed like the initiative's
 * (`lobbyPrefix(tenant)` = `<tenant>:`, the BFF gateway's lobbyGuard), then
 * `doc:<doc>` — ONE lobby per document, so whoever calls, everyone on the page
 * joins the same platform-api session. The document part is the document's
 * chat channel suffix (`conversationChannelForDoc`), so long or non-slug ids
 * are hashed exactly as the conversation's are.
 */
export function documentCallLobby(prefix: string, conversationChannel: string): string {
  return `${prefix}doc:${conversationChannel.replace(/^assessment:doc:/, '')}`;
}

/** Rides the invite: the document's own URL, so the callee's Accept can open it from any page. */
export function documentCallChannel(href: string): string {
  return `${DOC_CALL_CHANNEL}${href}`;
}

/** The document URL a ring names — only an in-app assessment path, never an arbitrary URL. */
export function hrefFromCallChannel(channel: string | null | undefined): string | null {
  if (!channel || !channel.startsWith(DOC_CALL_CHANNEL)) return null;
  const href = channel.slice(DOC_CALL_CHANNEL.length);
  return /^\/assessment\/[a-z-]+\?doc=[^\s]+$/.test(href) ? href : null;
}
