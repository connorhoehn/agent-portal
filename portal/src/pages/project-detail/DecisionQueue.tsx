// Decisions raised against this initiative — reachable, deliberately not a
// headline. A table of records on the library's DataTable (docs/layout-cascade.md
// "Tables"): one line per row, the summary and linked work item in columns of
// their own, the way into the detail pane as the row's Open action.

import { ArrowRightIcon, Chip, DataTable, IconButton, InlinePlaceholder, T } from '@connorhoehnslalom/ui-components/shared';
import type { DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
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
    key: 'topic', header: 'Decision',
    render: (d) => (
      <T size="sm" weight="semibold" className="block max-w-[320px] truncate" title={d.topic}>{d.topic}</T>
    ),
  },
  {
    key: 'requiredRole', header: 'Needs',
    render: (d) => (d.requiredRole
      ? <Chip tone="purple" size="xs">needs {d.requiredRole}</Chip>
      : <T size="xs" tone="tertiary">—</T>),
  },
  {
    key: 'summary', header: 'Summary',
    render: (d) => (
      <T size="xs" tone="tertiary" className="block max-w-[360px] truncate" title={d.summary ?? undefined}>
        {d.summary ?? '—'}
      </T>
    ),
  },
  {
    key: 'workItemTitle', header: 'Work item',
    render: (d) => (
      <T size="xs" tone="tertiary" className="block max-w-[220px] truncate" title={d.workItemTitle ?? undefined}>
        {d.workItemTitle ?? '—'}
      </T>
    ),
  },
  {
    key: 'escalatedAt', header: 'Escalated', numeric: true,
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
    <DataTable<ProjectDecision>
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
