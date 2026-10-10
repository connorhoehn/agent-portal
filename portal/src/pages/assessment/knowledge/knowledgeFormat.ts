// Pure derivations for the Knowledge Explorer — no React, no fetch.
//
// Ported behavior from agentic-assessment-accelerator's
// knowledge/{DocumentsExplorer,KnowledgeTree}.tsx and
// rules/RulesExplorer.tsx: which tree sections a mode shows, the default
// selection on load, the breadcrumb path for a node, the Views block counts,
// and the display-only markdown cleanup (frontmatter/title-heading strip).
// KnowledgeExplorer.tsx is the only caller; everything here is exercised
// directly by __tests__/knowledgeFormat.test.ts.

import { relativeTime } from '../../../lib/relativeTime.ts';
import { parsePgTimestamp } from '../../../lib/pgTimestamp.ts';
import type {
  ActivityRun,
  ActivityRunStatus,
  AssessmentSSEEvent,
  CommentListItem,
  KnowledgeMode,
  KnowledgeNode,
  KnowledgeSection,
  PresenceViewer,
} from './types';
import type { ActivityEvent, ChatMessage as RMChatMessage, Reaction } from '@connorhoehnslalom/realtime-modules/client';
import type { ReactionSummary } from '@connorhoehnslalom/ui-components/social';

// ─── Section selection ──────────────────────────────────────────────────────

// Keyed against what GET /api/assessment/knowledge/tree actually returns
// (middleware/src/mock/assessment.ts's knowledge-sections fixture and the Aurora
// provider's `section_key` rows agree on these four spellings — confirmed
// live via `curl .../knowledge/tree`: `enterprise_context`, `rules`,
// `prompts`, and the synced `confluence-eng` picked up separately by `kind`
// below). `enterprise` used to be spelled `enterprise` here, matching
// nothing the server ever sends, which hid all 10 of that section's nodes
// (6 real documents) behind an empty rail — see DEFECTS.md.
const SECTION_KEY_FOR_MODE: Record<Exclude<KnowledgeMode, 'workspace'>, string> = {
  enterprise: 'enterprise_context',
  rules: 'rules',
  prompts: 'prompts',
};

export const MODE_LABEL: Record<KnowledgeMode, string> = {
  workspace: 'Workspace',
  enterprise: 'Enterprise',
  rules: 'Rules',
  prompts: 'Prompts',
};

/**
 * Which tree sections a mode shows. Workspace is the synced space(s) — the
 * same `kind === 'synced'` filter the source's DocumentsExplorer used for
 * its own "workspace" mode; the other three modes are each one local
 * section, keyed to match (see docs/knowledge-library.md's tree shape).
 */
export function sectionsForMode(sections: KnowledgeSection[], mode: KnowledgeMode): KnowledgeSection[] {
  if (mode === 'workspace') return sections.filter((s) => s.kind === 'synced' || s.key === 'workspace_drafts');
  const key = SECTION_KEY_FOR_MODE[mode];
  return sections.filter((s) => s.key === key);
}

export function flatNodes(sections: KnowledgeSection[]): KnowledgeNode[] {
  return sections.flatMap((s) => s.nodes);
}

export function findNode(nodes: KnowledgeNode[], id: string | null): KnowledgeNode | null {
  if (!id) return null;
  return nodes.find((n) => n.id === id) ?? null;
}

/** `page:` nodes are synced pages; everything else is a local doc (or a
 *  content-less folder). Drives whether the activity bar renders at all. */
export function isPageNode(node: KnowledgeNode | null): boolean {
  return node?.id.startsWith('page:') ?? false;
}

/** A content-less folder: a real directory with nothing of its own to open —
 *  DocView renders a folder pane (its children) rather than fetching a doc. */
export function isFolderNode(node: KnowledgeNode | null): boolean {
  return Boolean(node?.is_dir && !node.page_id);
}

/**
 * Default selection once the tree loads: the first VIEWABLE leaf, falling
 * back to any leaf. Landing on a folder, or a leaf flagged `viewable: false`
 * (a hidden non-markdown binary), would open a pane with nothing to show.
 */
export function firstViewableLeaf(nodes: KnowledgeNode[]): KnowledgeNode | null {
  const leaves = nodes.filter((n) => !n.is_dir);
  return leaves.find((n) => n.viewable !== false) ?? leaves[0] ?? null;
}

/**
 * Root-to-node chain of ancestor nodes for the breadcrumb, walking
 * `parent_id`. Selecting a doc two folders deep yields
 * `[Organization, Tooling, <doc>]`, which the caller joins after
 * "Home › <Mode>" — plain "Home › Workspace › <doc>" when the doc has no
 * ancestors, same as the source's flat crumb.
 */
export function nodePath(nodes: KnowledgeNode[], id: string | null): KnowledgeNode[] {
  if (!id) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const path: KnowledgeNode[] = [];
  let current = byId.get(id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path;
}

// ─── The documents rail (DocumentRail.tsx) ─────────────────────────────────
// realtime-examples' Documents rail draws one tree with folders at its root.
// Here each source section is that folder, so its rows carry a synthetic id
// the move endpoints must never see: a drop onto a section's root is a move to
// `parentId: null` inside that section.

export const SECTION_FOLDER_PREFIX = 'section:';
export function sectionFolderId(sectionKey: string): string {
  return `${SECTION_FOLDER_PREFIX}${sectionKey}`;
}
export function sectionKeyOfFolder(id: string | null): string | null {
  return id?.startsWith(SECTION_FOLDER_PREFIX) ? id.slice(SECTION_FOLDER_PREFIX.length) : null;
}
/** The rail tree's drop parent → the parent the move endpoints take (null = the section root). */
export function moveParentForRail(targetParentId: string | null): string | null {
  return targetParentId === null || sectionKeyOfFolder(targetParentId) !== null ? null : targetParentId;
}
/**
 * The rail's drag model. `StackedRail` passes drag events through and leaves
 * what a drop means to the host, so the before / after / into decision the
 * old `TreeView` made lives here, with the same rules: the row's top third is
 * "before", its bottom third "after", the middle "into"; a drop never lands a
 * node inside itself or its own subtree; `into` appends as the last child.
 * Root pages carry their section's folder id as `parentId`, so a drop beside
 * one resolves to that folder and `moveParentForRail` maps it back to null.
 */
export type RailDropPosition = 'before' | 'after' | 'into';
export interface RailDragNode { id: string; parentId: string | null; isDir?: boolean }
export function railDropPosition(offsetY: number, height: number): RailDropPosition {
  return offsetY < height / 3 ? 'before' : offsetY > (height * 2) / 3 ? 'after' : 'into';
}
export function railReorderTarget(
  nodes: ReadonlyArray<RailDragNode>, draggedId: string, targetId: string, position: RailDropPosition,
): { parentId: string | null; position: number } | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const target = byId.get(targetId);
  if (!target || !byId.has(draggedId) || draggedId === targetId) return null;
  for (let at: RailDragNode | undefined = target; at?.parentId; at = byId.get(at.parentId)) {
    if (at.parentId === draggedId) return null;
  }
  if (position === 'into') {
    return { parentId: targetId, position: nodes.filter((node) => node.parentId === targetId && node.id !== draggedId).length };
  }
  const siblings = nodes.filter((node) => node.parentId === target.parentId && node.id !== draggedId).map((node) => node.id);
  const index = siblings.indexOf(targetId);
  return index === -1 ? null : { parentId: target.parentId, position: position === 'before' ? index : index + 1 };
}
/** Documents in a section — what its folder row counts ("Engineering Space 4"). */
export function sectionDocumentCount(section: KnowledgeSection): number {
  return section.nodes.filter((node) => !isFolderNode(node)).length;
}
/**
 * The rail's Recent view: the documents changed most recently, newest first.
 * Derived from the tree's own `updated_at`, so it is the same for every
 * viewer — the tree carries no per-person read history to do better.
 */
export function recentDocuments(sections: KnowledgeSection[], limit = 8): KnowledgeNode[] {
  return flatNodes(sections)
    .filter((node) => !isFolderNode(node) && node.viewable !== false && !!node.updated_at)
    .sort((a, b) => (Date.parse(b.updated_at!) || 0) - (Date.parse(a.updated_at!) || 0))
    .slice(0, limit);
}
/**
 * The rail's age column, the reference rail's shape: "now", "12m", "5h", "4d",
 * "3mo", "2y". Unlike `relativeTime` it never turns into a calendar date — a
 * 36px rail row has room for three characters.
 */
export function compactAge(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const then = parsePgTimestamp(iso);
  if (then === null) return '';
  const minutes = Math.max(0, Math.floor((now - then.getTime()) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
/** Upload: a Markdown file's first `# ` heading names the draft, else its file name. */
export function uploadTitle(fileName: string, markdown: string): string {
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(markdown)?.[1]?.trim();
  return (heading || fileName.replace(/\.(md|markdown|txt)$/i, '').trim() || 'Untitled').slice(0, 240);
}

export const CLASSIFICATION_LABEL: Record<string, string> = {
  reference: 'Reference',
  template: 'Template',
  guardrail: 'Guardrail',
  prompt: 'Prompt',
  synced: 'Synced',
};

// ─── The Enterprise rail's "Related" jump links ─────────────────────────────
// Presentation-only, ported from DocumentsExplorer's RELATED_LINKS — plain
// data here so it's the same list whether tested or rendered.

export interface RelatedLink {
  label: string;
  href: string;
}

export const RELATED_LINKS: RelatedLink[] = [
  { label: 'Workspace documents', href: '/assessment/workspace' },
  { label: 'Prompts', href: '/assessment/prompts' },
  { label: 'Rules', href: '/assessment/rules' },
  { label: 'Teams & org', href: '/assessment/teams' },
];

// ─── Views block counts ──────────────────────────────────────────────────────
//
// The assessment domain model (docs/assessment-tenant.md) has no Comment
// entity of its own — the source's confluence sync brought comment threads
// with it, and this port keeps the Views row + CommentListItem shape for
// structural parity, but KnowledgeExplorer always passes an empty list.
// Activity has a real backing entity (Run), so its count/filter do real work.

/** Runs whose command/summary mentions one of this section's node titles —
 *  the same best-effort text match the source's ActivityBar used per page,
 *  scoped here to a whole section since ActivityRun carries no page/doc id
 *  in either contract. */
export function activityForSection(section: KnowledgeSection, activity: ActivityRun[]): ActivityRun[] {
  const titles = section.nodes.map((n) => n.title.toLowerCase()).filter(Boolean);
  if (titles.length === 0) return [];
  return activity.filter((run) => {
    const haystack = `${run.command} ${run.summary}`.toLowerCase();
    return titles.some((t) => haystack.includes(t));
  });
}

/** Same match, scoped to one node — what the per-page activity bar shows. */
export function activityForNode(node: KnowledgeNode, activity: ActivityRun[]): ActivityRun[] {
  const needle = node.title.toLowerCase();
  if (!needle) return activity;
  return activity.filter((run) => `${run.command} ${run.summary}`.toLowerCase().includes(needle));
}

export interface ViewCounts {
  commentsCount: number;
  activityCount: number;
}

export function viewCounts(section: KnowledgeSection, comments: CommentListItem[], activity: ActivityRun[]): ViewCounts {
  const pageIds = new Set(section.nodes.map((n) => n.page_id).filter((id): id is string => Boolean(id)));
  return {
    commentsCount: comments.filter((c) => pageIds.has(c.page_id)).length,
    activityCount: activityForSection(section, activity).length,
  };
}

// ─── Runs -> activity feed ───────────────────────────────────────────────────

/**
 * Tolerant parse of GET /api/assessment/runs. The exact wire shape isn't
 * pinned down beyond the Run domain entity (docs/assessment-tenant.md) and
 * the mock backend lands from a separate task — accepts a bare array or
 * `{ runs: [...] }` and keeps only records that look like a run. A malformed
 * or not-yet-live response reads as no activity, never a crash.
 */
export function parseActivityRuns(raw: unknown): ActivityRun[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { runs?: unknown }).runs)
      ? (raw as { runs: unknown[] }).runs
      : [];

  const runs: ActivityRun[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.command !== 'string' || typeof r.started_at !== 'string') continue;
    const status: ActivityRunStatus = r.status === 'completed' || r.status === 'failed' ? r.status : 'running';
    const summary =
      typeof r.summary === 'string' ? r.summary : typeof r.team_id === 'string' ? `Team ${r.team_id}` : r.command;
    runs.push({
      id: r.id,
      command: r.command,
      status,
      started_at: r.started_at,
      finished_at: typeof r.finished_at === 'string' ? r.finished_at : null,
      summary,
    });
  }
  return runs;
}

export interface KnowledgeActivityItem {
  id: string;
  actor: string;
  action: string;
  subject: string;
  timeLabel: string;
  kind: string;
}

/** Maps runs onto the library ActivityFeed's item shape. */
export function toActivityFeedItems(runs: ActivityRun[]): KnowledgeActivityItem[] {
  return runs.map((r) => ({
    id: r.id,
    actor: 'Agent run',
    action: r.status === 'completed' ? 'completed' : r.status === 'failed' ? 'failed' : 'started',
    subject: `${r.command} — ${r.summary}`,
    timeLabel: relativeTime(r.started_at),
    kind: r.status === 'failed' ? 'status' : 'task',
  }));
}

// ─── Markdown display cleanup (ported from source markdownComponents.tsx) ───

/**
 * Strip a leading YAML frontmatter block for DISPLAY only (editing keeps the
 * full source) — raw `---`-fenced frontmatter isn't markdown; a plain
 * renderer turns the first key line into a giant setext heading, which reads
 * as broken output on every prompt/rule file.
 */
/**
 * Drops the language off ```json fences so the library's highlighter does not
 * run on them.
 *
 * `MarkdownView`'s JSON highlighter corrupts its own output. It makes two
 * sequential regex passes over the raw source (read from the installed dist,
 * 2.277.2, `shared-CSjbhJoV.js`):
 *
 *   pass 1  /("...")(\s*:)/  ->  <span style="color:PROPERTY">$1</span>$2
 *   pass 2  /("...")/         ->  <span style="color:STRING">$1</span>
 *
 * Pass 2's "quoted run" pattern matches the quoted ATTRIBUTE VALUE that pass 1
 * just wrote — the `"color:…"` it emitted is itself a quoted run — and wraps
 * it again. The result is nested, broken markup that renders at the reader as
 * the literal text `"color:…">"evidence_type"`. It fires on any JSON object
 * with a property, which is every JSON object, so this is not an edge case.
 * (The real colour values are in the library bundle and in the queue row; they
 * are spelled out here only as PROPERTY/STRING because a hex literal in a page
 * file fails the branding gate, whose budget is zero.)
 *
 * Losing the colour is much better than printing markup at the reader. The
 * same flaw is latent in the bash and comment-first highlighters (a `#`
 * comment's span has a quoted attribute too), but none of the documents here
 * carry a bash comment and those blocks render correctly, so this defuses
 * ONLY what is demonstrably broken rather than flattening every fence.
 *
 * Queued in docs/ui-components-queue.md; delete this the moment the
 * highlighter tokenises instead of chaining replaces.
 */
export function defuseJsonFences(markdown: string): string {
  // Only an opening fence at the start of a line, so a ```json appearing
  // inside an indented block or in prose is left alone.
  return markdown.replace(/^(\s*)```json\b/gm, '$1```');
}

export function stripFrontmatter(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return match ? markdown.slice(match[0].length).replace(/^\s+/, '') : markdown;
}

/** The pane header already shows the doc title — a body that opens with
 *  `# <title>` would render it twice. */
export function stripTitleHeading(markdown: string, title: string): string {
  const lines = markdown.split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first === -1) return markdown;
  const m = /^#\s+(.+?)\s*$/.exec(lines[first]);
  if (m && m[1].trim().toLowerCase() === title.trim().toLowerCase()) {
    return [...lines.slice(0, first), ...lines.slice(first + 1)].join('\n').replace(/^\s*\n/, '');
  }
  return markdown;
}

// ─── Realtime — channel names, SSE/channel feed merging, reaction summaries ─
//
// Everything below is what KnowledgeExplorer/DocPane need to wire the
// realtime-modules hooks and ui-components' realtime-modules integrations
// without hand-rolling: which channel a doc or section lives on, folding
// GET /api/assessment/events (server-originated) and a channel's own
// useActivity feed (peer-originated) into the single list WrappedActivityPanel
// renders, and turning raw useReactions() events into the aggregated
// {emoji,count,mine} shape ReactionsBar wants.

/** One document's realtime channel — presence/activity/chat/reactions all
 *  scope to this, per docs/assessment-tenant.md's Workspace realtime plan. */
export function channelForDoc(docId: string): string {
  return `assessment:doc:${docId}`;
}

/**
 * The document's conversation on the BFF gateway (the composer dock and the
 * Chat panel). The chat service caps a channel name at 50 characters, which a
 * `draft:<uuid>` id overflows, so a long or non-slug id is hashed — the same
 * rule realtime-examples' `roomFeedChannel` applies to long lobby names. A
 * silently truncated name would read and post into somebody else's thread.
 */
export const CHAT_CHANNEL_MAX = 50;
export function conversationChannelForDoc(docId: string): string {
  const plain = channelForDoc(docId);
  if (plain.length <= CHAT_CHANNEL_MAX && /^[A-Za-z0-9:_-]+$/.test(plain)) return plain;
  // cyrb53: a 53-bit string hash, stable across browsers and sessions.
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < docId.length; i++) {
    const ch = docId.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `assessment:doc:h:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/** A presence roster as `PresenceAvatars` users — the rail's per-source "who is here". */
export function presenceAvatarUsers(roster: ReadonlyArray<{ clientId: string; status?: string; metadata?: Record<string, unknown> }>): Array<{ id: string; name: string; idle?: boolean; avatarUrl?: string }> {
  // One avatar per PERSON, not per connection (re-audit #16, 2026-09-29: a
  // reader with two tabs showed twice). Keyed by the presence metadata's
  // userId when the gateway stamped one, else by the connection; a person
  // reads idle only when every one of their connections is.
  const byUser = new Map<string, { id: string; name: string; idle: boolean; avatarUrl?: string }>();
  for (const entry of roster) {
    const meta = entry.metadata ?? {};
    const userId = typeof meta['userId'] === 'string' && meta['userId'].length > 0 ? meta['userId'] : entry.clientId;
    const name = [meta['displayName'], meta['name'], meta['userId']].find((value): value is string => typeof value === 'string' && value.length > 0);
    const idle = !!entry.status && entry.status !== 'online';
    // The gateway stamps the signed token's avatar on the entry; absent → initials.
    const avatarUrl = typeof meta['avatarUrl'] === 'string' && meta['avatarUrl'].length > 0 ? meta['avatarUrl'] : undefined;
    const seen = byUser.get(userId);
    if (seen) { seen.idle = seen.idle && idle; seen.avatarUrl ??= avatarUrl; }
    else byUser.set(userId, { id: userId, name: name ?? 'Someone', idle, ...(avatarUrl ? { avatarUrl } : {}) });
  }
  return [...byUser.values()].map(({ id, name, idle, avatarUrl }) => ({ id, name, ...(idle ? { idle: true } : {}), ...(avatarUrl ? { avatarUrl } : {}) }));
}

/** One tree section's realtime channel — just a presence headcount
 *  ("N viewing") on the section's rail header. */
export function channelForSection(sectionKey: string): string {
  return `assessment:knowledge:${sectionKey}`;
}

/**
 * Adapts one server-sent AssessmentSSEEvent onto the same ActivityEvent
 * shape a channel's useActivity() hook already returns, so the two sources
 * can be merged and handed to WrappedActivityPanel as one feed. `by` (or
 * `dispatched_by`-style actor fields the union carries under `by`) becomes
 * both userId and a human displayName; system-originated events (no actor)
 * read as "System".
 */
export function sseEventToActivityEvent(e: AssessmentSSEEvent): ActivityEvent {
  const { type, ts, ...rest } = e;
  const actor = 'by' in rest && typeof rest.by === 'string' ? rest.by : null;
  return { eventType: type, detail: rest as Record<string, unknown>, timestamp: ts, userId: actor, displayName: actor ?? 'System' };
}

/** Stable de-dupe key for one ActivityEvent — used by mergeFeeds since
 *  ActivityEvent itself carries no id. Timestamp + eventType + actor is
 *  specific enough for two sources that never legitimately double-publish
 *  the same fact at the same instant. */
function activityEventKey(e: ActivityEvent): string {
  return `${e.timestamp}|${e.eventType}|${e.userId ?? ''}`;
}

/**
 * Folds the SSE-derived feed and a channel's peer activity feed into one
 * list, de-duped and newest-first — what WrappedActivityPanel is handed.
 */
export function mergeFeeds(sseEvents: ActivityEvent[], channelEvents: ActivityEvent[]): ActivityEvent[] {
  const seen = new Set<string>();
  const merged: ActivityEvent[] = [];
  for (const e of [...sseEvents, ...channelEvents]) {
    const key = activityEventKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return merged;
}

/** SSE events relevant to one document's activity bar: saves/publishes of
 *  that doc, comments on it, or a pull of the section it belongs to (a
 *  synced page's own history includes "the space was re-synced"). */
export function sseEventsForDoc(events: AssessmentSSEEvent[], docId: string, sectionKey: string | null): AssessmentSSEEvent[] {
  return events.filter((e) => {
    if (e.type === 'knowledge.doc.saved' || e.type === 'knowledge.published') return e.id === docId;
    if (e.type === 'knowledge.comment.created') return e.doc_id === docId;
    if (e.type === 'knowledge.pulled') return sectionKey !== null && e.section === sectionKey;
    return false;
  });
}

/** SSE knowledge.pulled events for one section — feeds the section's
 *  Pull-button pending state (cleared once a matching event arrives) and
 *  the Views-block Activity row. */
export function pulledEventsForSection(events: AssessmentSSEEvent[], sectionKey: string): Extract<AssessmentSSEEvent, { type: 'knowledge.pulled' }>[] {
  return events.filter((e): e is Extract<AssessmentSSEEvent, { type: 'knowledge.pulled' }> => e.type === 'knowledge.pulled' && e.section === sectionKey);
}

/** Which section (if any) a node belongs to — ActivityBar needs the
 *  section key to also pick up that section's pull events. */
export function sectionForNode(sections: KnowledgeSection[], nodeId: string): KnowledgeSection | null {
  return sections.find((s) => s.nodes.some((n) => n.id === nodeId)) ?? null;
}

/**
 * Aggregates useReactions()'s raw per-click Reaction[] into the
 * {emoji,count,mine} shape ReactionsBar expects, scoped to one target
 * (a document). `mine` is true when the current viewer (by clientId) is
 * one of the reactors, driving ReactionsBar's toggle-off affordance.
 */
/** One durable reaction row, as GET /knowledge/doc/reactions sends it. */
export interface StoredReaction {
  target_id: string;
  emoji: string;
  actor: string;
  created_at: string;
}

/**
 * The same {emoji,count,mine} shape, from the DURABLE rows rather than the
 * gateway's per-click stream.
 *
 * Two differences from `summarizeReactions` below, both load-bearing. Identity
 * is the session `sub`, not a gateway clientId — a clientId identifies a
 * CONNECTION and changes on reconnect, so "mine" computed from it stops being
 * mine, and offline there is no clientId at all. And the store holds one row
 * per (target, emoji, actor), so a count is a count of PEOPLE; the gateway
 * stream is per click and has to be de-duplicated to mean the same thing.
 */
export function summarizeStoredReactions(
  rows: StoredReaction[], targetId: string, mySub: string | null,
): ReactionSummary[] {
  const byEmoji = new Map<string, { count: number; mine: boolean }>();
  for (const r of rows) {
    if (r.target_id !== targetId) continue;
    const entry = byEmoji.get(r.emoji) ?? { count: 0, mine: false };
    entry.count += 1;
    if (mySub !== null && r.actor === mySub) entry.mine = true;
    byEmoji.set(r.emoji, entry);
  }
  return [...byEmoji.entries()].map(([emoji, { count, mine }]) => ({ emoji, count, mine }));
}

export function summarizeReactions(reactions: Reaction[], targetId: string, currentClientId: string | null): ReactionSummary[] {
  const byEmoji = new Map<string, { count: number; mine: boolean }>();
  for (const r of reactions) {
    if (r.targetId !== targetId) continue;
    const entry = byEmoji.get(r.emoji) ?? { count: 0, mine: false };
    entry.count += 1;
    if (currentClientId !== null && r.clientId === currentClientId) entry.mine = true;
    byEmoji.set(r.emoji, entry);
  }
  return [...byEmoji.entries()].map(([emoji, { count, mine }]) => ({ emoji, count, mine }));
}

// ─── ui-components/social adapters ──────────────────────────────────────────
//
// The library's realtime-modules integrations subpath (the
// WrappedChatPanel/WrappedActivityPanel/WrappedPresencePanel/
// WrappedConnectionPill/RealtimeCapabilityProvider/ReconnectingShim we would
// otherwise use here) statically imports CanvasDocumentView, which statically
// imports TiptapEditor, which imports `@tiptap/react` — an optional peer this
// portal doesn't install. Vite's dev server papers over the missing peer;
// `vite build` cannot, and fails on every single named export of that
// subpath, confirmed by isolating each one. So DocPane/ActivityBar/
// KnowledgeExplorer are built on the corresponding PLAIN primitives
// (`ChatPanel`, `ActivityFeed`, `PresenceAvatars` via PresenceAvatarGroup,
// `ConnectionPill` — none of which reach Tiptap) plus these two adapters,
// which reproduce the wrapper's own adaptation logic by hand.


const ACTIVITY_EVENT_LABEL: Record<string, string> = {
  'knowledge.pulled': 'synced',
  'knowledge.published': 'published',
  'knowledge.doc.saved': 'saved',
  'knowledge.comment.created': 'commented',
  'run.started': 'started a run',
  'run.progress': 'is running',
  'run.completed': 'completed a run',
  'run.failed': 'failed',
};

/** Merged ActivityEvent (SSE-derived or channel-native) -> the
 *  {id,actor,action,subject,timeLabel,kind} shape ActivityFeed renders —
 *  same target shape as toActivityFeedItems, just fed from the realtime
 *  merge instead of the /runs snapshot. */
export function activityEventToFeedItem(e: ActivityEvent): KnowledgeActivityItem {
  const detail = e.detail as Record<string, unknown>;
  const subject =
    e.eventType === 'knowledge.pulled' ? `${detail['files_pulled'] ?? '?'} of ${detail['pages'] ?? '?'} pages`
    : e.eventType === 'knowledge.comment.created' ? String(detail['body'] ?? '')
    : e.eventType === 'run.progress' ? `${detail['command'] ?? ''} — ${detail['percent'] ?? 0}%`
    : String(detail['command'] ?? detail['summary'] ?? detail['reason'] ?? '');
  return {
    id: `${e.timestamp}|${e.eventType}|${e.userId ?? ''}`,
    actor: e.displayName || 'System',
    action: ACTIVITY_EVENT_LABEL[e.eventType] ?? e.eventType,
    subject,
    timeLabel: relativeTime(e.timestamp),
    kind: e.eventType === 'run.failed' ? 'status' : e.eventType.startsWith('run.') ? 'task' : 'status',
  };
}

// ─── Realtime-over-SSE — the BFF path that works without the gateway ───────
//
// docs/assessment-journeys/stretch/realtime.md found that presence, live
// edit propagation and comments all fail between two tabs because
// VITE_GATEWAY_URL points at middleware's /ws stub (accepts the socket,
// implements no protocol). Everything below makes those three surfaces
// honest on top of GET /api/assessment/events instead — the gateway is
// still consulted and merged in when it IS live, but nothing here depends
// on it.

// ─── Doc-saved / "who changed this" notice ─────────────────────────────────

export interface ExternalSaveNotice {
  by: string;
  ts: string;
}

/**
 * This tab's own-save bookkeeping — what `externalDocSave` needs in order to
 * tell "another tab/user saved this doc" apart from "the SSE broadcast of MY
 * OWN save came back over the wire" (every subscriber gets that broadcast,
 * sender included).
 *
 * Previously this was a single `ignoreUpToTs: string | null` compared AFTER
 * the fact against each event's `ts`. That loses a real race:
 * putKnowledgeDoc/restoreKnowledgeDocVersion (providers/assessment.ts)
 * publish to the broker BEFORE the PUT/restore handler returns, so the SSE
 * frame carrying this tab's own save can reach the client before `putJson`'s
 * response does — and at that instant `ignoreUpToTs` is still null (or an
 * older ts), so the event reads as external and a notice gets shown that a
 * *later* update to `ignoreUpToTs` can never retract (the old code kept a
 * "seen" ref keyed on that same ts, so it never re-examined the event once
 * flagged). A single before/after comparison can only be right for whichever
 * of the two orderings it was written for.
 *
 * The fix is to stop comparing order at all: track the save's IDENTITY (the
 * exact `ts` a confirmed-own save carries, as a membership set rather than a
 * cutoff) plus an explicit in-flight flag covering the window before that
 * identity is even known yet. Both are order-independent, so recomputing
 * this function after either piece of state updates — including well after
 * a notice was first shown — naturally reconciles: an event that used to
 * read as external and no longer does simply stops appearing, retracting
 * whatever was shown for it.
 */
export interface OwnSaveState {
  /** Every `ts` (== the PUT/restore response's `updated_at`) this tab has
   *  CONFIRMED as its own save/restore for this doc. A set, not a cutoff, so
   *  it only ever grows — restoring or reselecting this doc later (a
   *  "reload" of the pane's own React state) can't forget an entry the way
   *  a single `ignoreUpToTs` reset to null would, which is what let a stale
   *  echo of your own earlier save reappear as "someone else changed this"
   *  after navigating away and back. */
  confirmedTimestamps: ReadonlySet<string>;
  /** True for the whole span between issuing this tab's own save/restore
   *  request and its response resolving (set BEFORE the `fetch`, cleared in
   *  a `finally`). Covers the frame-before-response race: at that moment the
   *  ts isn't in `confirmedTimestamps` yet, but the event still isn't
   *  external — it's this exact in-flight request's own echo arriving
   *  early. */
  saveInFlight: boolean;
}

/**
 * The newest `knowledge.doc.saved` for `docId` this tab did not cause. See
 * `OwnSaveState` for why membership + an in-flight flag replace a single
 * before/after timestamp comparison.
 */
export function externalDocSave(
  events: AssessmentSSEEvent[], docId: string, own: OwnSaveState,
): ExternalSaveNotice | null {
  let latest: ExternalSaveNotice | null = null;
  for (const e of events) {
    if (e.type !== 'knowledge.doc.saved' || e.id !== docId) continue;
    if (own.confirmedTimestamps.has(e.ts)) continue;
    if (own.saveInFlight) continue;
    if (!latest || e.ts > latest.ts) latest = { by: e.by, ts: e.ts };
  }
  return latest;
}

/** "Updated by <who> <age>" — `by` is the acting user's sub; this port has no
 *  user directory to resolve a display name from here, so the sub is shown
 *  as-is (matches how `by` is already surfaced elsewhere, e.g. the activity
 *  feed's actor field). `ts` is the save's own event timestamp, rendered
 *  through `relativeTime` rather than a hardcoded "just now" — DEFECTS #5
 *  (assessor) / #8 (lead-assessor) / #7 (program-lead, admin): a save from
 *  101 minutes ago replayed into a fresh tab was still being announced as
 *  "just now" regardless of its actual age. */
export function docSavedNoticeText(by: string, ts: string): string {
  return `Updated by ${by} ${relativeTime(ts)}`;
}

// ─── Comments over SSE ──────────────────────────────────────────────────────

export interface KnowledgeCommentItem {
  id: string;
  parentId?: string;
  clientId: string;
  /**
   * The authenticated author. Distinct from `clientId`, which identifies a
   * CONNECTION — ChatPanel's own doc is explicit that "is this mine" keys on
   * `userId` and never on `clientId`, "otherwise your own messages stop being
   * yours partway up the thread". Without it the panel cannot tell which
   * comments are the viewer's, so it offers edit and delete on none of them.
   */
  userId?: string;
  content: string;
  timestamp: string;
  displayName?: string;
  /** ISO — the author changed the text. ChatPanel renders "(edited)". */
  editedAt?: string;
  /**
   * ISO — the author removed it. ChatPanel keeps the row in place and says so,
   * which is why this is a soft delete: a hole in a thread other people are
   * part-way through reading is worse than a tombstone.
   */
  deletedAt?: string;
}

/** One doc's `knowledge.comment.created` events, in arrival order — the
 *  server-side echo of POST /knowledge/doc/comment. Every SSE subscriber
 *  gets this broadcast, sender included, which is what lets the sender see
 *  their own comment: the gateway chat channel never echoes at all (the
 *  stub implements no chat protocol), so without this the drawer stayed
 *  "No messages yet" even right after a successful send. */
export function commentsForDoc(events: AssessmentSSEEvent[], docId: string): KnowledgeCommentItem[] {
  return events
    .filter((e): e is Extract<AssessmentSSEEvent, { type: 'knowledge.comment.created' }> =>
      e.type === 'knowledge.comment.created' && e.doc_id === docId)
    .map((e) => ({ id: e.id, clientId: e.by, userId: e.by, content: e.body, timestamp: e.ts, displayName: e.by,
      ...(e.parent_id ? { parentId: e.parent_id } : {}),
    }));
}

/** Resolve quotes from the current document, never a stale copy of deleted text. */
export function commentQuote(comments: KnowledgeCommentItem[], parentId: string) {
  const parent = comments.find((comment) => comment.id === parentId);
  return {
    messageId: parentId,
    author: parent?.displayName ?? parent?.userId ?? 'Comment',
    ...(parent ? { timestamp: parent.timestamp } : {}),
    text: !parent ? 'Original comment unavailable.' : parent.deletedAt ? 'This comment was deleted.' : parent.content,
  };
}

/** Replayed events must not overwrite a newer durable edit or resurrect a tombstone. */
export function applyCommentUpdates(comments: KnowledgeCommentItem[], events: AssessmentSSEEvent[], docId: string): KnowledgeCommentItem[] {
  const byId = new Map(comments.map((comment) => [comment.id, { ...comment }]));
  for (const event of events) {
    if ((event.type !== 'knowledge.comment.edited' && event.type !== 'knowledge.comment.deleted') || event.doc_id !== docId) continue;
    const comment = byId.get(event.id);
    if (!comment) continue;
    if (event.type === 'knowledge.comment.deleted') {
      if (!comment.deletedAt || Date.parse(event.ts) > Date.parse(comment.deletedAt)) comment.deletedAt = event.ts;
    } else if (!comment.deletedAt && Date.parse(event.ts) >= Date.parse(comment.editedAt ?? comment.timestamp)) {
      comment.content = event.body;
      comment.editedAt = event.ts;
    }
  }
  return [...byId.values()];
}

/** Keep observed writes when the bounded event feed rolls over or a stale GET lands. */
export function retainCommentUpdates(previous: KnowledgeCommentItem[], incoming: KnowledgeCommentItem[]): KnowledgeCommentItem[] {
  const rows = new Map(previous.map((comment) => [comment.id, comment]));
  for (const comment of incoming) {
    const prior = rows.get(comment.id);
    const merged = { ...comment };
    if (prior?.editedAt && Date.parse(prior.editedAt) > Date.parse(comment.editedAt ?? comment.timestamp)) {
      merged.content = prior.content;
      merged.editedAt = prior.editedAt;
    }
    if (prior?.deletedAt && (!comment.deletedAt || Date.parse(prior.deletedAt) > Date.parse(comment.deletedAt))) merged.deletedAt = prior.deletedAt;
    if (prior?.parentId) merged.parentId = prior.parentId;
    rows.set(comment.id, merged);
  }
  return [...rows.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// Older clients and optional gateway peers can still deliver a separate
// channel message for a durable comment. New posts use only the BFF + SSE.
// Retain the legacy cross-source window for those unrelated gateway IDs.
const COMMENT_DEDUPE_WINDOW_MS = 15_000;

/**
 * Fold the DURABLE thread in under the live ones.
 *
 * `GET /knowledge/doc/comments` is the authoritative list — it survives a
 * reload, which neither the SSE echoes (this session only) nor the gateway
 * channel (offline here) do. It goes first so a reader sees the real thread,
 * and the live sources are merged on top for anything that has arrived since
 * the fetch.
 *
 * Dedupe is by ID and exact, unlike `mergeComments`'s content+time window: a
 * stored comment and its own SSE echo now carry the SAME id, because the
 * provider mints one and uses it for both the row and the event. The window
 * heuristic is still needed for the CHANNEL, whose ids come from a different
 * namespace entirely.
 */
export function withStoredComments(
  stored: KnowledgeCommentItem[], live: KnowledgeCommentItem[],
): KnowledgeCommentItem[] {
  const seen = new Set(stored.map((c) => c.id));
  const merged = [...stored, ...live.filter((c) => !seen.has(c.id))];
  merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return merged;
}

export function mergeComments(
  sseComments: KnowledgeCommentItem[], channelMessages: KnowledgeCommentItem[],
): KnowledgeCommentItem[] {
  const merged: KnowledgeCommentItem[] = [...sseComments];
  for (const c of channelMessages) {
    const cTs = Date.parse(c.timestamp);
    const dupe = sseComments.some((s) => {
      if (s.content !== c.content) return false;
      const sTs = Date.parse(s.timestamp);
      if (Number.isNaN(cTs) || Number.isNaN(sTs)) return s.timestamp === c.timestamp;
      return Math.abs(sTs - cTs) <= COMMENT_DEDUPE_WINDOW_MS;
    });
    if (!dupe) merged.push(c);
  }
  merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return merged;
}

// ─── Presence over SSE ──────────────────────────────────────────────────────

/** The most recent `knowledge.presence` roster for `docId` in the shared SSE
 *  event list — the broker publishes the FULL current roster on every
 *  change, so the latest one is authoritative; earlier ones are stale. */
export function latestPresenceForDoc(events: AssessmentSSEEvent[], docId: string): PresenceViewer[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'knowledge.presence' && e.doc_id === docId) return e.viewers;
  }
  return [];
}

export interface MergedPresenceUser {
  id: string;
  name: string;
  detail?: string;
}

/**
 * Collapses same-`sub` viewers into ONE avatar rather than showing the same
 * person twice — the two-tab proof's exact scenario (one signed-in user,
 * two tabs on the same doc). Decision: merge to one entry with a "×N" name
 * suffix and an "N tabs open" detail line, not two separate avatars.
 */
export function mergeSsePresence(viewers: PresenceViewer[]): MergedPresenceUser[] {
  const bySub = new Map<string, { name: string; tabIds: Set<string> }>();
  for (const v of viewers) {
    const entry = bySub.get(v.sub) ?? { name: v.name, tabIds: new Set<string>() };
    entry.tabIds.add(v.tab_id);
    if (v.name) entry.name = v.name;
    bySub.set(v.sub, entry);
  }
  return [...bySub.entries()]
    .map(([sub, e]) => ({
      id: sub,
      name: e.tabIds.size > 1 ? `${e.name} ×${e.tabIds.size}` : e.name,
      detail: e.tabIds.size > 1 ? `${e.tabIds.size} tabs open` : undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ChannelPresencePeer {
  clientId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Merges the SSE-derived roster with the gateway channel's own presence
 * roster. When a real gateway is live, DocPane announces itself over BOTH
 * paths (the SSE presence route AND the channel's `presence.updateMetadata`,
 * stamping `metadata.sub` with the session sub) — so the same human shows up
 * in both `sseViewers` and `channelPeers`. A channel peer whose
 * `metadata.sub` matches an SSE viewer's `sub` is folded into that same
 * entry (counted as one more open tab, not a second person); a channel peer
 * with no matching sub — a real peer on the channel this app's SSE route
 * never heard from, or a bare gateway connection that never announced —
 * renders as its own entry keyed by `clientId`. With no gateway connected,
 * `channelPeers` is empty and this is identical to `mergeSsePresence` alone.
 */
export function mergePresenceForDisplay(
  sseViewers: PresenceViewer[], channelPeers: ChannelPresencePeer[],
): MergedPresenceUser[] {
  const bySub = new Map<string, { name: string; tabIds: Set<string> }>();
  for (const v of sseViewers) {
    const entry = bySub.get(v.sub) ?? { name: v.name, tabIds: new Set<string>() };
    entry.tabIds.add(`sse:${v.tab_id}`);
    if (v.name) entry.name = v.name;
    bySub.set(v.sub, entry);
  }

  const unmatched: MergedPresenceUser[] = [];
  for (const p of channelPeers) {
    const sub = typeof p.metadata?.['sub'] === 'string' ? (p.metadata['sub'] as string) : null;
    const displayName = typeof p.metadata?.['displayName'] === 'string' ? (p.metadata['displayName'] as string) : null;
    if (sub) {
      const entry = bySub.get(sub) ?? { name: displayName ?? sub, tabIds: new Set<string>() };
      entry.tabIds.add(`gw:${p.clientId}`);
      bySub.set(sub, entry);
      continue;
    }
    unmatched.push({ id: p.clientId, name: displayName ?? p.clientId.slice(0, 8) });
  }

  const fromSubs = [...bySub.entries()].map(([sub, e]) => ({
    id: sub,
    name: e.tabIds.size > 1 ? `${e.name} ×${e.tabIds.size}` : e.name,
    detail: e.tabIds.size > 1 ? `${e.tabIds.size} tabs open` : undefined,
  }));
  return [...fromSubs, ...unmatched].sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Honest connection state ─────────────────────────────────────────────────

export type LiveConnectionState = 'connected' | 'connecting';

/** The pill's displayed state, driven by the SSE stream — the substrate
 *  that actually carries doc-saved/comment/presence updates with no
 *  gateway involved. `gateway.connectionState` is not a trustworthy "is
 *  anything real happening" signal: middleware's /ws stub accepts every
 *  socket and reports 'connected' forever without implementing any
 *  protocol (see docs/assessment-journeys/stretch/realtime.md). */
export function liveConnectionState(sseConnected: boolean): LiveConnectionState {
  return sseConnected ? 'connected' : 'connecting';
}

/**
 * Whether the realtime-modules gateway has done more than accept a raw
 * socket upgrade. `clientId` is only ever set once the gateway sends its
 * `{ type: 'session', clientId, ... }` handshake frame — the one signal
 * a stub that "accepts the connection and does nothing" can never
 * produce, unlike `connectionState`, which such a stub happily reports as
 * 'connected' forever (confirmed against realtime-modules' useWebSocket:
 * connectionState flips to 'connected' on the raw `onopen`, before any
 * application-level handshake).
 */
export function isGatewayReady(connectionState: string, clientId: string | null): boolean {
  return connectionState === 'connected' && clientId !== null;
}

/** The pill's secondary hint — null when the gateway is genuinely live. */
export function gatewayOfflineHint(gatewayReady: boolean): string | null {
  return gatewayReady ? null : 'Gateway offline — presence and co-editing via the BFF';
}

// ─── Editor save gate (docs/assessment-journeys/stretch/realtime.md) ───────
//
// useCRDT (realtime-modules) only wires its Y.Text observer — the thing that
// makes `crdt.content` ever change — inside the effect that requires
// `connectionState === 'connected'`. While the transport is `reconnecting`
// or `disconnected` that effect never runs: `crdt.content` is frozen at its
// initial `''`, `applyLocalEdit` mutates a Y.Doc nobody is reading, and a
// textarea bound to `value={crdt.content}` renders permanently blank and
// rejects every keystroke — on a document that may have 326 characters of
// real content. Saving `crdt.content` in that state posts `""` with a 200.
//
// The fix is not to patch useCRDT (a vendored library, not owned here) but
// to stop trusting it as the editor's only content source when it cannot
// possibly be right, and to gate Save on a real "was this content ever
// actually loaded" question rather than on the transport alone.

/** Coarse view of the CRDT transport for gating purposes — collapses
 *  realtime-modules' five-state `ConnectionState` down to the one
 *  distinction that matters here: is `crdt.content` trustworthy right now? */
export type DocSyncStatus = 'synced' | 'reconnecting' | 'disconnected';

/** `isGatewayReady` already answers "is the CRDT content trustworthy" —
 *  this just names the two ways it can be untrustworthy so the UI and the
 *  save gate can say which one applies. */
export function docSyncStatus(connectionState: string, clientId: string | null): DocSyncStatus {
  if (isGatewayReady(connectionState, clientId)) return 'synced';
  return connectionState === 'reconnecting' ? 'reconnecting' : 'disconnected';
}

export interface DocSaveGateInput {
  /** The CRDT transport's state for this doc's channel. */
  status: DocSyncStatus;
  /** Whether the HTTP-fetched document (the `GET .../knowledge/doc` this
   *  page already did) has non-empty markdown to seed a fallback editor
   *  from. Irrelevant when `status` is 'synced' — the CRDT content is then
   *  authoritative, including a genuinely empty document. */
  hasSeed: boolean;
}

export interface DocSaveGate {
  allowed: boolean;
  /** A one-line, user-facing reason. Present only when `allowed` is false. */
  reason?: string;
}

/**
 * The one question a save must answer before it is allowed to reach the
 * server: did the editor ever actually show the user real content, or is it
 * possible this is an uninitialized editor about to overwrite a real
 * document with an empty string it never loaded?
 *
 * - `synced` always passes, INCLUDING an empty `crdt.content` — that is a
 *   real, observed state (the CRDT genuinely synced to an empty document,
 *   or the user deliberately cleared it), not an editor that never loaded.
 * - Off-sync (`reconnecting`/`disconnected`) passes only when a non-empty
 *   HTTP fallback exists to edit against instead of the CRDT. Off-sync with
 *   no fallback means nothing has ever loaded into the editor — refuse.
 */
export function decideDocSaveGate({ status, hasSeed }: DocSaveGateInput): DocSaveGate {
  if (status === 'synced' || hasSeed) return { allowed: true };
  return {
    allowed: false,
    reason: status === 'reconnecting'
      ? 'Save is unavailable — the realtime session is still reconnecting and this document has no offline copy loaded to save.'
      : 'Save is unavailable — the realtime session is disconnected and this document has no offline copy loaded to save.',
  };
}
