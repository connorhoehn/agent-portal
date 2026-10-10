// One viewer's authorized work-graph snapshot — the single builder behind the
// REST snapshot route (routes/work-graph.ts) and the live stream's per-viewer
// frames (lib/work-graph/stream.ts). Everything is re-decided for the session
// handed in (lib/work-graph/authority.ts), so a stream frame can carry only
// what that same viewer's REST snapshot would at the same moment.

import { clock } from '../../mock/core/index.js';
import type { Session } from '../session.js';
import type { WorkGraphSnapshot, WorkGraphSnapshotV2 } from '@connorhoehnslalom/realtime-modules/work-graph';
import { confirmWorkGraphViewer, workGraphViewer, type WorkGraphViewer } from './authority.js';
import { loadWorkGraphRows, type WorkGraphSubject } from './sources.js';
import { projectWorkGraph } from './projection.js';
import { assembleWorkGraphSnapshot, policyRevisionFor, subjectKey, type WorkGraphQuery } from './snapshot.js';

export interface BuiltWorkGraph { snapshot: WorkGraphSnapshot | WorkGraphSnapshotV2; viewer: WorkGraphViewer }

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
    sprints: rows.sprints, decisions: rows.decisions, flowRuns: rows.flowRuns, timezone: query.timezone,
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
