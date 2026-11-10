// Decisions raised against this initiative — reachable, deliberately not a
// headline. A table of records on the library's DataTable (docs/layout-cascade.md
// "Tables"): the status and the decision's title always show; the title wraps to two lines and then clamps, the
// summary and linked work item are one cut line each; a cut value shows in
// full on hover or focus (ui-components 2.518.0 `truncate` + `wrap`). The way
// into the detail pane is the row's Open action.

import { ArrowRightIcon, Chip, DataTable, IconButton, InlinePlaceholder, T } from '@connorhoehn/ui-components/shared';
import type { DataTableColumn } from '@connorhoehn/ui-components/shared';
import { RecordLink } from '../decisions/RecordLink';
import { DECISION_TONE } from './projectFormat';
import type { ProjectDecision } from './types';

const COLUMNS: DataTableColumn<ProjectDecision>[] = [
  {
    key: 'status', header: 'Status', width: '120px',
    render: (d) => (
      <Chip tone={DECISION_TONE[d.status] ?? 'warning'} size="xs" uppercase>{d.status}</Chip>
    ),
  },
  {
    key: 'topic', header: 'Decision', truncate: true, wrap: 'two-lines', width: '18rem', getFilterText: (d) => d.topic,
    render: (d) => (
      <RecordLink to={`/iq/decisions/${encodeURIComponent(d.id)}`}>{d.topic}</RecordLink>
    ),
  },
  {
    key: 'requiredRole', header: 'Needs', priority: 3,
    render: (d) => (d.requiredRole
      ? <Chip tone="purple" size="xs">needs {d.requiredRole}</Chip>
      : <T size="xs" tone="tertiary">—</T>),
  },
  {
    key: 'summary', header: 'Summary', truncate: true, priority: 5, getFilterText: (d) => d.summary ?? '',
    render: (d) => <T size="xs" tone="tertiary">{d.summary ?? '—'}</T>,
  },
  {
    key: 'workItemTitle', header: 'Work item', truncate: true, width: '11rem', priority: 4, getFilterText: (d) => d.workItemTitle ?? '',
    render: (d) => <T size="xs" tone="tertiary">{d.workItemTitle ?? '—'}</T>,
  },
  {
    key: 'escalatedAt', header: 'Escalated', numeric: true, priority: 2,
    render: (d) => (d.escalatedAt ? new Date(d.escalatedAt).toLocaleDateString() : '—'),
  },
];

/** `onOpen`: the decision's detail in the right pane (detail goes far right, never a navigation). */
export function DecisionQueue({ decisions, onOpen }: { decisions: ProjectDecision[]; onOpen?: (id: string) => void }) {
  if (decisions.length === 0) {
    return (
      <InlinePlaceholder size="sm" align="center">
        No decisions linked to this project yet.
      </InlinePlaceholder>
    );
  }
  return (
    // Summary, then the work item, the role and the date give way as the table narrows (each row's "+N"
    // lists them); under 40rem a row is a stacked card with every field.
    <DataTable<ProjectDecision>
      narrow
      responsiveColumns
      data={decisions}
      columns={COLUMNS}
      keyField={(d) => d.id}
      onRowClick={onOpen ? (d) => onOpen(d.id) : undefined}
      rowActions={onOpen ? (d) => (
        <IconButton
          size="sm"
          icon={<ArrowRightIcon />}
          aria-label={`Open details for ${d.topic}`}
          title="Details"
          onClick={() => onOpen(d.id)}
        />
      ) : undefined}
      pageSize={25}
      emptyMessage="No decisions"
    />
  );
}
