import {
  AvatarGroup,
  Chip,
  DataTable,
  Inline,
  ProgressBar,
  Spinner,
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
}: {
  projects: ProjectSummary[];
  onOpen: (project: ProjectSummary) => void;
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
            to={`/iq/projects/${p.id}`}
            onClick={(e) => e.stopPropagation()}
            className="block text-[13px] font-semibold text-text-primary no-underline hover:underline truncate"
          >
            {p.name}
          </Link>
          <T as="div" className="font-mono text-[10px] text-text-tertiary truncate">
            {deriveProjectKey(p.id, p.name)}
            {p.repoFullName ? ` · ${p.repoFullName}` : ''}
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
    {
      key: 'activeAgentRuns', header: 'Active', sortable: true,
      compare: (a, b) => (a.activeAgentRuns ?? 0) - (b.activeAgentRuns ?? 0),
      render: (p) => (p.activeAgentRuns ?? 0) > 0 ? (
        <Inline gap="xs" wrap={false}>
          <Spinner size="sm" color="var(--color-success)" aria-label="Agents working now" />
          <T className="text-[12px] font-medium text-text-secondary whitespace-nowrap">
            {p.activeAgentRuns} agent{p.activeAgentRuns === 1 ? '' : 's'}
          </T>
        </Inline>
      ) : (
        <T className="text-[11px] text-text-tertiary">idle</T>
      ),
    },
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
