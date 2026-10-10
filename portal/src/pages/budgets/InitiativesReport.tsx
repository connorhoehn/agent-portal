// Initiatives report — the per-initiative allocation ledger: what each
// initiative is allowed to spend this period, against what it actually spent.
// Every mutating affordance (set / edit / delete an allocation) is gated on
// the ManageBudgets capability, same engine as the API's own gate.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Button,
  Card,
  CardHeader,
  CatalogGrid,
  Chip,
  ConfirmDialog,
  DataTable,
  type DataTableColumn,
  EmptyState,
  IconButton,
  InlinePlaceholder,
  Inline,
  Input,
  ProgressBar,
  Select,
  Stack,
  T,
  TrashIcon,
} from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { usd, modelLabelFor, ago, rowBudgetStats } from './budgetsFormat';
import type { BudgetRow, BudgetSummary, InitiativeOption } from './types';
import { absoluteTime } from '../../lib/relativeTime';

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

// ─── Breakdown card (spend by model / by trigger) ────────────────────────────

function BreakdownCard({ title, rows, emptyLabel }: {
  title: string;
  rows: Array<{ label: string; spentUsd: number; runCount: number }>;
  /** What an empty card means. Both breakdowns now cut the same set of runs,
   *  so empty means "no spend this period" and nothing else — but a card that
   *  renders blank beside a populated one reads as broken, so it says so. */
  emptyLabel?: string;
}) {
  const max = Math.max(...rows.map((r) => r.spentUsd), 0.000001);
  return (
    <Card padding="none" className="overflow-hidden">
      <CardHeader inset title={title} />
      <Stack gap="sm" className="px-3.5 py-2.5">
        {rows.length === 0 ? (
          <InlinePlaceholder>{emptyLabel ?? 'no spend this period'}</InlinePlaceholder>
        ) : (
          rows.map((r) => (
            <Inline key={r.label} align="center" gap="sm" wrap={false} className="min-w-0">
              <T size="xs" tone="secondary" className="w-24 shrink-0 truncate" title={r.label}>{r.label}</T>
              <ProgressBar
                value={Math.max((r.spentUsd / max) * 100, 2)}
                size="sm"
                showRatio={false}
                className="flex-1 min-w-0"
                aria-label={`${r.label} share of period spend`}
              />
              <T size="xs" weight="medium" tabular>{usd(r.spentUsd)}</T>
              <T size="xs" tone="tertiary" className="w-14 justify-end">
                {r.runCount} {r.runCount === 1 ? 'run' : 'runs'}
              </T>
            </Inline>
          ))
        )}
      </Stack>
    </Card>
  );
}

// ─── Inline allocation editor ────────────────────────────────────────────────

function AllocationCell({ row, canManage, onSaved }: {
  row: BudgetRow;
  canManage: boolean;
  onSaved: () => void;
}) {
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

  if (row.allocatedUsd == null) {
    return (
      <Inline align="center" justify="end" gap="sm" wrap={false}>
        <T size="xs" className="text-warning">unallocated</T>
        {canManage && (
          <Button
            variant="secondary"
            size="sm"
            onClick={beginEdit}
            data-allocation-trigger={row.orgProjectId}
          >
            Set budget
          </Button>
        )}
      </Inline>
    );
  }

  if (!canManage) return <T tabular>{usd(row.allocatedUsd)}</T>;
  return (
    <Button
      variant="link"
      onClick={beginEdit}
      title="Click to edit the monthly allocation"
      aria-label={`Edit monthly budget for ${row.orgProjectName ?? row.orgProjectId}: ${usd(row.allocatedUsd)}`}
      data-allocation-trigger={row.orgProjectId}
    >
      <T tabular>{usd(row.allocatedUsd)}</T>
    </Button>
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
  budgets: BudgetRow[];
  summary: BudgetSummary | undefined;
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
}

export function InitiativesReport({
  budgets, summary, error, hasData, canManage, refresh, initiatives,
}: InitiativesReportProps) {
  const [confirmDelete, setConfirmDelete] = useState<BudgetRow | null>(null);
  const [showFirstBudget, setShowFirstBudget] = useState(false);

  async function deleteAllocation(row: BudgetRow) {
    const res = await writeJson(`/api/budgets/${encodeURIComponent(row.orgProjectId)}`, 'DELETE');
    if (!res.ok) {
      toastError(null, 'Failed to remove allocation', res.error ?? undefined);
    } else {
      toastSuccess(null, 'Allocation removed', row.orgProjectName ?? row.orgProjectId);
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
  const columns: DataTableColumn<BudgetRow>[] = [
    {
      key: 'initiative',
      header: 'Initiative',
      render: (row) => (
        <Inline align="center" gap="sm" wrap={false} className="min-w-0">
          <Link
            to={`/iq/projects/${row.orgProjectId}`}
            className="truncate text-text-primary no-underline hover:text-primary hover:underline"
          >
            {row.orgProjectName ?? row.orgProjectId}
          </Link>
          {rowBudgetStats(row).blindSpot && (
            <Chip tone="warning" size="xs" title="Spending with no allocation — set a budget so this spend has a ceiling">
              blind spot
            </Chip>
          )}
        </Inline>
      ),
    },
    {
      key: 'allocated',
      header: 'Allocated',
      numeric: true,
      render: (row) => <AllocationCell row={row} canManage={canManage} onSaved={refresh} />,
    },
    {
      key: 'spent',
      header: 'Spent',
      numeric: true,
      render: (row) => (
        <Inline align="center" justify="end" gap="sm" wrap={false}>
          {/* The floor is a subset of the figure beside it, never extra spend:
              a full floor says so in words instead of restating the number. */}
          {row.maintenanceUsd > 0 && (
            <Chip
              tone="neutral"
              size="xs"
              title="Cron-triggered bot runs — the recurring floor of keeping this initiative's repos alive. Part of the spend figure, not additional to it."
            >
              {row.maintenanceUsd >= row.spentThisPeriodUsd ? 'all maintenance' : `${usd(row.maintenanceUsd)} maintenance`}
            </Chip>
          )}
          <T tabular>{usd(row.spentThisPeriodUsd)}</T>
        </Inline>
      ),
    },
    {
      key: 'remaining',
      header: 'Remaining',
      numeric: true,
      render: (row) => {
        const { remaining, burn } = rowBudgetStats(row);
        if (remaining == null || burn == null) return <T tone="tertiary">—</T>;
        return (
          <Inline align="center" justify="end" gap="sm" wrap={false}>
            <T tabular weight={remaining < 0 ? 'semibold' : undefined} className={remaining < 0 ? 'text-danger' : undefined}>
              {usd(remaining)}
            </T>
            <ProgressBar
              value={Math.min(row.spentThisPeriodUsd, row.allocatedUsd!)}
              max={row.allocatedUsd!}
              size="sm"
              showRatio={false}
              className="w-16 shrink-0"
              color={burn > 1 ? 'var(--color-danger)' : burn > 0.8 ? 'var(--color-warning)' : undefined}
              aria-label={`Burn: ${Math.round(burn * 100)}% of allocation`}
            />
          </Inline>
        );
      },
    },
    {
      key: 'runs',
      header: 'Runs',
      numeric: true,
      render: (row) => <T tabular>{row.runCountThisPeriod}</T>,
    },
    {
      key: 'lastActivity',
      header: 'Last activity',
      // A readable local time, not the raw wire string; the tooltip carries
      // the precise moment.
      render: (row) => (
        <T tone="tertiary" title={absoluteTime(row.lastAgentActivityAt)}>{ago(row.lastAgentActivityAt)}</T>
      ),
    },
    {
      key: 'updatedBy',
      header: 'Updated by',
      render: (row) => (
        <T tone="tertiary" title={row.updatedByName ? row.updatedBy ?? undefined : undefined}>
          {row.updatedByName ?? row.updatedBy ?? '—'}
        </T>
      ),
    },
  ];

  return (
    <>
      {/* ── Allocation table ──
          This IS the report — it goes first, above the fold. The breakdown
          cards below are a second cut of the same numbers for whoever wants
          them, not a prerequisite to reading the ledger (DEFECTS.md #2: this
          page used to stack a description, a stat strip AND two breakdown
          cards above the table — three summary blocks before any row). */}
      <DataTable
        data-testid="budgets-initiatives-table"
        size="sm"
        data={budgets}
        columns={columns}
        keyField={(row) => row.orgProjectId}
        {...(canManage ? { rowActions: (row: BudgetRow) => row.allocatedUsd != null ? (
          <IconButton
            variant="ghost"
            size="sm"
            icon={<TrashIcon size={14} />}
            onClick={() => setConfirmDelete(row)}
            title="Remove this allocation"
            aria-label={`Remove allocation for ${row.orgProjectName ?? row.orgProjectId}`}
          />
        ) : null } : {})}
      />

      {/* ── Breakdown ──
          Two cuts of one set of runs, so they sum to the same total. By-model
          used to join only run-backed rows and rendered permanently empty
          beside a populated by-trigger card; it now resolves the model from
          the run, the job payload or the bot, and buckets the unresolvable
          as 'unknown' rather than dropping the spend. */}
      <CatalogGrid columns={2} dense className="mt-4">
        <BreakdownCard
          title="Spend by model"
          emptyLabel={(summary?.totalSpentThisPeriodUsd ?? 0) > 0
            ? 'no model recorded for this period’s runs'
            : 'no spend this period'}
          rows={(summary?.byModel ?? []).map((m) => ({
            label: m.model === 'unknown' ? 'unattributed' : modelLabelFor(m.model),
            spentUsd: m.spentUsd,
            runCount: m.runCount,
          }))}
        />
        <BreakdownCard
          title="Spend by trigger"
          rows={(summary?.byTrigger ?? []).map((t) => ({
            label: t.trigger, spentUsd: t.spentUsd, runCount: t.runCount,
          }))}
        />
      </CatalogGrid>

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
