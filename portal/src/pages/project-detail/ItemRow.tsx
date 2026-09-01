// One story or bug, and — when it has them — its children.
//
// WHY THIS RECURSES NOW. It used to render exactly one level and said so:
// "No expansion: the two-level tree ends here." The API disagrees. It returns
// story->story nesting (e.g. p-llm-platform: epic -> 2 stories -> 5 sized
// stories), and the epic header's numbers come from `pointsFor`/`countsFor` in
// projectFormat.ts, which walk the FULL subtree.
//
// So the header read "4/7 stories · 18/31 pts" above a list of 2 rows carrying
// no points at all, and every dispatchable, sized item was invisible. The Board
// view was fine the whole time because it flattens the subtree — which is why
// the two views disagreed about the same epic.
//
// Collapsed by default: the operator asked for a few things to look at at a
// time, and auto-expanding every branch rebuilds the wall of rows this is
// meant to avoid. A parent always shows its child count, so a collapsed row
// never hides the FACT of what is under it — that is the part that made the old
// behaviour a lie rather than merely terse.

import { useState } from 'react';
import { Avatar, Checkbox, Chip, Inline, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import type { BotRun } from '../bots/BotsPage';
import { EstimateChip, PrBadge, RunStateChips, StatusChip } from './WorkItemChips';
import type { WorkItemStatus, WorkItemTree } from './types';

/**
 * Indent per level, as static classes.
 *
 * A lookup rather than a computed `pl-[${n}px]`: Tailwind scans source text, so
 * a class name built at runtime is never generated and the row renders flush.
 * Depth is clamped to the last entry — a tree deeper than this indents no
 * further, which is better than falling back to zero indent and reading as a
 * sibling of the root.
 */
const INDENT = ['pl-0', 'pl-5', 'pl-10', 'pl-14', 'pl-20'] as const;

function indentFor(depth: number): string {
  return INDENT[Math.min(depth, INDENT.length - 1)];
}

export function ItemRow({
  item,
  onStatusToggle,
  run,
  runFor,
  onEstimate,
  depth = 0,
}: {
  item: WorkItemTree;
  onStatusToggle: (id: string, current: WorkItemStatus) => void;
  /** This row's run. Kept for the existing call site. */
  run: BotRun | undefined;
  /** Looks up a run for a DESCENDANT, which the caller cannot enumerate. */
  runFor?: (id: string) => BotRun | undefined;
  onEstimate: (item: WorkItemTree) => void;
  depth?: number;
}) {
  const isDone = item.status === 'done';
  const isBug = item.type === 'bug';
  const { can, ready } = useCapabilities();
  const canEdit = ready && can('DispatchAgentRun');

  const children = item.children ?? [];
  const hasChildren = children.length > 0;
  const [open, setOpen] = useState(false);

  return (
    <Stack gap="none">
      <Inline
        gap="sm"
        wrap={false}
        align="center"
        className={[
          'rounded-md px-3.5 py-1.5 transition-colors',
          indentFor(depth),
          isDone ? 'bg-surface-hover' : 'bg-surface hover:bg-surface-panel',
        ].join(' ')}
      >
        {/* Disclosure. A real <button> with aria-expanded, not a clickable
            glyph — this is the only control that reveals the sized work, so it
            has to be reachable from the keyboard and announced as a toggle.
            Leaf rows render a fixed-width spacer so titles stay aligned down
            the column. */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${children.length} under "${item.title}"`}
            className="shrink-0 w-4 text-[11px] leading-none text-text-tertiary hover:text-text-primary"
          >
            <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          </button>
        ) : (
          <span aria-hidden="true" className="shrink-0 w-4" />
        )}

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

        {/* The count of what is hidden. Shown whether open or closed, because
            its job is to say the subtree EXISTS, not to describe the toggle. */}
        {hasChildren && (
          <Chip tone="neutral" size="xs" title={`${children.length} nested item(s)`}>
            {children.length}
          </Chip>
        )}

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

      {hasChildren && open && (
        <Stack gap="none">
          {children.map((child) => (
            <ItemRow
              key={child.id}
              item={child}
              depth={depth + 1}
              onStatusToggle={onStatusToggle}
              run={runFor?.(child.id)}
              runFor={runFor}
              onEstimate={onEstimate}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
