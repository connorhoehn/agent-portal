// Assembles the viewer snapshot the library hook validates (`useWorkGraph`):
// v1 `WorkGraphSnapshot`, or v2 with the activity layer when the caller asks
// `schemaVersion=2`. v2 goes through the library's own `buildWorkGraphSnapshotV2`
// validator — a snapshot the reader would reject is a server error here, not
// something the browser discovers.

import { createHash } from 'node:crypto';
import {
  workDayWindow, WORK_GRAPH_SCHEMA_VERSION,
  type WorkDayWindow, type WorkGraphQueryV2, type WorkGraphSnapshot, type WorkGraphSnapshotV2, type WorkSourceStatus,
} from '@connorhoehnslalom/realtime-modules/work-graph';
import { buildWorkGraphSnapshotV2, bucketWorkEvents, deriveWorkEfforts } from '@connorhoehnslalom/realtime-modules/work-graph/server';
import { AppError, ValidationError } from '../async-handler.js';
import type { Projection, ViewerReads } from './projection.js';
import type { SourceHealth, WorkGraphSubject } from './sources.js';

export interface WorkGraphQuery {
  day: string;
  timezone: string;
  window: WorkDayWindow;
  v2: null | { windowStart: string; windowEnd: string; mode: 'live' | 'as-of' };
}

const KEYS_V1 = new Set(['day', 'timezone']);
const KEYS_V2 = new Set(['day', 'timezone', 'schemaVersion', 'windowStart', 'windowEnd', 'mode']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Strict like the reference route: unknown keys and half a v2 query are 400s. */
export function parseWorkGraphQuery(raw: Record<string, unknown>): WorkGraphQuery {
  const one = (key: string): string | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string') throw new ValidationError(`${key} must be given once`);
    return v;
  };
  const v2 = raw['schemaVersion'] !== undefined;
  for (const key of Object.keys(raw)) {
    if (!(v2 ? KEYS_V2 : KEYS_V1).has(key)) throw new ValidationError(v2 || !KEYS_V2.has(key) ? `unknown query key: ${key}` : `${key} requires schemaVersion=2`);
  }
  const day = one('day'), timezone = one('timezone');
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ValidationError('day must be YYYY-MM-DD');
  if (!timezone || timezone.length > 64) throw new ValidationError('timezone must be an IANA zone');
  let window: WorkDayWindow;
  try { window = workDayWindow(day, timezone); } catch { throw new ValidationError('day/timezone is not a real calendar day'); }
  if (!v2) return { day, timezone, window, v2: null };
  if (one('schemaVersion') !== '2') throw new ValidationError('schemaVersion must be 2');
  const windowStart = one('windowStart'), windowEnd = one('windowEnd'), mode = one('mode') ?? 'live';
  if (!windowStart || !windowEnd || !ISO.test(windowStart) || !ISO.test(windowEnd)) throw new ValidationError('windowStart and windowEnd must be ISO instants');
  if (mode !== 'live' && mode !== 'as-of') throw new ValidationError("mode must be 'live' or 'as-of'");
  if (!(windowStart < windowEnd && windowStart >= window.start && windowEnd <= window.end)) throw new ValidationError('the window must lie inside the day');
  return { day, timezone, window, v2: { windowStart, windowEnd, mode } };
}

/** The contract's `personId` slot carries the graph's subject (docs/activity-graph-migration.md §3). */
export function subjectKey(subject: WorkGraphSubject): string {
  return subject.kind === 'workspace' ? 'workspace' : subject.kind === 'person' ? `person:${subject.id}` : `initiative:${subject.id}`;
}

/** Changes whenever what this viewer may see could change: identity, role, gate outcomes. */
export function policyRevisionFor(sessionKey: string, reads: ViewerReads, unavailable: string[]): string {
  const material = JSON.stringify([sessionKey, reads.botRuns, reads.marketplaceRuns, reads.dispatch, reads.sprintsWide, reads.grants, [...unavailable].sort()]);
  return `orgiq.${createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
}

/** `owg2.<watermark>.<policyRevision>.<digest>`; the digest ignores `checkedAt` (an observation stamp). */
export function workGraphCursor(watermark: number, policyRevision: string, nodes: readonly unknown[], edges: readonly unknown[], sources: readonly WorkSourceStatus[]): string {
  const material = JSON.stringify([nodes, edges, sources.map(({ checkedAt: _checkedAt, ...rest }) => rest)]);
  return `owg2.${watermark}.${policyRevision}.${createHash('sha256').update(material).digest('hex').slice(0, 20)}`;
}

/** The policy revision a cursor this module minted names, or null. */
export function cursorPolicyRevision(cursor: string): string | null {
  const m = /^owg[12]\.\d+\.(orgiq\.[0-9a-f]{24})(?:\.[0-9a-f]+)?$/.exec(cursor);
  return m ? m[1]! : null;
}

export interface AssembleInput {
  subject: WorkGraphSubject;
  query: WorkGraphQuery;
  projection: Projection;
  sources: SourceHealth[];
  /** A gate whose evaluation failed withholds its rows; say so. */
  authorizationUnavailable: boolean;
  /** The budgets-tier gates (sprint money, envelopes) could not be decided; that money is withheld. */
  recordsUnavailable?: boolean;
  complete: boolean;
  policyRevision: string;
  observedAt: string;
}

export function assembleWorkGraphSnapshot(input: AssembleInput): WorkGraphSnapshot | WorkGraphSnapshotV2 {
  const { subject, query, projection, observedAt, policyRevision } = input;
  if (query.window.start > observedAt) throw new AppError(400, 'That day has not started yet');
  const personId = subjectKey(subject);
  const sources: WorkSourceStatus[] = input.sources.map(s => ({ source: s.source, health: s.health, checkedAt: observedAt, ...(s.message ? { message: s.message.slice(0, 1000) } : {}) }));
  if (input.authorizationUnavailable && !sources.some(s => s.source === 'cloud-compute')) {
    sources.push({ source: 'cloud-compute', health: 'authorization-unavailable', checkedAt: observedAt, message: 'Run visibility could not be decided; runs are withheld.' });
  } else if (input.authorizationUnavailable) {
    for (const s of sources) if (s.source === 'cloud-compute') s.health = 'authorization-unavailable';
  }
  if (input.recordsUnavailable) {
    const records = sources.find(s => s.source === 'document');
    if (records) records.health = 'authorization-unavailable';
    else sources.push({ source: 'document', health: 'authorization-unavailable', checkedAt: observedAt, message: 'Sprint budget visibility could not be decided; money is withheld.' });
  }
  const partial = sources.some(s => s.health !== 'available') || projection.omitted > 0;
  const stamps = [...projection.nodes, ...projection.edges].map(e => Date.parse(e.updatedAt)).filter(Number.isFinite);
  const watermark = Math.max(0, Math.floor(Math.max(0, ...stamps) / 1000));
  const v1: WorkGraphSnapshot = {
    schemaVersion: WORK_GRAPH_SCHEMA_VERSION,
    scope: { personId, day: query.day, timezone: query.timezone, policyRevision },
    revision: watermark,
    watermark,
    // Opaque: orgiq has no replay, so the cursor only names the snapshot it came
    // from — its watermark, policy revision and a digest of the graph it holds
    // (so two snapshots with one cursor hold the same graph). The live stream
    // (stream.ts) continues from it with per-viewer deltas.
    cursor: workGraphCursor(watermark, policyRevision, projection.nodes, projection.edges, sources),
    nodes: projection.nodes,
    edges: projection.edges,
    sources,
    partial,
  };
  if (!query.v2) return v1;

  // The reader asks for the whole local day; the answer cannot claim a window
  // that has not happened yet, so it ends at the observation instant.
  const windowEnd = query.v2.windowEnd < observedAt ? query.v2.windowEnd : observedAt;
  const windowStart = query.v2.windowStart < windowEnd ? query.v2.windowStart : query.window.start;
  const q: WorkGraphQueryV2 = { schemaVersion: 2, personId, day: query.day, timezone: query.timezone, windowStart, windowEnd, mode: query.v2.mode };
  const through = query.window.end < observedAt ? query.window.end : observedAt;
  const efforts = deriveWorkEfforts({
    nodes: projection.nodes, edges: projection.edges, anchorKinds: ['project'],
    // Members whose last change predates the day fold as context.
    contextBefore: query.window.start,
    titleFor: anchor => anchor.title,
  });
  const built = buildWorkGraphSnapshotV2({
    snapshot: v1,
    query: q,
    activity: {
      temporal: {
        mode: 'recent', observedAt,
        coverage: { from: query.window.start, through, complete: input.complete && !partial, ...(projection.omitted > 0 ? { omitted: projection.omitted } : {}) },
      },
      efforts,
      details: projection.details,
      operations: projection.operations,
      eventBuckets: bucketWorkEvents({ day: query.day, timezone: query.timezone }, projection.observations, { observedAt }),
    },
  });
  if (!built.ok) {
    console.warn(`[work-graph] v2 snapshot for ${personId} ${query.day} failed validation: ${built.errors.join('; ')}`);
    throw new AppError(500, 'The activity graph could not be assembled');
  }
  return built.value;
}
