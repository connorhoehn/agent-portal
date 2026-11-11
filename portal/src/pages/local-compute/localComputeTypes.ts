// The wire shapes of the paired-machine reads (GET /api/local-compute/nodes and /runs, the
// suggestions and the bot roster), shared by the Computers page and the machine detail.

import type { MachineMetrics } from './MachineConnection';
import type { JobStatus } from './localComputeFormat';

// ─── Wire shapes ─────────────────────────────────────────────────────────────

export interface NodePresence {
  status: 'connected' | 'stale' | 'offline';
  lastSeenAt: string | null;
  sessions: Array<{
    id: string;
    harness?: string;
    intent?: string;
    model?: string;
  }>;
}

export interface ComputeNode {
  id: string;
  label: string;
  platform: string | null;
  acceptJobs: boolean;
  localModels: string[];
  jobKinds: string[];
  maxConcurrency?: number;
  presence: NodePresence;
  /**
   * When the worker last asked the queue for work.
   *
   * NOT presence. Presence is the 25-second announce, which a paired machine
   * keeps sending whether or not its work loop is running — so a laptop with
   * the worker switched off reads `connected` and is indistinguishable from
   * one pulling work all day. Only this separates them. Null on a machine
   * that has never claimed, and on a cluster without the column.
   */
  lastClaimAt?: string | null;
  /** What the worker last reported about the machine it runs on. Null until a
   *  worker new enough to send it has announced. */
  metrics?: MachineMetrics | null;
}


export interface RunRow {
  id: string;
  kind: string;
  title: string;
  status: JobStatus;
  nodeId: string | null;
  nodeLabel: string | null;
  createdAt: string;
  claimedAt?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Retry context. `GET /runs` spreads the whole job, so these already ride
   *  the wire — they were simply never declared here, which is why a second
   *  attempt used to look identical to a first. */
  attempts?: number;
  maxAttempts?: number;
  result: { provider?: string; costUsd?: number; summary?: string } | null;
  /** What the run is ABOUT. `GET /runs` spreads the whole job, so the origin
   *  the dispatch route wrote (`workItemId` + `initiativeId`, or `botId`) has
   *  always been on the wire — the page simply never declared it, so a run
   *  named its title and led nowhere. That is the "no link to the work"
   *  report: every field needed to link was already here. */
  payload?: {
    workItemId?: string;
    initiativeId?: string;
    botId?: string;
    requiresReview?: boolean;
  };
  botId?: string | null;
  botName?: string | null;
}

/** Where a run's subject lives, if it has one a person can open. */
export function runOrigin(r: RunRow): { href: string; label: string } | null {
  const p = r.payload ?? {};
  if (p.workItemId && p.initiativeId) {
    return { href: `/iq/projects/${p.initiativeId}?item=${encodeURIComponent(p.workItemId)}`, label: 'work item' };
  }
  const bot = p.botId ?? r.botId;
  if (bot) return { href: `/admin/bots/${bot}`, label: r.botName ?? 'bot' };
  return null;
}

export interface WorkSuggestion {
  id: string;
  title: string;
  reason: string;
  initiativeId: string;
  initiativeName: string;
  workItemId: string;
  storyPoints: number | null;
  estimatedCostUsd: number | null;
}

export interface BotRow {
  id: string;
  name: string;
  model: string;
  cronExpr: string | null;
  enabled: boolean;
  pausedReason: string | null;
  lastRunAt: string | null;
  repoFullName?: string | null;
}
