// Live updates for the orgiq and pipelines work graphs (pipelines: see the end of this file). Primary path since realtime-modules
// 0.108: the gateway's workGraph() stream (stream.ts) — per-viewer deltas.
// Fallback (a reader whose stream is refused): the gateway's existing
// `activity()` feature (lib/gateway-run-feed.ts) on the dedicated default-deny
// family `orgiq:workgraph` (lib/tenant-channels.ts), described below.
//
// The frame is a HINT, not the record — the same rule flow runs follow
// (gateway-run-feed.ts publishFlowRunMove). It names which initiative moved and
// why, nothing else; the portal answers it by refetching the snapshot, which
// re-decides every part for that viewer (lib/work-graph/authority.ts). So a
// hint can never carry a run, cost or title to someone the REST gates would
// refuse, and the reader's `useWorkGraph` keeps its last authorized graph on
// screen while it refetches (`reset-required` / `gap`).

import { publishChannelActivity } from '../gateway-run-feed.js';
import { onBotRunChange, getBot, type BotRunChange } from '../../providers/bots.js';
import { jobEvents, type JobChangeEvent } from '../../providers/agent-jobs.js';
import { getWorkItem } from '../../providers/work-items.js';
import { onFlowRunMove, type FlowRunMove } from '../flow-runs/events.js';
import { flowRunStore } from '../flow-runs/store.js';
import { runIdFor } from '../pipeline-runs.js';
import { assessmentBroker } from '../assessment-broker.js';
import { DRAFT_KINDS, DRAFT_TENANT } from '../assessment-drafts.js';
import { publishWorkGraphChange } from './stream.js';
import { onSocialWorkGraphEvent, socialConversationOrNull, type SocialWorkGraphCause, type SocialWorkGraphEvent } from './social-events.js';

export const WORK_GRAPH_CHANNEL = 'orgiq:workgraph';
export const WORK_GRAPH_HINT = 'work-graph.changed';

export type WorkGraphCause = 'work-item' | 'work-document' | 'run' | 'sprint' | 'decision' | 'flow-run' | 'job';

/** Something on the graph moved: the stream recomputes each open reader's own
 * frames (stream.ts, every replica), and the content-free hint still goes out
 * for readers whose stream was refused (their fallback). Fire-and-forget safe. */
export async function notifyWorkGraphChanged(initiativeId: string | null, cause: WorkGraphCause): Promise<void> {
  await Promise.all([
    publishWorkGraphChange({ ...(initiativeId ? { initiativeId } : {}), cause }),
    publishChannelActivity(WORK_GRAPH_CHANNEL, WORK_GRAPH_HINT, { ...(initiativeId ? { initiativeId } : {}), cause }),
  ]);
}

/** A bot_runs row moved: resolve its initiative when the row says (bot target
 * or work item), else hint without one — every open graph refetches. */
export async function hintForRunChange(change: BotRunChange): Promise<void> {
  let initiativeId: string | null = null;
  try {
    if (change.workItemId) initiativeId = (await getWorkItem(change.workItemId))?.projectId ?? null;
    if (!initiativeId && change.botId) initiativeId = (await getBot(change.botId))?.orgProjectId ?? null;
  } catch { initiativeId = null; }
  await notifyWorkGraphChanged(initiativeId, 'run');
}

/** An orgiq flow run moved: hint with the initiative its conversation names. Other tenants' runs hint nothing. */
export async function hintForFlowRunMove(move: FlowRunMove): Promise<void> {
  const run = await flowRunStore.get(move.runId);
  if (!run || run.tenant !== 'orgiq') return;
  const initiativeId = /^orgiq:initiative:(.+)$/.exec(run.scope)?.[1] ?? null;
  await notifyWorkGraphChanged(initiativeId, 'flow-run');
}

/** An agent_jobs row changed status (enqueue, claim, start, finish, cancel): hint with the initiative its payload names, else none. */
export async function hintForJobChange(change: JobChangeEvent): Promise<void> {
  let initiativeId: string | null = null;
  try {
    const payload = change.payload ?? {};
    const direct = typeof payload['initiativeId'] === 'string' ? payload['initiativeId'] : null;
    const workItemId = typeof payload['workItemId'] === 'string' ? payload['workItemId'] : null;
    initiativeId = workItemId ? ((await getWorkItem(workItemId))?.projectId ?? direct) : direct;
    const botId = typeof payload['botId'] === 'string' ? payload['botId'] : null;
    if (!initiativeId && botId) initiativeId = (await getBot(botId))?.orgProjectId ?? null;
  } catch { initiativeId = null; }
  await notifyWorkGraphChanged(initiativeId, 'job');
}

// ── The pipelines counterpart ──────────────────────────────────────────────
//
// The same shape on `pipelines:workgraph` (lib/tenant-channels.ts): a stream
// recompute per open reader plus the content-free fallback hint, naming at most
// the run it concerns. A hint can never carry a run, title or approval to a
// viewer the pipelines gates refuse; the snapshot re-decides every part
// (lib/work-graph/authority.ts pipelinesWorkGraphViewer).

export const PIPELINES_WORK_GRAPH_CHANNEL = 'pipelines:workgraph';
export type PipelinesWorkGraphCause = 'run' | 'step' | 'approval' | 'flow-run' | 'deck' | 'job';

/** Something on the pipelines graph moved. Fire-and-forget safe. */
export async function notifyPipelinesWorkGraphChanged(runId: string | null, cause: PipelinesWorkGraphCause): Promise<void> {
  const detail = { ...(runId ? { runId } : {}), cause };
  await Promise.all([
    publishWorkGraphChange({ tenant: 'pipelines', ...detail }),
    publishChannelActivity(PIPELINES_WORK_GRAPH_CHANNEL, WORK_GRAPH_HINT, detail),
  ]);
}

/** A queue job moved (enqueue, claim, start, review, finish, cancel): its projected run's page, and every workspace graph. */
export async function pipelinesHintForJobChange(change: JobChangeEvent): Promise<void> {
  await notifyPipelinesWorkGraphChanged(runIdFor('agent_jobs', change.jobId), change.status === 'awaiting_review' ? 'approval' : 'job');
}

/** A bot_runs row moved: it may fold into a job's run or stand alone, so every pipelines graph refetches. */
export async function pipelinesHintForRunChange(): Promise<void> {
  await notifyPipelinesWorkGraphChanged(null, 'run');
}

/** A pipelines flow run moved: hint with the run its conversation names. Other tenants' runs hint nothing here. */
export async function pipelinesHintForFlowRunMove(move: FlowRunMove): Promise<void> {
  const run = await flowRunStore.get(move.runId);
  if (!run || run.tenant !== 'pipelines') return;
  await notifyPipelinesWorkGraphChanged(/^pipelines:run:(.+)$/.exec(run.scope)?.[1] ?? null, 'flow-run');
}

// ── The assessment counterpart ─────────────────────────────────────────────
//
// `assessment:workgraph` (lib/tenant-channels.ts): a stream recompute per open
// reader plus the content-free fallback hint, naming at most the team it
// concerns. Causes: a score applied, evidence added, a draft moved or decided,
// a deck saved, an agent or flow run moved. The snapshot re-decides every part
// for each viewer (lib/work-graph/authority.ts assessmentWorkGraphViewer), so a
// hint never carries a team, draft or title to someone the REST gates refuse.

export const ASSESSMENT_WORK_GRAPH_CHANNEL = 'assessment:workgraph';
export type AssessmentWorkGraphCause = 'score' | 'evidence' | 'draft' | 'deck' | 'run' | 'flow-run';

const TEAM_ID = /^TEAM-[A-Za-z0-9-]{1,120}$/;

/** Something on the assessment graph moved. Fire-and-forget safe. */
export async function notifyAssessmentWorkGraphChanged(teamId: string | null, cause: AssessmentWorkGraphCause): Promise<void> {
  const detail = { ...(teamId && TEAM_ID.test(teamId) ? { teamId } : {}), cause };
  await Promise.all([
    publishWorkGraphChange({ tenant: 'assessment', ...detail }),
    publishChannelActivity(ASSESSMENT_WORK_GRAPH_CHANNEL, WORK_GRAPH_HINT, detail),
  ]);
}

/** A durable flow run of the assessment tenant moved: a draft names its team in its scope (`TEAM-…/<dim>`), a conversation flow in its channel. */
export async function assessmentHintForFlowRunMove(move: FlowRunMove): Promise<void> {
  const run = await flowRunStore.get(move.runId);
  if (!run || run.tenant !== DRAFT_TENANT) return;
  if ((DRAFT_KINDS as readonly string[]).includes(run.kind)) {
    await notifyAssessmentWorkGraphChanged(run.scope.split('/')[0] ?? null, 'draft');
    return;
  }
  await notifyAssessmentWorkGraphChanged(/^assessment:team:(.+)$/.exec(run.scope)?.[1] ?? null, 'flow-run');
}

/** The ledger's run events (launch, progress, completion, failure) name their team. */
export function assessmentHintForBrokerEvent(event: { type: string; team_id?: string | null }): Promise<void> | null {
  return event.type.startsWith('run.') ? notifyAssessmentWorkGraphChanged(event.team_id ?? null, 'run') : null;
}

// ── The social counterpart ─────────────────────────────────────────────────
//
// `social:workgraph` (lib/tenant-channels.ts). Social conversations are PRIVATE: a channel's name is itself something a
// non-member must not learn. So the stream-internal change names the conversation (it only narrows which open streams
// recompute, and is never sent to a client), while the fallback hint every ViewSocial reader can subscribe to names
// NOTHING but `activity`. Whoever receives it refetches; the snapshot re-decides every part for that viewer
// (lib/work-graph/authority.ts socialWorkGraphViewer, social-sources.ts). Sources of change, none of which carry content:
// a chat write or membership change (lib/social-chat.ts), the call state store (lib/call-pages.ts), a deck save, a
// recording change, a flow run move (lib/work-graph/social-events.ts).

export const SOCIAL_WORK_GRAPH_CHANNEL = 'social:workgraph';
export type { SocialWorkGraphCause };

/** Something on the social graph moved. Fire-and-forget safe. */
export async function notifySocialWorkGraphChanged(conversationId: string | null, cause: SocialWorkGraphCause): Promise<void> {
  const conversation = socialConversationOrNull(conversationId);
  await Promise.all([
    publishWorkGraphChange({ tenant: 'social', ...(conversation ? { conversationId: conversation } : {}), cause }),
    publishChannelActivity(SOCIAL_WORK_GRAPH_CHANNEL, WORK_GRAPH_HINT, { cause: 'activity' }),
  ]);
}

/** A social flow run moved: its conversation is its scope. Other tenants' runs hint nothing here. */
export async function socialHintForFlowRunMove(move: FlowRunMove): Promise<void> {
  const run = await flowRunStore.get(move.runId);
  if (!run || run.tenant !== 'social') return;
  // A room-recording summary names the room lobby as its scope; both are conversations the graph draws.
  await notifySocialWorkGraphChanged(socialConversationOrNull(run.scope), run.kind === 'social.deck' ? 'deck' : 'flow-run');
}

/** A burst of writes (a conversation in full flow) recomputes once per window per conversation, never once per message. */
const SOCIAL_COALESCE_MS = 250;
const socialWindows = new Map<string, { held: SocialWorkGraphEvent | null; timer: NodeJS.Timeout }>();
export function coalescedSocialHint(event: SocialWorkGraphEvent, send: (event: SocialWorkGraphEvent) => void = e => { void notifySocialWorkGraphChanged(e.conversationId, e.cause).catch(() => undefined); }): void {
  const key = `${event.conversationId ?? '*'}|${event.cause}`;
  const open = socialWindows.get(key);
  if (open) { open.held = event; return; }
  // Leading edge: the first change of a burst goes out at once; the window holds back the rest and sends one more.
  send(event);
  const entry: { held: SocialWorkGraphEvent | null; timer: NodeJS.Timeout } = {
    held: null,
    timer: setTimeout(() => { socialWindows.delete(key); if (entry.held) send(entry.held); }, SOCIAL_COALESCE_MS),
  };
  entry.timer.unref?.();
  socialWindows.set(key, entry);
}
export function resetSocialHintCoalescing(): void { for (const entry of socialWindows.values()) clearTimeout(entry.timer); socialWindows.clear(); }

// Subscribed at import (routes/work-graph.ts is mounted in index.ts). Until the
// gateway's activity feature exists, publishChannelActivity is a no-op.
let stop: (() => void) | null = null;
export function startWorkGraphLiveHints(): void {
  stop?.();
  const stopRuns = onBotRunChange(change => { void hintForRunChange(change); });
  const stopFlows = onFlowRunMove(move => hintForFlowRunMove(move));
  const onJob = (change: JobChangeEvent) => { void hintForJobChange(change); };
  jobEvents.on('change', onJob);
  const stopPipelineRuns = onBotRunChange(() => { void pipelinesHintForRunChange(); });
  const stopPipelineFlows = onFlowRunMove(move => pipelinesHintForFlowRunMove(move));
  const onPipelineJob = (change: JobChangeEvent) => { void pipelinesHintForJobChange(change); };
  jobEvents.on('change', onPipelineJob);
  const stopAssessmentFlows = onFlowRunMove(move => assessmentHintForFlowRunMove(move));
  // run.progress fires every few seconds while a run is open; the stream's own diff makes a no-change recompute free of frames.
  const stopAssessmentBroker = assessmentBroker.subscribe(({ event }) => { void assessmentHintForBrokerEvent(event as { type: string; team_id?: string | null }); });
  const stopSocialFlows = onFlowRunMove(move => socialHintForFlowRunMove(move));
  const stopSocialEvents = onSocialWorkGraphEvent(event => coalescedSocialHint(event));
  stop = () => {
    stopSocialFlows(); stopSocialEvents();
    stopAssessmentFlows(); stopAssessmentBroker();
    stopRuns(); stopFlows(); jobEvents.off('change', onJob);
    stopPipelineRuns(); stopPipelineFlows(); jobEvents.off('change', onPipelineJob);
  };
}
export function stopWorkGraphLiveHints(): void { stop?.(); stop = null; }
startWorkGraphLiveHints();
