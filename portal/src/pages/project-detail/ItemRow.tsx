// One story or bug — the dispatchable unit. No expansion: the two-level tree
// ends here.

import { Avatar, Checkbox, Chip, Inline } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import type { BotRun } from '../bots/BotsPage';
import { EstimateChip, PrBadge, RunStateChips, StatusChip } from './WorkItemChips';
import type { WorkItemStatus, WorkItemTree } from './types';

export function ItemRow({
  item,
  onStatusToggle,
  run,
  onEstimate,
}: {
  item: WorkItemTree;
  onStatusToggle: (id: string, current: WorkItemStatus) => void;
  run: BotRun | undefined;
  onEstimate: (item: WorkItemTree) => void;
}) {
  const isDone = item.status === 'done';
  const isBug = item.type === 'bug';
  const { can, ready } = useCapabilities();
  const canEdit = ready && can('DispatchAgentRun');

  return (
    <Inline
      gap="sm"
      wrap={false}
      align="center"
      className={[
        'rounded-md px-3.5 py-1.5 transition-colors',
        isDone ? 'bg-surface-hover' : 'bg-surface hover:bg-surface-panel',
      ].join(' ')}
    >
      {/* The done-toggle PATCHes the item — DispatchAgentRun only. Viewers
          still see the status via the glyph, strikethrough and status chip. */}
      {canEdit && (
        <Checkbox
          checked={isDone}
          aria-label={`Mark "${item.title}" done`}
          onChange={() => onStatusToggle(item.id, item.status)}
        />
      )}

      {/* Type glyph — a bug reads danger so it can't be mistaken for a story
          at a glance; a story takes a muted primary. */}
      <span
        aria-hidden="true"
        title={isBug ? 'bug' : 'story'}
        className={`shrink-0 font-mono text-[12px] ${isBug ? 'text-danger' : 'text-primary/50'}`}
      >
        {isBug ? '◆' : '■'}
      </span>
      {isBug && <Chip tone="danger" size="xs">bug</Chip>}

      <span
        className={[
          'min-w-0 flex-1 text-[13px] font-medium',
          isDone ? 'text-text-tertiary line-through' : 'text-text-primary',
        ].join(' ')}
      >
        {item.title}
      </span>

      {item.labels.slice(0, 2).map((l) => (
        <Chip key={l} tone="neutral" size="xs">{l}</Chip>
      ))}

      <EstimateChip item={item} onEstimate={onEstimate} />
      <RunStateChips item={item} run={run} />

      {item.prStatus && <PrBadge prStatus={item.prStatus} prUrl={item.prUrl} />}

      {item.storyPoints != null && (
        <Chip tone="neutral" size="xs" mono title={`${item.storyPoints} story points`}>
          {item.storyPoints}
        </Chip>
      )}

      {item.assigneeName && <Avatar name={item.assigneeName} size={22} title={item.assigneeName} />}

      <StatusChip status={item.status} />
    </Inline>
  );
}
