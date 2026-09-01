import {
  Avatar,
  Card,
  Inline,
  StatusDot,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime';
import { ProjectStatusChip } from './ProjectStatusChip';
import { SPEND_TITLE, deriveProjectKey, freshnessColor, usd } from './projectFormat';
import type { ProjectSummary } from './types';

// This was a hand-rolled grid: a shared `LIST_COLS` template string that the
// header row and every data row had to repeat identically, six `<div>` cells
// per row, and pixel column widths tuned by hand ("96px clipped it, hence
// 110"). It is a table. `<Table>` sizes its own columns, so the template string
// and its "must match header exactly" warning are gone.

export function ProjectTable({
  projects,
  onOpen,
}: {
  projects: ProjectSummary[];
  onOpen: (project: ProjectSummary) => void;
}) {
  return (
    <Card padding="none" className="overflow-hidden">
      <Table>
        <TableHead>
          <TableRow>
            <TableTh>Project</TableTh>
            <TableTh>Status</TableTh>
            <TableTh>Owner</TableTh>
            <TableTh className="text-right" title={SPEND_TITLE}>Spend (MTD)</TableTh>
            <TableTh className="text-right">Updated</TableTh>
          </TableRow>
        </TableHead>
        <TableBody>
          {projects.map(project => {
            const spend = project.agentSpendUsd ?? 0;
            return (
              <TableRow key={project.id} clickable onClick={() => onOpen(project)}>
                <TableTd>
                  <span className="block text-[13px] font-semibold text-text-primary">{project.name}</span>
                  <span className="block font-mono text-[10px] text-text-tertiary">
                    {deriveProjectKey(project.id, project.name)}
                  </span>
                </TableTd>
                <TableTd><ProjectStatusChip status={project.status} /></TableTd>
                <TableTd>
                  {project.ownerName ? (
                    <Inline gap="xs" wrap={false} className="min-w-0">
                      <Avatar name={project.ownerName} size={20} />
                      <span className="truncate text-[12px] text-text-secondary">{project.ownerName}</span>
                    </Inline>
                  ) : (
                    <span className="text-[11px] text-text-tertiary">—</span>
                  )}
                </TableTd>
                <TableTd className="text-right tabular-nums whitespace-nowrap" title={SPEND_TITLE}>
                  {spend > 0
                    ? <span className="text-[12px] font-semibold text-text-secondary">{usd(spend)}</span>
                    : <span className="text-[12px] text-text-tertiary">—</span>}
                </TableTd>
                <TableTd className="whitespace-nowrap">
                  <Inline gap="xs" justify="end" wrap={false}>
                    <StatusDot
                      size="xs"
                      color={freshnessColor(project.lastActivityAt)}
                      label={<span className="text-[11px] text-text-tertiary">{relativeTime(project.lastActivityAt ?? project.createdAt)}</span>}
                    />
                  </Inline>
                </TableTd>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
