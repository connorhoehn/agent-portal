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
import type { PipelinesViewerReads } from './pipelines-projection.js';
import type { AssessmentViewerReads } from './assessment-projection.js';
import type { SocialViewerReads } from './social-projection.js';

/** The pipelines tenant's subjects: one run's page, or the whole workspace. */
export type PipelinesWorkGraphSubject = { kind: 'run'; id: string } | { kind: 'workspace' };
/** The assessment tenant's subjects: one team's page, or the whole workspace. */
export type AssessmentWorkGraphSubject = { kind: 'team'; id: string } | { kind: 'workspace' };
/** The social tenant's subjects: one conversation (its chat channel name: `social:ch:<slug>`, `social:dm:<a>:<b>`, `social:team:<team>:<ch>`, `social:room:<slug>`), or the whole workspace. */
export type SocialWorkGraphSubject = { kind: 'conversation'; id: string } | { kind: 'workspace' };
export type AnyWorkGraphSubject = WorkGraphSubject | PipelinesWorkGraphSubject | AssessmentWorkGraphSubject | SocialWorkGraphSubject;
export type WorkGraphTenant = 'orgiq' | 'pipelines' | 'assessment' | 'social';

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
export function subjectKey(subject: AnyWorkGraphSubject, tenant: WorkGraphTenant = 'orgiq'): string {
  // `workspace` is orgiq's; the pipelines workspace is its own subject, so one key never names both tenants' graphs.
  if (subject.kind === 'workspace') return tenant === 'pipelines' ? 'workspace:pipelines' : tenant === 'assessment' ? 'workspace:assessment' : tenant === 'social' ? 'workspace:social' : 'workspace';
  return `${subject.kind}:${subject.id}`;
}

/** Changes whenever what this viewer may see could change: identity, role, gate outcomes. */
export function policyRevisionFor(sessionKey: string, reads: ViewerReads, unavailable: string[]): string {
  const material = JSON.stringify([sessionKey, reads.botRuns, reads.marketplaceRuns, reads.dispatch, reads.sprintsWide, reads.grants, [...unavailable].sort()]);
  return `orgiq.${createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
}

/** The pipelines tenant's counterpart: the same idea over its two gates (ViewPipelines, ApproveStep). */
export function pipelinesPolicyRevisionFor(sessionKey: string, reads: PipelinesViewerReads, unavailable: string[]): string {
  const material = JSON.stringify([sessionKey, reads.view, reads.approvals, [...unavailable].sort()]);
  return `pipelines.${createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
}

/** The assessment tenant's counterpart: ViewAssessment, ScoreAssessment, RunAssessmentAgent. */
export function assessmentPolicyRevisionFor(sessionKey: string, reads: AssessmentViewerReads, unavailable: string[]): string {
  const material = JSON.stringify([sessionKey, reads.view, reads.score, reads.run, [...unavailable].sort()]);
  return `assessment.${createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
}

/** The social tenant's counterpart: ViewSocial, PostMessage, StartCall. */
export function socialPolicyRevisionFor(sessionKey: string, reads: SocialViewerReads, unavailable: string[]): string {
  const material = JSON.stringify([sessionKey, reads.view, reads.post, reads.call, [...unavailable].sort()]);
  return `social.${createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
}

/** `owg2.<watermark>.<policyRevision>.<digest>`; the digest ignores `checkedAt` (an observation stamp). */
export function workGraphCursor(watermark: number, policyRevision: string, nodes: readonly unknown[], edges: readonly unknown[], sources: readonly WorkSourceStatus[]): string {
  const material = JSON.stringify([nodes, edges, sources.map(({ checkedAt: _checkedAt, ...rest }) => rest)]);
  return `owg2.${watermark}.${policyRevision}.${createHash('sha256').update(material).digest('hex').slice(0, 20)}`;
}

/** The policy revision a cursor this module minted names, or null. */
export function cursorPolicyRevision(cursor: string): string | null {
  const m = /^owg[12]\.\d+\.((?:orgiq|pipelines|assessment|social)\.[0-9a-f]{24})(?:\.[0-9a-f]+)?$/.exec(cursor);
  return m ? m[1]! : null;
}

export interface AssembleInput {
  subject: AnyWorkGraphSubject;
  query: WorkGraphQuery;
  projection: Projection;
  sources: SourceHealth[];
  /** A gate whose evaluation failed withholds its rows; say so. */
  authorizationUnavailable: boolean;
  /** The budgets-tier gates (sprint money, envelopes) could not be decided; that money is withheld. */
  recordsUnavailable?: boolean;
  complete: boolean;
  /** The graph's tenant (orgiq when absent): decides the source a failed gate decision withholds (`cloud-compute` | `pipeline`) and the subject key. */
  tenant?: WorkGraphTenant;
  policyRevision: string;
  observedAt: string;
}

export function assembleWorkGraphSnapshot(input: AssembleInput): WorkGraphSnapshot | WorkGraphSnapshotV2 {
  const { subject, query, projection, observedAt, policyRevision } = input;
  if (query.window.start > observedAt) throw new AppError(400, 'That day has not started yet');
  const personId = subjectKey(subject, input.tenant);
  const sources: WorkSourceStatus[] = input.sources.map(s => ({ source: s.source, health: s.health, checkedAt: observedAt, ...(s.message ? { message: s.message.slice(0, 1000) } : {}) }));
  const withheld = input.tenant === 'pipelines' ? 'pipeline' : input.tenant === 'assessment' ? 'document' : input.tenant === 'social' ? 'conversation' : 'cloud-compute';
  if (input.authorizationUnavailable && !sources.some(s => s.source === withheld)) {
    sources.push({ source: withheld, health: 'authorization-unavailable', checkedAt: observedAt, message: withheld === 'pipeline' ? 'Pipeline visibility could not be decided; runs and approvals are withheld.' : withheld === 'document' ? 'Assessment visibility could not be decided; teams, evidence, drafts and runs are withheld.' : withheld === 'conversation' ? 'Social visibility could not be decided; conversations, calls, recordings, decks and runs are withheld.' : 'Run visibility could not be decided; runs are withheld.' });
  } else if (input.authorizationUnavailable) {
    for (const s of sources) if (s.source === withheld) s.health = 'authorization-unavailable';
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

  // The v2 contract needs windowStart < windowEnd <= observedAt. At the day's
  // very first instant (observedAt === window.start) no such window exists, so
  // observe one millisecond in: the day has begun, and 1 ms is the smallest
  // window the contract can express. Every later instant is untouched.
  const v2ObservedAt = observedAt > query.window.start ? observedAt : new Date(Date.parse(query.window.start) + 1).toISOString();
  // The reader asks for the whole local day; the answer cannot claim a window
  // that has not happened yet, so it ends at the observation instant.
  const windowEnd = query.v2.windowEnd < v2ObservedAt ? query.v2.windowEnd : v2ObservedAt;
  const windowStart = query.v2.windowStart < windowEnd ? query.v2.windowStart : query.window.start;
  const q: WorkGraphQueryV2 = { schemaVersion: 2, personId, day: query.day, timezone: query.timezone, windowStart, windowEnd, mode: query.v2.mode };
  const through = query.window.end < v2ObservedAt ? query.window.end : v2ObservedAt;
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
        mode: 'recent', observedAt: v2ObservedAt,
        coverage: { from: query.window.start, through, complete: input.complete && !partial, ...(projection.omitted > 0 ? { omitted: projection.omitted } : {}) },
      },
      efforts,
      details: projection.details,
      operations: projection.operations,
      eventBuckets: bucketWorkEvents({ day: query.day, timezone: query.timezone }, projection.observations, { observedAt: v2ObservedAt }),
    },
  });
  if (!built.ok) {
    console.warn(`[work-graph] v2 snapshot for ${personId} ${query.day} failed validation: ${built.errors.join('; ')}`);
    throw new AppError(500, 'The activity graph could not be assembled');
  }
  return built.value;
}
