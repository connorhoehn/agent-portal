// Reads the rows the work-graph projection draws, through the SAME providers
// the REST routes use, and only the parts the viewer's gates admit
// (lib/work-graph/authority.ts). Nothing is fetched and then filtered for a
// viewer who may not read it: a member's request never touches bot_runs.
//
// Mock mode: the seeded work items carry frozen-epoch offsets, so their
// timestamps go through `mockReprojectedIso` — the one reprojection the
// initiative activity feed and series already share (providers/work-items.ts).

import { config } from '../../config.js';
import { getProject, listProjects } from '../../providers/projects.js';
import { aurora } from '../../providers/index.js';
import { getProjectWorkItems, mockReprojectedIso, type WorkItem } from '../../providers/work-items.js';
import { listBotsResult, listBotRunsForBotsResult, listMarketplaceRuns, type BotRun } from '../../providers/bots.js';
import { listWorkDocuments } from '../../providers/work-documents.js';
import { listJobs, type AgentJob } from '../../providers/agent-jobs.js';
import { listSprints, type SprintRow } from '../../providers/sprints.js';
import { listGrants } from '../../providers/budgets.js';
import { listDecisionActivity, DECISION_ACTIVITY_LIMIT } from '../../providers/decisions.js';
import { getUser } from '../../providers/identity.js';
import { flowRunStore, type FlowRunRow } from '../flow-runs/index.js';
import type { Session } from '../session.js';
import { firstLine } from '../upstream.js';
import { intervalOverlapsWorkDay } from './day-overlap.js';
import { type WorkDayWindow, type WorkSourceKind, type WorkSourceHealth } from '@connorhoehnslalom/realtime-modules/work-graph';
import {
  isoInstant, type BotRow, type DecisionGraphRow, type DocumentLinkRow, type FlowRunGraphRow, type InitiativeRow, type JobGraphRow, type RunRow,
  type SprintGraphRow, type ViewerReads, type WorkItemRow,
} from './projection.js';

/** `person`: one person's day — framed by assignee (work items), steward (sprints), participant (decisions)
 * and, for the viewer's own person only, requester (flow runs). */
export type WorkGraphSubject = { kind: 'initiative'; id: string } | { kind: 'workspace' } | { kind: 'person'; id: string };

/** What the loader needs of the request besides the gates. */
export interface WorkGraphLoadContext { session: Session; timezone: string }

/** Per-bot history depth read for the graph (the bots page reads 50 too). */
export const BOT_RUN_DEPTH = 50;
export const MARKETPLACE_RUN_DEPTH = 100;
/** Document lookups are one query per work item; bounded per request. */
export const DOCUMENT_LOOKUP_CAP = 100;
export const SPRINT_READ_CAP = 300;
export const FLOW_RUN_READ_CAP = 50;
/** Live queue rows read per status (queued / claimed / running). */
export const JOB_READ_CAP = 100;
export const LIVE_JOB_STATUSES = ['queued', 'claimed', 'running'] as const;
/** The orgiq durable flow kinds (lib/flow-runs/channel.ts CONVERSATION_*_KINDS). */
export const ORGIQ_FLOW_KINDS = ['orgiq.summarize', 'orgiq.diagram', 'orgiq.doc'] as const;

export interface SourceHealth { source: WorkSourceKind; health: WorkSourceHealth; message?: string }
export interface WorkGraphRows {
  initiatives: InitiativeRow[];
  items: WorkItemRow[];
  bots: BotRow[];
  runs: RunRow[];
  documents: DocumentLinkRow[];
  sprints: SprintGraphRow[];
  decisions: DecisionGraphRow[];
  flowRuns: FlowRunGraphRow[];
  jobs: JobGraphRow[];
  /** The subject person's display name (person subjects only). */
  personName?: string;
  sources: SourceHealth[];
  /** False when a bounded read may have stopped short of the day (history depth). */
  complete: boolean;
}

const onCalendar = (iso: string | null): string | null => (iso && config.mock.aurora ? mockReprojectedIso(iso) : iso);

function itemRow(item: WorkItem): WorkItemRow {
  return {
    id: item.id, projectId: item.projectId, parentId: item.parentId, type: item.type, title: item.title, status: item.status,
    sprintId: item.sprintId ?? null,
    priority: item.priority, assigneeId: item.assigneeId, assigneeName: item.assigneeName, blockedReason: item.blockedReason,
    nextStep: item.nextStep, createdAt: onCalendar(item.createdAt)!, updatedAt: onCalendar(item.updatedAt)!, completedAt: onCalendar(item.completedAt),
  };
}
function runRow(run: BotRun, projectId: string): RunRow {
  return {
    id: run.id, botId: run.botId, trigger: run.trigger, workItemId: run.workItemId, status: run.status, costUsd: run.costUsd,
    modelProvider: run.modelProvider, startedAt: run.startedAt, finishedAt: run.finishedAt, projectId, jobId: run.jobId ?? null,
  };
}

/** The item-in-day rule the projection applies, used here to bound document lookups. */
function itemTouchesDay(item: WorkItemRow, window: Pick<WorkDayWindow, 'start' | 'end'>): boolean {
  const start = isoInstant(item.createdAt) ?? isoInstant(item.updatedAt);
  if (!start) return false;
  const closed = item.status === 'done' || item.status === 'cancelled';
  const end = closed ? (isoInstant(item.completedAt) ?? isoInstant(item.updatedAt) ?? start) : undefined;
  return intervalOverlapsWorkDay(start, end && end < start ? start : end, window);
}

function sprintRow(sprint: SprintRow): SprintGraphRow {
  return {
    id: sprint.id, orgProjectId: sprint.orgProjectId, name: sprint.name, goal: sprint.goal, stewardPersonId: sprint.stewardPersonId,
    stewardName: sprint.stewardName, startsOn: sprint.startsOn, endsOn: sprint.endsOn, status: sprint.status,
    itemCount: sprint.itemCount, doneItemCount: sprint.doneItemCount, pointsTotal: sprint.pointsTotal, pointsDone: sprint.pointsDone,
    estimatedCostUsd: sprint.estimatedCostUsd, grantedUsd: sprint.grantedUsd, grantCount: sprint.grantCount,
  };
}
function flowRow(run: FlowRunRow): FlowRunGraphRow {
  return {
    id: run.id, kind: run.kind, scope: run.scope, status: run.status, steps: run.progress.map(step => ({ status: step.status })),
    createdAt: run.createdAt, updatedAt: run.updatedAt, finishedAt: run.finishedAt, leaseExpiresAt: run.leaseExpiresAt,
  };
}

/** Sprints the viewer's gate admits: all of them at the budgets read tier, else
 * only their own (`GET /api/sprints?scope=mine`, keyed by their linked person). */
async function readSprints(subject: WorkGraphSubject, reads: ViewerReads, viewerPerson: string | null): Promise<{ rows: SprintRow[]; capped: boolean }> {
  const orgProjectId = subject.kind === 'initiative' ? subject.id : undefined;
  let rows: SprintRow[];
  if (reads.sprintsWide) rows = await listSprints({ ...(orgProjectId ? { orgProjectId } : {}), limit: SPRINT_READ_CAP });
  else if (viewerPerson) rows = await listSprints({ personId: viewerPerson, mineOnly: true, ...(orgProjectId ? { orgProjectId } : {}), limit: SPRINT_READ_CAP });
  else rows = [];
  return { rows, capped: rows.length >= SPRINT_READ_CAP };
}

/** The viewer's OWN flow runs of the orgiq kinds, each re-checked against its
 * conversation's read authority (routes/conversation-summarize.ts ownRun). */
async function readFlowRuns(session: Session, windowStart: string): Promise<{ rows: FlowRunRow[]; capped: boolean }> {
  const own = await flowRunStore.listByRequester('orgiq', session.sub, ORGIQ_FLOW_KINDS, windowStart, FLOW_RUN_READ_CAP);
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
  return { rows, capped: own.length >= FLOW_RUN_READ_CAP };
}

const stringOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** A live job's attribution: the payload's own work item / initiative (checked against the rows
 * already read), else its bot's target initiative. Unattributable jobs are not drawn. */
function jobRow(job: AgentJob, itemProject: Map<string, string>, botTarget: Map<string, string>): JobGraphRow | null {
  if (job.status !== 'queued' && job.status !== 'claimed' && job.status !== 'running') return null;
  const workItemId = stringOf(job.payload['workItemId']);
  const projectId = (workItemId ? itemProject.get(workItemId) : undefined)
    ?? (job.botId ? botTarget.get(job.botId) : undefined) ?? stringOf(job.payload['initiativeId']);
  if (!projectId) return null;
  return {
    id: job.id, kind: job.kind, title: job.title, status: job.status, botId: job.botId, projectId,
    workItemId: workItemId && itemProject.has(workItemId) ? workItemId : null,
    createdAt: job.createdAt, claimedAt: job.claimedAt, startedAt: job.startedAt,
  };
}

/** Null when the subject (initiative or person) does not exist (the route answers 404). */
export async function loadWorkGraphRows(
  subject: WorkGraphSubject, reads: ViewerReads, window: Pick<WorkDayWindow, 'start' | 'end'>, ctx: WorkGraphLoadContext,
): Promise<WorkGraphRows | null> {
  const sources: SourceHealth[] = [];
  let complete = true;
  const recordProblems: string[] = [];

  let personName: string | undefined;
  if (subject.kind === 'person') {
    const person = await aurora.fetchPersonGraph(subject.id);
    if (!person) return null;
    personName = person.name;
  }
  const personId = subject.kind === 'person' ? subject.id : null;

  let initiatives: InitiativeRow[];
  if (subject.kind === 'initiative') {
    const project = await getProject(subject.id);
    if (!project) return null;
    initiatives = [{ id: project.id, name: project.name, status: project.status, createdAt: project.createdAt, ownerName: project.ownerName }];
  } else {
    initiatives = (await listProjects({ limit: 200 })).map(p => ({ id: p.id, name: p.name, status: p.status, createdAt: p.createdAt, ownerName: p.ownerName }));
  }

  const allItems = (await Promise.all(initiatives.map(i => getProjectWorkItems(i.id)))).flat().map(itemRow);
  const items = personId ? allItems.filter(item => item.assigneeId === personId) : allItems;

  // The viewer's own person (app_users.person_id): "mine" sprints and own flow runs.
  const viewerPerson = (await getUser(ctx.session.sub))?.personId ?? null;

  // Sprints.
  let sprints: SprintGraphRow[] = [];
  try {
    const read = await readSprints(subject, reads, viewerPerson);
    if (read.capped) complete = false;
    let rows = read.rows;
    if (personId) {
      const itemSprints = new Set(items.map(i => i.sprintId).filter((id): id is string => !!id));
      rows = rows.filter(r => r.stewardPersonId === personId || itemSprints.has(r.id));
    }
    sprints = rows.map(sprintRow);
    if (reads.grants && sprints.length) {
      const grants = await listGrants(subject.kind === 'initiative' ? subject.id : undefined);
      for (const sprint of sprints) {
        const mine = grants.filter(g => g.sprintId === sprint.id);
        if (mine.length) sprint.envelopes = mine.map(g => ({ granteeName: g.granteeName, allocatedUsd: g.allocatedUsd }));
      }
    }
  } catch (err) { recordProblems.push(`Sprints: ${firstLine(err)}`); }

  // Decisions: tenant-gated like /api/graph/decisions.
  let decisions: DecisionGraphRow[] = [];
  try {
    const rows = await listDecisionActivity(subject.kind === 'initiative' ? { projectId: subject.id } : {});
    if (rows.length >= DECISION_ACTIVITY_LIMIT) complete = false;
    decisions = personId ? rows.filter(d => d.participants.some(p => p.personId === personId)) : rows;
  } catch (err) { recordProblems.push(`Decisions: ${firstLine(err)}`); }

  // Flow runs: the viewer's own, only (never another person's).
  let flowRuns: FlowRunGraphRow[] = [];
  if (!personId || personId === viewerPerson) {
    try {
      const read = await readFlowRuns(ctx.session, window.start);
      if (read.capped) complete = false;
      const itemIds = new Set(allItems.map(i => i.id));
      flowRuns = read.rows.filter(run => {
        if (subject.kind !== 'initiative') return true;
        const initiativeId = /^orgiq:initiative:(.+)$/.exec(run.scope)?.[1];
        const workId = /^orgiq:work:(.+)$/.exec(run.scope)?.[1];
        return initiativeId === subject.id || (!!workId && itemIds.has(workId));
      }).map(flowRow);
      sources.push({ source: 'pipeline', health: 'available' });
    } catch (err) { sources.push({ source: 'pipeline', health: 'delayed', message: firstLine(err) }); }
  }

  // A person's day draws only the initiatives their own rows touch.
  if (personId) {
    const touched = new Set<string>([
      ...items.map(i => i.projectId), ...sprints.map(s => s.orgProjectId),
      ...decisions.flatMap(d => (d.projectId ? [d.projectId] : [])),
      ...flowRuns.flatMap(f => { const m = /^orgiq:initiative:(.+)$/.exec(f.scope); return m ? [m[1]!] : []; }),
    ]);
    initiatives = initiatives.filter(i => touched.has(i.id));
  }
  const initiativeIds = new Set(initiatives.map(i => i.id));

  let bots: BotRow[] = [];
  const runs: RunRow[] = [];
  const jobs: JobGraphRow[] = [];
  if (reads.botRuns || reads.marketplaceRuns) {
    const wanted = personId ? new Set(items.map(i => i.id)) : null;
    let healthy = true; let message: string | undefined;
    if (reads.botRuns) {
      const roster = await listBotsResult();
      if (roster.degraded) { healthy = false; message = firstLine(roster.error); }
      bots = roster.items.filter(b => b.orgProjectId && initiativeIds.has(b.orgProjectId))
        .map(b => ({ id: b.id, name: b.name, model: b.model, enabled: b.enabled, pausedReason: b.pausedReason, orgProjectId: b.orgProjectId }));
      const history = await listBotRunsForBotsResult(bots.map(b => b.id), BOT_RUN_DEPTH);
      if (history.degraded) { healthy = false; message = firstLine(history.error); }
      const target = new Map(bots.map(b => [b.id, b.orgProjectId!]));
      for (const bot of bots) {
        const mine = history.items.filter(r => r.botId === bot.id);
        // A full page whose oldest row is still inside the day may have cut it short.
        if (mine.length >= BOT_RUN_DEPTH && mine.every(r => (isoInstant(r.startedAt) ?? '') >= window.start)) complete = false;
      }
      for (const run of history.items) {
        if (!run.botId || !target.has(run.botId)) continue;
        // A person's day keeps only the runs that operated on their own work.
        if (wanted && !(run.workItemId && wanted.has(run.workItemId))) continue;
        runs.push(runRow(run, target.get(run.botId)!));
      }
    }
    if (reads.marketplaceRuns) {
      for (const initiative of initiatives) {
        try {
          const market = await listMarketplaceRuns(initiative.id, MARKETPLACE_RUN_DEPTH);
          if (market.length >= MARKETPLACE_RUN_DEPTH && market.every(r => (isoInstant(r.startedAt) ?? '') >= window.start)) complete = false;
          for (const run of market) {
            if (wanted && !(run.workItemId && wanted.has(run.workItemId))) continue;
            runs.push(runRow(run, initiative.id));
          }
        } catch (err) { healthy = false; message = firstLine(err); }
      }
    }
    if (personId) {
      const used = new Set(runs.map(r => r.botId).filter((id): id is string => !!id));
      bots = bots.filter(b => used.has(b.id));
    }
    // Live queue rows: the dispatch tier (marketplace read gate), narrower than /api/work/jobs.
    if (reads.marketplaceRuns) {
      try {
        const itemProject = new Map(allItems.map(i => [i.id, i.projectId]));
        const botTarget = new Map(bots.flatMap(b => (b.orgProjectId ? [[b.id, b.orgProjectId] as const] : [])));
        const wantedItems = personId ? new Set(items.map(i => i.id)) : null;
        for (const status of LIVE_JOB_STATUSES) {
          const live = await listJobs({ status, limit: JOB_READ_CAP });
          if (live.length >= JOB_READ_CAP) complete = false;
          for (const job of live) {
            const row = jobRow(job, itemProject, botTarget);
            if (!row || !initiativeIds.has(row.projectId)) continue;
            if (wantedItems && !(row.workItemId && wantedItems.has(row.workItemId))) continue;
            jobs.push(row);
          }
        }
      } catch (err) { healthy = false; message = firstLine(err); }
    }
    sources.push({ source: 'cloud-compute', health: healthy ? 'available' : 'delayed', ...(message ? { message } : {}) });
  }

  // Linked documents, for the in-day items only (one lookup each, bounded).
  const documents: DocumentLinkRow[] = [];
  const candidates = items.filter(item => initiativeIds.has(item.projectId) && itemTouchesDay(item, window));
  if (candidates.length > DOCUMENT_LOOKUP_CAP) complete = false;
  let docsHealthy = true; let docsMessage: string | undefined;
  for (const item of candidates.slice(0, DOCUMENT_LOOKUP_CAP)) {
    try {
      for (const doc of await listWorkDocuments(item.id)) {
        documents.push({ workItemId: item.id, documentId: doc.id, title: doc.title ?? null, source: doc.source ?? null, linkedAt: doc.linkedAt });
      }
    } catch (err) { docsHealthy = false; docsMessage = firstLine(err); }
  }
  // Documents, sprints and decisions are all records read from Aurora: one source.
  const recordMessage = [docsMessage, ...recordProblems].filter((m): m is string => !!m).join('; ');
  sources.push({ source: 'document', health: docsHealthy && recordProblems.length === 0 ? 'available' : 'delayed', ...(recordMessage ? { message: recordMessage } : {}) });

  return { initiatives, items, bots, runs, documents, sprints, decisions, flowRuns, jobs, ...(personName ? { personName } : {}), sources, complete };
}
