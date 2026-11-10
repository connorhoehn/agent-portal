// Decisions raised against this initiative — reachable, deliberately not a
// headline. A table of records on the library's DataTable (docs/layout-cascade.md
// "Tables"): the status and the decision's title always show; the title and the summary wrap to two lines and then
// clamp; a cut value shows in full on hover or focus (ui-components 2.518.0 `truncate` + `wrap`). The way
// into the detail pane is the row's Open action.

import { ArrowRightIcon, Chip, DataTable, IconButton, InlinePlaceholder, T } from '@connorhoehn/ui-components/shared';
import type { DataTableColumn } from '@connorhoehn/ui-components/shared';
import { RecordLink } from '../decisions/RecordLink';
import { DECISION_TONE } from './projectFormat';
import type { ProjectDecision } from './types';

/** The compact date a decision was escalated: "Nov 8", with the year only when it is not this one. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Decision and Summary matter most: the title keeps a fixed share and Summary (no width) takes every rem left over.
 * The work item is a compact key chip (its title is the hover) and the escalation date a short one, both sized to
 * their content. As the table narrows the role goes first, then the work item, then the date.
 */
function columnsFor(workItemKeys: ReadonlyMap<string, string>): DataTableColumn<ProjectDecision>[] {
  return [
    {
      key: 'status', header: 'Status', width: '6.5rem',
      render: (d) => (
        <Chip tone={DECISION_TONE[d.status] ?? 'warning'} size="xs" uppercase>{d.status}</Chip>
      ),
    },
    {
      key: 'topic', header: 'Decision', truncate: true, wrap: 'two-lines', width: '15rem', getFilterText: (d) => d.topic,
      render: (d) => (
        <RecordLink to={`/iq/decisions/${encodeURIComponent(d.id)}`}>{d.topic}</RecordLink>
      ),
    },
    {
      key: 'summary', header: 'Summary', truncate: true, wrap: 'two-lines', width: '20rem', getFilterText: (d) => d.summary ?? '',
      render: (d) => <T as="span" size="xs" tone="tertiary" className="line-clamp-2 break-words">{d.summary ?? '—'}</T>,
    },
    {
      key: 'requiredRole', header: 'Needs', width: '9rem', priority: 4,
      render: (d) => (d.requiredRole
        ? <Chip tone="purple" size="xs">needs {d.requiredRole}</Chip>
        : <T size="xs" tone="tertiary">—</T>),
    },
    {
      key: 'workItemTitle', header: 'Work item', width: '6rem', priority: 3, getFilterText: (d) => d.workItemTitle ?? '',
      render: (d) => {
        const key = d.workItemId ? workItemKeys.get(d.workItemId) : undefined;
        if (key) return <Chip tone="neutral" size="xs" mono title={d.workItemTitle ?? undefined}>{key}</Chip>;
        return <T size="xs" tone="tertiary">{d.workItemTitle ? 'Linked' : '—'}</T>;
      },
    },
    {
      key: 'escalatedAt', header: 'Escalated', width: '6rem', priority: 2,
      render: (d) => <T size="xs" tone="secondary">{d.escalatedAt ? shortDate(d.escalatedAt) : '—'}</T>,
    },
  ];
}

const NO_KEYS: ReadonlyMap<string, string> = new Map();

/** `onOpen`: the decision's detail in the right pane (detail goes far right, never a navigation). `workItemKeys`: work item id to its public key. */
export function DecisionQueue({ decisions, onOpen, workItemKeys = NO_KEYS }: {
  decisions: ProjectDecision[]; onOpen?: (id: string) => void; workItemKeys?: ReadonlyMap<string, string>;
}) {
  if (decisions.length === 0) {
    return (
      <InlinePlaceholder size="sm" align="center">
        No decisions linked to this project yet.
      </InlinePlaceholder>
    );
  }
  return (
    // The role, then the work item and the date give way as the table narrows (one "+N" control in the header lists
    // them, each row's chevron its own values; ui-components 2.519.0); under 40rem a row is a stacked card with every field.
    <DataTable<ProjectDecision>
      narrow
      responsiveColumns
      hiddenColumnsControl="header"
      data={decisions}
      columns={columnsFor(workItemKeys)}
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
