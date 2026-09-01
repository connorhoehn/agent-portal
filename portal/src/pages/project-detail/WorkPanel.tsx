// The work column: a toolbar, then either the epic tree or the board.
//
// The view switch used to be two hand-styled <button>s inside a bordered div,
// sitting on the same line as a bare "3 epics" caption. Filters and view modes
// belong in a Toolbar directly above the thing they control, which is what this
// is now.

import { useState } from 'react';
import {
  Button,
  EmptyState,
  InlineAlert,
  LoadingState,
  SegmentedControl,
  Stack,
  Toolbar,
  ToolbarGroup,
} from '@connorhoehnslalom/ui-components/shared';
import type { BotRun } from '../bots/BotsPage';
import { BoardView } from './BoardView';
import { EpicCard } from './EpicCard';
import { NewItemForm, type NewItemDraft } from './NewItemForm';
import type { WorkItemStatus, WorkItemTree, WorkView } from './types';

const VIEW_OPTIONS = [
  { value: 'tree', label: '≡ List' },
  { value: 'board', label: '⊞ Board' },
];

export function WorkPanel({
  workTree,
  workLoading,
  canDispatch,
  showGrantCue,
  marketRuns,
  onStatusToggle,
  onAddItem,
  onAddEpic,
  onEstimate,
}: {
  workTree: WorkItemTree[];
  workLoading: boolean;
  canDispatch: boolean;
  /** sme-only pre-dispatch warning: no active sprint grant on this initiative. */
  showGrantCue: boolean;
  marketRuns: Record<string, BotRun>;
  onStatusToggle: (id: string, current: WorkItemStatus) => void;
  onAddItem: (parentId: string, draft: NewItemDraft) => void;
  onAddEpic: (draft: NewItemDraft) => void;
  onEstimate: (item: WorkItemTree) => void;
}) {
  const [workView, setWorkView] = useState<WorkView>('tree');
  const [addingEpic, setAddingEpic] = useState(false);

  return (
    <Stack gap="md">
      <Toolbar
        aria-label="Work view"
        end={(
          <SegmentedControl
            size="sm"
            options={VIEW_OPTIONS}
            value={workView}
            onChange={(v) => setWorkView(v as WorkView)}
          />
        )}
      >
        <ToolbarGroup>
          <span className="text-[13px] text-text-secondary tabular-nums">
            {workTree.length > 0 ? `${workTree.length} epic${workTree.length !== 1 ? 's' : ''}` : ''}
          </span>
        </ToolbarGroup>
      </Toolbar>

      {/* Pre-dispatch grant cue — sme-only, subtle, non-blocking. The Estimate
          control below still renders and still opens the drawer: authorization
          is enforced server-side and a grant could exist out-of-band, so this
          warns without presuming. */}
      {showGrantCue && (
        <InlineAlert tone="warning">
          You hold no active sprint grant on this initiative — ask the release manager for a grant
          before dispatching.
        </InlineAlert>
      )}

      {workLoading && <LoadingState label="Loading work items…" />}

      {workView === 'board' ? (
        <BoardView epics={workTree} marketRuns={marketRuns} onEstimate={onEstimate} />
      ) : (
        <Stack gap="md">
          {!workLoading && workTree.length === 0 && !addingEpic && (
            <EmptyState
              title="No work yet"
              body={canDispatch
                ? 'Create an epic, add sized stories and bugs, and dispatch them to agents from here.'
                : undefined}
            />
          )}
          {workTree.map((epic) => (
            <EpicCard
              key={epic.id}
              item={epic}
              onStatusToggle={onStatusToggle}
              onAddItem={onAddItem}
              marketRuns={marketRuns}
              onEstimate={onEstimate}
            />
          ))}
          {!canDispatch ? null : addingEpic ? (
            <NewItemForm
              defaultType="epic"
              onSave={(draft) => { onAddEpic(draft); setAddingEpic(false); }}
              onCancel={() => setAddingEpic(false)}
            />
          ) : (
            <Stack gap="none" align="start">
              <Button size="sm" variant="secondary" onClick={() => setAddingEpic(true)}>
                ⚡ New epic
              </Button>
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  );
}
