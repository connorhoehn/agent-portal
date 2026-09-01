// The work board for one sprint: the items in it, bucketed by status, plus the
// two ManageSprints writes (move an item in, move one out).

import { useMemo, useState } from 'react';
import {
  BoardColumn,
  Button,
  Card,
  CatalogGrid,
  Chip,
  EmptyState,
  IconButton,
  Inline,
  LoadingState,
  MetaLine,
  Select,
  Stack,
  Switch,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { sprintItemUrl, sprintItemsUrl } from './sprintForm';
import { addableItems, bucketByColumn, PRIORITY_TONE, usd } from './sprintFormat';
import { writeJson } from './writeJson';
import type { WorkItem, WorkTreeNode } from './types';

// Move an item INTO this sprint. The candidate list is the initiative's work
// tree minus what is already here — offering an item already in the sprint
// would be a no-op, and the PATCH allows re-homing one from another sprint.
function AddItemControl({ sprintId, orgProjectId, presentIds, onAdded }: {
  sprintId: string; orgProjectId: string; presentIds: Set<string>; onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: tree } = useFetch<WorkTreeNode[]>(
    open ? `/api/graph/projects/${encodeURIComponent(orgProjectId)}/work` : null,
  );
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);

  const candidates = useMemo(
    () => addableItems(tree ?? [], presentIds),
    [tree, presentIds],
  );

  async function add() {
    if (!choice) return;
    setBusy(true);
    const res = await writeJson<{ workItem: WorkItem }>(sprintItemsUrl(sprintId), 'PATCH', { workItemId: choice });
    setBusy(false);
    if (!res.ok) { toastError(null, 'Could not add item', res.error ?? ''); return; }
    toastSuccess(null, 'Item added to sprint');
    setChoice(''); setOpen(false);
    onAdded();
  }

  if (!open) {
    return <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>+ Add work item</Button>;
  }
  return (
    <Inline gap="xs">
      <Select
        size="sm"
        className="w-auto min-w-[220px]"
        aria-label="Work item to add to this sprint"
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        options={[
          {
            value: '',
            label: candidates.length ? 'Select an item to add…' : 'No addable items in this initiative',
          },
          ...candidates.map((c) => ({ value: c.id, label: `${c.type} · ${c.title}` })),
        ]}
      />
      <Button size="sm" variant="primary" disabled={busy || !choice} onClick={() => void add()}>Add</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setOpen(false); setChoice(''); }}>Cancel</Button>
    </Inline>
  );
}

function WorkItemCard({ item, isMine, canRemove, removing, onRemove }: {
  item: WorkItem; isMine: boolean; canRemove: boolean; removing: boolean; onRemove: () => void;
}) {
  return (
    <Card
      padding="none"
      // The one row that is yours should be findable in a column of twelve
      // without reading every assignee.
      className={isMine ? 'p-2 border-l-[3px] border-l-primary' : 'p-2'}
    >
      <Stack gap="xs">
        <Inline gap="xs" align="start" justify="between" wrap={false}>
          <span className="text-[13px] leading-snug">{item.title}</span>
          {canRemove ? (
            <IconButton
              aria-label={`Remove ${item.title} from this sprint`}
              title="Remove from this sprint"
              size="sm"
              variant="ghost"
              disabled={removing}
              onClick={onRemove}
              icon="✕"
            />
          ) : null}
        </Inline>
        <MetaLine
          items={[
            <Chip key="type" tone="neutral" size="sm">{item.type}</Chip>,
            // Priority is shown only when it is one — a chip on every card
            // says nothing about which to pick up.
            PRIORITY_TONE[item.priority]
              ? <Chip key="prio" tone={PRIORITY_TONE[item.priority]!} size="sm">{item.priority}</Chip>
              : null,
            item.storyPoints != null ? `${item.storyPoints} pts` : null,
            // Complexity and dollars are the two estimates the model plans
            // in — never hours.
            item.estimatedCostUsd != null ? `est ${usd(item.estimatedCostUsd)}` : null,
            item.assigneeName,
            item.prUrl
              ? <a key="pr" href={item.prUrl} target="_blank" rel="noreferrer" className="text-primary">PR</a>
              : null,
          ]}
        />
      </Stack>
    </Card>
  );
}

export function SprintBoard({ sprintId, orgProjectId, personId, canManageSprints, onChanged }: {
  sprintId: string; orgProjectId: string; personId: string | null;
  canManageSprints: boolean; onChanged: () => void;
}) {
  const { data, isLoading, error, refresh } = useFetch<WorkItem[]>(
    `/api/graph/work?sprint=${encodeURIComponent(sprintId)}&limit=200`,
  );
  const [mineOnly, setMineOnly] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const items = useMemo(() => {
    const all = data ?? [];
    return mineOnly && personId ? all.filter((i) => i.assigneeId === personId) : all;
  }, [data, mineOnly, personId]);

  const presentIds = useMemo(() => new Set((data ?? []).map((i) => i.id)), [data]);
  const columns = useMemo(() => bucketByColumn(items), [items]);

  const afterChange = () => { refresh(); onChanged(); };

  async function removeItem(id: string) {
    setRemovingId(id);
    const res = await writeJson<{ workItem: WorkItem }>(sprintItemUrl(sprintId, id), 'DELETE');
    setRemovingId(null);
    if (!res.ok) { toastError(null, 'Could not remove item', res.error ?? ''); return; }
    toastSuccess(null, 'Item removed from sprint');
    afterChange();
  }

  const addControl = canManageSprints ? (
    <AddItemControl sprintId={sprintId} orgProjectId={orgProjectId} presentIds={presentIds} onAdded={afterChange} />
  ) : null;

  if (error) {
    return <EmptyState title="Could not load this sprint's work" description={error} />;
  }
  if (isLoading && !data) {
    return <LoadingState label="Loading work…" />;
  }
  if ((data ?? []).length === 0) {
    return (
      <Stack gap="sm">
        <EmptyState
          title="No work items in this sprint"
          body="Items carry sprint membership on the board — assign one to this sprint from the initiative's work items."
        />
        {addControl}
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <Inline justify="between">
        {addControl ?? <span />}
        {personId ? (
          <Inline gap="xs" as="label" className="text-[12px] text-text-secondary cursor-pointer">
            <Switch
              checked={mineOnly}
              onChange={setMineOnly}
              size="sm"
              aria-label="Only work assigned to me"
            />
            Only work assigned to me
          </Inline>
        ) : null}
      </Inline>
      {/* Fixed columns, not auto-fit: an auto-fit grid stretches the two empty
          lanes across half the screen the moment a board is lopsided. */}
      <CatalogGrid columns={columns.length >= 5 ? 5 : 4} dense>
        {columns.map((col) => (
          <BoardColumn
            key={col.status}
            label={col.label}
            count={col.items.length}
            emptyLabel="—"
          >
            {col.items.map((i) => (
              <WorkItemCard
                key={i.id}
                item={i}
                isMine={!!personId && i.assigneeId === personId}
                canRemove={canManageSprints}
                removing={removingId === i.id}
                onRemove={() => void removeItem(i.id)}
              />
            ))}
          </BoardColumn>
        ))}
      </CatalogGrid>
    </Stack>
  );
}
