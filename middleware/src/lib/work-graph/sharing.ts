// Work-sharing grants (docs/communication-plane-goal.md §3): the store, the
// lifecycle and the per-viewer filter.
//
// A grant is realtime-modules' `WorkSharingGrant` (work-graph
// `createSharingGrant` / `transitionSharingGrant` / `effectiveSharingGrant` —
// the library owns the state machine, the revision check and read-time
// expiry); this module adds the audience the plane resolves fresh at read
// time (a conversation's CURRENT members or a Social team's CURRENT roster),
// the store, and `filterSharedWork`, which hands the library's
// `filterForViewer` the owner's own snapshot as a projection state plus the
// disclosure decisions each effective grant makes. The library performs no
// authorization I/O: everything it is handed has already been decided here —
// the owner's graph built under the OWNER's authority, the audience checked
// against the viewer's conversations and teams, the selection intersected.
//
// Stores: DynamoDB `${prefix}work-sharing` (PK ownerKey = `<org>#<owner>`,
// SK grantId, the row as JSON, TTL 90 days past expiry — the chat tables'
// pattern, lib/realtime-gateway.ts DynamoChatPinsStore) when the chat store is
// Dynamo; the registered fixture `social.work-sharing` (mock/social-work-sharing.ts)
// under MOCK_AURORA (key `social-work-sharing`); memory otherwise. The library ships no sharing store of
// its own (0.115 `WorkSharingRepository` is an interface), so the Dynamo table
// lives here, declared beside the chat tables in infra/lib/social-stack.ts.

import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  createSharingGrant, effectiveSharingGrant, filterForViewer, SharingGrantExpiredError, SharingRevisionConflictError, transitionSharingGrant,
  type DisclosureDecision, type DisclosureLevel, type InternalWorkEdge, type InternalWorkNode, type SharingTransition, type ViewerWorkEdge, type ViewerWorkNode,
  type WorkGraphPolicyInput, type WorkGraphQueryScope, type WorkGraphSnapshot, type WorkGraphSnapshotV2, type WorkHistoryGrant, type WorkProjectionState,
  type WorkSharingGrant,
} from '@connorhoehnslalom/realtime-modules/work-graph';
import type { DynamoCommandClient } from '@connorhoehnslalom/realtime-modules/server/stores/dynamo';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { clock } from '../../mock/core/index.js';
import { socialWorkSharingFixture, type StoredWorkSharing, type WorkSharingAudienceRef } from '../../mock/social-work-sharing.js';
import { AppError, ValidationError } from '../async-handler.js';
import { socialChat } from '../social-chat.js';

export type { StoredWorkSharing, WorkSharingAudienceRef };

/** The work graph a person shares is orgiq's (the person subject lives there). */
export const WORK_SHARING_ORG = 'orgiq';
export const MAX_SHARING_MS = 24 * 3_600_000;
export const MIN_SHARING_MS = 5 * 60_000;
export const MAX_HISTORY_MS = 7 * 86_400_000;
const SELECTION_CAP = 250;

// ── Store ────────────────────────────────────────────────────────────────────

export interface WorkSharingStore {
  listByOwner(organizationId: string, ownerId: string): Promise<StoredWorkSharing[]>;
  get(organizationId: string, grantId: string): Promise<StoredWorkSharing | null>;
  /** Insert or replace. `expectedRevision` null inserts; a mismatch throws SharingRevisionConflictError. */
  put(row: StoredWorkSharing, expectedRevision: number | null): Promise<StoredWorkSharing>;
}

const ownerKey = (organizationId: string, ownerId: string) => `${organizationId}#${ownerId}`;

/** Rows in an array the caller owns: the registered fixture under MOCK_AURORA, a private array otherwise. */
export class RowsWorkSharingStore implements WorkSharingStore {
  constructor(private readonly rows: () => StoredWorkSharing[]) {}
  async listByOwner(organizationId: string, ownerId: string): Promise<StoredWorkSharing[]> {
    return this.rows().filter(r => r.organizationId === organizationId && r.ownerId === ownerId).map(r => structuredClone(r));
  }
  async get(organizationId: string, grantId: string): Promise<StoredWorkSharing | null> {
    const row = this.rows().find(r => r.organizationId === organizationId && r.grantId === grantId);
    return row ? structuredClone(row) : null;
  }
  async put(row: StoredWorkSharing, expectedRevision: number | null): Promise<StoredWorkSharing> {
    const rows = this.rows();
    const i = rows.findIndex(r => r.organizationId === row.organizationId && r.grantId === row.grantId);
    const current = i >= 0 ? rows[i]!.grant.revision : null;
    if (current !== expectedRevision) throw new SharingRevisionConflictError();
    const copy = structuredClone(row);
    if (i >= 0) rows.splice(i, 1, copy); else rows.push(copy);
    return structuredClone(copy);
  }
}

export interface DynamoWorkSharingStoreOpts { client: DynamoCommandClient; tableName: string; now?: () => number; ttlSeconds?: number }
/** `${prefix}work-sharing`: PK `ownerKey` (`<org>#<owner>`), SK `grantId`, the row as JSON in `row`, `revision` for the conditional put. */
export class DynamoWorkSharingStore implements WorkSharingStore {
  private readonly client: DynamoCommandClient;
  readonly tableName: string;
  private readonly now: () => number;
  private readonly ttlSeconds: number;
  constructor(opts: DynamoWorkSharingStoreOpts) {
    if (!opts.client || typeof opts.client.send !== 'function') throw new Error('DynamoWorkSharingStore needs a DynamoDB client');
    if (!opts.tableName) throw new Error('DynamoWorkSharingStore needs a table name');
    this.client = opts.client; this.tableName = opts.tableName; this.now = opts.now ?? Date.now; this.ttlSeconds = opts.ttlSeconds ?? 90 * 86_400;
  }
  private parse(item: Record<string, { S?: string; N?: string }> | undefined): StoredWorkSharing | null {
    const raw = item?.['row']?.S;
    if (!raw) return null;
    if (item?.['ttl']?.N && Number(item['ttl'].N) <= Math.floor(this.now() / 1000)) return null;
    try { return JSON.parse(raw) as StoredWorkSharing; } catch { return null; }
  }
  async listByOwner(organizationId: string, ownerId: string): Promise<StoredWorkSharing[]> {
    const out: StoredWorkSharing[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName, ConsistentRead: true,
        KeyConditionExpression: 'ownerKey = :owner', ExpressionAttributeValues: { ':owner': { S: ownerKey(organizationId, ownerId) } },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })) as { Items?: Array<Record<string, { S?: string; N?: string }>>; LastEvaluatedKey?: Record<string, AttributeValue> };
      for (const item of result?.Items ?? []) { const row = this.parse(item); if (row) out.push(row); }
      startKey = result?.LastEvaluatedKey;
    } while (startKey);
    return out;
  }
  async get(organizationId: string, grantId: string): Promise<StoredWorkSharing | null> {
    // The owner is part of the key; a grant id alone is found through its index row.
    const result = await this.client.send(new GetItemCommand({
      TableName: this.tableName, ConsistentRead: true, Key: { ownerKey: { S: `${organizationId}#grant` }, grantId: { S: grantId } },
    })) as { Item?: Record<string, { S?: string; N?: string }> };
    const pointer = result?.Item?.['owner']?.S;
    if (!pointer) return null;
    const rows = await this.client.send(new GetItemCommand({
      TableName: this.tableName, ConsistentRead: true, Key: { ownerKey: { S: ownerKey(organizationId, pointer) }, grantId: { S: grantId } },
    })) as { Item?: Record<string, { S?: string; N?: string }> };
    return this.parse(rows?.Item);
  }
  async put(row: StoredWorkSharing, expectedRevision: number | null): Promise<StoredWorkSharing> {
    const ttl = String(Math.floor(Date.parse(row.grant.expiresAt) / 1000) + this.ttlSeconds);
    const condition = expectedRevision === null
      ? { ConditionExpression: 'attribute_not_exists(grantId)' }
      : { ConditionExpression: 'revision = :expected', ExpressionAttributeValues: { ':expected': { N: String(expectedRevision) } } };
    try {
      await this.client.send(new PutItemCommand({
        TableName: this.tableName, ...condition,
        Item: { ownerKey: { S: ownerKey(row.organizationId, row.ownerId) }, grantId: { S: row.grantId }, revision: { N: String(row.grant.revision) },
          row: { S: JSON.stringify(row) }, ttl: { N: ttl } },
      }));
    } catch (error) {
      if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') throw new SharingRevisionConflictError();
      throw error;
    }
    // The pointer row lets `get` find a grant by id without scanning owners.
    await this.client.send(new PutItemCommand({
      TableName: this.tableName,
      Item: { ownerKey: { S: `${row.organizationId}#grant` }, grantId: { S: row.grantId }, owner: { S: row.ownerId }, ttl: { N: ttl } },
    }));
    return structuredClone(row);
  }
  async remove(organizationId: string, ownerId: string, grantId: string): Promise<void> {
    await this.client.send(new DeleteItemCommand({ TableName: this.tableName, Key: { ownerKey: { S: ownerKey(organizationId, ownerId) }, grantId: { S: grantId } } }));
  }
}

let memoryRows: StoredWorkSharing[] = [];
let override: WorkSharingStore | null = null;
/** The store for this process: Dynamo beside a Dynamo chat store, the registered fixture under MOCK_AURORA, memory otherwise. */
export function workSharingStore(): WorkSharingStore {
  if (override) return override;
  const chat = socialChat();
  if (chat.kind === 'dynamo' && chat.dynamo) return new DynamoWorkSharingStore({ client: chat.dynamo.client, tableName: `${chat.dynamo.tablePrefix}work-sharing` });
  if (config.mock.aurora) return new RowsWorkSharingStore(() => socialWorkSharingFixture.rows());
  return new RowsWorkSharingStore(() => memoryRows);
}
export function setWorkSharingStoreForTests(store: WorkSharingStore | null): void { override = store; memoryRows = []; }

// ── Lifecycle ────────────────────────────────────────────────────────────────

export interface NewWorkSharing {
  ownerId: string;
  audience: WorkSharingAudienceRef;
  nodeIds: string[];
  edgeIds?: string[];
  disclosure?: DisclosureLevel;
  /** Milliseconds from now; clamped to the library's [5 min, 24 h]. */
  durationMs?: number;
  /** Keep a history grant beside the current one so a later stop leaves the shared days visible as `historical`. */
  history?: { dayFrom: string; dayThrough: string; durationMs?: number } | null;
}

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Validate the request's selection and audience shape (never its authority — the route decides that). */
export function parseNewWorkSharing(body: unknown, ownerId: string): NewWorkSharing {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const audienceRaw = b['audience'] as Record<string, unknown> | undefined;
  const kind = audienceRaw?.['kind'];
  const id = typeof audienceRaw?.['id'] === 'string' ? audienceRaw['id'].trim() : '';
  if ((kind !== 'conversation' && kind !== 'team') || !id || id.length > 256) throw new ValidationError('audience must be {kind: "conversation" | "team", id}');
  const nodeIds = Array.isArray(b['nodeIds']) ? b['nodeIds'].filter((v): v is string => typeof v === 'string' && NODE_ID.test(v)) : [];
  if (!nodeIds.length) throw new ValidationError('nodeIds must name at least one work node');
  if (nodeIds.length > SELECTION_CAP) throw new ValidationError(`nodeIds must name at most ${SELECTION_CAP} nodes`);
  const edgeIds = Array.isArray(b['edgeIds']) ? b['edgeIds'].filter((v): v is string => typeof v === 'string' && NODE_ID.test(v)).slice(0, SELECTION_CAP) : [];
  const disclosure = b['disclosure'];
  if (disclosure !== undefined && disclosure !== 'summary' && disclosure !== 'details') throw new ValidationError("disclosure must be 'summary' or 'details'");
  const durationMs = typeof b['durationMs'] === 'number' && Number.isFinite(b['durationMs']) ? b['durationMs'] : undefined;
  let history: NewWorkSharing['history'] = null;
  const h = b['history'] as Record<string, unknown> | undefined;
  if (h && typeof h === 'object') {
    const dayFrom = h['dayFrom'], dayThrough = h['dayThrough'];
    if (typeof dayFrom !== 'string' || typeof dayThrough !== 'string' || !DAY.test(dayFrom) || !DAY.test(dayThrough) || dayFrom > dayThrough) {
      throw new ValidationError('history needs dayFrom <= dayThrough as YYYY-MM-DD');
    }
    history = { dayFrom, dayThrough, ...(typeof h['durationMs'] === 'number' ? { durationMs: h['durationMs'] as number } : {}) };
  }
  return { ownerId, audience: { kind, id }, nodeIds: [...new Set(nodeIds)], edgeIds: [...new Set(edgeIds)], ...(disclosure ? { disclosure } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}), history };
}

const libraryAudience = (ref: WorkSharingAudienceRef) =>
  ref.kind === 'conversation' ? { kind: 'conversation' as const, conversationIds: [ref.id] } : { kind: 'people' as const, personIds: [] };
const clamp = (ms: number | undefined, fallback: number, max: number) => Math.min(max, Math.max(MIN_SHARING_MS, ms ?? fallback));

/** Create the current grant (and its history grant when asked), using the library's lifecycle. */
export async function createWorkSharing(input: NewWorkSharing, store: WorkSharingStore = workSharingStore()): Promise<{ current: StoredWorkSharing; history: StoredWorkSharing | null }> {
  const now = clock.nowIso();
  const nowMs = Date.parse(now);
  const selection = { nodeIds: input.nodeIds, edgeIds: input.edgeIds ?? [], disclosure: input.disclosure ?? 'summary' as DisclosureLevel };
  const historyId = input.history ? `wsg-${randomUUID()}` : undefined;
  const current = createSharingGrant({
    id: `wsg-${randomUUID()}`, organizationId: WORK_SHARING_ORG, ownerId: input.ownerId, audience: libraryAudience(input.audience), selection,
    expiresAt: new Date(nowMs + clamp(input.durationMs, MAX_SHARING_MS, MAX_SHARING_MS)).toISOString(), ...(historyId ? { historyGrantId: historyId } : {}),
  }, now);
  const rows: { current: StoredWorkSharing; history: StoredWorkSharing | null } = {
    current: { organizationId: WORK_SHARING_ORG, ownerId: input.ownerId, grantId: current.id, kind: 'current', audience: input.audience, grant: current },
    history: null,
  };
  if (input.history && historyId) {
    const base = createSharingGrant({
      id: historyId, organizationId: WORK_SHARING_ORG, ownerId: input.ownerId, audience: libraryAudience(input.audience), selection,
      expiresAt: new Date(nowMs + clamp(input.history.durationMs, MAX_HISTORY_MS, MAX_HISTORY_MS)).toISOString(),
    }, now);
    const { historyGrantId: _drop, ...rest } = base;
    const history: WorkHistoryGrant = { ...rest, dayFrom: input.history.dayFrom, dayThrough: input.history.dayThrough };
    rows.history = { organizationId: WORK_SHARING_ORG, ownerId: input.ownerId, grantId: history.id, kind: 'history', audience: input.audience, grant: history };
  }
  await store.put(rows.current, null);
  if (rows.history) await store.put(rows.history, null);
  return rows;
}

export type WorkSharingAction = SharingTransition['action'];

/** Apply one library transition to a stored grant; 409 on a stale revision or an impossible move, 410 when expired. */
export async function transitionWorkSharing(row: StoredWorkSharing, transition: SharingTransition, store: WorkSharingStore = workSharingStore()): Promise<StoredWorkSharing> {
  const now = clock.nowIso();
  let next: WorkSharingGrant | WorkHistoryGrant;
  try { next = transitionSharingGrant(effectiveSharingGrant(row.grant, now), transition, now); }
  catch (error) {
    if (error instanceof SharingRevisionConflictError) throw new AppError(409, 'The sharing grant changed; reload and try again');
    if (error instanceof SharingGrantExpiredError) throw new AppError(410, 'The sharing grant has expired');
    if (error instanceof RangeError) throw new AppError(409, error.message);
    throw error;
  }
  try { return await store.put({ ...row, grant: next }, row.grant.revision); }
  catch (error) {
    if (error instanceof SharingRevisionConflictError) throw new AppError(409, 'The sharing grant changed; reload and try again');
    throw error;
  }
}

// ── Reading: which grants reach this viewer, and what they disclose ──────────

/** The viewer's audience memberships, resolved by the caller from the directory — never from the request. */
export interface SharingViewerContext { viewerId: string; conversationIds: ReadonlySet<string>; teamIds: ReadonlySet<string> }

export interface EffectiveSharing {
  row: StoredWorkSharing;
  grant: WorkSharingGrant | WorkHistoryGrant;
  /** A history grant, or a current grant that is no longer active but whose history grant still is. */
  historical: boolean;
}

/** The owner's grants this viewer is an audience of, as of now (read-time expiry is authoritative). */
export function effectiveSharingFor(rows: readonly StoredWorkSharing[], viewer: SharingViewerContext, now: string = clock.nowIso()): EffectiveSharing[] {
  const reaches = (ref: WorkSharingAudienceRef) => ref.kind === 'conversation' ? viewer.conversationIds.has(ref.id) : viewer.teamIds.has(ref.id);
  const out: EffectiveSharing[] = [];
  for (const row of rows) {
    if (!reaches(row.audience)) continue;
    const grant = effectiveSharingGrant(row.grant, now);
    if (grant.state !== 'active') continue;
    out.push({ row: { ...row, grant }, grant, historical: row.kind === 'history' });
  }
  return out;
}

/** The sharing state one person shows on an Active-now tile: active beats historical; fresh = touched in the last 24 h. */
export function sharingSummary(effective: readonly EffectiveSharing[], now: string = clock.nowIso()): { state: 'active' | 'historical'; fresh: boolean } | null {
  if (!effective.length) return null;
  const active = effective.some(e => !e.historical);
  const latest = Math.max(...effective.map(e => Date.parse(e.grant.updatedAt)).filter(Number.isFinite));
  return { state: active ? 'active' : 'historical', fresh: Number.isFinite(latest) && Date.parse(now) - latest <= 86_400_000 };
}

type Snapshot = WorkGraphSnapshot | WorkGraphSnapshotV2;

/** The owner's own snapshot as the library's projection state (the shape `filterForViewer` reads). */
function projectionState(snapshot: Snapshot, organizationId: string, ownerId: string): WorkProjectionState {
  const nodes: Record<string, InternalWorkNode> = {};
  for (const n of snapshot.nodes) {
    nodes[n.id] = {
      id: n.id, organizationId, actorId: ownerId, kind: n.kind, sourceRef: { source: 'cloud-compute', resourceId: n.id }, policyRef: 'owner-snapshot',
      title: n.title, ...(n.description ? { description: n.description } : {}), status: n.status,
      ...(n.startedAt ? { startedAt: n.startedAt } : {}), updatedAt: n.updatedAt, ...(n.endedAt ? { endedAt: n.endedAt } : {}),
      sourceEventId: n.id, revision: 1,
    };
  }
  const edges: Record<string, InternalWorkEdge> = {};
  for (const e of snapshot.edges) {
    edges[e.id] = {
      id: e.id, organizationId, actorId: ownerId, fromId: e.fromId, toId: e.toId, relation: e.relation, policyRef: 'owner-snapshot',
      ...(e.label ? { label: e.label } : {}), status: e.status, ...(e.startedAt ? { startedAt: e.startedAt } : {}), updatedAt: e.updatedAt,
      ...(e.endedAt ? { endedAt: e.endedAt } : {}), sourceEventId: e.id, provenance: 'source-event', revision: 1,
    };
  }
  return { schemaVersion: snapshot.schemaVersion === 2 ? 1 : snapshot.schemaVersion, organizationId, actorId: ownerId, revision: snapshot.revision, sessions: {}, nodes, edges, sourceCheckpoints: {}, appliedEventIds: [] } as WorkProjectionState;
}

const DISCLOSURE_RANK: Record<DisclosureLevel, number> = { existence: 0, summary: 1, details: 2 };
const lower = (a: DisclosureLevel, b: DisclosureLevel): DisclosureLevel => (DISCLOSURE_RANK[a] <= DISCLOSURE_RANK[b] ? a : b);

export interface SharedWorkFilterResult {
  nodes: ViewerWorkNode[];
  edges: ViewerWorkEdge[];
  /** Node id → the grant state that disclosed it (active wins over historical). */
  provenance: Map<string, 'active' | 'historical'>;
}

/**
 * The part of the owner's snapshot these grants disclose to the viewer: each grant's
 * selection, at that grant's disclosure (never above what the owner's own view carried),
 * through the library's `filterForViewer`; edges only between disclosed nodes. The
 * decision maps are built here, intersected with the owner's graph — the library
 * performs no lookup.
 */
export function filterSharedWork(snapshot: Snapshot, effective: readonly EffectiveSharing[], scope: Omit<WorkGraphQueryScope, 'policyRevision'> & { policyRevision: string }): SharedWorkFilterResult {
  const state = projectionState(snapshot, scope.organizationId, scope.personId);
  const nodes = new Map<string, ViewerWorkNode>();
  const edges = new Map<string, ViewerWorkEdge>();
  const provenance = new Map<string, 'active' | 'historical'>();
  for (const share of effective) {
    const selected = new Set(share.grant.selection.nodeIds);
    const nodeDecisions = new Map<string, DisclosureDecision>();
    for (const n of snapshot.nodes) {
      if (!selected.has(n.id)) continue;
      nodeDecisions.set(n.id, { targetId: n.id, decision: 'allow', maximumDisclosure: lower(share.grant.selection.disclosure, n.disclosure), capabilities: n.capabilities, policyRevision: scope.policyRevision });
    }
    const edgeDecisions = new Map<string, DisclosureDecision>();
    const explicitEdges = new Set(share.grant.selection.edgeIds);
    for (const e of snapshot.edges) {
      if (!(selected.has(e.fromId) && selected.has(e.toId)) && !explicitEdges.has(e.id)) continue;
      if (!nodeDecisions.has(e.fromId) || !nodeDecisions.has(e.toId)) continue;
      edgeDecisions.set(e.id, { targetId: e.id, decision: 'allow', maximumDisclosure: lower(share.grant.selection.disclosure, e.disclosure), capabilities: e.capabilities, policyRevision: scope.policyRevision });
    }
    const policy: WorkGraphPolicyInput = { scope, grant: share.grant, nodeDecisions, edgeDecisions };
    const filtered = filterForViewer(state, policy);
    const label = share.historical ? 'historical' : 'active';
    for (const n of filtered.nodes) {
      const prior = nodes.get(n.id);
      if (!prior || DISCLOSURE_RANK[n.disclosure] > DISCLOSURE_RANK[prior.disclosure]) nodes.set(n.id, n);
      if (provenance.get(n.id) !== 'active') provenance.set(n.id, label);
    }
    for (const e of filtered.edges) {
      const prior = edges.get(e.id);
      if (!prior || DISCLOSURE_RANK[e.disclosure] > DISCLOSURE_RANK[prior.disclosure]) edges.set(e.id, e);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], provenance };
}
