// Sprints — the SME's own cadence, and the org-leader's view across them.
//
// The program operating model (docs/program-operating-model.md) is built on
// sprints: an initiative runs them, one SME stewards each, a budget_grant
// scopes an envelope to one, and work items carry sprint_id. Until this page
// existed the only surface for any of that was the grants TABLE on the Budgets
// page — gated to org-leader/hr-admin — so the SME the model is written for
// could not open their own sprint anywhere.
//
// Two framings this page holds deliberately:
//
//  • "Mine" is not "mine to steward". Stewardship in the seed sits with six
//    people while sprint work is assigned across the whole cast, so a sprint is
//    yours when you steward it, hold its envelope, OR have work in it — and
//    each card says which. Anything narrower shows most SMEs an empty page.
//
//  • The money is INITIATIVE spend inside the sprint window, and it is labelled
//    that way everywhere it appears. bot_runs record which initiative and which
//    bot paid, never whose envelope authorized it, so a "your burn" figure
//    would be invented. This repeats a decision already made for the Budgets
//    grants table rather than quietly softening it here.
//
// Read-only by design: nothing on this page writes. Sprint planning (moving
// items, re-granting envelopes) belongs to the board and the ledger.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  PageSection,
  Card,
  Chip,
  ProgressBar,
  EmptyState,
  StatCard,
  KPIGrid,
  SegmentedControl,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';

// ─── Types (the /api/sprints + /api/graph/work contracts) ────────────────────

interface Sprint {
  id: string;
  orgProjectId: string;
  orgProjectName: string | null;
  name: string;
  goal: string | null;
  stewardPersonId: string | null;
  stewardName: string | null;
  startsOn: string | null;
  endsOn: string | null;
  status: string;
  itemCount: number;
  doneItemCount: number;
  pointsTotal: number;
  pointsDone: number;
  /** Sum of work_items.estimated_cost_usd — what the sprint was planned to cost. */
  estimatedCostUsd: number;
  /** budget_grants.allocated_usd scoped to this sprint. */
  grantedUsd: number;
  grantCount: number;
  /** Initiative spend inside the sprint dates. NOT anyone's personal burn. */
  initiativeSpendInWindowUsd: number;
  isSteward: boolean;
  isGrantee: boolean;
  myItemCount: number;
  myOpenItemCount: number;
}

interface SprintsResponse {
  scope: 'mine' | 'all';
  /** people.id behind the session, or null for an unlinked account. */
  personId: string | null;
  canSeeAll: boolean;
  sprints: Sprint[];
}

interface WorkItem {
  id: string;
  projectId: string;
  type: string;
  title: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  assigneeName: string | null;
  storyPoints: number | null;
  estimatedCostUsd: number | null;
  prUrl: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `2026-08-24` → `24 Aug`. Sprint dates are DATEs, so they are parsed as UTC
 *  and formatted in UTC — reading them locally shifts a sprint boundary by a
 *  day for anyone west of Greenwich. */
function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const DAY_MS = 86_400_000;

/** Whole days from today to `iso` (negative once it has passed). */
function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const end = new Date(`${iso}T00:00:00Z`).getTime();
  if (Number.isNaN(end)) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((end - todayUtc) / DAY_MS);
}

/** How far through its own window a sprint is, 0–1. */
function windowProgress(s: Sprint): number | null {
  if (!s.startsOn || !s.endsOn) return null;
  const start = new Date(`${s.startsOn}T00:00:00Z`).getTime();
  const end = new Date(`${s.endsOn}T00:00:00Z`).getTime();
  if (!(end > start)) return null;
  return Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
}

function dateRange(s: Sprint): string {
  return `${shortDate(s.startsOn)} → ${shortDate(s.endsOn)}`;
}

const STATUS_TONE: Record<string, 'success' | 'info' | 'neutral'> = {
  active: 'success',
  planned: 'info',
  done: 'neutral',
};

// Board columns, in the order work moves through them. 'cancelled' is rendered
// only when something is actually in it — an always-present empty column reads
// as a stage of the process rather than an exception.
const BOARD_COLUMNS: Array<{ status: string; label: string }> = [
  { status: 'open', label: 'Open' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'in_review', label: 'In review' },
  { status: 'done', label: 'Done' },
  { status: 'cancelled', label: 'Cancelled' },
];

const PRIORITY_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  critical: 'danger',
  high: 'warning',
};

// ─── Why this sprint is yours ────────────────────────────────────────────────

function MineChips({ s }: { s: Sprint }) {
  const chips: Array<{ key: string; label: string; tone: 'accent' | 'info' }> = [];
  if (s.isSteward) chips.push({ key: 'steward', label: 'You steward this', tone: 'accent' });
  if (s.isGrantee) chips.push({ key: 'grantee', label: 'Your envelope', tone: 'accent' });
  if (s.myItemCount > 0) {
    chips.push({
      key: 'items',
      label: s.myOpenItemCount > 0
        ? `${s.myOpenItemCount} open of ${s.myItemCount} yours`
        : `${s.myItemCount} yours, all done`,
      tone: 'info',
    });
  }
  if (chips.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {chips.map((c) => <Chip key={c.key} tone={c.tone} size="sm">{c.label}</Chip>)}
    </div>
  );
}

// ─── Sprint card (the picker) ────────────────────────────────────────────────

function SprintCard({ s, selected, onSelect }: {
  s: Sprint; selected: boolean; onSelect: () => void;
}) {
  const left = daysUntil(s.endsOn);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
        background: selected ? 'var(--color-surface-hover)' : 'var(--color-surface)',
        border: `1px solid ${selected ? 'var(--color-primary)' : 'var(--color-border)'}`,
        borderRadius: 8, padding: 12, font: 'inherit', color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <strong style={{ fontSize: 14 }}>{s.name}</strong>
        <Chip tone={STATUS_TONE[s.status] ?? 'neutral'} size="sm">{s.status}</Chip>
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
        {s.orgProjectName ?? s.orgProjectId} · {dateRange(s)}
        {s.status === 'active' && left !== null
          ? ` · ${left >= 0 ? `${left}d left` : `${-left}d over`}`
          : ''}
      </div>
      <div style={{ marginTop: 8 }}>
        <ProgressBar
          value={s.pointsDone}
          max={Math.max(s.pointsTotal, 1)}
          size="sm"
          label={`${s.pointsDone}/${s.pointsTotal} pts`}
        />
      </div>
      <div style={{ marginTop: 8 }}><MineChips s={s} /></div>
    </button>
  );
}

// ─── Work board for one sprint ───────────────────────────────────────────────

function SprintBoard({ sprintId, personId }: { sprintId: string; personId: string | null }) {
  const { data, isLoading, error } = useFetch<WorkItem[]>(
    `/api/graph/work?sprint=${encodeURIComponent(sprintId)}&limit=200`,
  );
  const [mineOnly, setMineOnly] = useState(false);

  const items = useMemo(() => {
    const all = data ?? [];
    return mineOnly && personId ? all.filter((i) => i.assigneeId === personId) : all;
  }, [data, mineOnly, personId]);

  const columns = BOARD_COLUMNS
    .map((c) => ({ ...c, items: items.filter((i) => i.status === c.status) }))
    .filter((c) => c.status !== 'cancelled' || c.items.length > 0);

  if (error) {
    return (
      <EmptyState
        title="Could not load this sprint's work"
        description={error}
      />
    );
  }
  if (isLoading && !data) {
    return <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>Loading work…</div>;
  }
  if ((data ?? []).length === 0) {
    return (
      <EmptyState
        title="No work items in this sprint"
        body="Items carry sprint membership on the board — assign one to this sprint from the initiative's work items."
      />
    );
  }

  return (
    <div>
      {personId ? (
        <label style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10, cursor: 'pointer',
        }}>
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
          Only work assigned to me
        </label>
      ) : null}
      <div style={{
        display: 'grid', gap: 12,
        gridTemplateColumns: `repeat(auto-fit, minmax(220px, 1fr))`,
      }}>
        {columns.map((col) => (
          <div key={col.status}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em',
              color: 'var(--color-text-tertiary)', marginBottom: 6,
            }}>
              <span>{col.label}</span>
              <span>{col.items.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {col.items.length === 0
                ? <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>—</div>
                : col.items.map((i) => (
                  <div key={i.id} style={{
                    border: '1px solid var(--color-border)', borderRadius: 6,
                    padding: 8, background: 'var(--color-surface)',
                    // The one row that is yours should be findable in a column
                    // of twelve without reading every assignee.
                    borderLeft: personId && i.assigneeId === personId
                      ? '3px solid var(--color-primary)'
                      : '1px solid var(--color-border)',
                  }}>
                    <div style={{ fontSize: 13, lineHeight: 1.3 }}>{i.title}</div>
                    <div style={{
                      display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
                      marginTop: 6, fontSize: 11, color: 'var(--color-text-tertiary)',
                    }}>
                      <Chip tone="neutral" size="sm">{i.type}</Chip>
                      {/* Priority is shown only when it is one — a chip on
                          every card says nothing about which to pick up. */}
                      {PRIORITY_TONE[i.priority]
                        ? <Chip tone={PRIORITY_TONE[i.priority]!} size="sm">{i.priority}</Chip>
                        : null}
                      {i.storyPoints != null ? <span>{i.storyPoints} pts</span> : null}
                      {/* Complexity and dollars are the two estimates the model
                          plans in — never hours. */}
                      {i.estimatedCostUsd != null ? <span>· est {usd(i.estimatedCostUsd)}</span> : null}
                      {i.assigneeName ? <span>· {i.assigneeName}</span> : null}
                      {i.prUrl
                        ? <a href={i.prUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)' }}>PR</a>
                        : null}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Sprint detail ───────────────────────────────────────────────────────────

function SprintDetail({ s, personId }: { s: Sprint; personId: string | null }) {
  const progress = windowProgress(s);
  const left = daysUntil(s.endsOn);
  const overEnvelope = s.grantedUsd > 0 && s.initiativeSpendInWindowUsd > s.grantedUsd;

  return (
    <Card padding="md">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{s.name}</h2>
            <Chip tone={STATUS_TONE[s.status] ?? 'neutral'} size="sm">{s.status}</Chip>
          </div>
          {s.goal ? (
            <p style={{ margin: '6px 0 0', color: 'var(--color-text-secondary)', fontSize: 13, maxWidth: 720 }}>
              {s.goal}
            </p>
          ) : null}
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            <Link to={`/iq/projects/${encodeURIComponent(s.orgProjectId)}`}>
              {s.orgProjectName ?? s.orgProjectId}
            </Link>
            {' · '}
            {/* The steward is the SME accountable for the sprint; the envelope
                below is granted to them, which is why the two sit together. */}
            Steward: {s.stewardName ?? 'unassigned'}
            {' · '}{dateRange(s)}
            {left !== null && s.status !== 'done'
              ? ` · ${left >= 0 ? `${left} days left` : `${-left} days over`}`
              : ''}
          </div>
        </div>
        <div style={{ minWidth: 220, flex: '0 1 260px' }}>
          {progress !== null ? (
            <ProgressBar
              value={Math.round(progress * 100)}
              max={100}
              showRatio={false}
              label="Elapsed"
              size="sm"
            />
          ) : null}
          <div style={{ marginTop: 8 }}>
            <ProgressBar
              value={s.pointsDone}
              max={Math.max(s.pointsTotal, 1)}
              label="Points done"
              size="sm"
            />
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <KPIGrid columns={4}>
          <StatCard
            label="Points"
            value={`${s.pointsDone} / ${s.pointsTotal}`}
            hint={`${s.doneItemCount} of ${s.itemCount} items done`}
          />
          <StatCard
            label="Planned cost"
            value={usd(s.estimatedCostUsd)}
            hint="Sum of the sprint's work-item dollar estimates"
          />
          <StatCard
            label="Envelope granted"
            value={s.grantCount > 0 ? usd(s.grantedUsd) : '—'}
            hint={s.grantCount > 0
              ? `${s.grantCount} grant${s.grantCount === 1 ? '' : 's'} to ${s.stewardName ?? 'the steward'}`
              : 'No budget grant scoped to this sprint'}
          />
          <StatCard
            label="Initiative spend in window"
            value={usd(s.initiativeSpendInWindowUsd)}
            danger={overEnvelope}
            // The label is load-bearing, not decoration. bot_runs record the
            // initiative and the bot that paid, never the person whose envelope
            // authorized it — so this is what the initiative spent between
            // these dates, and calling it the steward's burn would be a number
            // the data cannot support.
            hint={`All agent spend attributed to this initiative ${dateRange(s)} — not a personal burn figure`}
          />
        </KPIGrid>
      </div>

      {overEnvelope ? (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-danger)' }}>
          The initiative spent more inside this window than the sprint's envelope holds. That
          spend is the initiative's, not necessarily this sprint's — cron maintenance on the
          same repos lands in the same window.
        </div>
      ) : null}

      <div style={{ marginTop: 18 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Work in this sprint</h3>
        <SprintBoard sprintId={s.id} personId={personId} />
      </div>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SprintsPage() {
  const { session } = useSession();
  // The wide scope carries every sprint's envelope, which is the money
  // /api/budgets gates — the API refuses `scope=all` to anyone else, so the
  // control only offers it where it will be honoured.
  const canRequestAll = session?.role === 'org-leader'
    || session?.role === 'hr-admin'
    || session?.role === 'admin';

  const [scope, setScope] = useState<'mine' | 'all'>(canRequestAll ? 'all' : 'mine');
  const [activeOnly, setActiveOnly] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const url = `/api/sprints?scope=${scope}${activeOnly ? '&status=active' : ''}`;
  const { data, isLoading, error } = useFetch<SprintsResponse>(url, 60_000);

  const sprints = useMemo(() => data?.sprints ?? [], [data]);

  // Keep a selection valid across scope/filter changes rather than silently
  // rendering a detail panel for a sprint no longer in the list.
  useEffect(() => {
    if (sprints.length === 0) { setSelectedId(null); return; }
    setSelectedId((cur) => (cur && sprints.some((s) => s.id === cur) ? cur : sprints[0]!.id));
  }, [sprints]);

  const selected = sprints.find((s) => s.id === selectedId) ?? null;
  const personId = data?.personId ?? null;

  const totals = useMemo(() => ({
    granted: sprints.reduce((n, s) => n + s.grantedUsd, 0),
    spend: sprints.reduce((n, s) => n + s.initiativeSpendInWindowUsd, 0),
    myOpen: sprints.reduce((n, s) => n + s.myOpenItemCount, 0),
    pointsDone: sprints.reduce((n, s) => n + s.pointsDone, 0),
    pointsTotal: sprints.reduce((n, s) => n + s.pointsTotal, 0),
  }), [sprints]);

  const description = scope === 'mine'
    ? 'Sprints you steward, hold an envelope on, or have work in — with the dates, the work and the money for each.'
    : 'Every initiative\'s sprints, the SME accountable for each, and what the initiative spent inside the window.';

  return (
    <PageSection
      title="Sprints"
      description={description}
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {canRequestAll ? (
            <SegmentedControl
              size="sm"
              value={scope}
              onChange={(v) => setScope(v as 'mine' | 'all')}
              options={[
                { label: 'Mine', value: 'mine' },
                { label: 'All sprints', value: 'all' },
              ]}
            />
          ) : null}
          <SegmentedControl
            size="sm"
            value={activeOnly ? 'active' : 'any'}
            onChange={(v) => setActiveOnly(v === 'active')}
            options={[
              { label: 'Active', value: 'active' },
              { label: 'All time', value: 'any' },
            ]}
          />
        </div>
      }
    >
      {error ? (
        <EmptyState
          title="Could not load sprints"
          description={
            <>
              {error}
              {/* The one failure worth naming: the org-wide scope carries every
                  sprint's envelope, so the API refuses it without ManageBudgets. */}
              {error.startsWith('403')
                ? ' — the org-wide scope needs ManageBudgets; switch back to “Mine”.'
                : ''}
            </>
          }
        />
      ) : isLoading && !data ? (
        <div style={{ color: 'var(--color-text-tertiary)' }}>Loading sprints…</div>
      ) : sprints.length === 0 ? (
        <EmptyState
          title={scope === 'mine' ? 'No sprints of yours' : 'No sprints'}
          description={
            scope === 'mine' && personId === null
              // An unlinked account is a different answer from "you have no
              // sprints", and saying so is the difference between a fixable
              // provisioning gap and an apparently empty product.
              ? 'Your sign-in is not linked to a person in the org graph, so "mine" cannot be resolved. Link it from Identity → Users.'
              : scope === 'mine'
                ? 'No sprint currently has your stewardship, your envelope, or work assigned to you.'
                : activeOnly
                  ? 'No sprint is active right now. Switch to "All time" to see past and planned ones.'
                  : 'No initiative has sprints yet.'
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <KPIGrid columns={4}>
            <StatCard
              label={scope === 'mine' ? 'My sprints' : 'Sprints'}
              value={sprints.length}
              hint={activeOnly ? 'active only' : 'all statuses'}
            />
            <StatCard
              label="Points"
              value={`${totals.pointsDone} / ${totals.pointsTotal}`}
              hint="Complexity delivered against committed"
            />
            <StatCard
              label="Envelopes granted"
              value={usd(totals.granted)}
              hint="Sum of the budget grants scoped to these sprints"
            />
            <StatCard
              label="Initiative spend in windows"
              value={usd(totals.spend)}
              hint="Attributed to the initiatives, not to people"
            />
          </KPIGrid>

          {scope === 'mine' && totals.myOpen > 0 ? (
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              {totals.myOpen} open item{totals.myOpen === 1 ? '' : 's'} assigned to you across these sprints.
            </div>
          ) : null}

          <div style={{
            display: 'grid', gap: 10,
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          }}>
            {sprints.map((s) => (
              <SprintCard
                key={s.id}
                s={s}
                selected={s.id === selectedId}
                onSelect={() => setSelectedId(s.id)}
              />
            ))}
          </div>

          {selected ? <SprintDetail s={selected} personId={personId} /> : null}
        </div>
      )}
    </PageSection>
  );
}
