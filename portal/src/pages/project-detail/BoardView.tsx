// The board view of the same work the tree shows.
//
// This used to be a hand-built CSS matrix — `gridTemplateColumns: '160px
// repeat(4, 1fr)'` with a sticky header row, a hairline on every cell edge and
// a dashed "—" box in each of the (many) empty cells. On a lopsided initiative
// that is four columns of dashed boxes, which is most of the clutter on the
// page. It is now one Card per epic holding four real lanes, so an empty lane
// says so once instead of drawing a placeholder per cell.

import { Avatar, BoardColumn, Card, CatalogGrid, Chip, EmptyState, Inline, Stack } from '@connorhoehnslalom/ui-components/shared';
import type { BotRun } from '../bots/BotsPage';
import { EstimateChip, PrBadge, RunStateChips, StatusChip } from './WorkItemChips';
import {
  BOARD_STATUSES,
  BOARD_STATUS_LABELS,
  PRIORITY_BORDER_CLASS,
  bucketByStatus,
} from './projectFormat';
import type { WorkItemTree } from './types';

function BoardCard({
  item,
  run,
  onEstimate,
}: {
  item: WorkItemTree;
  run: BotRun | undefined;
  onEstimate: (item: WorkItemTree) => void;
}) {
  const isBug = item.type === 'bug';
  return (
    <Card
      padding="sm"
      className={`border-l-[3px] ${PRIORITY_BORDER_CLASS[item.priority] ?? PRIORITY_BORDER_CLASS.medium}`}
    >
      <Stack gap="xs">
        <Inline gap="xs" align="start" wrap={false}>
          <Chip tone={isBug ? 'danger' : 'info'} size="xs" uppercase>{item.type}</Chip>
          {/* The title wraps rather than truncating: a card whose only job is
              to name the work must not end in "…". */}
          <span className="min-w-0 flex-1 text-[12px] font-medium leading-snug text-text-primary">
            {item.title}
          </span>
        </Inline>
        <Inline gap="xs" justify="between">
          <Inline gap="xs">
            {item.assigneeName && <Avatar name={item.assigneeName} size={18} title={item.assigneeName} />}
            {item.storyPoints != null && (
              <Chip tone="neutral" size="xs" mono title={`${item.storyPoints} story points`}>
                {item.storyPoints}pt
              </Chip>
            )}
          </Inline>
          <Inline gap="xs">
            <EstimateChip item={item} onEstimate={onEstimate} />
            <RunStateChips item={item} run={run} />
            {item.prStatus && <PrBadge prStatus={item.prStatus} prUrl={item.prUrl} />}
          </Inline>
        </Inline>
      </Stack>
    </Card>
  );
}

function EpicSwimlane({
  epic,
  marketRuns,
  onEstimate,
}: {
  epic: WorkItemTree;
  marketRuns: Record<string, BotRun>;
  onEstimate: (item: WorkItemTree) => void;
}) {
  const byStatus = bucketByStatus(epic);
  return (
    <Card padding="sm">
      <Stack gap="sm">
        <Inline gap="sm" align="center" wrap={false}>
          <Chip tone="neutral" size="xs" uppercase>Epic</Chip>
          <span className="min-w-0 flex-1 text-[13px] font-semibold text-text-primary">
            {epic.title}
          </span>
          {epic.assigneeName && <Avatar name={epic.assigneeName} size={18} title={epic.assigneeName} />}
          <StatusChip status={epic.status} />
        </Inline>
        <CatalogGrid columns={4} dense>
          {BOARD_STATUSES.map((status) => {
            const items = byStatus.get(status) ?? [];
            return (
              <BoardColumn
                key={status}
                label={BOARD_STATUS_LABELS[status]}
                count={items.length}
                emptyLabel="Nothing here"
              >
                {items.length > 0
                  ? items.map((item) => (
                    <BoardCard
                      key={item.id}
                      item={item}
                      run={marketRuns[item.id]}
                      onEstimate={onEstimate}
                    />
                  ))
                  : undefined}
              </BoardColumn>
            );
          })}
        </CatalogGrid>
      </Stack>
    </Card>
  );
}

export function BoardView({
  epics,
  marketRuns,
  onEstimate,
}: {
  epics: WorkItemTree[];
  marketRuns: Record<string, BotRun>;
  onEstimate: (item: WorkItemTree) => void;
}) {
  if (epics.length === 0) {
    return <EmptyState title="No epics yet" body="Create one to see the board." />;
  }
  return (
    <Stack gap="md">
      {epics.map((epic) => (
        <EpicSwimlane key={epic.id} epic={epic} marketRuns={marketRuns} onEstimate={onEstimate} />
      ))}
    </Stack>
  );
}
