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
  EmptyState,
  IconButton,
  InlinePlaceholder,
  Inline,
  Input,
  ProgressBar,
  Select,
  Stack,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
} from '@connorhoehnslalom/ui-components/shared';
import { toastError } from '../../lib/toastStore';
import { usd, modelLabelFor, ago, rowBudgetStats } from './budgetsFormat';
import { T } from './Text';
import type { BudgetRow, BudgetSummary, InitiativeOption } from './types';

async function putAllocation(orgProjectId: string, allocatedUsd: number): Promise<boolean> {
  try {
    const res = await fetch(`/api/budgets/${encodeURIComponent(orgProjectId)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allocatedUsd }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      toastError(null, 'Failed to set budget', body?.error ?? `${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    toastError(null, 'Failed to set budget', err instanceof Error ? err.message : undefined);
    return false;
  }
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
              <T className="text-[11px] text-text-secondary w-24 shrink-0 truncate" title={r.label}>{r.label}</T>
              <ProgressBar
                value={Math.max((r.spentUsd / max) * 100, 2)}
                size="sm"
                showRatio={false}
                className="flex-1 min-w-0"
                aria-label={`${r.label} share of period spend`}
              />
              <T className="text-[11px] text-text-primary font-medium whitespace-nowrap tabular-nums">{usd(r.spentUsd)}</T>
              <T className="text-[10px] text-text-tertiary whitespace-nowrap w-14 text-right">
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
        className="w-24"
      />
    );
  }

  if (row.allocatedUsd == null) {
    return (
      <Inline align="center" gap="sm" wrap={false}>
        <T className="text-[11px] text-warning">— unallocated</T>
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

  if (!canManage) return <T className="tabular-nums">{usd(row.allocatedUsd)}</T>;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={beginEdit}
      title="Click to edit the monthly allocation"
      data-allocation-trigger={row.orgProjectId}
      className="px-1.5 py-0.5 -mx-1.5 h-fit w-fit border-0 text-[12px] text-text-primary tabular-nums hover:bg-surface-hover"
    >
      {usd(row.allocatedUsd)}
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
      <T className="text-[12px] font-semibold text-text-primary mb-2">Set the first budget</T>
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
    try {
      const res = await fetch(`/api/budgets/${encodeURIComponent(row.orgProjectId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        toastError(null, 'Failed to remove allocation', body?.error ?? `${res.status}`);
      }
    } catch (err) {
      toastError(null, 'Failed to remove allocation', err instanceof Error ? err.message : undefined);
    }
    setConfirmDelete(null);
    refresh();
  }

  if (error) {
    return (
      <Card padding="md">
        <T className="text-[12px] text-danger">Failed to load budgets: {error}</T>
      </Card>
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

  return (
    <>
      {/* ── Allocation table ──
          This IS the report — it goes first, above the fold. The breakdown
          cards below are a second cut of the same numbers for whoever wants
          them, not a prerequisite to reading the ledger (DEFECTS.md #2: this
          page used to stack a description, a stat strip AND two breakdown
          cards above the table — three summary blocks before any row). */}
      <Card padding="none" className="overflow-x-auto">
        <Table>
          <TableHead>
            <TableRow>
              <TableTh>Initiative</TableTh>
              <TableTh>Allocated</TableTh>
              <TableTh>Spent</TableTh>
              <TableTh>Remaining</TableTh>
              <TableTh>Runs</TableTh>
              <TableTh>Last activity</TableTh>
              <TableTh>Updated by</TableTh>
              {canManage && <TableTh aria-label="Actions" />}
            </TableRow>
          </TableHead>
          <TableBody>
            {budgets.map((row) => {
              const { blindSpot, remaining, burn } = rowBudgetStats(row);
              return (
                <TableRow key={row.orgProjectId}>
                  <TableTd>
                    <Inline align="center" gap="sm" wrap={false} className="min-w-0">
                      <Link
                        to={`/iq/projects/${row.orgProjectId}`}
                        className="text-[12px] font-medium text-text-primary no-underline truncate hover:text-primary hover:underline"
                      >
                        {row.orgProjectName ?? row.orgProjectId}
                      </Link>
                      {blindSpot && (
                        <Chip tone="warning" size="xs" title="Spending with no allocation — set a budget so this spend has a ceiling">
                          blind spot
                        </Chip>
                      )}
                    </Inline>
                  </TableTd>
                  <TableTd>
                    <AllocationCell row={row} canManage={canManage} onSaved={refresh} />
                  </TableTd>
                  <TableTd>
                    <T className="tabular-nums">{usd(row.spentThisPeriodUsd)}</T>
                    {/* The floor is a subset. Repeating an identical figure
                        under the total ("$3.75" / "$3.75 maintenance")
                        reads as a second charge, so a full floor says so in
                        words instead of restating the number. */}
                    {row.maintenanceUsd > 0 && (
                      <T
                        className="text-[11px] text-text-tertiary tabular-nums mt-0.5"
                        title="Cron-triggered bot runs — the recurring floor of keeping this initiative's repos alive. Part of the figure above, not additional to it."
                      >
                        {row.maintenanceUsd >= row.spentThisPeriodUsd
                          ? 'all maintenance'
                          : `${usd(row.maintenanceUsd)} maintenance`}
                      </T>
                    )}
                  </TableTd>
                  <TableTd>
                    {remaining == null || burn == null ? (
                      <T className="text-text-tertiary">—</T>
                    ) : (
                      <Stack gap="xs" className="min-w-28">
                        <T className={`tabular-nums text-[12px] ${remaining < 0 ? 'text-danger font-semibold' : ''}`}>
                          {usd(remaining)}
                        </T>
                        <ProgressBar
                          value={Math.min(row.spentThisPeriodUsd, row.allocatedUsd!)}
                          max={row.allocatedUsd!}
                          size="sm"
                          showRatio={false}
                          color={burn > 1 ? 'var(--color-danger)' : burn > 0.8 ? 'var(--color-warning)' : undefined}
                          aria-label={`Burn: ${Math.round(burn * 100)}% of allocation`}
                        />
                      </Stack>
                    )}
                  </TableTd>
                  <TableTd>
                    <T className="tabular-nums">{row.runCountThisPeriod}</T>
                  </TableTd>
                  <TableTd>
                    <T className="text-text-tertiary whitespace-nowrap" title={row.lastAgentActivityAt ?? undefined}>
                      {ago(row.lastAgentActivityAt)}
                    </T>
                  </TableTd>
                  <TableTd>
                    <T className="text-text-tertiary" title={row.updatedByName ? row.updatedBy ?? undefined : undefined}>
                      {row.updatedByName ?? row.updatedBy ?? '—'}
                    </T>
                  </TableTd>
                  {canManage && (
                    <TableTd>
                      {row.allocatedUsd != null && (
                        <IconButton
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmDelete(row)}
                          title="Remove this allocation"
                          aria-label={`Remove allocation for ${row.orgProjectName ?? row.orgProjectId}`}
                          className="text-text-tertiary hover:text-danger"
                        >
                          ✕
                        </IconButton>
                      )}
                    </TableTd>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {/* ── Breakdown ──
          Two cuts of one set of runs, so they sum to the same total. By-model
          used to join only run-backed rows and rendered permanently empty
          beside a populated by-trigger card; it now resolves the model from
          the run, the job payload or the bot, and buckets the unresolvable
          as 'unknown' rather than dropping the spend. */}
      <CatalogGrid columns={2} dense className="mt-4">
        <BreakdownCard
          title="SPEND BY MODEL"
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
          title="SPEND BY TRIGGER"
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
