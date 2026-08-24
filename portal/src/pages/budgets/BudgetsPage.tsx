// Budgets — the program-manager's ledger: monthly agent-spend allocations per
// initiative, judged against actuals derived from bot + marketplace runs.
//
// Reads are org-leader/hr-admin (route-gated to match the API); every mutating
// affordance (set / edit / delete an allocation) is gated on the
// ManageBudgets capability, same engine as the API's own gate. The one row
// this page exists to make loud: an initiative spending with NO allocation —
// the blind spot chip.

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  PageSection,
  Card,
  Chip,
  ProgressBar,
  EmptyState,
  StatCard,
  KPIGrid,
  ConfirmDialog,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities, type Action } from '../../lib/capabilities';
import { toastError } from '../../lib/toastStore';
import { DEVBOX_MODELS } from '../../lib/devboxModels';

// The Cedar action exists server-side (middleware/src/lib/authz.ts) and is
// evaluated by the capability probe; the portal Action union predates it.
const MANAGE_BUDGETS: Action = 'ManageBudgets';

// ─── Types (the /api/budgets contract) ───────────────────────────────────────

interface BudgetRow {
  orgProjectId: string;
  orgProjectName: string | null;
  /** Null = spending with no allocation — the blind spot this page surfaces. */
  allocatedUsd: number | null;
  period: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  spentThisPeriodUsd: number;
  runCountThisPeriod: number;
  lastAgentActivityAt: string | null;
  /** Cron-triggered subset of spend — the maintenance floor, not extra spend. */
  maintenanceUsd: number;
}

interface BudgetSummary {
  totalAllocatedUsd: number;
  totalSpentThisPeriodUsd: number;
  totalMaintenanceUsd: number;
  byModel: Array<{ model: string; spentUsd: number; runCount: number }>;
  byTrigger: Array<{ trigger: string; spentUsd: number; runCount: number }>;
}

interface InitiativeOption {
  id: string;
  name: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Bedrock inference-profile id → the short label the rest of the app uses. */
function modelLabel(id: string): string {
  return DEVBOX_MODELS.find((m) => m.id === id)?.label ?? id;
}

/** Aurora timestamps arrive without T/Z — same normalization as Bots. */
function ago(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (Number.isNaN(mins)) return '—';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

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

function BreakdownCard({ title, rows }: {
  title: string;
  rows: Array<{ label: string; spentUsd: number; runCount: number }>;
}) {
  const max = Math.max(...rows.map((r) => r.spentUsd), 0.000001);
  return (
    <Card padding="none" className="overflow-hidden">
      <div className="px-3.5 py-2.5 border-b border-border">
        <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">{title}</span>
      </div>
      <div className="px-3.5 py-2.5 flex flex-col gap-2">
        {rows.length === 0 ? (
          <span className="text-[11px] text-text-tertiary">no spend this period</span>
        ) : (
          rows.map((r) => (
            <div key={r.label} className="flex items-center gap-2 min-w-0">
              <span className="text-[11px] text-text-secondary w-24 shrink-0 truncate" title={r.label}>{r.label}</span>
              <div className="flex-1 h-2 rounded bg-surface-hover overflow-hidden min-w-0">
                <div
                  className="h-full rounded bg-primary"
                  style={{ width: `${Math.max((r.spentUsd / max) * 100, 2)}%` }}
                />
              </div>
              <span className="text-[11px] text-text-primary font-medium whitespace-nowrap tabular-nums">{usd(r.spentUsd)}</span>
              <span className="text-[10px] text-text-tertiary whitespace-nowrap w-14 text-right">
                {r.runCount} {r.runCount === 1 ? 'run' : 'runs'}
              </span>
            </div>
          ))
        )}
      </div>
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

  async function save() {
    const value = Number(draft);
    if (!Number.isFinite(value) || value < 0) { setEditing(false); return; }
    setBusy(true);
    const ok = await putAllocation(row.orgProjectId, value);
    setBusy(false);
    setEditing(false);
    if (ok) onSaved();
  }

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        min={0}
        step={1}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={() => { if (!busy) void save(); }}
        aria-label={`Monthly budget for ${row.orgProjectName ?? row.orgProjectId}`}
        className="w-24 px-2 py-1 rounded-md border border-border bg-surface text-[12px] text-text-primary box-border"
      />
    );
  }

  function beginEdit() {
    setDraft(row.allocatedUsd != null ? String(row.allocatedUsd) : '');
    setEditing(true);
  }

  if (row.allocatedUsd == null) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="text-[11px] text-warning">— unallocated</span>
        {canManage && (
          <button
            onClick={beginEdit}
            className="px-2 py-0.5 rounded border border-border bg-surface text-[10.5px] text-text-secondary cursor-pointer hover:border-primary hover:text-primary transition-colors"
          >
            Set budget
          </button>
        )}
      </span>
    );
  }

  if (!canManage) return <span className="tabular-nums">{usd(row.allocatedUsd)}</span>;
  return (
    <button
      onClick={beginEdit}
      title="Click to edit the monthly allocation"
      className="px-1.5 py-0.5 -mx-1.5 rounded border-none bg-transparent text-[12px] text-text-primary tabular-nums cursor-pointer hover:bg-surface-hover font-[inherit]"
    >
      {usd(row.allocatedUsd)}
    </button>
  );
}

// ─── First-budget form (empty state) ─────────────────────────────────────────

function FirstBudgetForm({ onSaved }: { onSaved: () => void }) {
  const { data: initiatives } = useFetch<InitiativeOption[]>('/api/graph/projects?limit=100');
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
      <div className="text-[12px] font-semibold text-text-primary mb-2">Set the first budget</div>
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Initiative"
          className="flex-1 min-w-40 px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
        >
          <option value="">Pick an initiative…</option>
          {(initiatives ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <input
          type="number"
          min={0}
          step={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="USD / month"
          aria-label="Monthly allocation in USD"
          className="w-32 px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary box-border"
        />
        <button
          onClick={() => void save()}
          disabled={!valid || busy}
          className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-40"
        >
          {busy ? 'saving…' : 'Allocate'}
        </button>
      </div>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

interface GrantRow {
  id: string;
  orgProjectId: string;
  orgProjectName: string | null;
  granteePersonId: string;
  granteeName: string | null;
  sprintName: string | null;
  startsOn: string | null;
  endsOn: string | null;
  sprintStatus: string | null;
  allocatedUsd: number;
  initiativeSpendInWindowUsd: number;
}

/**
 * Sprint envelopes — a release manager handing an SME money for one sprint.
 *
 * The window figure is the INITIATIVE's spend inside the sprint dates, and is
 * labelled as such: bot_runs record which initiative and which bot paid, never
 * which person's envelope, so presenting it as the SME's personal burn would
 * be a number the data cannot support.
 */
function SprintEnvelopes() {
  const { data, error } = useFetch<{ grants: GrantRow[] }>('/api/budgets/grants', 60_000);
  const grants = data?.grants ?? [];
  if (error || grants.length === 0) return null;

  const active = grants.filter((g) => g.sprintStatus === 'active');
  const rest = grants.filter((g) => g.sprintStatus !== 'active');
  const ordered = [...active, ...rest].slice(0, 12);

  return (
    <Card padding="none" className="overflow-x-auto mt-4">
      <div className="px-3.5 py-3 border-b border-border">
        <div className="text-[13px] font-semibold text-text-primary">Sprint envelopes</div>
        <div className="text-[11.5px] text-text-secondary mt-0.5">
          What each SME was given to see a sprint through. Spend shown is the initiative's
          within the sprint window, not the individual's.
        </div>
      </div>
      <Table>
        <TableHead>
          <TableRow>
            <TableTh>SME</TableTh>
            <TableTh>Initiative</TableTh>
            <TableTh>Sprint</TableTh>
            <TableTh>Envelope</TableTh>
            <TableTh>Initiative spend in window</TableTh>
          </TableRow>
        </TableHead>
        <TableBody>
          {ordered.map((g) => (
            <TableRow key={g.id}>
              <TableTd>
                <span className="text-[12.5px] text-text-primary">{g.granteeName ?? g.granteePersonId}</span>
              </TableTd>
              <TableTd>
                <Link
                  to={`/iq/projects/${encodeURIComponent(g.orgProjectId)}`}
                  className="text-[12.5px] text-primary no-underline hover:underline"
                >
                  {g.orgProjectName ?? g.orgProjectId}
                </Link>
              </TableTd>
              <TableTd>
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] text-text-primary">{g.sprintName ?? '—'}</span>
                  {g.sprintStatus === 'active' && <Chip tone="success">active</Chip>}
                </div>
                {g.startsOn && g.endsOn && (
                  <div className="text-[11px] text-text-tertiary mt-0.5 tabular-nums">
                    {g.startsOn} → {g.endsOn}
                  </div>
                )}
              </TableTd>
              <TableTd><span className="tabular-nums">{usd(g.allocatedUsd)}</span></TableTd>
              <TableTd>
                <span className="tabular-nums text-text-secondary">{usd(g.initiativeSpendInWindowUsd)}</span>
              </TableTd>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

export default function BudgetsPage() {
  const { data, error, refresh } = useFetch<{ budgets: BudgetRow[]; summary: BudgetSummary }>('/api/budgets', 30_000);
  const { can, ready } = useCapabilities();
  const canManage = ready && can(MANAGE_BUDGETS);
  const [confirmDelete, setConfirmDelete] = useState<BudgetRow | null>(null);
  const [showFirstBudget, setShowFirstBudget] = useState(false);

  const monthLabel = useMemo(
    () => new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    [],
  );

  const budgets = data?.budgets ?? [];
  const summary = data?.summary;

  const totalAllocated = summary?.totalAllocatedUsd ?? 0;
  const totalSpent = summary?.totalSpentThisPeriodUsd ?? 0;
  const remaining = totalAllocated - totalSpent;
  const totalMaintenance = summary?.totalMaintenanceUsd ?? 0;
  const totalRuns = budgets.reduce((n, b) => n + b.runCountThisPeriod, 0);

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

  return (
    <PageSection
      title="Budgets"
      description={`Monthly agent-spend allocations per initiative, against actuals from bot and marketplace runs · ${monthLabel}`}
    >
      {error && (
        <Card padding="md" className="mb-4">
          <div className="text-[12px] text-danger">Failed to load budgets: {error}</div>
        </Card>
      )}

      {!error && data && budgets.length === 0 ? (
        <>
          <EmptyState
            title="No budgets yet"
            description="Allocate a monthly agent budget to each initiative; spend accrues automatically from bot and marketplace runs attributed to it. Initiatives that spend with no allocation surface here as blind spots."
            {...(canManage && !showFirstBudget
              ? { actionLabel: 'Set the first budget', onAction: () => setShowFirstBudget(true) }
              : {})}
          />
          {canManage && showFirstBudget && (
            <FirstBudgetForm onSaved={() => { setShowFirstBudget(false); refresh(); }} />
          )}
        </>
      ) : (
        <>
          {/* ── Header stat tiles ── */}
          <div className="mb-4">
            <KPIGrid columns={4}>
              <StatCard label="Allocated" value={usd(totalAllocated)} hint={monthLabel} mono />
              <StatCard label="Spent this period" value={usd(totalSpent)} hint={`${totalRuns} ${totalRuns === 1 ? 'run' : 'runs'}`} mono />
              <StatCard
                label="Remaining"
                value={usd(remaining)}
                danger={remaining < 0}
                hint={remaining < 0 ? 'over allocation' : 'allocated − spent'}
                mono
              />
              {/* The recurring floor: what scheduled bots cost to keep the
                  repos alive. Only the remainder of an allocation is available
                  for new work, so this belongs beside the totals, not buried
                  in the by-trigger split. */}
              <StatCard
                label="Maintenance floor"
                value={usd(totalMaintenance)}
                hint={totalSpent > 0 ? `${Math.round((totalMaintenance / totalSpent) * 100)}% of spend · scheduled bots` : 'scheduled bots'}
                mono
              />
            </KPIGrid>
          </div>

          {/* ── Breakdown cards ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            <BreakdownCard
              title="SPEND BY MODEL"
              rows={(summary?.byModel ?? []).map((m) => ({
                label: modelLabel(m.model), spentUsd: m.spentUsd, runCount: m.runCount,
              }))}
            />
            <BreakdownCard
              title="SPEND BY TRIGGER"
              rows={(summary?.byTrigger ?? []).map((t) => ({
                label: t.trigger, spentUsd: t.spentUsd, runCount: t.runCount,
              }))}
            />
          </div>

          {/* ── Allocation table ── */}
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
                  const blindSpot = row.allocatedUsd == null && row.spentThisPeriodUsd > 0;
                  const rowRemaining = row.allocatedUsd != null ? row.allocatedUsd - row.spentThisPeriodUsd : null;
                  const burn = row.allocatedUsd != null && row.allocatedUsd > 0
                    ? row.spentThisPeriodUsd / row.allocatedUsd
                    : null;
                  return (
                    <TableRow key={row.orgProjectId}>
                      <TableTd>
                        <span className="inline-flex items-center gap-2 min-w-0">
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
                        </span>
                      </TableTd>
                      <TableTd>
                        <AllocationCell row={row} canManage={canManage} onSaved={refresh} />
                      </TableTd>
                      <TableTd>
                        <span className="tabular-nums">{usd(row.spentThisPeriodUsd)}</span>
                        {row.maintenanceUsd > 0 && (
                          <div
                            className="text-[11px] text-text-tertiary tabular-nums mt-0.5"
                            title="Cron-triggered bot runs — the recurring floor of keeping this initiative's repos alive"
                          >
                            {usd(row.maintenanceUsd)} maintenance
                          </div>
                        )}
                      </TableTd>
                      <TableTd>
                        {rowRemaining == null || burn == null ? (
                          <span className="text-text-tertiary">—</span>
                        ) : (
                          <div className="min-w-28">
                            <span className={`tabular-nums text-[12px] ${rowRemaining < 0 ? 'text-danger font-semibold' : ''}`}>
                              {usd(rowRemaining)}
                            </span>
                            <div className="mt-1">
                              <ProgressBar
                                value={Math.min(row.spentThisPeriodUsd, row.allocatedUsd!)}
                                max={row.allocatedUsd!}
                                size="sm"
                                showRatio={false}
                                color={burn > 1 ? 'var(--color-danger)' : burn > 0.8 ? 'var(--color-warning)' : undefined}
                                aria-label={`Burn: ${Math.round(burn * 100)}% of allocation`}
                              />
                            </div>
                          </div>
                        )}
                      </TableTd>
                      <TableTd>
                        <span className="tabular-nums">{row.runCountThisPeriod}</span>
                      </TableTd>
                      <TableTd>
                        <span className="text-text-tertiary whitespace-nowrap" title={row.lastAgentActivityAt ?? undefined}>
                          {ago(row.lastAgentActivityAt)}
                        </span>
                      </TableTd>
                      <TableTd>
                        <span className="text-text-tertiary">{row.updatedBy ?? '—'}</span>
                      </TableTd>
                      {canManage && (
                        <TableTd>
                          {row.allocatedUsd != null && (
                            <button
                              onClick={() => setConfirmDelete(row)}
                              title="Remove this allocation"
                              aria-label={`Remove allocation for ${row.orgProjectName ?? row.orgProjectId}`}
                              className="px-1.5 py-0.5 rounded border-none bg-transparent text-[12px] text-text-tertiary cursor-pointer hover:text-danger"
                            >
                              ✕
                            </button>
                          )}
                        </TableTd>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>

          <SprintEnvelopes />
        </>
      )}

      <ConfirmDialog
        open={confirmDelete != null}
        title="Remove allocation?"
        body={`${confirmDelete?.orgProjectName ?? confirmDelete?.orgProjectId ?? ''} keeps accruing spend — it will show as an unallocated blind spot instead of being judged against a budget.`}
        confirmLabel="Remove"
        tone="destructive"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => { if (confirmDelete) void deleteAllocation(confirmDelete); }}
      />
    </PageSection>
  );
}
