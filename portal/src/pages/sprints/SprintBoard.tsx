// The work board for one sprint: the items in it, bucketed by status, plus the
// two ManageSprints writes (move an item in, move one out).

import { useMemo, useReducer, useState, type KeyboardEvent } from 'react';
import {
  BoardColumn,
  Button,
  Card,
  CatalogGrid,
  Chip,
  EmptyState,
  FilterChip,
  IconButton,
  Inline,
  Link as ExternalLink,
  LoadingState,
  MetaLine,
  Select,
  Stack,
  T,
  Toolbar,
  ToolbarGroup,
  ToolbarLabel,
} from '@connorhoehnslalom/ui-components/shared';
import { useUrlState } from '../../lib/useUrlState';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { escapeNestReducer, INITIAL_ESCAPE_NEST_STATE, shouldHostHandleEscape, topEscapeLayer } from './escapeNesting';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { sprintItemUrl, sprintItemsUrl } from './sprintForm';
import { addableItems, applyQuickFilters, bucketByColumn, parseQuickFilters, PRIORITY_TONE, QUICK_FILTERS, serializeQuickFilters, usd, type QuickFilter } from './sprintFormat';
import { writeJson } from '../../lib/writeJson';
import type { WorkItem, WorkTreeNode } from './types';

// Move an item INTO this sprint. The candidate list is the initiative's work
// tree minus what is already here — offering an item already in the sprint
// would be a no-op, and the PATCH allows re-homing one from another sprint.
function AddItemControl({ sprintId, orgProjectId, presentIds, onAdded }: {
  sprintId: string; orgProjectId: string; presentIds: Set<string>; onAdded: () => void;
}) {
  // Same nesting rule as GrantsPanel's forms (escapeNesting.ts): this
  // control lives inside the sprint drawer's Work tab, and the drawer's own
  // Escape-to-close must not fire while this inline form is open — one
  // Escape cancels the form and returns focus to "+ Add work item"; only
  // the next one closes the drawer.
  const [nest, dispatchNest] = useReducer(escapeNestReducer, INITIAL_ESCAPE_NEST_STATE);
  const open = topEscapeLayer(nest) === 'add';

  const { data: tree } = useFetch<WorkTreeNode[]>(
    open ? `/api/graph/projects/${encodeURIComponent(orgProjectId)}/work` : null,
  );
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);

  const candidates = useMemo(
    () => addableItems(tree ?? [], presentIds),
    [tree, presentIds],
  );

  function openForm() {
    dispatchNest({ type: 'open', id: 'add' });
  }
  function closeForm() {
    dispatchNest({ type: 'close', id: 'add' });
    setChoice('');
    // "+ Add work item" is conditionally rendered, not just hidden, so it has
    // already unmounted by the time this runs — a captured DOM ref would be
    // stale. The stable `data-add-item-trigger` survives the remount; the
    // requestAnimationFrame runs after it's back (same pattern as
    // EstimateDrawer's `handleClose` / GrantsPanel's `focusTrigger`).
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-add-item-trigger]')?.focus();
    });
  }
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (shouldHostHandleEscape(nest)) return;
    e.preventDefault();
    e.stopPropagation();
    closeForm();
  }

  async function add() {
    if (!choice) return;
    setBusy(true);
    const res = await writeJson<{ workItem: WorkItem }>(sprintItemsUrl(sprintId), 'PATCH', { workItemId: choice });
    setBusy(false);
    if (!res.ok) { toastError(null, 'Could not add item', res.error ?? ''); return; }
    toastSuccess(null, 'Item added to sprint');
    closeForm();
    onAdded();
  }

  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={openForm} data-add-item-trigger>
        + Add work item
      </Button>
    );
  }
  return (
    <Inline gap="xs" onKeyDown={handleKeyDown}>
      <Select
        size="sm"
        className="w-auto min-w-[220px]"
        aria-label="Work item to add to this sprint"
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        // The form mounts fresh every time "+ Add work item" opens it —
        // autoFocus lands the keyboard here instead of leaving it on
        // `<body>`, which is what made this form's own Escape handler
        // never see the key.
        autoFocus
        options={[
          {
            value: '',
            label: candidates.length ? 'Select an item to add…' : 'No addable items in this initiative',
          },
          ...candidates.map((c) => ({ value: c.id, label: `${c.type} · ${c.title}` })),
        ]}
      />
      <Button size="sm" variant="primary" disabled={busy || !choice} onClick={() => void add()}>Add</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={closeForm}>Cancel</Button>
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
          <T size="sm" className="leading-snug">{item.title}</T>
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
              ? <ExternalLink external key="pr" href={item.prUrl} className="text-primary">PR</ExternalLink>
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
  // Jira-style quick filters, in the URL (`?quick=mine,recent`) so a filtered
  // board survives Back, refresh and a shared link.
  const [quick, setQuick] = useUrlState<QuickFilter[]>('quick', parseQuickFilters, serializeQuickFilters);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const items = useMemo(
    () => applyQuickFilters(data ?? [], quick, { personId }),
    [data, quick, personId],
  );
  // "Only my issues" needs a linked person to mean anything.
  const offered = QUICK_FILTERS.filter((f) => f.id !== 'mine' || personId);
  const toggle = (id: QuickFilter) => setQuick(quick.includes(id) ? quick.filter((q) => q !== id) : [...quick, id]);

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
    return (
      <UnavailableNotice error={error} what="this sprint's work" source="Sprint items are read from Aurora" onRetry={refresh} />
    );
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
      {/* The quick-filter row above the board, as Jira and Linear draw it:
          a labelled run of toggles at the board's left edge, the one write
          (add an item) at its end. */}
      <Toolbar size="sm" aria-label="Board quick filters" end={addControl ?? undefined}>
        <ToolbarGroup aria-label="Quick filters">
          <ToolbarLabel>Quick filters</ToolbarLabel>
          {offered.map((f) => (
            <FilterChip
              key={f.id}
              size="sm"
              active={quick.includes(f.id)}
              onClick={() => toggle(f.id)}
              title={f.title}
              data-testid={`sprint-board-quick-${f.id}`}
            >
              {f.label}
            </FilterChip>
          ))}
          {quick.length > 0 ? (
            <Button size="sm" variant="link" onClick={() => setQuick([])}>Clear</Button>
          ) : null}
        </ToolbarGroup>
        {quick.length > 0 ? (
          <ToolbarGroup divided>
            <ToolbarLabel>{items.length} of {(data ?? []).length} items</ToolbarLabel>
          </ToolbarGroup>
        ) : null}
      </Toolbar>
      {/* Fixed columns, not auto-fit: an auto-fit grid stretches the two empty
          lanes across half the screen the moment a board is lopsided. */}
      <CatalogGrid columns={columns.length >= 5 ? 5 : 4} dense variant="lanes">
        {columns.map((col) => (
          <BoardColumn
            key={col.status}
            label={col.label}
            count={col.items.length}
            emptyLabel={quick.length ? 'No matching items' : 'No items'}
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
