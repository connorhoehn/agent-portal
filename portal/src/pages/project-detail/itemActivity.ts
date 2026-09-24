// A work item's Activity tab: its history assembled from data the page
// already reads — the item's own timestamps and estimate provenance, the
// audit rows in its comment thread (status changes, run settlements), and the
// marketplace runs dispatched against it. No React; unit-tested alone.
//
// Nothing here is invented: an event appears only when a timestamp for it was
// recorded. An item with no history shows the list's empty state, not a
// synthetic "Created" line dated now.

import type { BotRun } from '../bots/BotsPage';
import type { FlatWorkItem } from './projectFormat.ts';
import type { ThreadComment } from './useWorkItemThread.ts';

/** Mirrors the library's WorkActivityEvent without importing the library,
 *  so this file stays runnable under plain node:test. */
export interface ItemActivityEvent {
  id: string;
  kind: 'status' | 'run' | 'estimate' | 'comment' | 'system';
  at: string;
  text: string;
  actor?: string | null;
  detail?: string;
  href?: string;
  openLabel?: string;
}

const money = (n: number) => `$${n.toFixed(2)}`;

function quote(body: string, max = 80): string {
  const one = body.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const RUN_END: Record<BotRun['status'], string> = {
  running: 'Agent run started',
  done: 'Agent run finished',
  failed: 'Agent run failed',
  skipped: 'Agent run skipped',
};

export function itemActivity(
  item: Pick<FlatWorkItem, 'id' | 'createdAt' | 'completedAt' | 'estimatedAt' | 'estimatedByName' | 'estimateModel' | 'estimatedCostUsd' | 'estimateReviewedAt' | 'estimateReviewedByName'>,
  comments: ThreadComment[],
  runs: BotRun[],
  /** Bedrock model id → its display name ("Haiku"). */
  modelLabel: (id: string) => string = (id) => id,
): ItemActivityEvent[] {
  const out: ItemActivityEvent[] = [];
  if (item.createdAt) out.push({ id: `${item.id}:created`, kind: 'system', at: item.createdAt, text: 'Created' });
  if (item.completedAt) out.push({ id: `${item.id}:completed`, kind: 'status', at: item.completedAt, text: 'Completed' });

  if (item.estimatedAt) {
    out.push({
      id: `${item.id}:estimated`,
      kind: 'estimate',
      at: item.estimatedAt,
      text: item.estimateModel ? `Estimate recorded on ${modelLabel(item.estimateModel)}` : 'Estimate recorded',
      actor: item.estimatedByName ?? null,
      ...(item.estimatedCostUsd != null ? { detail: `up to ${money(item.estimatedCostUsd)}` } : {}),
    });
  }
  if (item.estimateReviewedAt) {
    out.push({
      id: `${item.id}:reviewed`, kind: 'estimate', at: item.estimateReviewedAt,
      text: 'Estimate reviewed', actor: item.estimateReviewedByName ?? null,
    });
  }

  for (const c of comments) {
    out.push(c.isSystem
      ? { id: c.id, kind: /status/i.test(c.body) ? 'status' : 'system', at: c.createdAt, text: c.body, actor: c.authorName }
      : { id: c.id, kind: 'comment', at: c.createdAt, text: `Commented: “${quote(c.body)}”`, actor: c.authorName });
  }

  for (const r of runs) {
    if (r.workItemId !== item.id) continue;
    out.push({ id: `${r.id}:start`, kind: 'run', at: r.startedAt, text: 'Agent run started' });
    if (r.finishedAt && r.status !== 'running') {
      const pr = r.outcome?.prUrl;
      out.push({
        id: `${r.id}:end`,
        kind: 'run',
        at: r.finishedAt,
        text: RUN_END[r.status],
        ...(r.costUsd != null ? { detail: money(r.costUsd) } : {}),
        ...(pr ? { href: pr, openLabel: 'Open PR' } : {}),
      });
    }
  }
  return out;
}
