// A person's shared work, as one viewer may see it (docs/communication-plane-goal.md §3):
// the owner's own work-graph subject (`/api/work-graph/people/:id/graph`'s builder,
// run under the OWNER's directory authority — the owner shares what they can
// see), filtered with realtime-modules' `filterForViewer` against
//   - the owner's sharing grants whose audience reaches the viewer NOW (a
//     conversation the viewer belongs to, a Social team the viewer is on),
//   - the implicit grant: work the owner has referenced into a conversation
//     the viewer is a member of (a message's `metadata.pageReference` naming
//     the owner's initiative or work item).
// The owner sees everything of their own. A viewer with no grant and no shared
// conversation gets an EMPTY graph (200) — never a 403 that says the owner has
// work — and an unknown or unlinked owner reads the same way. Nothing here
// widens: the viewer's audience memberships come from the directory and the
// chat/platform stores, never from the request.

import {
  validateWorkGraphSnapshot, validateWorkGraphSnapshotV2, workDayWindow, type WorkGraphSnapshot, type WorkGraphSnapshotV2, type WorkSharingGrant,
} from '@connorhoehn/realtime-modules/work-graph';
import type { FileUploadRow } from '@connorhoehn/realtime-modules/fileupload';
import { clock } from '../../mock/core/index.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { AppError } from '../async-handler.js';
import { canonicalCallPage } from '../call-pages.js';
import { readableUploads } from '../gateway-attachments.js';
import { sessionGatewayContext } from '../live-principal.js';
import { ROLES_BY_TENANT, type Session } from '../session.js';
import { dmMembers, socialChat } from '../social-chat.js';
import { dmPageDescriptor } from '../dm-page-references.js';
import { buildViewerWorkGraph } from './build.js';
import { nodeIdFor } from './projection.js';
import { loadViewerConversations } from './social-sources.js';
import { effectiveSharingFor, filterSharedWork, sharingSummary, workSharingStore, WORK_SHARING_ORG, type EffectiveSharing, type SharingViewerContext, type StoredWorkSharing } from './sharing.js';
import { workGraphCursor, type WorkGraphQuery } from './snapshot.js';

type Snapshot = WorkGraphSnapshot | WorkGraphSnapshotV2;

/**
 * The subject key the reply is scoped to: the REQUEST's — `shared-work:<userId>`,
 * what the portal's reader (`lib/workGraph.ts` `workGraphSubjectKey`) keys its
 * snapshot on, so the client never re-keys a `person:` scope into it. The
 * owner's own graph is built under `person:<personId>` and re-scoped here;
 * one contract, decided on the server.
 */
export const sharedWorkSubjectKey = (ownerUserId: string): string => `shared-work:${ownerUserId}`;

export interface SharedWorkGrantView {
  id: string;
  state: StoredWorkSharing['grant']['state'];
  kind: 'current' | 'history';
  audience: StoredWorkSharing['audience'];
  nodeIds: string[];
  disclosure: StoredWorkSharing['grant']['selection']['disclosure'];
  revision: number;
  updatedAt: string;
  expiresAt: string;
  historyGrantId?: string;
  dayFrom?: string;
  dayThrough?: string;
}

export interface SharedWork {
  /** The person graph's shape (the library `WorkGraph` renders it), holding only what this viewer may see. */
  snapshot: Snapshot;
  sharing: {
    /** `owner`: everything; `audience`: through grants/references; `none`: nothing reached this viewer. */
    viewer: 'owner' | 'audience' | 'none';
    state: 'active' | 'historical' | null;
    fresh: boolean;
    /** Node id → how it reached the viewer (owner: absent). */
    provenance: Record<string, 'active' | 'historical' | 'referenced'>;
    /** The owner's grants (every one for the owner; the ones that reach this viewer otherwise). */
    grants: SharedWorkGrantView[];
    /** Conversations the implicit rule drew from (ids the viewer is in). */
    referencedIn: string[];
  };
  /** The same disclosure as a flat list: one row per node the viewer may see, with how and where it reached them. */
  items: SharedWorkItem[];
}

// ── The ONE shared-work notion (docs/audit/2026-10-07-audit-plan.md D6) ──────
//
// Sharing grants, page references posted into a conversation, deck shares and
// file attachments are all "work shared between people". Seven derivations
// used to exist (two reference resolvers, the uploads list, the deck share, the
// bindings, the portal's own list and this graph). They are now one model and
// one resolver, folded through the VIEWER's authority:
//
//   SharedWorkItem { kind, id, title, status, href, sharedBy, sharedInto, at, authority, provenance, ref }
//
//   kind        initiative | work-item (a page reference), work-node (a sharing grant's node),
//               deck (a deck posted with its file), file (an attachment)
//   title       null when the viewer may not read the thing itself — a stored title is never echoed
//   sharedInto  the conversation or Social team it was shared into (its rail title where the viewer has one)
//   authority   `grant`: a sharing grant whose audience reaches the viewer; `membership`: the viewer is a
//               current member of the conversation it was posted into (and may read the file / page now)
//   provenance  grant:active | grant:historical | reference | deck | attachment
//
// `sharedWorkInConversation` (the conversation's Shared work view and the same
// handler on the plane) and `buildSharedWork`'s `items` (a person's shared
// work) produce it; `ownerSharingState` is the grant half the Active now flag
// reads, so no second place sums grants.

export type SharedWorkItemKind = 'initiative' | 'work-item' | 'work-node' | 'deck' | 'file';
export type SharedWorkProvenance = 'grant:active' | 'grant:historical' | 'reference' | 'deck' | 'attachment';
export interface SharedWorkAudienceRef { kind: 'conversation' | 'team'; id: string; title: string | null }
export interface SharedWorkItem {
  kind: SharedWorkItemKind;
  id: string;
  title: string | null;
  status: 'available' | 'unavailable';
  href: string | null;
  sharedBy: { userId: string; displayName: string } | null;
  sharedInto: SharedWorkAudienceRef;
  at: string | null;
  authority: 'grant' | 'membership';
  provenance: SharedWorkProvenance;
  ref: { messageId?: string; grantId?: string; fileId?: string; fileName?: string; nodeKind?: string };
}

const EMPTY_SOURCES: Snapshot['sources'] = [];
const REFERENCE_CONVERSATIONS = 25;
const REFERENCE_MESSAGES = 100;

/** The owner as the work graph would see them: their orgiq role from the directory, or null when they hold none. */
export function ownerSession(user: UserInfo): Session | null {
  const roles = user.grants['orgiq'] ?? [];
  const role = ROLES_BY_TENANT.orgiq.find(r => roles.includes(r)) ?? (roles.includes('admin') ? 'admin' : null);
  if (!role) return null;
  return { sub: user.id, name: user.displayName, tenant: 'orgiq', role: role as Session['role'], grants: structuredClone(user.grants), epoch: user.epoch, iat: 0 };
}

/** An empty graph keyed on `personId` — the request's subject key (`sharedWorkSubjectKey`). */
export function emptySnapshot(personId: string, query: WorkGraphQuery, observedAt: string): Snapshot {
  const scope = { personId, day: query.day, timezone: query.timezone, policyRevision: 'orgiq.000000000000000000000000' };
  const v1: WorkGraphSnapshot = { schemaVersion: 1, scope, revision: 0, watermark: 0, cursor: `owg1.0.${scope.policyRevision}`, nodes: [], edges: [], sources: EMPTY_SOURCES, partial: false };
  if (!query.v2) return v1;
  const start = query.v2.windowStart < query.v2.windowEnd ? query.v2.windowStart : query.window.start;
  const end = query.v2.windowEnd < observedAt ? query.v2.windowEnd : observedAt;
  return {
    ...v1, schemaVersion: 2, query: { schemaVersion: 2, personId, day: query.day, timezone: query.timezone, windowStart: start, windowEnd: end, mode: query.v2.mode },
    temporal: { mode: query.v2.mode, observedAt, coverage: { from: start, through: end, complete: true } }, efforts: [], details: [], operations: [], eventBuckets: [],
  } as WorkGraphSnapshotV2;
}

export function grantView(row: StoredWorkSharing): SharedWorkGrantView {
  const g = row.grant;
  return {
    id: g.id, state: g.state, kind: row.kind, audience: row.audience, nodeIds: [...g.selection.nodeIds], disclosure: g.selection.disclosure,
    revision: g.revision, updatedAt: g.updatedAt, expiresAt: g.expiresAt,
    ...('historyGrantId' in g && g.historyGrantId ? { historyGrantId: g.historyGrantId } : {}),
    ...('dayFrom' in g ? { dayFrom: g.dayFrom, dayThrough: g.dayThrough } : {}),
  };
}

/** The viewer's audience memberships, from the stores the chat and the platform read — never from the request. */
export async function sharingViewerContext(viewer: Session): Promise<SharingViewerContext & { conversations: string[]; titles: Map<string, string> }> {
  let names: Map<string, string>;
  try { names = new Map((await listUsers()).map(u => [u.id, u.displayName])); } catch { names = new Map(); }
  const problems: string[] = [];
  const { conversations, teams } = await loadViewerConversations(viewer, names, problems);
  const ids = conversations.map(c => c.id);
  return { viewerId: viewer.sub, conversationIds: new Set(ids), teamIds: new Set(teams.map(t => t.id)), conversations: ids, titles: new Map(conversations.map(c => [c.id, c.title])) };
}

/** Node ids of the owner's work referenced (page references) in the viewer's conversations, with the conversations they came from. */
export async function referencedWork(ownerUserId: string, snapshot: Snapshot, conversationIds: readonly string[]): Promise<{ nodeIds: Set<string>; conversations: string[]; byNode: Map<string, { conversation: string; messageId: string; at: string }> }> {
  const nodeIds = new Set<string>();
  const where = new Set<string>();
  const byNode = new Map<string, { conversation: string; messageId: string; at: string }>();
  const present = new Set(snapshot.nodes.map(n => n.id));
  const chat = socialChat(); await chat.ready;
  for (const channel of conversationIds.slice(0, REFERENCE_CONVERSATIONS)) {
    if (channel.startsWith('social:room:')) continue;
    let messages;
    try { messages = await chat.chatStore.listMessages(channel, REFERENCE_MESSAGES); } catch { continue; }
    for (const m of messages) {
      if (m.userId !== ownerUserId || m.deletedAt) continue;
      const page = dmPageDescriptor((m.metadata as Record<string, unknown> | undefined)?.['pageReference']);
      if (!page) continue;
      const id = page.kind === 'initiative' ? nodeIdFor.initiative(page.id) : nodeIdFor.work(page.id);
      if (present.has(id)) {
        nodeIds.add(id); where.add(channel);
        const prior = byNode.get(id);
        if (!prior || prior.at < m.timestamp) byNode.set(id, { conversation: channel, messageId: m.id, at: m.timestamp });
      }
    }
  }
  return { nodeIds, conversations: [...where], byNode };
}

/**
 * The grant half, for one owner as one viewer: the owner's rows, the ones that
 * reach the viewer now (all current, unexpired ones for the owner themself) and
 * the Active-now summary of them. Read by `buildSharedWork`, the conversation
 * resolver and plane-active alike — no second place sums grants.
 */
export async function ownerSharingState(ownerUserId: string, viewer: Pick<Session, 'sub'>, context: SharingViewerContext, now: string = clock.nowIso()):
  Promise<{ rows: StoredWorkSharing[]; effective: EffectiveSharing[]; summary: { state: 'active' | 'historical'; fresh: boolean } | null }> {
  const rows = await workSharingStore().listByOwner(WORK_SHARING_ORG, ownerUserId);
  // The owner is every audience: each still-active grant of theirs (a history grant as historical), the same
  // read-time expiry the audience gets, so the owner's list is exactly what the audience can see.
  const effective = viewer.sub === ownerUserId
    ? rows.map(r => ({ row: r, grant: r.grant, historical: r.kind === 'history' } as EffectiveSharing))
      .filter(e => e.grant.state === 'active' && Date.parse(e.grant.expiresAt) > Date.parse(now))
    : effectiveSharingFor(rows, context, now);
  return { rows, effective, summary: sharingSummary(effective, now) };
}

const audienceRef = (audience: StoredWorkSharing['audience'], titles: ReadonlyMap<string, string>): SharedWorkAudienceRef =>
  ({ kind: audience.kind, id: audience.id, title: audience.kind === 'conversation' ? titles.get(audience.id) ?? null : null });

/** The grant that disclosed `nodeId` to this viewer: an active one first, else the historical one. */
function grantFor(nodeId: string, effective: readonly EffectiveSharing[]): EffectiveSharing | null {
  const hits = effective.filter(e => e.grant.selection.nodeIds.includes(nodeId));
  return hits.find(e => !e.historical) ?? hits[0] ?? null;
}

/** Work-node items for nodes a viewer may see, each naming the grant or reference that disclosed it. */
function nodeItems(owner: { userId: string; displayName: string }, nodes: readonly Snapshot['nodes'][number][],
  provenance: Readonly<Record<string, 'active' | 'historical' | 'referenced'>>, effective: readonly EffectiveSharing[],
  referenced: ReadonlyMap<string, { conversation: string; messageId: string; at: string }>, titles: ReadonlyMap<string, string>): SharedWorkItem[] {
  return nodes.flatMap((n): SharedWorkItem[] => {
    const how = provenance[n.id];
    if (how === 'referenced') {
      const ref = referenced.get(n.id);
      if (!ref) return [];
      return [{ kind: 'work-node', id: n.id, title: n.title, status: 'available', href: null, sharedBy: owner,
        sharedInto: { kind: 'conversation', id: ref.conversation, title: titles.get(ref.conversation) ?? null }, at: ref.at,
        authority: 'membership', provenance: 'reference', ref: { messageId: ref.messageId, nodeKind: n.kind } }];
    }
    const share = grantFor(n.id, effective);
    if (!share) return [];
    return [{ kind: 'work-node', id: n.id, title: n.title, status: 'available', href: null, sharedBy: owner,
      sharedInto: audienceRef(share.row.audience, titles), at: share.grant.updatedAt,
      authority: 'grant', provenance: share.historical || how === 'historical' ? 'grant:historical' : 'grant:active', ref: { grantId: share.grant.id, nodeKind: n.kind } }];
  });
}

const DISCLOSURE_RANK: Record<string, number> = { existence: 0, summary: 1, details: 2 };
const rank = (d: string) => DISCLOSURE_RANK[d] ?? 0;

/** The implicit grant in the library's own shape, so it goes through the same filter as an explicit one. */
function implicitShare(ownerUserId: string, referenced: { nodeIds: Set<string>; conversations: string[] }): EffectiveSharing {
  const now = clock.nowIso();
  const grant: WorkSharingGrant = {
    schemaVersion: 1, id: 'implicit:referenced', organizationId: WORK_SHARING_ORG, ownerId: ownerUserId,
    audience: { kind: 'conversation', conversationIds: referenced.conversations },
    selection: { nodeIds: [...referenced.nodeIds], edgeIds: [], disclosure: 'summary' }, state: 'active', createdAt: now, updatedAt: now, expiresAt: now, revision: 1,
  };
  return { historical: false, grant, row: { organizationId: WORK_SHARING_ORG, ownerId: ownerUserId, grantId: grant.id, kind: 'current', audience: { kind: 'conversation', id: referenced.conversations[0]! }, grant } };
}

/**
 * The owner's graph as this viewer may see it: keyed on the request's subject,
 * with only the nodes and edges the filter kept, and a v2 snapshot's efforts,
 * details and operations trimmed to them. The cursor is re-minted for the
 * narrowed graph (two snapshots with one cursor hold the same graph).
 *
 * Every effort's `edgeIds` is trimmed as well as its `nodeIds`: the library's
 * v2 validator refuses an effort naming an edge the snapshot does not carry,
 * and a sharing grant that selects nodes drops the edges to the rest of the
 * owner's day — which is how an audience member's populated reply read
 * "The activity graph could not load" while an empty one rendered (D1).
 */
function narrow(snapshot: Snapshot, subjectKey: string, nodes: Snapshot['nodes'], edges: Snapshot['edges']): Snapshot {
  const keep = new Set(nodes.map(n => n.id));
  const keptEdges = new Set(edges.filter(e => keep.has(e.fromId) && keep.has(e.toId)).map(e => e.id));
  const kept = edges.filter(e => keptEdges.has(e.id));
  const base: WorkGraphSnapshot = {
    ...(snapshot as WorkGraphSnapshot), schemaVersion: 1, scope: { ...snapshot.scope, personId: subjectKey }, nodes, edges: kept,
    cursor: workGraphCursor(snapshot.watermark, snapshot.scope.policyRevision, nodes, kept, snapshot.sources),
  };
  if (snapshot.schemaVersion !== 2) return base;
  const v2 = snapshot as WorkGraphSnapshotV2;
  const detailed = new Set(v2.details.filter(d => keep.has(d.nodeId)).map(d => d.nodeId));
  return {
    ...base, schemaVersion: 2, query: { ...v2.query, personId: subjectKey }, temporal: v2.temporal,
    efforts: v2.efforts.filter(e => keep.has(e.anchorNodeId)).map(e => ({
      ...e, nodeIds: e.nodeIds.filter(id => keep.has(id)), edgeIds: e.edgeIds.filter(id => keptEdges.has(id)), contextNodeIds: e.contextNodeIds.filter(id => keep.has(id)),
    })),
    details: v2.details.filter(d => detailed.has(d.nodeId)),
    operations: v2.operations.filter(o => keep.has(o.processNodeId) && keptEdges.has(o.edgeId)),
    eventBuckets: v2.eventBuckets,
  } as WorkGraphSnapshotV2;
}

/** A reply the library's own reader would refuse is a server fault, never a blank canvas with "Try again". */
function checked(snapshot: Snapshot, subjectKey: string): Snapshot {
  const result = snapshot.schemaVersion === 2 ? validateWorkGraphSnapshotV2(snapshot) : validateWorkGraphSnapshot(snapshot);
  if (!result.ok) {
    console.warn(`[shared-work] snapshot for ${subjectKey} failed validation: ${result.errors.join('; ')}`);
    throw new AppError(500, 'The shared work graph could not be assembled');
  }
  return snapshot;
}

/** Today's query in the viewer's zone when the request names no day (the plane's default). */
export function todayQuery(timezone = 'UTC'): WorkGraphQuery {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(clock.now());
  return { day, timezone, window: workDayWindow(day, timezone), v2: null };
}

/**
 * The shared-work answer for `viewer` looking at `ownerUserId`. Throws the owner
 * builder's 503 only; an owner who cannot be seen at all answers an empty graph.
 */
export async function buildSharedWork(viewer: Session, ownerUserId: string, query: WorkGraphQuery): Promise<SharedWork> {
  const observedAt = clock.nowIso();
  const key = sharedWorkSubjectKey(ownerUserId);
  const empty = (viewerKind: SharedWork['sharing']['viewer'] = 'none'): SharedWork => ({
    snapshot: emptySnapshot(key, query, observedAt),
    sharing: { viewer: viewerKind, state: null, fresh: false, provenance: {}, grants: [], referencedIn: [] },
    items: [],
  });
  let owner: UserInfo | null;
  try { owner = await getUser(ownerUserId, { authoritative: true }); } catch { owner = null; }
  if (!owner || !owner.personId) return empty(viewer.sub === ownerUserId ? 'owner' : 'none');
  const source = ownerSession(owner);
  if (!source) return empty(viewer.sub === ownerUserId ? 'owner' : 'none');
  let built;
  try { built = await buildViewerWorkGraph(source, { kind: 'person', id: owner.personId }, query); }
  catch (error) {
    // The owner's own authority failing (a stale directory row, a refused tenant) is the owner's absence, not the viewer's 403.
    if ((error as { status?: number })?.status === 401 || (error as { status?: number })?.status === 403) built = null;
    else throw error;
  }
  if (!built) return empty(viewer.sub === ownerUserId ? 'owner' : 'none');
  const context = await sharingViewerContext(viewer);
  const ownerRef = { userId: owner.id, displayName: owner.displayName };

  if (viewer.sub === ownerUserId) {
    const { rows, effective: own, summary } = await ownerSharingState(ownerUserId, viewer, context, observedAt);
    const grants = rows.map(r => grantView(r));
    // The owner's list: what their current grants disclose, each row naming where it went.
    const shared = new Set(own.flatMap(e => e.grant.selection.nodeIds));
    const ownProvenance = Object.fromEntries(built.snapshot.nodes.filter(n => shared.has(n.id)).map(n => [n.id, grantFor(n.id, own)?.historical ? 'historical' as const : 'active' as const]));
    return {
      snapshot: checked(narrow(built.snapshot, key, built.snapshot.nodes, built.snapshot.edges), key),
      sharing: { viewer: 'owner', state: summary?.state ?? null, fresh: summary?.fresh ?? false, provenance: {}, grants, referencedIn: [] },
      items: nodeItems(ownerRef, built.snapshot.nodes.filter(n => shared.has(n.id)), ownProvenance, own, new Map(), context.titles),
    };
  }

  const { effective } = await ownerSharingState(ownerUserId, viewer, context, observedAt);
  const referenced = await referencedWork(ownerUserId, built.snapshot, context.conversations);
  if (!effective.length && !referenced.nodeIds.size) return empty('none');
  const scope = { organizationId: WORK_SHARING_ORG, viewerId: viewer.sub, personId: ownerUserId, day: query.day, timezone: query.timezone, policyRevision: built.snapshot.scope.policyRevision };
  // Explicit grants and the implicit one go through the same library filter, separately, so each node's provenance is honest.
  const explicit = filterSharedWork(built.snapshot, effective, scope);
  const implicit = referenced.nodeIds.size ? filterSharedWork(built.snapshot, [implicitShare(ownerUserId, referenced)], scope) : { nodes: [], edges: [], provenance: new Map<string, 'active' | 'historical'>() };
  const nodes = new Map(explicit.nodes.map(n => [n.id, n]));
  for (const n of implicit.nodes) { const prior = nodes.get(n.id); if (!prior || rank(n.disclosure) > rank(prior.disclosure)) nodes.set(n.id, n); }
  const edges = new Map(explicit.edges.map(e => [e.id, e]));
  for (const e of implicit.edges) if (!edges.has(e.id)) edges.set(e.id, e);
  const provenance: Record<string, 'active' | 'historical' | 'referenced'> = {};
  for (const n of implicit.nodes) provenance[n.id] = 'referenced';
  for (const [id, label] of explicit.provenance) if (label === 'active' || !provenance[id]) provenance[id] = label;
  const filtered = { nodes: [...nodes.values()], edges: [...edges.values()] };
  const summary = sharingSummary(effective);
  return {
    snapshot: checked(narrow(built.snapshot, key, filtered.nodes, filtered.edges), key),
    sharing: {
      viewer: filtered.nodes.length ? 'audience' : 'none', state: summary?.state ?? null, fresh: summary?.fresh ?? false, provenance,
      grants: effective.map(e => grantView(e.row)), referencedIn: referenced.conversations,
    },
    items: nodeItems(ownerRef, filtered.nodes, provenance, effective, referenced.byNode, context.titles),
  };
}

// ── Everything shared INTO one conversation ──────────────────────────────────

const CONVERSATION_MESSAGES = 200;
const GRANT_OWNERS = 10;
const orgAccess = (session: Session): boolean => (session.grants.orgiq?.length ?? 0) > 0;
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const attachmentIds = (metadata: Record<string, unknown> | undefined): string[] => {
  const list = metadata?.['attachments'];
  return Array.isArray(list) ? list.flatMap(a => (a && typeof a === 'object' ? [text((a as Record<string, unknown>)['id'])].filter((v): v is string => !!v) : [])) : [];
};

export interface ConversationSharedWork { conversation: string; title: string | null; items: SharedWorkItem[]; limits: string[] }

/**
 * What was shared into `conversation` as `viewer` may see it, or null when the
 * viewer is not a current member (the route's uniform 404). Every producer is
 * folded through the viewer's authority NOW:
 *   - page references: the message must be visible to the viewer (not deleted,
 *     after their history floor); the page itself resolves only with a current
 *     orgiq grant and only if it exists — otherwise the row is `unavailable`
 *     with no title (the same rule as /api/social/dms/page-reference);
 *   - deck shares and files: the uploads read rule (`readableUploads`: the
 *     uploader, or a subscriber now whose floor predates the file); a deck whose
 *     file the viewer may not download is `unavailable`;
 *   - sharing grants whose audience is this conversation, from any current
 *     member: the owner's graph is built under the OWNER's authority and
 *     filtered by the library against the grant, so a node's title appears only
 *     at the disclosure the owner chose.
 * The viewer's own shares appear too (a member is in their own audience).
 */
export async function sharedWorkInConversation(viewer: Session, conversation: string): Promise<ConversationSharedWork | null> {
  const context = await sharingViewerContext(viewer);
  if (!context.conversationIds.has(conversation)) return null;
  const limits: string[] = [];
  const title = context.titles.get(conversation) ?? null;
  const into: SharedWorkAudienceRef = { kind: 'conversation', id: conversation, title };
  let names: Map<string, string>;
  try { names = new Map((await listUsers()).map(u => [u.id, u.displayName])); } catch { names = new Map(); limits.push('the directory could not be read; sharers are named by id'); }
  const who = (userId: string | null | undefined) => (userId ? { userId, displayName: names.get(userId) ?? userId } : null);
  const items: SharedWorkItem[] = [];

  // Files the viewer may download now, by upload id (the gateway's own guards, never a stored title).
  const { channelGuards } = await import('../gateway/authority.js');
  const ctx = sessionGatewayContext(viewer);
  let files: FileUploadRow[] = [];
  try { files = await readableUploads(conversation, ctx, channelGuards); }
  catch { limits.push('the file list could not be read'); }
  const fileById = new Map(files.map(f => [f.uploadId, f]));
  const claimed = new Set<string>();

  // The thread, as the viewer may read it.
  const chat = socialChat(); await chat.ready;
  const { historyFloor, messageVisible } = await import('../../routes/chat-pins.js');
  let messages: Awaited<ReturnType<typeof chat.chatStore.listMessages>> = [];
  try {
    const floor = await historyFloor(conversation, viewer.sub).catch(() => null);
    messages = (await chat.chatStore.listMessages(conversation, CONVERSATION_MESSAGES)).filter(m => messageVisible(m, floor));
  } catch { limits.push('the conversation could not be read'); }
  const mayResolvePages = orgAccess(viewer);
  for (const m of messages) {
    const metadata = m.metadata as Record<string, unknown> | undefined;
    const page = dmPageDescriptor(metadata?.['pageReference']);
    if (page) {
      let resolved: { title: string; href: string } | null = null;
      if (mayResolvePages) {
        try { const canonical = await canonicalCallPage(page); resolved = { title: canonical.title, href: canonical.href }; }
        catch (error) { if (!(error instanceof AppError) || ![403, 404].includes(error.status)) throw error; }
      }
      items.push({ kind: page.kind, id: page.id, title: resolved?.title ?? null, status: resolved ? 'available' : 'unavailable', href: resolved?.href ?? null,
        sharedBy: who(m.userId), sharedInto: into, at: m.timestamp, authority: 'membership', provenance: 'reference', ref: { messageId: m.id } });
    }
    const deck = metadata?.['sourceDeck'];
    const deckId = deck && typeof deck === 'object' ? text((deck as Record<string, unknown>)['id']) : null;
    if (deckId) {
      const fileId = attachmentIds(metadata).find(id => fileById.has(id)) ?? null;
      const file = fileId ? fileById.get(fileId)! : null;
      if (fileId) claimed.add(fileId);
      items.push({ kind: 'deck', id: deckId, title: file?.filename ?? null, status: file ? 'available' : 'unavailable',
        href: file ? `/api/uploads/${encodeURIComponent(file.uploadId)}` : null, sharedBy: who(m.userId), sharedInto: into, at: m.timestamp,
        authority: 'membership', provenance: 'deck', ref: { messageId: m.id, ...(file ? { fileId: file.uploadId, fileName: file.filename } : {}) } });
    }
  }
  for (const file of files) {
    if (claimed.has(file.uploadId)) continue;
    items.push({ kind: 'file', id: file.uploadId, title: file.filename, status: 'available', href: `/api/uploads/${encodeURIComponent(file.uploadId)}`,
      sharedBy: who(file.uploader), sharedInto: into, at: file.createdAt, authority: 'membership', provenance: 'attachment', ref: { fileId: file.uploadId, fileName: file.filename } });
  }

  // Sharing grants into this conversation, from any current member (the audience the owner belonged to when sharing).
  let members: string[] = [];
  try { members = [...new Set([...(await chat.membershipStore.listMembers(conversation)).filter(r => r.removedAt == null).map(r => r.userId), ...(dmMembers(conversation) ?? [])])]; }
  catch { limits.push('the conversation roster could not be read; sharing grants into it are unknown'); }
  const query = todayQuery();
  let owners = 0;
  for (const ownerId of members) {
    let state;
    try { state = await ownerSharingState(ownerId, viewer, context); } catch { limits.push('the sharing store could not be read'); break; }
    const here = state.effective.filter(e => e.row.audience.kind === 'conversation' && e.row.audience.id === conversation);
    if (!here.length) continue;
    if (++owners > GRANT_OWNERS) { limits.push(`sharing grants from more than ${GRANT_OWNERS} members are not listed`); break; }
    let user: UserInfo | null = null;
    try { user = await getUser(ownerId, { authoritative: true }); } catch { user = null; }
    const source = user?.personId ? ownerSession(user) : null;
    if (!user || !source) continue;
    let built;
    try { built = await buildViewerWorkGraph(source, { kind: 'person', id: user.personId! }, query); }
    catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 401 || status === 403) continue;
      limits.push(`${user.displayName}'s shared work could not be read`); continue;
    }
    if (!built) continue;
    const scope = { organizationId: WORK_SHARING_ORG, viewerId: viewer.sub, personId: ownerId, day: query.day, timezone: query.timezone, policyRevision: built.snapshot.scope.policyRevision };
    const filtered = filterSharedWork(built.snapshot, here, scope);
    const provenance = Object.fromEntries([...filtered.provenance]);
    items.push(...nodeItems({ userId: user.id, displayName: user.displayName }, filtered.nodes, provenance, here, new Map(), context.titles));
  }

  items.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.id.localeCompare(b.id));
  return { conversation, title, items, limits: [...new Set(limits)] };
}
