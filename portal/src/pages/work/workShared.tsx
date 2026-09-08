// Shared contracts + fragments for the Automate pages (Overview, Queue,
// Findings). One definition of a Job/Finding/Proposal and of the little
// origin/serves chips, so the three pages cannot drift apart on what a queue
// row means.

import { Link } from 'react-router';
import { Chip, Inline, type ChipTone } from '@connorhoehnslalom/ui-components/shared';
import type { ReactNode } from 'react';

// ─── Wire contracts ──────────────────────────────────────────────────────────

export interface Job {
  id: string; kind: string; title: string; status: string; priority: number;
  boxId: string | null; attempts: number; maxAttempts: number;
  result: { summary?: string; turns?: number; costUsd?: number; toolCalls?: number; durationMs?: number } | null;
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

/** Job status → Chip tone (+ solid for the one state that's actually running
 *  right now, so "running" reads louder than everything merely queued). */
export const STATUS_CHIP: Record<string, { tone: ChipTone; solid?: boolean }> = {
  running: { tone: 'accent', solid: true },
  claimed: { tone: 'accent' },
  queued: { tone: 'neutral' },
  awaiting_review: { tone: 'warning' },
  done: { tone: 'success' },
  failed: { tone: 'danger' },
  cancelled: { tone: 'neutral' },
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

export const SEVERITY_TONE: Record<Finding['severity'], ChipTone> = {
  critical: 'danger',
  warning: 'warning',
  info: 'neutral',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** What a job is for, in the words the board uses. */
export function serves(job: Job): { itemTitle: string; initiativeId: string; initiativeName: string } | null {
  const p = job.payload;
  if (!p?.workItemTitle || !p.initiativeId || !p.initiativeName) return null;
  return { itemTitle: p.workItemTitle, initiativeId: p.initiativeId, initiativeName: p.initiativeName };
}

/** "4m ago" — age in human units. */
export function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function money(n: number | undefined): string {
  return typeof n === 'number' ? `$${n.toFixed(4)}` : '—';
}

export async function post(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// ─── Fragments ───────────────────────────────────────────────────────────────

/** A styled inline text node with zero raw elements — `Inline` in `as="span"`
 *  mode, the same pattern `distillation/Text.tsx` and `DepartmentInsightStrip.tsx`
 *  use elsewhere in the portal. Every Automate page needs the occasional small
 *  styled caption or muted label; a bare styled span/div is what the
 *  validator's component-discipline check forbids, so this goes through a
 *  real composite instead. Forwards the interactive bits (`role`, `tabIndex`,
 *  `onClick`, `onKeyDown`) a chip-shaped click target needs. */
export function T({
  as = 'span', className, title, children, wrap = false, ...rest
}: {
  as?: 'span' | 'div';
  className?: string;
  title?: string;
  children?: ReactNode;
  wrap?: boolean;
  role?: string;
  tabIndex?: number;
  onClick?: (e: React.MouseEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  return (
    <Inline as={as} gap="none" wrap={wrap} className={className} title={title} {...rest}>
      {children}
    </Inline>
  );
}

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
 * Lives inside the row's own link, so it navigates by hand rather than
 * nesting a second anchor.
 */
export function ServesItem({ job, onOpenInitiative }: { job: Job; onOpenInitiative: (id: string) => void }) {
  const s = serves(job);
  if (!s) return null;
  const go = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenInitiative(s.initiativeId);
  };
  return (
    <T
      role="link"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') go(e); }}
      title={`Serving “${s.itemTitle}” on ${s.initiativeName} — open the initiative`}
      className="text-[10px] px-1.5 py-0.5 rounded bg-surface-hover text-text-secondary shrink-0 max-w-[220px] truncate cursor-pointer hover:text-primary"
    >
      ↳ {s.itemTitle} · {s.initiativeName}
    </T>
  );
}

/** Small status pill for a queue row. */
export function JobStatusPill({ status }: { status: string }) {
  const c = STATUS_CHIP[status] ?? { tone: 'neutral' as const };
  return (
    <Chip tone={c.tone} solid={c.solid} size="xs" className="shrink-0 whitespace-nowrap">
      {status.replace('_', ' ')}
    </Chip>
  );
}

/** Small severity pill shared by findings rows and sweep group headers. */
export function SeverityChip({ severity }: { severity: string }) {
  const tone = SEVERITY_TONE[severity as Finding['severity']] ?? 'neutral';
  return <Chip tone={tone} size="xs" className="shrink-0">{severity}</Chip>;
}

/** The one link that leaves the loop's run surfaces: what reached the graph. */
export function GraphUpdatesLink() {
  return (
    <Link to="/iq/work/changes" className="text-[12px] text-primary no-underline hover:underline">
      Graph updates →
    </Link>
  );
}
