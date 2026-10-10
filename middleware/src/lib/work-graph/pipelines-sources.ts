// Reads the rows the pipelines work graph draws, through the SAME providers the
// /api/pipelines routes use, and only the parts the viewer's gates admit
// (lib/work-graph/authority.ts pipelinesWorkGraphViewer). A viewer without
// ApproveStep never causes the approvals queue to be read.

import { loadProjection } from '../../providers/pipeline-runs.js';
import { loadDefinitions, listApprovals } from '../../providers/pipeline-definitions.js';
import { listDecks } from '../../providers/pipeline-decks.js';
import { flowRunStore, PIPELINE_DECK_REVISE_KIND, type FlowRunRow } from '../flow-runs/index.js';
import type { Session } from '../session.js';
import { firstLine } from '../upstream.js';
import type { SourceHealth } from './sources.js';
import type { FlowRunGraphRow } from './projection.js';
import type { PApprovalRow, PDeckRow, PDefinitionRow, PipelinesViewerReads, PRunRow, PStepRow } from './pipelines-projection.js';
import type { PipelinesWorkGraphSubject } from './snapshot.js';

export const PIPELINES_FLOW_KINDS = ['pipelines.summarize', 'pipelines.diagram', 'pipelines.doc', 'pipelines.agent', PIPELINE_DECK_REVISE_KIND] as const;
export const PIPELINES_FLOW_READ_CAP = 50;

export interface PipelinesWorkGraphRows {
  definitions: PDefinitionRow[];
  runs: PRunRow[];
  steps: PStepRow[];
  approvals: PApprovalRow[];
  decks: PDeckRow[];
  flowRuns: FlowRunGraphRow[];
  sources: SourceHealth[];
  complete: boolean;
}

function flowRow(run: FlowRunRow): FlowRunGraphRow {
  return {
    id: run.id, kind: run.kind, scope: run.scope, status: run.status, steps: run.progress.map(step => ({ status: step.status })),
    createdAt: run.createdAt, updatedAt: run.updatedAt, finishedAt: run.finishedAt, leaseExpiresAt: run.leaseExpiresAt,
  };
}

/** The viewer's OWN flow runs of the pipelines kinds. A conversation flow is re-checked against its
 * conversation's read authority; a deck revision is its requester's alone, behind ViewPipelines
 * (GET /api/pipelines/decks/:id/runs/:runId). */
async function readOwnFlowRuns(session: Session, windowStart: string): Promise<{ rows: FlowRunRow[]; capped: boolean }> {
  const own = await flowRunStore.listByRequester('pipelines', session.sub, PIPELINES_FLOW_KINDS, windowStart, PIPELINES_FLOW_READ_CAP);
  if (own.length === 0) return { rows: [], capped: false };
  const { sessionGatewayContext } = await import('../live-principal.js');
  const { admitConversationChat } = await import('../gateway/authority.js');
  const verdicts = new Map<string, boolean>();
  const rows: FlowRunRow[] = [];
  for (const run of own) {
    if (run.kind === PIPELINE_DECK_REVISE_KIND) { rows.push(run); continue; }
    if (!verdicts.has(run.scope)) {
      verdicts.set(run.scope, await admitConversationChat(
        { ctx: sessionGatewayContext(session), channel: run.scope, kind: 'subscribe', clientId: 'rest:work-graph' }));
    }
    if (verdicts.get(run.scope)) rows.push(run);
  }
  return { rows, capped: own.length >= PIPELINES_FLOW_READ_CAP };
}

/** Null when the subject (a run) is unreadable or absent (the route answers the uniform 404). */
export async function loadPipelinesWorkGraphRows(
  subject: PipelinesWorkGraphSubject, reads: PipelinesViewerReads, window: { start: string; end: string }, session: Session,
): Promise<PipelinesWorkGraphRows | null> {
  const empty: PipelinesWorkGraphRows = { definitions: [], runs: [], steps: [], approvals: [], decks: [], flowRuns: [], sources: [], complete: true };
  if (!reads.view) return subject.kind === 'run' ? null : empty;
  const sources: SourceHealth[] = [];
  let complete = true;
  const problems: string[] = [];

  const projection = await loadProjection();
  for (const u of projection.unavailable) problems.push(`${u.table}: ${firstLine(u.error)}`);
  if (subject.kind === 'run' && !projection.runs.some(r => r.id === subject.id)) return null;
  const runs: PRunRow[] = projection.runs.map(r => ({
    id: r.id, definitionId: r.definitionId, status: r.status, triggeredBy: r.triggeredBy, triggerType: r.triggerType,
    startedAt: r.startedAt, finishedAt: r.finishedAt, costUsd: r.costUsd, contextTenant: r.context.tenant,
  }));
  const wanted = (runId: string) => subject.kind !== 'run' || runId === subject.id;
  const steps: PStepRow[] = [];
  for (const [runId, list] of projection.steps) {
    if (!wanted(runId)) continue;
    for (const s of list) steps.push({ runId, stepId: s.stepId, label: s.label, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt, detail: s.detail ?? null });
  }

  let definitions: PDefinitionRow[] = [];
  try {
    const loaded = await loadDefinitions();
    for (const u of loaded.unavailable) problems.push(`${u.source}: ${firstLine(u.error)}`);
    definitions = loaded.definitions.map(d => ({ id: d.id, title: d.title, kind: d.kind, enabled: d.enabled, owner: d.owner }));
  } catch (err) { problems.push(`definitions: ${firstLine(err)}`); }

  // Approvals: read only for a viewer who may decide them.
  let approvals: PApprovalRow[] = [];
  if (reads.approvals) {
    try {
      const listed = await listApprovals();
      for (const u of listed.unavailable) problems.push(`${u.source}: ${firstLine(u.error)}`);
      approvals = listed.approvals.filter(a => subject.kind !== 'run' || a.runId === subject.id).map(a => ({
        id: a.id, source: a.source, runId: a.runId, definitionId: a.definitionId, stepId: a.stepId, title: a.title, question: a.question, requestedAt: a.requestedAt, requiredRoles: a.requiredRoles,
      }));
    } catch (err) { problems.push(`approvals: ${firstLine(err)}`); }
  }

  let decks: PDeckRow[] = [];
  try {
    decks = (await listDecks(subject.kind === 'run' ? subject.id : undefined)).map(d => ({
      id: d.id, runId: d.runId, title: d.title, updatedAt: d.updatedAt,
      revisionLabel: d.latestRevision?.label ?? null, producedBy: d.latestRevision?.producedBy ?? null,
    }));
  } catch (err) { problems.push(`decks: ${firstLine(err)}`); }

  let flowRuns: FlowRunGraphRow[] = [];
  try {
    const read = await readOwnFlowRuns(session, window.start);
    if (read.capped) complete = false;
    flowRuns = read.rows.map(flowRow);
  } catch (err) { problems.push(`flow runs: ${firstLine(err)}`); }

  sources.push({ source: 'pipeline', health: problems.length ? 'delayed' : 'available', ...(problems.length ? { message: problems.join('; ') } : {}) });
  return { definitions, runs, steps, approvals, decks, flowRuns, sources, complete };
}
