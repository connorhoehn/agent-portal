import {
  AvatarGroup,
  Chip,
  DataTable,
  Inline,
  ProgressBar,
  Stack,
  StatusDot,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { Link } from 'react-router';
import { relativeTime } from '../../lib/relativeTime';
import { ProjectStatusChip } from './ProjectStatusChip';
import { T } from './Text';
import {
  PRIORITY_TONE,
  SPEND_TITLE,
  allocationFraction,
  deriveProjectKey,
  freshnessColor,
  pointsFraction,
  priorityRank,
  usd,
} from './projectFormat';
import type { ProjectSummary } from './types';

// The scan view of the program wall, on the library's standard DataTable —
// column sorting, paging and row plumbing come from the system instead of a
// hand-assembled <Table> that duplicated all three badly.

const time = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : 0);

export function ProjectTable({
  projects,
  onOpen,
  hrefOf = (project) => `/iq/projects/${encodeURIComponent(project.id)}`,
}: {
  projects: ProjectSummary[];
  onOpen: (project: ProjectSummary) => void;
  hrefOf?: (project: ProjectSummary) => string;
}) {
  const columns: DataTableColumn<ProjectSummary>[] = [
    {
      key: 'name', header: 'Initiative', sortable: true,
      render: (p) => (
        <Stack gap="none" className="min-w-0">
          {/* A real Link, not just the row's onClick: DataTable's row-click is
              a bare <tr onClick> with no keyboard access, so this is the one
              focusable, Enter-activatable control in the row — same pattern
              as `work/QueuePage.tsx`. */}
          <Link
            to={hrefOf(p)}
            onClick={(e) => e.stopPropagation()}
            className="block text-[13px] font-semibold text-text-primary no-underline hover:underline truncate"
          >
            {p.name}
          </Link>
          {/* The key only: the repository path made this the widest column
              and pushed Spend and Updated out of the 1,026px pane beside the
              explorer rail (horizontal scroll at 1642px). The path stays one
              hover away here and is the Repository button on the detail page. */}
          <T as="div" className="font-mono text-[10px] text-text-tertiary truncate" title={p.repoFullName ?? undefined}>
            {deriveProjectKey(p.id, p.name)}
          </T>
        </Stack>
      ),
    },
    {
      key: 'priority', header: 'Priority', sortable: true,
      compare: (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
      render: (p) => p.priority
        ? <Chip tone={PRIORITY_TONE[p.priority] ?? 'neutral'} size="xs" uppercase>{p.priority}</Chip>
        : <T className="text-[11px] text-text-tertiary">—</T>,
    },
    {
      key: 'status', header: 'Status', sortable: true,
      compare: (a, b) => String(a.status ?? '').localeCompare(String(b.status ?? '')),
      render: (p) => <ProjectStatusChip status={p.status} />,
    },
    {
      key: 'team', header: 'Team',
      render: (p) => {
        const team = p.ownerName ? [p.ownerName, ...(p.smeNames ?? [])] : (p.smeNames ?? []);
        return team.length > 0 ? (
          <Inline gap="xs" wrap={false} className="min-w-0">
            <AvatarGroup names={team} size={20} maxVisible={4} />
            <T className="truncate text-[12px] text-text-secondary">{p.ownerName ?? team[0]}</T>
          </Inline>
        ) : (
          <T className="text-[11px] text-text-tertiary">—</T>
        );
      },
    },
    // No "Active" column: the explorer rail beside this table already reads
    // "Nora DaSilva · 2 agents" / "· Idle" for every row, and the column was
    // what pushed Spend and Updated past the pane's edge at 1642px.
    {
      key: 'progress', header: 'Progress', sortable: true,
      compare: (a, b) => (pointsFraction(a) ?? -1) - (pointsFraction(b) ?? -1),
      render: (p) => pointsFraction(p) != null ? (
        <Stack gap="none" className="min-w-[110px]">
          <ProgressBar
            value={p.pointsDone ?? 0}
            max={Math.max(p.pointsTotal ?? 0, 1)}
            size="sm"
            showRatio={false}
            label={<T className="text-[10px] text-text-tertiary">{p.pointsDone}/{p.pointsTotal} pts</T>}
          />
        </Stack>
      ) : (
        <T className="text-[11px] text-text-tertiary">—</T>
      ),
    },
    {
      key: 'agentSpendUsd', header: 'Spend (MTD)', align: 'right', sortable: true,
      compare: (a, b) => (a.agentSpendUsd ?? 0) - (b.agentSpendUsd ?? 0),
      render: (p) => {
        const spend = p.agentSpendUsd ?? 0;
        const burn = allocationFraction(p);
        return spend > 0 ? (
          <T
            title={SPEND_TITLE}
            className={`text-[12px] font-semibold tabular-nums whitespace-nowrap ${burn != null && burn > 1 ? 'text-danger' : 'text-text-secondary'}`}
          >
            {usd(spend)}
            {p.allocatedUsd != null && (
              <T className="font-normal text-text-tertiary">&nbsp;/ {usd(p.allocatedUsd)}</T>
            )}
          </T>
        ) : (
          <T className="text-[12px] text-text-tertiary">—</T>
        );
      },
    },
    {
      key: 'lastActivityAt', header: 'Updated', align: 'right', sortable: true,
      compare: (a, b) => time(a.lastActivityAt ?? a.createdAt) - time(b.lastActivityAt ?? b.createdAt),
      render: (p) => (
        <Inline gap="xs" justify="end" wrap={false}>
          <StatusDot
            size="xs"
            color={freshnessColor(p.lastActivityAt)}
            label={<T className="text-[11px] text-text-tertiary whitespace-nowrap">{relativeTime(p.lastActivityAt ?? p.createdAt)}</T>}
          />
        </Inline>
      ),
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
