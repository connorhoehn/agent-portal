// The work column: a filter toolbar, then one of three views of the SAME
// backlog.
//
// It used to be a list of epic cards, each holding its own rows — so reading
// "what is in review across this initiative" meant expanding six cards and
// holding the answer in your head, and the board stacked one four-lane board
// per epic down the page. An initiative has one backlog. An epic is a way of
// FILTERING it, not a reason to draw another container.
//
// So: `items` (default) is the flat, sortable table of every dispatchable
// story and bug; `board` is ONE four-lane board over the same filtered set;
// `epics` keeps the per-epic rollup for when progress-per-epic is the actual
// question.
//
// Items and Board share every filter — same backlog, two shapes. Epics is
// deliberately different: an epic card's header states rollups over its FULL
// subtree, so hiding some of its rows would put the header and the rows it
// sits above into open disagreement (a header reading "4/7 stories" over two
// visible rows — a bug this page has already been fixed for once). So in
// Epics mode only the epic filter applies, and the filters that cannot apply
// are not rendered. A control that silently does nothing is worse than an
// absent one.

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Button,
  Card,
  Chip,
  DataTable,
  EmptyState,
  FilterChip,
  Inline,
  InlineAlert,
  LoadingState,
  SearchInput,
  SegmentedControl,
  Select,
  Stack,
  Toolbar,
  ToolbarGroup,
} from '@connorhoehnslalom/ui-components/shared';
import type { BotRun } from '../bots/BotsPage';
import { BoardView } from './BoardView';
import { EpicCard } from './EpicCard';
import { NewItemForm, type NewItemDraft } from './NewItemForm';
import { PersonRef } from './PersonRef';
import { T } from './Text';
import { WorkItemDrawer, useOpenWorkItem } from './WorkItemDrawer';
import { EstimateChip, PrBadge, RunStateChips, StatusChip } from './WorkItemChips';
import {
  assigneeFacets,
  epicFacets,
  filterWorkItems,
  flattenWorkItems,
  type FlatWorkItem,
} from './projectFormat';
import type { WorkItemStatus, WorkItemTree, WorkView } from './types';

const VIEW_OPTIONS = [
  { value: 'items', label: '≡ Items' },
  { value: 'board', label: '⊞ Board' },
  { value: 'epics', label: '◇ Epics' },
];

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'in_review', label: 'In review' },
  { value: 'done', label: 'Done' },
];

const TYPE_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All types' },
  { value: 'story', label: 'Stories' },
  { value: 'bug', label: 'Bugs' },
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
  const [workView, setWorkView] = useState<WorkView>('items');
  const [addingEpic, setAddingEpic] = useState(false);
  const [epicId, setEpicId] = useState('all');
  const [status, setStatus] = useState('all');
  const [type, setType] = useState('all');
  const [assigneeId, setAssigneeId] = useState('all');
  const [q, setQ] = useState('');

  const allItems = useMemo(() => flattenWorkItems(workTree), [workTree]);
  // Opened from the table's title links. Resolved against the UNFILTERED
  // list: a link pasted from elsewhere must still open even when the current
  // filters would hide its row.
  const { item: openItem, itemHref, close: closeItem } = useOpenWorkItem(allItems);
  const items = useMemo(
    () => filterWorkItems(allItems, { epicId, status, type, assigneeId, q }),
    [allItems, epicId, status, type, assigneeId, q],
  );
  // Facets count the WHOLE backlog, not the filtered slice: a facet whose
  // count moves as you filter can't tell you what picking it would give you.
  const epics = useMemo(() => epicFacets(workTree, allItems), [workTree, allItems]);
  const people = useMemo(() => assigneeFacets(allItems), [allItems]);

  const filtered = epicId !== 'all' || status !== 'all' || type !== 'all' || assigneeId !== 'all' || q !== '';
  // Item-level filters cut individual rows, which the epic rollup cards
  // cannot honour without contradicting their own headers.
  const itemFilters = workView !== 'epics';
  const visibleEpics = epicId === 'all' ? workTree : workTree.filter((e) => e.id === epicId);

  const columns = useMemo(() => [
    {
      // The machine slug, not decoration: it is what you paste into a prompt,
      // a commit message or a bot target, so it has to be selectable text on
      // the row rather than something you dig out of a detail pane.
      key: 'id',
      header: 'ID',
      width: '104px',
      sortable: true,
      render: (row: FlatWorkItem) => (
        // nowrap: an id is one token. Left to wrap, `wi-obs-e2-s3` broke at
        // its hyphens into "wi-" / "obs-" / "e2-s3" — three lines that no
        // longer read as a single identifier you could copy or recognise.
        <T className="whitespace-nowrap font-mono text-[11px] text-text-tertiary">{row.id}</T>
      ),
    },
    {
      // Type rides WITH the title rather than owning a column. Story-vs-bug is
      // one word that qualifies the title; giving it 72px of its own pushed
      // the row past the width of the pane and spilled the trailing controls
      // out over the rail beside it.
      key: 'title',
      header: 'Title',
      sortable: true,
      render: (row: FlatWorkItem) => (
        <Inline gap="xs" align="start" wrap={false}>
          <Chip tone={row.type === 'bug' ? 'danger' : 'info'} size="xs" uppercase>{row.type}</Chip>
          <Link
            to={itemHref(row.id)}
            className="font-medium text-text-primary no-underline hover:underline"
          >
            {row.title}
          </Link>
        </Inline>
      ),
    },
    {
      key: 'epicTitle',
      header: 'Epic',
      width: '134px',
      sortable: true,
      render: (row: FlatWorkItem) => (
        // Clicking an epic filters the backlog to it rather than navigating —
        // the epic is a lens on THIS table, so leaving the page to look at one
        // would be the wrong destination. A library Button, stripped of its
        // own chrome via className, is the real focusable control here — not
        // a hand-rolled clickable span.
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setEpicId(row.epicId)}
          title={`Filter to ${row.epicTitle} (${row.epicId})`}
          // One line, truncated. Left to wrap, "SLOs and error budgets" took
          // three lines and set the height of EVERY row — the epic is context
          // for the work, not the thing you came to read, so it must not cost
          // more vertical space than the title it sits beside. The full text
          // is on the title attribute and in the epic filter above.
          // max-w, not just truncate: the table lays out on content, so a
          // cell with no ceiling grows to fit its longest epic name and
          // pushes the whole row past the pane. The cap is what makes the
          // declared column width real.
          className="h-auto w-full min-w-0 max-w-[124px] flex-col items-start justify-start gap-0.5 border-0 p-0 text-left hover:bg-transparent hover:underline"
        >
          <T className="w-full truncate text-text-secondary">{row.epicTitle}</T>
          <T className="whitespace-nowrap font-mono text-[10px] text-text-tertiary">{row.epicId}</T>
        </Button>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '88px',
      sortable: true,
      render: (row: FlatWorkItem) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setStatus(row.status)}
          title={`Filter to ${row.status.replace('_', ' ')}`}
          className="h-auto min-w-0 cursor-pointer border-0 bg-transparent p-0 hover:bg-transparent"
        >
          <StatusChip status={row.status} />
        </Button>
      ),
    },
    {
      key: 'assigneeName',
      header: 'Assignee',
      width: '138px',
      sortable: true,
      render: (row: FlatWorkItem) => (
        // Capped for the same reason as the epic cell: a long name would set
        // the column's width and push the row past the pane.
        <T as="div" className="block max-w-[118px]">
          <PersonRef
            personId={row.assigneeId}
            name={row.assigneeName}
            department={row.assigneeDept}
          />
        </T>
      ),
    },
    {
      key: 'storyPoints',
      header: 'Pts',
      width: '56px',
      align: 'right' as const,
      sortable: true,
      // Explicit comparator: unpointed sorts last in both directions rather
      // than stringifying null into the middle of the numbers.
      compare: (a: FlatWorkItem, b: FlatWorkItem) => (a.storyPoints ?? -1) - (b.storyPoints ?? -1),
      render: (row: FlatWorkItem) => (
        <T className="tabular-nums text-text-secondary">{row.storyPoints ?? '—'}</T>
      ),
    },
    {
      key: 'signals',
      header: '',
      // 112px was sized when this column held glyphs only. The estimate
      // provenance chip ("Rachel Kowalski · just now") and the play action are
      // both real content now, and at 112px the ▶ button rendered as "▶ Ru" —
      // a clipped control on a money path, which is worse than no control.
      // The chip truncates inside this width; its full text is in the tooltip.
      // Sized so the table stays inside its overflow-x wrapper: the wrapper
      // scrolls, so an oversized column hides a spend control off-screen
      // rather than clipping it visibly, which is the worse failure.
      width: '224px',
      filterable: false,
      render: (row: FlatWorkItem) => (
        <Inline gap="xs" align="center" justify="end" wrap={false}>
          <EstimateChip item={row} onEstimate={onEstimate} />
          <RunStateChips item={row} run={marketRuns[row.id]} />
          {row.prStatus && <PrBadge prStatus={row.prStatus} prUrl={row.prUrl} />}
        </Inline>
      ),
    },
  ], [marketRuns, onEstimate, itemHref]);

  return (
    <Stack gap="md">
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

      {/* One frame, not three: the filter toolbar is the table's header row,
          so the search box, the chips and the ID column share one left edge
          and there is no seam between "filters" and "rows". */}
      <Card padding="none" className="overflow-hidden">
      {/* wrap: six filter controls plus a view switch do not fit one row in
          this pane, and the default scroller would hide the status chips
          entirely — a filter you cannot see is a filter that does not exist. */}
      <Toolbar
        wrap
        bordered
        aria-label="Work filters"
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
          {itemFilters && (
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="Search work…"
              aria-label="Search work items"
              className="w-[200px] shrink-0"
            />
          )}
          <Select
            size="sm"
            aria-label="Filter by epic"
            value={epicId}
            onChange={(e) => setEpicId(e.target.value)}
            options={[
              // "All epics (17)" read as SEVENTEEN EPICS; 17 was the item
              // count. Every count in this control is items, so the one that
              // could be misread says which.
              { value: 'all', label: `All epics · ${allItems.length} items` },
              ...epics.map((e) => ({ value: e.value, label: `${e.label} (${e.count})` })),
            ]}
          />
          {itemFilters && (
            <Select
              size="sm"
              aria-label="Filter by type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              options={TYPE_FILTERS}
            />
          )}
          {itemFilters && people.length > 0 && (
            <Select
              size="sm"
              aria-label="Filter by assignee"
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              options={[
                { value: 'all', label: 'Anyone' },
                ...people.map((p) => ({ value: p.value, label: `${p.label} (${p.count})` })),
              ]}
            />
          )}
        </ToolbarGroup>
        {itemFilters && (
          <ToolbarGroup>
            {/* `sm`, not `xs`: these are the most-used control in the
                toolbar and at xs they read as captions rather than as
                buttons — small enough to be hard to hit and easy to miss. */}
            {STATUS_FILTERS.map((s) => (
              <FilterChip key={s.value} size="md" active={status === s.value} onClick={() => setStatus(s.value)}>
                {s.label}
              </FilterChip>
            ))}
          </ToolbarGroup>
        )}
      </Toolbar>

      {workLoading && <LoadingState label="Loading work items…" />}

      {workView === 'board' && (
        <BoardView
          items={items}
          marketRuns={marketRuns}
          onEstimate={onEstimate}
          itemHref={itemHref}
        />
      )}

      {workView === 'items' && !workLoading && (
        <DataTable<FlatWorkItem>
          frameless
          striped
          data={items}
          columns={columns}
          keyField={(row) => row.id}
          pageSize={25}
          emptyMessage={filtered
            ? 'No work items match these filters.'
            : 'No work yet — create an epic, then add sized stories and bugs to it.'}
        />
      )}
      </Card>

      {workView === 'epics' && (
        <Stack gap="md">
          {!workLoading && visibleEpics.length === 0 && !addingEpic && (
            <EmptyState
              title="No epics yet"
              body={canDispatch
                ? 'Create an epic, add sized stories and bugs, and dispatch them to agents from here.'
                : undefined}
            />
          )}
          {visibleEpics.map((epic) => (
            <EpicCard
              key={epic.id}
              item={epic}
              onStatusToggle={onStatusToggle}
              onAddItem={onAddItem}
              marketRuns={marketRuns}
              onEstimate={onEstimate}
            />
          ))}
        </Stack>
      )}

      <WorkItemDrawer
        item={openItem}
        onClose={closeItem}
        onEstimate={onEstimate}
        canDispatch={canDispatch}
      />

      {/* Creating an epic is a backlog-level action, not a property of whichever
          view happens to be mounted — so it stays put across all three. */}
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
  );
}
