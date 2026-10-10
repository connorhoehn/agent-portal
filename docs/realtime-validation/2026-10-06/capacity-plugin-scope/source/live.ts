// Live updates for the orgiq work graph. Primary path since realtime-modules
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
import { getWorkItem } from '../../providers/work-items.js';
import { onFlowRunMove, type FlowRunMove } from '../flow-runs/events.js';
import { flowRunStore } from '../flow-runs/store.js';
import { publishWorkGraphChange } from './stream.js';

export const WORK_GRAPH_CHANNEL = 'orgiq:workgraph';
export const WORK_GRAPH_HINT = 'work-graph.changed';

export type WorkGraphCause = 'work-item' | 'work-document' | 'run' | 'sprint' | 'decision' | 'flow-run';

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

// Subscribed at import (routes/work-graph.ts is mounted in index.ts). Until the
// gateway's activity feature exists, publishChannelActivity is a no-op.
let stop: (() => void) | null = null;
export function startWorkGraphLiveHints(): void {
  stop?.();
  const stopRuns = onBotRunChange(change => { void hintForRunChange(change); });
  const stopFlows = onFlowRunMove(move => hintForFlowRunMove(move));
  stop = () => { stopRuns(); stopFlows(); };
}
export function stopWorkGraphLiveHints(): void { stop?.(); stop = null; }
startWorkGraphLiveHints();
