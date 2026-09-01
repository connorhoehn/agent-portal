// One epic and the stories and bugs directly inside it — the feature tier is
// gone, so this is the whole tree.

import { useState } from 'react';
import {
  Avatar,
  Button,
  Card,
  CollapsibleSection,
  Inline,
  InlinePlaceholder,
  ProgressBar,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import type { BotRun } from '../bots/BotsPage';
import { ItemRow } from './ItemRow';
import { NewItemForm, type NewItemDraft } from './NewItemForm';
import { StatusChip } from './WorkItemChips';
import { PRIORITY_GLYPH, countPoints, countStories, progressColor } from './projectFormat';
import type { WorkItemStatus, WorkItemTree } from './types';

/** The at-a-glance summary that rides on the epic's disclosure header:
 *  priority, story count, point progress, assignee, status. */
function EpicSummary({ item }: { item: WorkItemTree }) {
  const pts = countPoints(item);
  const stories = countStories(item);
  const pct = pts.total > 0 ? Math.round((pts.done / pts.total) * 100) : 0;

  return (
    <Inline gap="sm" align="center" wrap={false}>
      <span aria-hidden="true" className="shrink-0 text-[11px]" title={`priority: ${item.priority}`}>
        {PRIORITY_GLYPH[item.priority] ?? PRIORITY_GLYPH.medium}
      </span>
      {stories.total > 0 && (
        <span className="shrink-0 whitespace-nowrap text-[12px] text-text-secondary tabular-nums">
          {stories.done}/{stories.total} stories
        </span>
      )}
      {pts.total > 0 && (
        // No `label`: ProgressBar prints its own percentage beside a label, so
        // passing "58%" as the label rendered "58% ▬▬▬ 58%".
        <>
          <ProgressBar
            className="w-[72px] shrink-0"
            value={pts.done}
            max={pts.total}
            size="sm"
            color={progressColor(pct)}
            showRatio={false}
            aria-label={`${pct}% of points done`}
          />
          <span className="shrink-0 text-[11px] text-text-secondary tabular-nums">{pct}%</span>
        </>
      )}
      {item.assigneeName && <Avatar name={item.assigneeName} size={24} title={item.assigneeName} />}
      <StatusChip status={item.status} />
    </Inline>
  );
}

export function EpicCard({
  item,
  onStatusToggle,
  onAddItem,
  marketRuns,
  onEstimate,
}: {
  item: WorkItemTree;
  onStatusToggle: (id: string, current: WorkItemStatus) => void;
  onAddItem: (parentId: string, draft: NewItemDraft) => void;
  marketRuns: Record<string, BotRun>;
  onEstimate: (item: WorkItemTree) => void;
}) {
  const [addingItem, setAddingItem] = useState(false);
  const { can, ready } = useCapabilities();
  const canEdit = ready && can('DispatchAgentRun');

  return (
    <Card padding="none" className="overflow-hidden">
      <CollapsibleSection
        title={item.title}
        defaultOpen={item.status !== 'done'}
        badge={<EpicSummary item={item} />}
      >
        <Stack gap="sm" className="bg-surface-inset px-4 py-3">
          {item.description && (
            <p className="m-0 text-[13px] leading-relaxed text-text-secondary">{item.description}</p>
          )}

          <Stack gap="none">
            {item.children.map((child) => (
              <ItemRow
                key={child.id}
                item={child}
                onStatusToggle={onStatusToggle}
                run={marketRuns[child.id]}
                // Descendants are discovered by the row itself as it expands, so
                // it needs a lookup rather than a value — this card only knows
                // its own direct children and cannot enumerate deeper ids.
                runFor={(id) => marketRuns[id]}
                onEstimate={onEstimate}
              />
            ))}
            {item.children.length === 0 && (
              <InlinePlaceholder>No stories or bugs yet</InlinePlaceholder>
            )}
          </Stack>

          {/* Add story / bug — creation POSTs a work item (DispatchAgentRun). */}
          {!canEdit ? null : addingItem ? (
            <NewItemForm
              defaultType="story"
              typeOptions={['story', 'bug']}
              onSave={(draft) => { onAddItem(item.id, draft); setAddingItem(false); }}
              onCancel={() => setAddingItem(false)}
            />
          ) : (
            <Inline gap="none">
              <Button size="sm" variant="ghost" onClick={() => setAddingItem(true)}>
                + Add story / bug
              </Button>
            </Inline>
          )}
        </Stack>
      </CollapsibleSection>
    </Card>
  );
}
