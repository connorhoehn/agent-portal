// Reads the rows the assessment work graph draws, through the SAME providers the
// /api/assessment routes use, and only the parts the viewer's gates admit
// (lib/work-graph/authority.ts assessmentWorkGraphViewer). A viewer without
// ViewAssessment never causes a team, draft, deck or run to be read.

import { listTeams, getTeamDetail, listEvidence, listRuns } from '../../providers/assessment.js';
import { listDecks } from '../../providers/assessment-decks.js';
import { DRAFT_KINDS, DRAFT_TENANT, draftView } from '../assessment-drafts.js';
import { flowRunStore, type FlowRunRow } from '../flow-runs/index.js';
import type { Session } from '../session.js';
import { firstLine } from '../upstream.js';
import { intervalOverlapsWorkDay } from './day-overlap.js';
import type { SourceHealth } from './sources.js';
import type { FlowRunGraphRow } from './projection.js';
import type { ADeckRow, ADimensionRow, ADraftRow, AEvidenceRow, ARunRow, ATeamRow, AssessmentViewerReads } from './assessment-projection.js';
import type { AssessmentWorkGraphSubject } from './snapshot.js';

export const ASSESSMENT_FLOW_KINDS = ['assessment.summarize', 'assessment.diagram', 'assessment.doc', 'assessment.agent'] as const;
export const ASSESSMENT_FLOW_READ_CAP = 50;
/** Teams whose detail the workspace graph reads in one request (newest first, plus any a draft/deck/run names). */
export const ASSESSMENT_TEAM_READ_CAP = 60;
export const ASSESSMENT_RUN_READ_CAP = 100;
export const ASSESSMENT_DRAFT_READ_CAP = 200;

export interface AssessmentWorkGraphRows {
  teams: ATeamRow[]; dimensions: ADimensionRow[]; evidence: AEvidenceRow[]; drafts: ADraftRow[]; decks: ADeckRow[]; runs: ARunRow[];
  flowRuns: FlowRunGraphRow[]; sources: SourceHealth[]; complete: boolean;
}

function flowRow(run: FlowRunRow): FlowRunGraphRow {
  return {
    id: run.id, kind: run.kind, scope: run.scope, status: run.status, steps: run.progress.map(step => ({ status: step.status })),
    createdAt: run.createdAt, updatedAt: run.updatedAt, finishedAt: run.finishedAt, leaseExpiresAt: run.leaseExpiresAt,
  };
}

/** The viewer's OWN flow runs of the assessment kinds, each re-checked against its conversation's read authority. */
async function readOwnFlowRuns(session: Session, windowStart: string): Promise<{ rows: FlowRunRow[]; capped: boolean }> {
  const own = await flowRunStore.listByRequester('assessment', session.sub, ASSESSMENT_FLOW_KINDS, windowStart, ASSESSMENT_FLOW_READ_CAP);
  if (own.length === 0) return { rows: [], capped: false };
  const { sessionGatewayContext } = await import('../live-principal.js');
  const { admitConversationChat } = await import('../gateway/authority.js');
  const verdicts = new Map<string, boolean>();
  const rows: FlowRunRow[] = [];
  for (const run of own) {
    if (!verdicts.has(run.scope)) {
      verdicts.set(run.scope, await admitConversationChat(
        { ctx: sessionGatewayContext(session), channel: run.scope, kind: 'subscribe', clientId: 'rest:work-graph' }));
    }
    if (verdicts.get(run.scope)) rows.push(run);
  }
  return { rows, capped: own.length >= ASSESSMENT_FLOW_READ_CAP };
}

/** Null when the subject (a team) is unreadable or absent (the route answers the uniform 404). */
export async function loadAssessmentWorkGraphRows(
  subject: AssessmentWorkGraphSubject, reads: AssessmentViewerReads, window: { start: string; end: string }, session: Session,
): Promise<AssessmentWorkGraphRows | null> {
  const empty: AssessmentWorkGraphRows = { teams: [], dimensions: [], evidence: [], drafts: [], decks: [], runs: [], flowRuns: [], sources: [], complete: true };
  if (!reads.view) return subject.kind === 'team' ? null : empty;
  const problems: string[] = [];
  let complete = true;
  const teamId = subject.kind === 'team' ? subject.id : undefined;
  const touched = (at: string | null | undefined) => !!at && intervalOverlapsWorkDay(at, at, window);

  // Drafts, decks and runs first: in the workspace they name teams whose detail is read.
  let drafts: ADraftRow[] = [];
  try {
    const flows = await flowRunStore.listTenantSince(DRAFT_TENANT, DRAFT_KINDS, window.start, ASSESSMENT_DRAFT_READ_CAP);
    if (flows.length >= ASSESSMENT_DRAFT_READ_CAP) complete = false;
    drafts = flows.map(run => {
      const view = draftView(run);
      return {
        id: run.id, kind: run.kind, teamId: view.teamId, dimensionId: view.dimensionId, status: run.status, decision: view.decision,
        createdAt: run.createdAt, updatedAt: run.updatedAt, finishedAt: run.finishedAt, requestedBy: run.requestedBy, revision: view.revision,
        leaseExpiresAt: run.leaseExpiresAt,
      };
    }).filter(d => !teamId || d.teamId === teamId);
  } catch (err) { problems.push(`drafts: ${firstLine(err)}`); }

  let decks: ADeckRow[] = [];
  try {
    decks = (await listDecks(teamId)).map(d => ({ id: d.id, teamId: d.teamId, title: d.title, updatedAt: d.updatedAt, revisionLabel: d.latestRevision?.label ?? null }));
  } catch (err) { problems.push(`decks: ${firstLine(err)}`); }

  let runs: ARunRow[] = [];
  try {
    runs = (await listRuns({ ...(teamId ? { team: teamId } : {}), limit: ASSESSMENT_RUN_READ_CAP })).map(r => ({
      id: r.id, command: r.command, teamId: r.team_id, deckId: typeof r.args?.['deck_id'] === 'string' ? String(r.args['deck_id']) : null,
      status: r.status, startedAt: r.started_at, finishedAt: r.finished_at, summary: r.summary,
    }));
  } catch (err) { problems.push(`runs: ${firstLine(err)}`); }

  // Teams.
  let teams: ATeamRow[] = [];
  const dimensions: ADimensionRow[] = [];
  const evidence: AEvidenceRow[] = [];
  try {
    const summaries = await listTeams();
    if (teamId && !summaries.some(t => t.id === teamId)) return null;
    const named = new Set([...drafts.map(d => d.teamId), ...decks.filter(d => touched(d.updatedAt)).map(d => d.teamId), ...runs.map(r => r.teamId).filter((t): t is string => !!t)]);
    const wanted = teamId
      ? summaries.filter(t => t.id === teamId)
      : [...summaries].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).filter((t, i) => i < ASSESSMENT_TEAM_READ_CAP || named.has(t.id));
    if (!teamId && summaries.length > wanted.length) complete = false;
    teams = wanted.map(t => ({ id: t.id, name: t.name, cohort: t.cohort, lead: t.assessment_lead || null, updatedAt: t.updated_at }));
    await Promise.all(wanted.map(async t => {
      const detail = await getTeamDetail(t.id);
      if (!detail) return;
      for (const d of detail.dimensions) {
        const changed = d.history.reduce<string | null>((acc, h) => (!acc || h.changed_at > acc ? h.changed_at : acc), null);
        const latestEntry = d.history.find(h => h.changed_at === changed);
        dimensions.push({
          teamId: t.id, id: d.id, title: d.title, level: d.current_level, isNa: d.is_na, confidence: d.confidence,
          changedAt: changed, changedBy: latestEntry?.changed_by ?? null, followupsOpen: d.follow_up_questions.filter(q => q.status === 'OPEN').length,
        });
      }
      for (const e of (await listEvidence(t.id)) ?? []) {
        evidence.push({
          teamId: t.id, id: e.evidence_id, dimensionId: e.dimension_id || null, sourceType: e.source_type, excerpt: e.excerpt,
          capturedAt: e.captured_at, status: e.status, supportsLevel: e.supports_level,
        });
      }
    }));
  } catch (err) { problems.push(`teams: ${firstLine(err)}`); }
  if (teamId && !teams.some(t => t.id === teamId)) return problems.length ? { ...empty, sources: [{ source: 'document', health: 'delayed', message: problems.join('; ') }], complete: false } : null;

  let flowRuns: FlowRunGraphRow[] = [];
  if (reads.run) {
    try {
      const read = await readOwnFlowRuns(session, window.start);
      if (read.capped) complete = false;
      flowRuns = read.rows.map(flowRow);
    } catch (err) { problems.push(`flow runs: ${firstLine(err)}`); }
  }

  const sources: SourceHealth[] = [{ source: 'document', health: problems.length ? 'delayed' : 'available', ...(problems.length ? { message: problems.join('; ') } : {}) }];
  return { teams, dimensions, evidence, drafts, decks, runs, flowRuns, sources, complete };
}
