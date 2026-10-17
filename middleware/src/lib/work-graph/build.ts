// One viewer's authorized work-graph snapshot — the single builder behind the
// REST snapshot route (routes/work-graph.ts) and the live stream's per-viewer
// frames (lib/work-graph/stream.ts). Everything is re-decided for the session
// handed in (lib/work-graph/authority.ts), so a stream frame can carry only
// what that same viewer's REST snapshot would at the same moment.

import { clock } from '../../mock/core/index.js';
import type { Session } from '../session.js';
import type { WorkGraphSnapshot, WorkGraphSnapshotV2 } from '@connorhoehn/realtime-modules/work-graph';
import { assessmentWorkGraphViewer, confirmAssessmentWorkGraphViewer, confirmPipelinesWorkGraphViewer, confirmSocialWorkGraphViewer, confirmWorkGraphViewer, pipelinesWorkGraphViewer, socialWorkGraphViewer, workGraphViewer, type WorkGraphViewer } from './authority.js';
import { loadSocialWorkGraphRows } from './social-sources.js';
import { projectSocialWorkGraph } from './social-projection.js';
import { loadAssessmentWorkGraphRows } from './assessment-sources.js';
import { projectAssessmentWorkGraph } from './assessment-projection.js';
import { loadPipelinesWorkGraphRows } from './pipelines-sources.js';
import { projectPipelinesWorkGraph } from './pipelines-projection.js';
import { loadWorkGraphRows, type WorkGraphSubject } from './sources.js';
import { projectWorkGraph } from './projection.js';
import {
  assembleWorkGraphSnapshot, assessmentPolicyRevisionFor, pipelinesPolicyRevisionFor, policyRevisionFor, socialPolicyRevisionFor, subjectKey,
  type AnyWorkGraphSubject, type AssessmentWorkGraphSubject, type PipelinesWorkGraphSubject, type SocialWorkGraphSubject, type WorkGraphQuery, type WorkGraphTenant,
} from './snapshot.js';

/** What a caller of either tenant's builder needs of the viewer: whose snapshot this is. */
export interface BuiltWorkGraph { snapshot: WorkGraphSnapshot | WorkGraphSnapshotV2; viewer: { session: Session } }

/** Null when the subject is unavailable (the route's uniform 404). Throws the
 * route's 401/403/503 AppErrors; a grant or epoch change during the reads refuses. */
export async function buildViewerWorkGraph(source: Session | undefined, subject: WorkGraphSubject, query: WorkGraphQuery): Promise<BuiltWorkGraph | null> {
  const viewer = await workGraphViewer(source);
  const rows = await loadWorkGraphRows(subject, viewer.reads, query.window, { session: viewer.session, timezone: query.timezone });
  // After the reads: nothing they returned can postdate the observation.
  const observedAt = clock.nowIso();
  if (!rows) return null;
  const projection = projectWorkGraph({
    window: query.window, observedAt, scope: subject.kind === 'initiative' ? 'initiative' : 'workspace',
    initiatives: rows.initiatives, items: rows.items, bots: rows.bots, runs: rows.runs, documents: rows.documents,
    sprints: rows.sprints, decisions: rows.decisions, flowRuns: rows.flowRuns, jobs: rows.jobs, timezone: query.timezone,
    reads: viewer.reads,
  });
  const snapshot = assembleWorkGraphSnapshot({
    subject, query, projection, sources: rows.sources, observedAt,
    authorizationUnavailable: viewer.unavailable.some(k => k === 'botRuns' || k === 'marketplaceRuns' || k === 'dispatch'),
    recordsUnavailable: viewer.unavailable.some(k => k === 'sprintsWide' || k === 'grants'),
    complete: rows.complete,
    policyRevision: policyRevisionFor(`${viewer.session.sub}|${viewer.session.tenant}|${viewer.session.role}|${viewer.session.epoch}`, viewer.reads, viewer.unavailable),
  });
  // A grant or epoch change while the rows were read refuses the answer.
  await confirmWorkGraphViewer(viewer);
  return { snapshot, viewer };
}

/** The pipelines counterpart (docs/activity-graph-migration.md §8): the same assembly and v2 validation,
 * over the pipelines gates. Null when the run is unreadable or absent (the route's uniform 404). */
export async function buildPipelinesViewerWorkGraph(source: Session | undefined, subject: PipelinesWorkGraphSubject, query: WorkGraphQuery): Promise<BuiltWorkGraph | null> {
  const viewer = await pipelinesWorkGraphViewer(source);
  const rows = await loadPipelinesWorkGraphRows(subject, viewer.reads, query.window, viewer.session);
  const observedAt = clock.nowIso();
  if (!rows) return null;
  const projection = projectPipelinesWorkGraph({
    window: query.window, observedAt, scope: subject.kind === 'run' ? 'run' : 'workspace', ...(subject.kind === 'run' ? { focusRunId: subject.id } : {}),
    definitions: rows.definitions, runs: rows.runs, steps: rows.steps, approvals: rows.approvals, decks: rows.decks, flowRuns: rows.flowRuns,
    reads: viewer.reads,
  });
  const snapshot = assembleWorkGraphSnapshot({
    subject, query, projection, sources: rows.sources, observedAt,
    authorizationUnavailable: viewer.unavailable.length > 0, tenant: 'pipelines',
    complete: rows.complete,
    policyRevision: pipelinesPolicyRevisionFor(`${viewer.session.sub}|${viewer.session.tenant}|${viewer.session.role}|${viewer.session.epoch}`, viewer.reads, viewer.unavailable),
  });
  await confirmPipelinesWorkGraphViewer(viewer);
  return { snapshot, viewer };
}

/** The assessment counterpart (docs/activity-graph-migration.md §9). Null when the team is unreadable or absent (the route's uniform 404). */
export async function buildAssessmentViewerWorkGraph(source: Session | undefined, subject: AssessmentWorkGraphSubject, query: WorkGraphQuery): Promise<BuiltWorkGraph | null> {
  const viewer = await assessmentWorkGraphViewer(source);
  const rows = await loadAssessmentWorkGraphRows(subject, viewer.reads, query.window, viewer.session);
  const observedAt = clock.nowIso();
  if (!rows) return null;
  const projection = projectAssessmentWorkGraph({
    window: query.window, observedAt, scope: subject.kind === 'team' ? 'team' : 'workspace', ...(subject.kind === 'team' ? { focusTeamId: subject.id } : {}),
    teams: rows.teams, dimensions: rows.dimensions, evidence: rows.evidence, drafts: rows.drafts, decks: rows.decks, runs: rows.runs, flowRuns: rows.flowRuns,
    reads: viewer.reads,
  });
  const snapshot = assembleWorkGraphSnapshot({
    subject, query, projection, sources: rows.sources, observedAt,
    authorizationUnavailable: viewer.unavailable.length > 0, tenant: 'assessment',
    complete: rows.complete,
    policyRevision: assessmentPolicyRevisionFor(`${viewer.session.sub}|${viewer.session.tenant}|${viewer.session.role}|${viewer.session.epoch}`, viewer.reads, viewer.unavailable),
  });
  await confirmAssessmentWorkGraphViewer(viewer);
  return { snapshot, viewer };
}

/** The social counterpart (docs/activity-graph-migration.md §10). Null when the conversation is not one the viewer belongs to (the route's uniform 404). */
export async function buildSocialViewerWorkGraph(source: Session | undefined, subject: SocialWorkGraphSubject, query: WorkGraphQuery): Promise<BuiltWorkGraph | null> {
  const viewer = await socialWorkGraphViewer(source);
  const rows = await loadSocialWorkGraphRows(subject, viewer.reads, query.window, viewer.session);
  const observedAt = clock.nowIso();
  if (!rows) return null;
  const projection = projectSocialWorkGraph({
    window: query.window, observedAt, scope: subject.kind === 'conversation' ? 'conversation' : 'workspace',
    ...(subject.kind === 'conversation' ? { focusConversationId: subject.id } : {}),
    conversations: rows.conversations, teams: rows.teams, threads: rows.threads, calls: rows.calls, recordings: rows.recordings,
    decks: rows.decks, flowRuns: rows.flowRuns, reads: viewer.reads,
  });
  const snapshot = assembleWorkGraphSnapshot({
    subject, query, projection, sources: rows.sources, observedAt,
    authorizationUnavailable: viewer.unavailable.length > 0, tenant: 'social',
    complete: rows.complete,
    policyRevision: socialPolicyRevisionFor(`${viewer.session.sub}|${viewer.session.tenant}|${viewer.session.role}|${viewer.session.epoch}`, viewer.reads, viewer.unavailable),
  });
  await confirmSocialWorkGraphViewer(viewer);
  return { snapshot, viewer };
}

/** One tenant's builder, chosen by the stream channel's family (stream.ts). */
export function buildTenantWorkGraph(tenant: WorkGraphTenant, source: Session | undefined, subject: AnyWorkGraphSubject, query: WorkGraphQuery): Promise<BuiltWorkGraph | null> {
  if (tenant === 'social') return buildSocialViewerWorkGraph(source, subject as SocialWorkGraphSubject, query);
  if (tenant === 'assessment') return buildAssessmentViewerWorkGraph(source, subject as AssessmentWorkGraphSubject, query);
  return tenant === 'pipelines'
    ? buildPipelinesViewerWorkGraph(source, subject as PipelinesWorkGraphSubject, query)
    : buildViewerWorkGraph(source, subject as WorkGraphSubject, query);
}

/** The policy revision this viewer would be served right now — what an access signal compares (stream.ts). */
export async function viewerPolicyRevision(tenant: WorkGraphTenant, source: Session | undefined): Promise<string> {
  if (tenant === 'social') {
    const viewer = await socialWorkGraphViewer(source);
    return socialPolicyRevisionFor(`${viewer.session.sub}|${viewer.session.tenant}|${viewer.session.role}|${viewer.session.epoch}`, viewer.reads, viewer.unavailable);
  }
  if (tenant === 'pipelines') {
    const viewer = await pipelinesWorkGraphViewer(source);
    return pipelinesPolicyRevisionFor(`${viewer.session.sub}|${viewer.session.tenant}|${viewer.session.role}|${viewer.session.epoch}`, viewer.reads, viewer.unavailable);
  }
  if (tenant === 'assessment') {
    const viewer = await assessmentWorkGraphViewer(source);
    return assessmentPolicyRevisionFor(`${viewer.session.sub}|${viewer.session.tenant}|${viewer.session.role}|${viewer.session.epoch}`, viewer.reads, viewer.unavailable);
  }
  const viewer = await workGraphViewer(source);
  return policyRevisionFor(`${viewer.session.sub}|${viewer.session.tenant}|${viewer.session.role}|${viewer.session.epoch}`, viewer.reads, viewer.unavailable);
}

// ── The snapshots this process served, for the stream's catch-up ───────────
//
// A reader opens its stream from the cursor of a snapshot it just fetched. To
// send it a delta for what changed in between, the stream needs THAT snapshot:
// the one this viewer was served (never another viewer's — the key carries the
// viewer). Short-lived and bounded; a miss only costs the reader a refetch.

const SERVED_TTL_MS = 120_000;
const SERVED_MAX = 512;
interface Served { at: number; snapshot: WorkGraphSnapshot | WorkGraphSnapshotV2 }
const served = new Map<string, Served>();
const servedKey = (viewerId: string, personId: string, day: string, timezone: string, cursor: string) =>
  JSON.stringify([viewerId, personId, day, timezone, cursor]);

export function rememberServedWorkGraph(viewerId: string, snapshot: WorkGraphSnapshot | WorkGraphSnapshotV2): void {
  const now = Date.now();
  const key = servedKey(viewerId, snapshot.scope.personId, snapshot.scope.day, snapshot.scope.timezone, snapshot.cursor);
  served.delete(key);
  served.set(key, { at: now, snapshot });
  for (const [k, v] of served) {
    if (served.size <= SERVED_MAX && now - v.at <= SERVED_TTL_MS) break;
    served.delete(k);
  }
}

/** Taken, not read: one subscription adopts it as its baseline. */
export function takeServedWorkGraph(viewerId: string, personId: string, day: string, timezone: string, cursor: string): WorkGraphSnapshot | WorkGraphSnapshotV2 | null {
  const key = servedKey(viewerId, personId, day, timezone, cursor);
  const hit = served.get(key);
  if (!hit) return null;
  served.delete(key);
  return Date.now() - hit.at <= SERVED_TTL_MS ? hit.snapshot : null;
}
export function resetServedWorkGraphs(): void { served.clear(); }
export { subjectKey };
