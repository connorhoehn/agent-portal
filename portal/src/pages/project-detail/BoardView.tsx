// ONE board for the initiative's whole backlog.
//
// This used to render a Card per epic, each with its own four lanes — so an
// initiative with six epics stacked six boards down the page and you could
// never see "everything in review" in one place, which is the only question a
// board answers. An initiative has one backlog; an epic is a way of filtering
// it, so filtering happens in the toolbar above and this draws four lanes,
// once, over whatever survived.

import { Link } from 'react-router';
import { Avatar, BoardColumn, Card, CatalogGrid, Chip, EmptyState, Inline, SectionLabel, Stack } from '@connorhoehnslalom/ui-components/shared';
import type { BotRun } from '../bots/BotsPage';
import { EstimateChip, PrBadge, RunStateChips } from './WorkItemChips';
import {
  BOARD_STATUSES,
  BOARD_STATUS_LABELS,
  PRIORITY_BORDER_CLASS,
  bucketItemsByStatus,
} from './projectFormat';
import type { FlatWorkItem } from './projectFormat';
import type { WorkItemTree } from './types';

function BoardCard({
  item,
  run,
  onEstimate,
  itemHref,
}: {
  item: FlatWorkItem;
  run: BotRun | undefined;
  onEstimate: (item: WorkItemTree) => void;
  itemHref: (id: string) => string;
}) {
  const isBug = item.type === 'bug';
  return (
    // Only the title opens the item (same `?item=` destination the table's
    // titles use) — the card itself is not a link. It used to wrap the whole
    // card in a `Link`, which put PrBadge's external `<a>` and RunStateChips'
    // internal `Link`s inside it: an `<a>` nested in an `<a>`, which React
    // (correctly) logs as a hydration error. `ItemRow` already links only the
    // title for the same item in the tree view, so this brings Board in line
    // with it rather than inventing a third pattern.
    <Card
      padding="sm"
      className={`border-l-[3px] ${PRIORITY_BORDER_CLASS[item.priority] ?? PRIORITY_BORDER_CLASS.medium}`}
    >
      <Stack gap="xs">
        <Inline gap="xs" align="start" wrap={false}>
          <Chip tone={isBug ? 'danger' : 'info'} size="xs" uppercase>{item.type}</Chip>
          {/* The title wraps rather than truncating: a card whose only job is
              to name the work must not end in "…". */}
          <Link
            to={itemHref(item.id)}
            className="min-w-0 flex-1 text-[12px] font-medium leading-snug text-text-primary no-underline hover:underline"
          >
            {item.title}
          </Link>
        </Inline>
        {/* With one board across all epics, the card has to say which epic it
            belongs to — that context used to come from the swimlane header. */}
        <SectionLabel as="div" className="truncate">
          {item.epicTitle}
        </SectionLabel>
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

export function BoardView({
  items,
  marketRuns,
  onEstimate,
  itemHref,
}: {
  items: FlatWorkItem[];
  marketRuns: Record<string, BotRun>;
  onEstimate: (item: WorkItemTree) => void;
  itemHref: (id: string) => string;
}) {
  if (items.length === 0) {
    return <EmptyState title="Nothing on the board" body="No work items match the current filters." />;
  }
  const byStatus = bucketItemsByStatus(items);
  return (
    <CatalogGrid columns={4} dense>
      {BOARD_STATUSES.map((status) => {
        const lane = byStatus.get(status) ?? [];
        return (
          <BoardColumn
            key={status}
            label={BOARD_STATUS_LABELS[status]}
            count={lane.length}
            emptyLabel="Nothing here"
          >
            {lane.length > 0
              ? lane.map((item) => (
                <BoardCard
                  key={item.id}
                  item={item}
                  run={marketRuns[item.id]}
                  onEstimate={onEstimate}
                  itemHref={itemHref}
                />
              ))
              : undefined}
          </BoardColumn>
        );
      })}
    </CatalogGrid>
  );
}
