// Pure formatting for local-compute displays.

import type { ChipTone } from '@connorhoehnslalom/ui-components/shared';
import { runStateChip } from '../../lib/statusTone.ts';

export type JobStatus = 'queued' | 'claimed' | 'running' | 'awaiting_review' | 'done' | 'failed' | 'cancelled';

// Both thin wrappers over the shared runStateChip (lib/statusTone.ts), the
// work lane's canonical job-status tone map. This used to disagree with it
// on two states: `running` read 'info' (now the louder solid accent tone —
// it's the one state actually in flight right now) and `awaiting_review`
// read 'info' (now 'warning' — it needs someone's attention). Both are
// visible colour changes on this page's job tables.
export function statusLabel(status: JobStatus): string {
  return runStateChip(status).label;
}

export function statusTone(status: JobStatus): ChipTone {
  return runStateChip(status).tone;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // floor, not round: 30 seconds ago is "just now", not "1m ago".
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}
