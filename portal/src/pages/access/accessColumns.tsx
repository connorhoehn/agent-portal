// The request table's columns, shared by Requests and Approvals so the two
// lists of the same records read the same (docs/layout-cascade.md "Tables":
// one thing per cell, numeric dates right-aligned, free text capped).

import { Chip, Link, T, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { relativeTime } from '../../lib/relativeTime';
import {
  DURATION_LABELS,
  EVENT_LABELS,
  STEP_KIND_LABELS,
  currentStep,
  eligibleLabel,
  eventHref,
  requestHref,
  requestTitle,
  statusLabel,
  statusTone,
  statusWord,
  type AccessEvent,
  type AccessRequest,
} from '../../lib/accessRequests';

/** A record link: a plain click navigates in the app, a modified click still opens the href. */
export function AccessLink({ to, children, ...rest }: { to: string; children: ReactNode; 'data-testid'?: string }) {
  const navigate = useNavigate();
  return (
    <Link href={to} {...rest} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); e.stopPropagation(); navigate(to); }}>
      {children}
    </Link>
  );
}

export const REQUEST_COLUMNS: DataTableColumn<AccessRequest>[] = [
  {
    key: 'item', header: 'Request', sortable: true, compare: (a, b) => a.item.title.localeCompare(b.item.title),
    render: (r) => <AccessLink to={requestHref(r.id)}><T size="sm" title={requestTitle(r)} className="block max-w-[24rem] truncate">{r.item.title}</T></AccessLink>,
  },
  { key: 'beneficiary', header: 'For', render: (r) => r.beneficiary.displayName },
  { key: 'status', header: 'Status', width: '112px', render: (r) => <Chip tone={statusTone(r.status)} size="xs">{statusLabel(r.status)}</Chip> },
  {
    // Who the open step waits on, by name (the step's kind rides along as the hover title).
    key: 'waiting', header: 'Waiting on',
    render: (r) => {
      const s = currentStep(r);
      if (!s) return <T size="xs" tone="tertiary">—</T>;
      const who = eligibleLabel(s, r.status);
      return <T size="sm" title={`${STEP_KIND_LABELS[s.kind] ?? s.kind} step: ${who}`} className="block max-w-[16rem] truncate">{who}</T>;
    },
  },
  { key: 'duration', header: 'Duration', render: (r) => DURATION_LABELS[r.duration] ?? r.duration },
  {
    key: 'submittedAt', header: 'Submitted', numeric: true, sortable: true,
    compare: (a, b) => a.submittedAt.localeCompare(b.submittedAt),
    render: (r) => relativeTime(r.submittedAt),
  },
];

/** "Draft → Submitted": a status change as words, or the one status when it did not change. */
const change = (e: AccessEvent) => {
  if (!e.before && !e.after) return '—';
  if (e.before === e.after) return statusWord(e.after ?? '');
  return `${e.before ? statusWord(e.before) : '—'} → ${e.after ? statusWord(e.after) : '—'}`;
};
export const eventTitle = (e: AccessEvent) => `${EVENT_LABELS[e.kind] ?? e.kind} ${e.subject ?? ''}`.trim();

export const EVENT_COLUMNS: DataTableColumn<AccessEvent>[] = [
  { key: 'at', header: 'When', numeric: true, sortable: true, compare: (a, b) => a.at.localeCompare(b.at), render: (e) => <T size="sm" title={e.at} className="justify-end">{relativeTime(e.at)}</T> },
  { key: 'kind', header: 'Event', width: '160px', render: (e) => <Chip tone={e.kind === 'step-rejected' || e.kind === 'sod-blocked' ? 'danger' : e.kind === 'sod-override' || e.kind === 'escalated' ? 'caution' : 'neutral'} size="xs">{EVENT_LABELS[e.kind] ?? e.kind}</Chip> },
  {
    key: 'requestId', header: 'About', width: '260px',
    render: (e) => (e.subject
      ? <AccessLink to={eventHref(e)}><T size="sm" title={e.subject} className="block max-w-[16rem] truncate">{e.subject}</T></AccessLink>
      : <T size="xs" tone="tertiary">—</T>),
  },
  { key: 'actor', header: 'Actor', render: (e) => e.actor?.displayName ?? <T size="sm" tone="tertiary">system</T> },
  { key: 'change', header: 'Change', render: change },
  { key: 'reason', header: 'Reason', render: (e) => (e.reason ? <T size="sm" tone="secondary" title={e.reason} className="block max-w-[24rem] truncate">{e.reason}</T> : <T size="xs" tone="tertiary">—</T>) },
];
