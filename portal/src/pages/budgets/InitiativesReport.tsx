// Initiatives report — the per-initiative allocation ledger: what each
// initiative is allowed to spend this period, against what it actually spent.
// Every mutating affordance (set / edit / delete an allocation) is gated on
// the ManageBudgets capability, same engine as the API's own gate.

import { useEffect, useRef, useState } from 'react';
import { matchesBudget } from './budgetsCommands';
import { Link } from 'react-router';
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  DataTable,
  type DataTableColumn,
  EmptyState,
  IconButton,
  Inline,
  Input,
  Select,
  Stack,
  T,
  TrashIcon,
} from '@connorhoehn/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { usd, ago, rowBudgetStats, budgetPeriodLabel } from './budgetsFormat';
import type { BudgetAccessLock, BudgetRow, InitiativeOption } from './types';
import { LockedFigure } from '../projects/BudgetAccess';
import { SpendFigureCell } from './SpendGroupTable';
import { discretionaryBudget, floorFigure, moneyOrDash, remainingTone, type InitiativeLedgerRow } from './spendReportModel';
import { ThresholdCell } from './ThresholdCell';
import { passesThresholdFilter, type ThresholdFilter } from './thresholdModel';

async function putAllocation(orgProjectId: string, allocatedUsd: number): Promise<boolean> {
  const res = await writeJson(`/api/budgets/${encodeURIComponent(orgProjectId)}`, 'PUT', { allocatedUsd });
  if (!res.ok) {
    toastError(null, 'Failed to set budget', res.error ?? undefined);
    return false;
  }
  // A money write with no acknowledgement read as "did that take?" — the row
  // re-renders, but the person is looking at the cell they just left.
  toastSuccess(null, 'Budget set', `$${allocatedUsd.toFixed(2)} / month`);
  return true;
}

// ─── Inline allocation editor ────────────────────────────────────────────────

function AllocationCell({ row, canManage, onSaved, onRemove }: {
  row: BudgetRow;
  canManage: boolean;
  onSaved: () => void;
  /** Remove this allocation (confirmed by the report); its control sits after the amount. */
  onRemove?: () => void;
}) {
  // The budget period ("2026-11", a sprint) is the amount's tooltip, not a second figure in the cell.
  const periodKey = budgetPeriodLabel(row).key;
  const periodTitle = periodKey ? `in force for ${periodKey}` : undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const returnFocusOnClose = useRef(false);

  // The button that opens the editor ("$60.00", or "Set budget" when
  // unallocated) is NOT the same DOM node when it comes back: this cell
  // swaps between an <Input> and a <Button> by conditional return, so
  // closing the editor unmounts the Input and MOUNTS A NEW Button element —
  // a ref captured off the original click/keyboard-activation event now
  // points at a detached node, and `.focus()` on it is a silent no-op
  // (this was the previous approach; it left `document.activeElement` on
  // `<body>` once the Input itself unmounted). A stable `data-*` attribute
  // survives the remount, so focus is restored by querying for it after the
  // close has committed, not by holding onto a node reference across it.
  const triggerSelector = `[data-allocation-trigger="${row.orgProjectId}"]`;

  useEffect(() => {
    if (editing) {
      // Manual focus instead of `autoFocus`, with `preventScroll` — the
      // table sits in an `overflow-x-auto` Card, and autofocusing inside it
      // was scrolling the table's own header out of the viewport.
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    } else if (returnFocusOnClose.current) {
      returnFocusOnClose.current = false;
      document.querySelector<HTMLButtonElement>(triggerSelector)?.focus({ preventScroll: true });
    }
  }, [editing, triggerSelector]);

  function beginEdit() {
    setDraft(row.allocatedUsd != null ? String(row.allocatedUsd) : '');
    setEditing(true);
  }

  function cancelEdit() {
    returnFocusOnClose.current = true;
    setEditing(false);
  }

  async function save() {
    const value = Number(draft);
    if (!Number.isFinite(value) || value < 0) { cancelEdit(); return; }
    setBusy(true);
    const ok = await putAllocation(row.orgProjectId, value);
    setBusy(false);
    returnFocusOnClose.current = true;
    setEditing(false);
    if (ok) onSaved();
  }

  if (editing) {
    return (
      <Input
        ref={inputRef}
        type="number"
        min={0}
        step={1}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
        }}
        onBlur={() => { if (!busy) void save(); }}
        aria-label={`Monthly budget for ${row.orgProjectName ?? row.orgProjectId}`}
        className="ml-auto w-24"
      />
    );
  }

  // Unallocated reads in the amount's own place and size — a link-sized "Set budget", or a dash
  // titled "unallocated" — so the row keeps the table's grid; the name's "blind spot" chip says
  // why it matters (walk, 9 November: a secondary button and a warning word broke the row).
  if (row.allocatedUsd == null) {
    return canManage ? (
      <Button
        variant="link"
        onClick={beginEdit}
        title="Unallocated: set this initiative's monthly budget"
        data-allocation-trigger={row.orgProjectId}
      >
        Set budget
      </Button>
    ) : <T tone="tertiary" title="Unallocated">—</T>;
  }

  if (!canManage) return <T tabular title={periodTitle}>{usd(row.allocatedUsd)}</T>;
  // The remove control rides the amount it removes rather than a separate Actions column, so the
  // ledger fits beside two rails (walk, 9 November).
  return (
    <Inline align="center" justify="end" gap="xs" wrap={false}>
    <Button
      variant="link"
      onClick={beginEdit}
      title={`Click to edit the monthly allocation${periodTitle ? ` · ${periodTitle}` : ''}`}
      aria-label={`Edit monthly budget for ${row.orgProjectName ?? row.orgProjectId}: ${usd(row.allocatedUsd)}`}
      data-allocation-trigger={row.orgProjectId}
    >
      <T tabular>{usd(row.allocatedUsd)}</T>
    </Button>
    {onRemove && (
      <IconButton
        variant="ghost"
        size="sm"
        icon={<TrashIcon size={14} />}
        onClick={onRemove}
        title="Remove this allocation"
        aria-label={`Remove allocation for ${row.orgProjectName ?? row.orgProjectId}`}
      />
    )}
    </Inline>
  );
}

// ─── First-budget form (empty state) ─────────────────────────────────────────

function FirstBudgetForm({ initiatives, onSaved }: { initiatives: InitiativeOption[] | null; onSaved: () => void }) {
  const [projectId, setProjectId] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const value = Number(amount);
  const valid = projectId !== '' && Number.isFinite(value) && value >= 0 && amount.trim() !== '';

  async function save() {
    if (!valid) return;
    setBusy(true);
    const ok = await putAllocation(projectId, value);
    setBusy(false);
    if (ok) onSaved();
  }

  return (
    <Card padding="md" className="mt-4 max-w-xl mx-auto">
      <T as="p" size="sm" weight="semibold" className="mb-2">Set the first budget</T>
      <Inline align="center" gap="sm" wrap>
        <Select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Initiative"
          placeholder="Pick an initiative…"
          options={(initiatives ?? []).map((p) => ({ value: p.id, label: p.name }))}
          className="flex-1 min-w-40"
        />
        <Input
          type="number"
          min={0}
          step={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="USD / month"
          aria-label="Monthly allocation in USD"
          className="w-32"
        />
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={!valid || busy}>
          {busy ? 'saving…' : 'Allocate'}
        </Button>
      </Inline>
    </Card>
  );
}

// ─── Report ────────────────────────────────────────────────────────────────

export interface InitiativesReportProps {
  /** Budgets rows joined to the spend report's initiative groups (held, projected, unknown). */
  budgets: InitiativeLedgerRow[];
  /** Where an initiative's own report opens (the list rail's selection). */
  reportHref: (orgProjectId: string) => string;
  /** The spend report's lock when the reader is below the budgets tier. */
  lock?: BudgetAccessLock | undefined;
  error: string | null;
  hasData: boolean;
  canManage: boolean;
  refresh: () => void;
  /**
   * BudgetsPage's own `/api/graph/projects?limit=100` read, passed down so
   * the empty-state "set the first budget" form doesn't open a second poll
   * of the same route the page already has (it only rendered on a rare,
   * click-triggered path, but it was still the same request twice).
   */
  initiatives: InitiativeOption[] | null;
  /** The page's controlled search; narrows the table, never the empty state. */
  query?: string;
  /** The configured thresholds (GET /api/budgets `thresholds`). */
  thresholds?: readonly number[];
  /** "Near or at cap" keeps only rows at or past the near line. */
  thresholdFilter?: ThresholdFilter;
  /** The row a bell item opened (`?row=`), highlighted. */
  selectedKey?: string | null;
}

export function InitiativesReport({
  budgets, reportHref, lock, error, hasData, canManage, refresh, initiatives, query = '',
  thresholds, thresholdFilter = 'all', selectedKey = null,
}: InitiativesReportProps) {
  const [confirmDelete, setConfirmDelete] = useState<BudgetRow | null>(null);
  const [showFirstBudget, setShowFirstBudget] = useState(false);
  // A removed allocation takes its trash button (the dialog's focus target) with it. Once the refreshed
  // row is back, focus moves to the control that replaced it — the row's "Set budget" in the Allocated
  // column — and the sideways-scrolled table returns to its start, so the row is readable from its name.
  const focusAfterRemove = useRef<string | null>(null);
  useEffect(() => {
    const id = focusAfterRemove.current;
    if (!id) return;
    const trigger = document.querySelector<HTMLButtonElement>(`[data-allocation-trigger="${CSS.escape(id)}"]`);
    if (!trigger) return;
    focusAfterRemove.current = null;
    for (let el = trigger.parentElement; el; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth && /(auto|scroll)/.test(getComputedStyle(el).overflowX)) { el.scrollLeft = 0; break; }
    }
    trigger.focus({ preventScroll: true });
  }, [budgets]);

  async function deleteAllocation(row: BudgetRow) {
    const res = await writeJson(`/api/budgets/${encodeURIComponent(row.orgProjectId)}`, 'DELETE');
    if (!res.ok) {
      toastError(null, 'Failed to remove allocation', res.error ?? undefined);
    } else {
      toastSuccess(null, 'Allocation removed', row.orgProjectName ?? row.orgProjectId);
      focusAfterRemove.current = row.orgProjectId;
    }
    setConfirmDelete(null);
    refresh();
  }

  if (error) {
    return (
      <UnavailableNotice
        error={error}
        what="budgets"
        source="Budgets are read from Aurora"
        onRetry={refresh}
      />
    );
  }

  if (hasData && budgets.length === 0) {
    return (
      <>
        <EmptyState
          title="No budgets yet"
          description="Allocate a monthly agent budget to each initiative; spend accrues automatically from bot and marketplace runs attributed to it. Initiatives that spend with no allocation surface here as blind spots."
          {...(canManage && !showFirstBudget
            ? { actionLabel: 'Set the first budget', onAction: () => setShowFirstBudget(true) }
            : {})}
        />
        {canManage && showFirstBudget && (
          <FirstBudgetForm
            initiatives={initiatives}
            onSaved={() => { setShowFirstBudget(false); refresh(); }}
          />
        )}
      </>
    );
  }

  // One line per row at the library's 44px list step: numbers right-aligned
  // in tabular figures, the burn meter INLINE beside the remaining figure,
  // and the maintenance share of spend a pill with its explanation in the
  // tooltip rather than a second line under the value.
  //
  // It fits the content column beside two rails at 1440 (walk, 9 November:
  // nine columns clipped "Last activity" and the row actions off the right
  // edge): short headers with the full name as the narrow card's label, Held
  // only when some row holds money or the figures are locked, and the last
  // agent activity in the initiative's tooltip. Under 40rem of its width the
  // table is the library's card form (`narrow`). Between the two, the
  // secondary figures give way as the table's own width narrows (DataTable
  // `responsiveColumns`, ui-components 2.516.0): Floor first, then Held, then
  // Projected; the initiative, Budget, Spent and Left never hide.
  const showHeld = !!lock || budgets.some((row) => (row.heldUsd ?? 0) > 0);
  const columns: DataTableColumn<InitiativeLedgerRow>[] = [
    {
      key: 'initiative',
      header: 'Initiative',
      render: (row) => (
        <Inline align="center" gap="sm" wrap={false} className="min-w-0">
          <Link
            to={reportHref(row.orgProjectId)}
            className="max-w-[10rem] truncate text-text-primary no-underline hover:text-primary hover:underline"
            title={`Open this initiative’s spend report · last agent activity ${ago(row.lastAgentActivityAt)}`}
          >
            {row.orgProjectName ?? row.orgProjectId}
          </Link>
          {rowBudgetStats(row).blindSpot && (
            <Chip tone="warning" size="xs" title="Spending with no allocation — set a budget so this spend has a ceiling">
              blind spot
            </Chip>
          )}
          {budgetPeriodLabel(row).betweenSprints && (
            <Chip tone="neutral" size="xs" title="No sprint is open, so this sprint allocation is not in force and the spend shown is the calendar month’s">
              between sprints
            </Chip>
          )}
        </Inline>
      ),
    },
    {
      key: 'allocated',
      header: 'Budget',
      label: 'Allocated',
      numeric: true,
      render: (row) => <AllocationCell row={row} canManage={canManage} onSaved={refresh} onRemove={() => setConfirmDelete(row)} />,
    },
    {
      key: 'floor',
      header: 'Floor',
      numeric: true,
      priority: 4,
      render: (row) => {
        const f = floorFigure(row);
        return <T tabular tone={f.text === '—' ? 'tertiary' : 'secondary'} title={f.title}>{f.text}</T>;
      },
    },
    {
      key: 'discretionarySpent',
      header: 'Spent',
      label: 'Discretionary spent',
      numeric: true,
      sortable: true,
      compare: (a, b) => (a.discretionarySpentUsd ?? a.spentThisPeriodUsd) - (b.discretionarySpentUsd ?? b.spentThisPeriodUsd),
      render: (row) => <SpendFigureCell knownUsd={row.discretionarySpentUsd ?? row.spentThisPeriodUsd} unknownCount={row.ledgerUnknownCount} lock={lock} />,
    },
    {
      key: 'discretionaryRemaining',
      header: 'Left',
      label: 'Discretionary left',
      numeric: true,
      sortable: true,
      compare: (a, b) => (a.discretionaryRemainingUsd ?? Infinity) - (b.discretionaryRemainingUsd ?? Infinity),
      render: (row) => {
        // An older BFF has no reserve figures: fall back to allocated − spent.
        const remaining = row.discretionaryRemainingUsd !== undefined ? row.discretionaryRemainingUsd : rowBudgetStats(row).remaining;
        const budget = row.discretionaryRemainingUsd !== undefined ? discretionaryBudget(row) : row.allocatedUsd;
        if (remaining == null || budget == null) return <T tone="tertiary">—</T>;
        const used = Math.max(0, budget - remaining);
        const tone = remainingTone(remaining, budget);
        // The burn is the figure's tone (warning, danger) and its title; the inline meter
        // cost the column the width the table needed beside two rails (walk, 9 November).
        return (
          <T tabular weight={tone === 'danger' ? 'semibold' : undefined} tone={tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : undefined}
            title={budget > 0 ? `Discretionary burn: ${Math.round((used / budget) * 100)}% of ${usd(budget)}` : 'No discretionary money after the floor'}>
            {usd(remaining)}
          </T>
        );
      },
    },
    {
      // The threshold mark (learning loop): spent + held against the allocation,
      // by the rule the bell announces 50 / 80 / 100 % with.
      key: 'threshold',
      header: 'Threshold',
      sortable: true,
      compare: (a, b) => (a.threshold?.percent ?? -1) - (b.threshold?.percent ?? -1),
      render: (row) => <ThresholdCell mark={row.threshold} thresholds={thresholds} what="allocation" />,
    },
    ...(showHeld ? [{
      key: 'held',
      header: 'Held',
      numeric: true,
      priority: 3,
      render: (row: InitiativeLedgerRow) => row.heldUsd === undefined && lock
        ? <LockedFigure lock={lock} />
        : <T tabular tone={row.heldUsd ? undefined : 'tertiary'} title="Forecast p75 reserved by dispatches still in flight">{row.heldUsd ? usd(row.heldUsd) : '—'}</T>,
    }] : []),
    {
      key: 'projected',
      header: 'Projected',
      numeric: true,
      priority: 2,
      sortable: true,
      compare: (a, b) => (a.projectedPeriodEndUsd ?? 0) - (b.projectedPeriodEndUsd ?? 0),
      render: (row) => {
        if (row.projectedPeriodEndUsd === undefined) return lock ? <LockedFigure lock={lock} /> : <T tone="tertiary">—</T>;
        const over = row.allocatedUsd != null && row.projectedPeriodEndUsd > row.allocatedUsd;
        return (
          <T tabular className={over ? 'text-danger' : undefined} title="Month-to-date spend plus the 7-day burn over the days left in the month">
            {moneyOrDash(row.projectedPeriodEndUsd)}
          </T>
        );
      },
    },
  ];

  return (
    <>
      {/* ── Allocation table ──
          This IS the report — it goes first, above the fold. The by-model and
          by-trigger cuts that used to sit under it as two breakdown cards are
          the page's group selector now (person, model, source, trigger), each
          one table over the spend ledger (DEFECTS.md #2). */}
      <DataTable
        data-testid="budgets-initiatives-table"
        narrow
        responsiveColumns
        // One "+N columns" control in the header, a chevron per row (ui-components 2.519.0).
        hiddenColumnsControl="header"
        data={budgets.filter((row) => matchesBudget(row, query) && passesThresholdFilter(row.threshold, thresholdFilter, thresholds))}
        emptyMessage={thresholdFilter === 'near' ? 'No initiative is near or at its cap.' : 'No initiative matches this search.'}
        columns={columns}
        keyField={(row) => row.orgProjectId}
        selectedKey={selectedKey}
      />

      <ConfirmDialog
        open={confirmDelete != null}
        title="Remove allocation?"
        body={`${confirmDelete?.orgProjectName ?? confirmDelete?.orgProjectId ?? ''} keeps accruing spend — it will show as an unallocated blind spot instead of being judged against a budget.`}
        confirmLabel="Remove"
        tone="destructive"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => { if (confirmDelete) void deleteAllocation(confirmDelete); }}
      />
    </>
  );
}
