// Pure formatting for local-compute displays.

export type JobStatus = 'queued' | 'claimed' | 'running' | 'awaiting_review' | 'done' | 'failed' | 'cancelled';

export function statusLabel(status: JobStatus): string {
  switch (status) {
    case 'awaiting_review': return 'awaiting review';
    default: return status;
  }
}

export function statusTone(status: JobStatus): 'success' | 'warning' | 'danger' | 'info' | 'tertiary' {
  switch (status) {
    case 'done': return 'success';
    case 'awaiting_review': return 'info';
    case 'running': return 'info';
    case 'failed': return 'danger';
    case 'cancelled': return 'tertiary';
    default: return 'tertiary';
  }
}

export function when(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}
