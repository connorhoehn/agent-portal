// The request table's columns, shared by Requests and Approvals so the two
// lists of the same records read the same (docs/layout-cascade.md "Tables":
// one thing per cell, numeric dates right-aligned, free text capped).

import { Chip, T, type DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime';
import {
  DURATION_LABELS,
  EVENT_LABELS,
  STEP_KIND_LABELS,
  currentStep,
  requestTitle,
  statusLabel,
  statusTone,
  type AccessEvent,
  type AccessRequest,
} from '../../lib/accessRequests';

export const REQUEST_COLUMNS: DataTableColumn<AccessRequest>[] = [
  { key: 'id', header: 'Request', width: '112px', render: (r) => <T size="sm" tabular>{r.id}</T> },
  {
    key: 'item', header: 'Item', sortable: true, compare: (a, b) => a.item.title.localeCompare(b.item.title),
    render: (r) => <T size="sm" title={requestTitle(r)} className="block max-w-[24rem] truncate">{r.item.title}</T>,
  },
  { key: 'beneficiary', header: 'For', render: (r) => r.beneficiary.displayName },
  { key: 'status', header: 'Status', width: '112px', render: (r) => <Chip tone={statusTone(r.status)} size="xs">{statusLabel(r.status)}</Chip> },
  {
    key: 'waiting', header: 'Waiting on',
    render: (r) => { const s = currentStep(r); return s ? STEP_KIND_LABELS[s.kind] ?? s.kind : <T size="xs" tone="tertiary">—</T>; },
  },
  { key: 'duration', header: 'Duration', render: (r) => DURATION_LABELS[r.duration] ?? r.duration },
  {
    key: 'submittedAt', header: 'Submitted', numeric: true, sortable: true,
    compare: (a, b) => a.submittedAt.localeCompare(b.submittedAt),
    render: (r) => relativeTime(r.submittedAt),
  },
];

const change = (e: AccessEvent) => (e.before || e.after ? `${e.before ?? '—'} → ${e.after ?? '—'}` : '—');
export const eventTitle = (e: AccessEvent) => `${EVENT_LABELS[e.kind] ?? e.kind} ${e.requestId}`;

export const EVENT_COLUMNS: DataTableColumn<AccessEvent>[] = [
  { key: 'at', header: 'When', numeric: true, sortable: true, compare: (a, b) => a.at.localeCompare(b.at), render: (e) => <T size="sm" title={e.at} className="justify-end">{relativeTime(e.at)}</T> },
  { key: 'kind', header: 'Event', width: '160px', render: (e) => <Chip tone={e.kind === 'step-rejected' ? 'danger' : e.kind === 'sod-override' ? 'caution' : 'neutral'} size="xs">{EVENT_LABELS[e.kind] ?? e.kind}</Chip> },
  { key: 'requestId', header: 'Request', width: '112px', render: (e) => <T size="sm" tabular>{e.requestId}</T> },
  { key: 'actor', header: 'Actor', render: (e) => e.actor?.displayName ?? <T size="sm" tone="tertiary">system</T> },
  { key: 'change', header: 'Change', render: change },
  { key: 'reason', header: 'Reason', render: (e) => (e.reason ? <T size="sm" tone="secondary" title={e.reason} className="block max-w-[24rem] truncate">{e.reason}</T> : <T size="xs" tone="tertiary">—</T>) },
];
