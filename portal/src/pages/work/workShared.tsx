// Shared contracts + fragments for the Automate pages (Overview, Queue,
// Findings). One definition of a Job/Finding/Proposal and of the little
// origin/serves chips, so the three pages cannot drift apart on what a queue
// row means.

import { Link } from 'react-router';
import { Chip, type ChipTone } from '@connorhoehnslalom/ui-components/shared';
import type { JobToolCall } from './toolCallFormat';
import { runStateChip, severityTone } from '../../lib/statusTone';
import { usd } from '../../lib/format';

export type { JobToolCall, ToolCallStripItem } from './toolCallFormat';
export { toToolCallStripItems } from './toolCallFormat';

// ─── Wire contracts ──────────────────────────────────────────────────────────

export interface Job {
  id: string; kind: string; title: string; status: string; priority: number;
  boxId: string | null; attempts: number; maxAttempts: number;
  result: {
    summary?: string; turns?: number; costUsd?: number; toolCalls?: number; durationMs?: number;
    toolCallList?: JobToolCall[];
  } | null;
  error: string | null; createdAt: string; finishedAt: string | null;
  /** The standing mission that enqueued this, when one did. */
  botId: string | null; botName: string | null; botTrigger: string | null;
  /** What the job was queued to move, resolved server-side from the work item
   * — see the POST /jobs contract in middleware routes/work.ts. Absent on a
   * job typed from scratch, which is a real answer, not a missing one. */
  payload?: {
    workItemId?: string; workItemTitle?: string;
    initiativeId?: string; initiativeName?: string;
  } | null;
}

export interface Finding {
  id: string; sweep: string; severity: 'critical' | 'warning' | 'info';
  title: string; detail: string | null; entityType: string | null; entityId: string | null;
  evidence: Record<string, unknown>; status: string; jobId: string | null; lastSeenAt: string;
}

export interface Proposal {
  id: string; source: string; kind: string; targetId: string;
  payload: Record<string, unknown>; rationale: string | null; confidence: number | null;
  evidence: Record<string, unknown> | null;
  status: string; applyError: string | null; createdAt: string;
}

/** GET /api/work/suggestions — see middleware lib/work-suggestions.ts. */
export interface WorkSuggestion {
  id: string;
  kind: 'blocked' | 'in-review' | 'next-up' | 'maintenance';
  title: string;
  reason: string;
  prompt: string;
  initiativeId: string;
  initiativeName: string;
  workItemId: string;
  storyPoints: number | null;
  estimatedCostUsd: number | null;
}

export interface Summary {
  jobs: Record<string, number>;
  proposals: Record<string, number>;
  consults?: { pending: number };
  findings: { open: number; critical: number; warning: number };
  busyBoxes: string[];
  sweeps: string[];
}

export interface LabConsult {
  id: string;
  question: string;
  context: string | null;
  repo: string | null;
  boxId: string | null;
  sessionId: string | null;
  status: 'pending' | 'answered' | 'expired' | 'withdrawn';
  answer: string | null;
  answeredBy: string | null;
  createdAt: string;
}

// ─── Tone tables ─────────────────────────────────────────────────────────────

/** Tone per suggestion kind, mirroring the server's ranking: stalled loudest. */
export const SUGGESTION_TONE: Record<WorkSuggestion['kind'], ChipTone> = {
  blocked: 'danger',
  'in-review': 'warning',
  'next-up': 'info',
  maintenance: 'neutral',
};

export const SUGGESTION_LABEL: Record<WorkSuggestion['kind'], string> = {
  blocked: 'blocked',
  'in-review': 'in review',
  'next-up': 'next up',
  maintenance: 'upkeep',
};

/** Statuses whose detail page streams live rather than replaying a transcript. */
export const LIVE_STATUSES = new Set(['claimed', 'running']);

export const PROPOSAL_LABELS: Record<string, string> = {
  link_document_mention: 'Link this document to an entity',
  add_person_skill: 'Give a person a skill',
  update_person_title: 'Change a person’s title',
  add_collaboration: 'Record a collaboration',
  add_skill: 'Add a new skill',
};

/** Graph-proposal status → Chip tone — a different vocabulary from job
 *  status (applied/approved/rejected vs queued/running/done). */
export const PROPOSAL_STATUS_CHIP: Record<string, ChipTone> = {
  applied: 'success',
  pending: 'warning',
  approved: 'accent',
  rejected: 'neutral',
  failed: 'danger',
};

// Sweep id → human label lives in findingsFilter.ts (`sweepLabel`) — it is
// pure (no React), so it can be unit-tested and it covers every sweep kind
// including group headings on the dismissed bucket, not just the tone table.

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** What a job is for, in the words the board uses. */
export function serves(job: Job): { itemTitle: string; initiativeId: string; initiativeName: string; workItemId?: string } | null {
  const p = job.payload;
  if (!p?.workItemTitle || !p.initiativeId || !p.initiativeName) return null;
  return { itemTitle: p.workItemTitle, initiativeId: p.initiativeId, initiativeName: p.initiativeName, ...(p.workItemId ? { workItemId: p.workItemId } : {}) };
}

export function money(n: number | undefined): string {
  return usd(n, { precision: 4 });
}

// ─── Fragments ───────────────────────────────────────────────────────────────

// The library's Text primitive, re-exported so the Automate pages keep
// importing `T` from here. This was a local `Inline as="span"` shim; the
// library now ships the same thing with a wider `as` union, so the copy is
// gone the way the twelve `pages/*/Text.tsx` shims already went. The extra
// `tabIndex`/`onKeyDown` this forwarded existed only for a span pretending
// to be a link — now a real `<Link>` above.
export { T } from '@connorhoehnslalom/ui-components/shared';

/** Chip naming the bot behind a queued job. Scheduled maintenance and work a
 * person queued this morning read identically without it — and only one of
 * them is a cost of ownership someone already agreed to. */
export function BotOrigin({ job }: { job: Job }) {
  if (!job.botName) return null;
  return (
    <Chip
      tone="neutral"
      size="xs"
      className="shrink-0 whitespace-nowrap"
      title={`Enqueued by the ${job.botName} bot (${job.botTrigger ?? 'manual'} trigger)`}
    >
      {job.botTrigger === 'cron' ? '⏱ ' : '🤖 '}{job.botName}
    </Chip>
  );
}

/**
 * Chip naming the work item a job serves, and the initiative it moves.
 * A real `<Link>`. This used to be a span carrying `role="link"` +
 * `tabIndex` + hand-written Enter/Space handling, justified as living inside
 * the row's own anchor — but neither call site nests it in one: the queue
 * row is a bare `<tr onClick>` and the Work-home row's title Link is a
 * sibling. So the hand-rolled version bought nothing and cost what only a
 * real anchor gives — middle-click, open-in-new-tab, the status-bar target
 * and a place in the browser's link list.
 */
export function ServesItem({ job }: { job: Job }) {
  const s = serves(job);
  if (!s) return null;
  return (
    <Link
      to={`/iq/projects/${encodeURIComponent(s.initiativeId)}${s.workItemId ? `?${new URLSearchParams({ tab: 'work', item: s.workItemId })}` : ''}`}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      title={`Serving “${s.itemTitle}” on ${s.initiativeName} — open ${s.workItemId ? 'the work item' : 'the initiative'}`}
      className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-text-secondary shrink-0 max-w-[220px] truncate no-underline hover:text-primary"
    >
      ↳ {s.itemTitle} · {s.initiativeName}
    </Link>
  );
}

/** Small status pill for a queue row. */
export function JobStatusPill({ status }: { status: string }) {
  const c = runStateChip(status);
  return (
    <Chip tone={c.tone} solid={c.solid} size="xs" className="shrink-0 whitespace-nowrap">
      {status === 'done' ? 'Completed' : c.label}
    </Chip>
  );
}

/** Small severity pill shared by findings rows and sweep group headers. */
/** `md` where the chip sits inside a control (a section header button): the
 *  xs chip's 10px label is off the control scale (12/14). */
export function SeverityChip({ severity, size = 'xs' }: { severity: string; size?: 'xs' | 'md' }) {
  return <Chip tone={severityTone(severity)} size={size} className="shrink-0">{severity}</Chip>;
}

/** The one link that leaves the loop's run surfaces: what reached the graph. */
export function GraphUpdatesLink() {
  return (
    <Link to="/iq/work/changes" className="text-xs text-primary no-underline hover:underline">
      Graph updates →
    </Link>
  );
}
