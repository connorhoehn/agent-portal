import {
  AvatarGroup,
  Chip,
  DataTable,
  ProgressBar,
  StatusDot,
  type DataTableColumn, T,
} from '@connorhoehnslalom/ui-components/shared';
import { Link } from 'react-router';
import { relativeTime } from '../../lib/relativeTime';
import { ProjectStatusChip } from './ProjectStatusChip';
import {
  PRIORITY_TONE,
  SPEND_TITLE,
  allocationFraction,
  deriveProjectKey,
  freshnessColor,
  pointsFraction,
  usd,
} from './projectFormat';
import type { ProjectSummary } from './types';

// The scan view of the program wall, on the library's standard DataTable —
// column sorting, paging and row plumbing come from the system instead of a
// hand-assembled table that duplicated all three badly.

export function ProjectTable({
  projects,
  onOpen,
  hrefOf = (project) => `/iq/projects/${encodeURIComponent(project.id)}`,
}: {
  projects: ProjectSummary[];
  onOpen: (project: ProjectSummary) => void;
  hrefOf?: (project: ProjectSummary) => string;
}) {
  // One thing per cell (docs/layout-cascade.md "Tables"): the key, priority and
  // freshness that used to stack under the name and status are columns of
  // their own, and the allocation shares the spend's single line. A table
  // wider than the pane scrolls inside DataTable's own wrapper. Ordering by
  // priority or recency is also the rail's Sort menu, which drives this table.
  const columns: DataTableColumn<ProjectSummary>[] = [
    {
      key: 'name', header: 'Initiative', sortable: true,
      // A real Link, not just the row's onClick: DataTable's row-click is a
      // bare <tr onClick> with no keyboard access, so this is the one
      // focusable, Enter-activatable control in the row — same pattern as
      // `work/QueuePage.tsx`.
      render: (p) => (
        <Link
          to={hrefOf(p)}
          onClick={(e) => e.stopPropagation()}
          className="block truncate text-[13px] font-semibold text-text-primary no-underline hover:underline"
          title={p.name}
        >
          {p.name}
        </Link>
      ),
    },
    {
      // The key only: the repository path made this the widest column. The
      // path stays one hover away here and is the Repository button on the
      // detail page.
      key: 'key', header: 'Key',
      render: (p) => (
        <T className="font-mono text-[11px] text-text-tertiary" title={p.repoFullName ?? undefined}>
          {deriveProjectKey(p.id, p.name)}
        </T>
      ),
    },
    {
      key: 'priority', header: 'Priority', width: '96px',
      render: (p) => (p.priority
        ? <Chip tone={PRIORITY_TONE[p.priority] ?? 'neutral'} size="xs" uppercase>{p.priority}</Chip>
        : <T className="text-[11px] text-text-tertiary">—</T>),
    },
    {
      key: 'status', header: 'Status', sortable: true, width: '120px',
      compare: (a, b) => String(a.status ?? '').localeCompare(String(b.status ?? '')),
      render: (p) => <ProjectStatusChip status={p.status} />,
    },
    {
      key: 'updated', header: 'Updated', numeric: true,
      render: (p) => (
        <StatusDot
          size="xs"
          color={freshnessColor(p.lastActivityAt)}
          label={<T className="text-[11px] text-text-tertiary whitespace-nowrap">{relativeTime(p.lastActivityAt ?? p.createdAt)}</T>}
        />
      ),
    },
    {
      // Faces only: each avatar's own tooltip names its person, and the rail
      // row beside this table already prints the owner's name.
      key: 'team', header: 'Team',
      render: (p) => {
        const team = p.ownerName ? [p.ownerName, ...(p.smeNames ?? [])] : (p.smeNames ?? []);
        return team.length > 0
          ? <AvatarGroup names={team} size={20} maxVisible={4} />
          : <T className="text-[11px] text-text-tertiary">—</T>;
      },
    },
    // No "Active" column: the explorer rail beside this table already reads
    // "Nora DaSilva · 2 agents" / "· Idle" for every row.
    {
      key: 'progress', header: 'Progress', sortable: true,
      compare: (a, b) => (pointsFraction(a) ?? -1) - (pointsFraction(b) ?? -1),
      render: (p) => pointsFraction(p) != null ? (
        <ProgressBar
          value={p.pointsDone ?? 0}
          max={Math.max(p.pointsTotal ?? 0, 1)}
          size="sm"
          showRatio={false}
          className="min-w-[88px]"
          label={<T className="text-[10px] text-text-tertiary whitespace-nowrap">{p.pointsDone}/{p.pointsTotal} pts</T>}
        />
      ) : (
        <T className="text-[11px] text-text-tertiary">—</T>
      ),
    },
    {
      key: 'agentSpendUsd', header: 'Spend (MTD)', numeric: true, sortable: true,
      compare: (a, b) => (a.agentSpendUsd ?? 0) - (b.agentSpendUsd ?? 0),
      render: (p) => {
        const spend = p.agentSpendUsd ?? 0;
        if (spend <= 0) return <T className="text-[12px] text-text-tertiary">—</T>;
        const burn = allocationFraction(p);
        return (
          <T
            className={`text-[12px] font-semibold tabular-nums whitespace-nowrap ${burn != null && burn > 1 ? 'text-danger' : 'text-text-secondary'}`}
            title={SPEND_TITLE}
          >
            {p.allocatedUsd != null ? `${usd(spend)} of ${usd(p.allocatedUsd)}` : usd(spend)}
          </T>
        );
      },
    },
  ];

  return (
    <DataTable<ProjectSummary>
      data={projects}
      columns={columns}
      keyField={(p) => p.id}
      onRowClick={onOpen}
      pageSize={25}
      emptyMessage="No initiatives"
    />
  );
}
