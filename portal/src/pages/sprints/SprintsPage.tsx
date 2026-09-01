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
// Planning lives here too, gated by capability. A user who holds ManageSprints
// gets a "New sprint" control and can move a work item into or out of a sprint
// from the board; one who holds ManageBudgets gets per-sprint grant management
// (list, add, re-size, revoke an envelope). Everything else stays read-only,
// and every write refetches the same data the page already loads.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
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
  Modal,
  Button,
  DataTable,
  FormField,
  InlineAlert,
} from '@connorhoehnslalom/ui-components/shared';
import type { DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess } from '../../lib/toastStore';
import {
  SPRINT_STATUSES,
  grantsUrl,
  sprintItemsUrl,
  sprintItemUrl,
  grantUrl,
  validateNewSprint,
  validateGrantAmount,
  type NewSprintForm,
} from './sprintForm';

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

// The GrantRow the /api/grants contract returns (a subset — the fields this
// page renders).
interface GrantRow {
  id: string;
  granteePersonId: string;
  granteeName: string | null;
  allocatedUsd: number;
  grantedBy: string | null;
  /** Why the envelope was granted. Editable so a mistyped note can be fixed;
   *  optional so the page still works before the backend returns it. */
  note?: string | null;
}

// An initiative's contributor list (/api/graph/projects/:id); their `personId`
// is the graph id the sprint/grant APIs key on. These are the common case for a
// sprint's steward/grantee, so they are surfaced first — but not the only
// eligible set (audit RM-5): a cross-initiative SME who does not contribute here
// must still be pickable, so both selects also read the org roster below.
interface Contributor { personId: string; name: string; role: string | null }
interface ProjectDetailLite { contributors?: Contributor[] }

// The full set of people the sprint/grant APIs will accept — /api/roster.
// `isSme` flags the SMEs the operating model spreads across initiatives.
interface RosterPerson { id: string; name: string; title?: string | null; isSme?: boolean }
interface RosterResponse { people: RosterPerson[] }

// Options for a steward/grantee <select>: the initiative's own contributors
// first (labelled with their role), then everyone else from the roster. This is
// the RM-5 fix — anyone the backend accepts is selectable, with the common case
// (this initiative's people) prioritised. `loading` shows a placeholder until
// the roster arrives; contributors render immediately either way.
function PeopleSelectOptions({ contributors, roster, loading }: {
  contributors: Contributor[]; roster: RosterPerson[]; loading: boolean;
}) {
  const contribIds = new Set(contributors.map((c) => c.personId));
  const others = roster.filter((p) => !contribIds.has(p.id));
  if (contributors.length === 0 && others.length === 0) {
    return <option value="" disabled>{loading ? 'Loading people…' : 'No people available'}</option>;
  }
  return (
    <>
      {contributors.length > 0 ? (
        <optgroup label="On this initiative">
          {contributors.map((c) => (
            <option key={c.personId} value={c.personId}>
              {c.name}{c.role ? ` · ${c.role}` : ''}
            </option>
          ))}
        </optgroup>
      ) : null}
      {others.length > 0 ? (
        <optgroup label={contributors.length > 0 ? 'Everyone else' : 'People'}>
          {others.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}{p.isSme ? ' · SME' : ''}
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  );
}

// The initiative options for the "New sprint" form come from the projects
// rollup (every initiative, not only ones that already have a sprint).
interface InitiativeOption { id: string; name: string }

// One node of /api/graph/projects/:id/work, flattened for the "add item" picker.
// `status` carries the item's board state so terminal items can be kept out of
// the picker (adding a done/cancelled item only muddies the sprint's rollups).
interface WorkTreeNode { id: string; type: string; title: string; status?: string; children?: WorkTreeNode[] }

// Items that have left the board — adding them to a sprint would fold closed
// work into its point/cost totals, so the picker omits them.
const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

// ─── Write helper ────────────────────────────────────────────────────────────

interface WriteResult<T> { ok: boolean; status: number; data: T | null; error: string | null }

/** One shape for every mutation: sends JSON with the session cookie, and
 *  surfaces the backend's `{ error }` message (400/403/404) verbatim. A bare
 *  403 with no body reads as a permission problem rather than a raw status. */
async function writeJson<T>(url: string, method: string, body?: unknown): Promise<WriteResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
    if (!res.ok) {
      const fallback = res.status === 403
        ? 'You do not have permission for this action.'
        : `HTTP ${res.status}`;
      return { ok: false, status: res.status, data: null, error: json.error ?? fallback };
    }
    return { ok: true, status: res.status, data: json as T, error: null };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err instanceof Error ? err.message : 'Request failed' };
  }
}

// Shared field styling — matches the page's inline-style visual language.
const inputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 9px', fontSize: 13,
  borderRadius: 6, border: '1px solid var(--color-border)',
  background: 'var(--color-surface)', color: 'var(--color-text-primary)', font: 'inherit',
};

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

/** Flatten /api/graph/projects/:id/work into a flat list. */
function flattenTree(nodes: WorkTreeNode[]): WorkTreeNode[] {
  const out: WorkTreeNode[] = [];
  const walk = (n: WorkTreeNode) => { out.push(n); (n.children ?? []).forEach(walk); };
  nodes.forEach(walk);
  return out;
}

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
    () => flattenTree(tree ?? []).filter(
      (n) => !presentIds.has(n.id) && n.type !== 'epic' && !TERMINAL_STATUSES.has(n.status ?? ''),
    ),
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
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>+ Add work item</Button>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <select style={{ ...inputStyle, width: 'auto', minWidth: 220 }} value={choice} onChange={(e) => setChoice(e.target.value)}>
        <option value="">{candidates.length ? 'Select an item to add…' : 'No addable items in this initiative'}</option>
        {candidates.map((c) => <option key={c.id} value={c.id}>{c.type} · {c.title}</option>)}
      </select>
      <Button size="sm" variant="primary" disabled={busy || !choice} onClick={() => void add()}>Add</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setOpen(false); setChoice(''); }}>Cancel</Button>
    </div>
  );
}

function SprintBoard({ sprintId, orgProjectId, personId, canManageSprints, onChanged }: {
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

  const afterChange = () => { refresh(); onChanged(); };

  async function removeItem(id: string) {
    setRemovingId(id);
    const res = await writeJson<{ workItem: WorkItem }>(sprintItemUrl(sprintId, id), 'DELETE');
    setRemovingId(null);
    if (!res.ok) { toastError(null, 'Could not remove item', res.error ?? ''); return; }
    toastSuccess(null, 'Item removed from sprint');
    afterChange();
  }

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
      <div>
        <EmptyState
          title="No work items in this sprint"
          body="Items carry sprint membership on the board — assign one to this sprint from the initiative's work items."
        />
        {canManageSprints ? (
          <div style={{ marginTop: 10 }}>
            <AddItemControl sprintId={sprintId} orgProjectId={orgProjectId} presentIds={presentIds} onAdded={afterChange} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      {canManageSprints ? (
        <div style={{ marginBottom: 10 }}>
          <AddItemControl sprintId={sprintId} orgProjectId={orgProjectId} presentIds={presentIds} onAdded={afterChange} />
        </div>
      ) : null}
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
                      {canManageSprints ? (
                        <button
                          type="button"
                          title="Remove from this sprint"
                          disabled={removingId === i.id}
                          onClick={() => void removeItem(i.id)}
                          style={{
                            marginLeft: 'auto', border: 'none', background: 'none', padding: 0,
                            cursor: 'pointer', color: 'var(--color-text-tertiary)', fontSize: 11,
                          }}
                        >
                          {removingId === i.id ? 'Removing…' : '✕ Remove'}
                        </button>
                      ) : null}
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

function SprintDetail({ s, personId, canManageSprints, canManageBudgets, onChanged }: {
  s: Sprint; personId: string | null;
  canManageSprints: boolean; canManageBudgets: boolean; onChanged: () => void;
}) {
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
        <SprintBoard
          sprintId={s.id}
          orgProjectId={s.orgProjectId}
          personId={personId}
          canManageSprints={canManageSprints}
          onChanged={onChanged}
        />
      </div>

      {canManageBudgets ? <GrantsPanel sprint={s} onChanged={onChanged} /> : null}
    </Card>
  );
}

// ─── Table view ──────────────────────────────────────────────────────────────
//
// The same sprints as the cards, scannable by column. With the org-wide scope
// a release manager reads every initiative's sprints at once; sorting by
// spend-vs-envelope or by window is a table job the card grid can't do.
// Row click selects, same as a card — the detail below is shared.

const SPRINT_TABLE_COLUMNS: DataTableColumn<Sprint>[] = [
  {
    key: 'name', header: 'Sprint', sortable: true,
    render: (s) => (
      <span style={{ fontWeight: 600 }}>
        {s.name}
        {' '}
        <Chip tone={STATUS_TONE[s.status] ?? 'neutral'} size="sm">{s.status}</Chip>
      </span>
    ),
  },
  {
    key: 'orgProjectName', header: 'Initiative', sortable: true,
    render: (s) => <span>{s.orgProjectName ?? '—'}</span>,
  },
  {
    key: 'stewardName', header: 'Steward', sortable: true,
    render: (s) => <span>{s.stewardName ?? '—'}</span>,
  },
  {
    key: 'startsOn', header: 'Window', sortable: true,
    compare: (a, b) => String(a.startsOn ?? '').localeCompare(String(b.startsOn ?? '')),
    render: (s) => <span style={{ whiteSpace: 'nowrap' }}>{dateRange(s)}</span>,
  },
  {
    key: 'pointsDone', header: 'Points', align: 'right', sortable: true,
    compare: (a, b) => (a.pointsDone / Math.max(a.pointsTotal, 1)) - (b.pointsDone / Math.max(b.pointsTotal, 1)),
    render: (s) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{s.pointsDone} / {s.pointsTotal}</span>,
  },
  {
    key: 'estimatedCostUsd', header: 'Planned', align: 'right', sortable: true,
    render: (s) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{usd(s.estimatedCostUsd)}</span>,
  },
  {
    key: 'grantedUsd', header: 'Envelope', align: 'right', sortable: true,
    render: (s) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{s.grantCount > 0 ? usd(s.grantedUsd) : '—'}</span>,
  },
  {
    key: 'initiativeSpendInWindowUsd', header: 'Spend in window', align: 'right', sortable: true,
    render: (s) => (
      <span style={{
        fontVariantNumeric: 'tabular-nums',
        color: s.grantCount > 0 && s.initiativeSpendInWindowUsd > s.grantedUsd
          ? 'var(--color-danger)' : undefined,
      }}>
        {usd(s.initiativeSpendInWindowUsd)}
      </span>
    ),
  },
];

function SprintTable({ sprints, onSelect }: {
  sprints: Sprint[]; onSelect: (id: string) => void;
}) {
  return (
    <DataTable<Sprint>
      data={sprints}
      columns={SPRINT_TABLE_COLUMNS}
      keyField={(s) => s.id}
      onRowClick={(s) => onSelect(s.id)}
      searchable={sprints.length > 8}
      searchPlaceholder="Filter sprints…"
      pageSize={25}
      emptyMessage="No sprints"
    />
  );
}

// ─── New sprint (ManageSprints) ──────────────────────────────────────────────

const EMPTY_FORM: NewSprintForm = {
  initiativeId: '', name: '', startsOn: '', endsOn: '', stewardPersonId: '', goal: '', status: 'planned',
};

function NewSprintModal({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (created: Sprint) => void;
}) {
  const [form, setForm] = useState<NewSprintForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Every initiative — not only ones that already have a sprint — so a first
  // sprint can be created. Only fetched while the modal is open.
  const { data: initiatives } = useFetch<InitiativeOption[]>(open ? '/api/graph/projects?limit=100' : null);
  // Steward options: the chosen initiative's contributors (fetched once an
  // initiative is picked) surfaced first, plus the whole org roster so a
  // cross-initiative SME who doesn't contribute here is still pickable (RM-5).
  const { data: project } = useFetch<ProjectDetailLite>(
    open && form.initiativeId ? `/api/graph/projects/${encodeURIComponent(form.initiativeId)}` : null,
  );
  const { data: roster, isLoading: rosterLoading } = useFetch<RosterResponse>(open ? '/api/roster' : null);

  useEffect(() => { if (open) { setForm(EMPTY_FORM); setError(null); } }, [open]);

  const set = (patch: Partial<NewSprintForm>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    const check = validateNewSprint(form);
    if (!check.ok) { setError(check.error); return; }
    setBusy(true);
    setError(null);
    const res = await writeJson<{ sprint: Sprint }>('/api/sprints', 'POST', check.value);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      // A 403 is shown inline (above) AND toasted so it isn't missed if the
      // modal is dismissed; other failures stay inline next to the form.
      if (res.status === 403) toastError(null, 'Not permitted', res.error ?? '');
      return;
    }
    toastSuccess(null, 'Sprint created', `${check.value.name} is ready to plan.`);
    // Hand the created row up so the page can drop a filter that would hide it
    // (a new sprint defaults to 'planned', which the active-only list omits).
    if (res.data?.sprint) onCreated(res.data.sprint);
    onClose();
  }

  const contributors = project?.contributors ?? [];
  const rosterPeople = roster?.people ?? [];

  return (
    <Modal open={open} onClose={onClose} title="New sprint" maxWidth={520}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Creating…' : 'Create sprint'}
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error ? <InlineAlert tone="error" onDismiss={() => setError(null)}>{error}</InlineAlert> : null}

        <FormField label="Initiative" required>
          {({ id }) => (
            <select
              id={id}
              style={inputStyle}
              value={form.initiativeId}
              onChange={(e) => set({ initiativeId: e.target.value, stewardPersonId: '' })}
            >
              <option value="">Select an initiative…</option>
              {(initiatives ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </FormField>

        <FormField label="Name" required>
          {({ id }) => (
            <input
              id={id}
              style={inputStyle}
              value={form.name}
              placeholder="e.g. Sprint 7 — auth hardening"
              onChange={(e) => set({ name: e.target.value })}
            />
          )}
        </FormField>

        <div style={{ display: 'flex', gap: 12 }}>
          <FormField label="Starts" required style={{ flex: 1 }}>
            {({ id }) => (
              <input id={id} type="date" style={inputStyle} value={form.startsOn}
                onChange={(e) => set({ startsOn: e.target.value })} />
            )}
          </FormField>
          <FormField label="Ends" required style={{ flex: 1 }}>
            {({ id }) => (
              <input id={id} type="date" style={inputStyle} value={form.endsOn}
                onChange={(e) => set({ endsOn: e.target.value })} />
            )}
          </FormField>
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <FormField label="Steward" hint="The SME accountable — anyone in the org, not only this initiative's contributors" style={{ flex: 1 }}>
            {({ id }) => (
              <select
                id={id}
                style={inputStyle}
                value={form.stewardPersonId ?? ''}
                onChange={(e) => set({ stewardPersonId: e.target.value })}
              >
                <option value="">Unassigned</option>
                <PeopleSelectOptions contributors={contributors} roster={rosterPeople} loading={rosterLoading} />
              </select>
            )}
          </FormField>
          <FormField label="Status" style={{ flex: 1 }}>
            {({ id }) => (
              <select id={id} style={inputStyle} value={form.status} onChange={(e) => set({ status: e.target.value })}>
                {SPRINT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
          </FormField>
        </div>

        <FormField label="Goal" hint="Optional — one line on what this sprint is for">
          {({ id }) => (
            <textarea
              id={id}
              style={{ ...inputStyle, resize: 'vertical', minHeight: 56 }}
              value={form.goal ?? ''}
              onChange={(e) => set({ goal: e.target.value })}
            />
          )}
        </FormField>
      </div>
    </Modal>
  );
}

// ─── Grant management (ManageBudgets) ────────────────────────────────────────

function GrantsPanel({ sprint, onChanged }: { sprint: Sprint; onChanged: () => void }) {
  const { data, isLoading, error, refresh } = useFetch<{ grants: GrantRow[] }>(grantsUrl(sprint.id));
  // Grantee options: the initiative's contributors first, plus the whole org
  // roster — same source as the steward picker — so a cross-initiative SME can
  // be granted an envelope even though they don't contribute here (RM-5).
  const { data: project } = useFetch<ProjectDetailLite>(
    `/api/graph/projects/${encodeURIComponent(sprint.orgProjectId)}`,
  );
  const { data: roster, isLoading: rosterLoading } = useFetch<RosterResponse>('/api/roster');
  const grants = data?.grants ?? [];
  const contributors = project?.contributors ?? [];
  const rosterPeople = roster?.people ?? [];

  const [adding, setAdding] = useState(false);
  const [grantee, setGrantee] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editNote, setEditNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reload() { refresh(); onChanged(); }

  async function addGrant() {
    if (!grantee) { setFormError('Pick who the envelope is granted to.'); return; }
    const amt = validateGrantAmount(amount);
    if (!amt.ok) { setFormError(amt.error); return; }
    setBusy(true); setFormError(null);
    const res = await writeJson<{ grant: GrantRow }>('/api/grants', 'POST', {
      initiativeId: sprint.orgProjectId,
      sprintId: sprint.id,
      granteePersonId: grantee,
      amountUsd: amt.value,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) { setFormError(res.error); return; }
    toastSuccess(null, 'Envelope granted', usd(amt.value));
    setAdding(false); setGrantee(''); setAmount(''); setNote('');
    reload();
  }

  async function saveEdit(id: string) {
    // Edit allows $0 — zeroing an envelope freezes its spend without deleting
    // the row (the backend accepts amountUsd >= 0). Create still forbids $0.
    const amt = validateGrantAmount(editAmount, { allowZero: true });
    if (!amt.ok) { setFormError(amt.error); return; }
    setBusy(true); setFormError(null);
    // Send the note alongside the amount so a mistyped note can be corrected
    // (or cleared). Trimmed empty string clears it per the PATCH contract.
    const res = await writeJson<{ grant: GrantRow }>(grantUrl(id), 'PATCH', {
      amountUsd: amt.value,
      note: editNote.trim(),
    });
    setBusy(false);
    if (!res.ok) { toastError(null, 'Could not update grant', res.error ?? ''); return; }
    toastSuccess(null, 'Envelope updated', usd(amt.value));
    setEditId(null);
    reload();
  }

  async function revoke(g: GrantRow) {
    setBusy(true);
    const res = await writeJson<{ ok: true }>(grantUrl(g.id), 'DELETE');
    setBusy(false);
    if (!res.ok) { toastError(null, 'Could not revoke grant', res.error ?? ''); return; }
    toastSuccess(null, 'Envelope revoked', `${g.granteeName ?? 'grantee'}'s grant removed.`);
    reload();
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Envelope grants</h3>
        {!adding ? (
          <Button size="sm" variant="secondary" onClick={() => { setAdding(true); setFormError(null); }}>
            + Grant envelope
          </Button>
        ) : null}
      </div>

      {formError ? (
        <div style={{ marginBottom: 8 }}>
          <InlineAlert tone="error" onDismiss={() => setFormError(null)}>{formError}</InlineAlert>
        </div>
      ) : null}

      {adding ? (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end',
          border: '1px solid var(--color-border)', borderRadius: 8, padding: 12, marginBottom: 10,
        }}>
          <FormField label="Grantee" style={{ flex: '1 1 180px' }}>
            {({ id }) => (
              <select id={id} style={inputStyle} value={grantee} onChange={(e) => setGrantee(e.target.value)}>
                <option value="">Select…</option>
                <PeopleSelectOptions contributors={contributors} roster={rosterPeople} loading={rosterLoading} />
              </select>
            )}
          </FormField>
          <FormField label="Amount (USD)" style={{ flex: '0 1 140px' }}>
            {({ id }) => (
              <input id={id} style={inputStyle} inputMode="decimal" placeholder="0.00"
                value={amount} onChange={(e) => setAmount(e.target.value)} />
            )}
          </FormField>
          <FormField label="Note" style={{ flex: '1 1 180px' }}>
            {({ id }) => (
              <input id={id} style={inputStyle} value={note} placeholder="Optional"
                onChange={(e) => setNote(e.target.value)} />
            )}
          </FormField>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void addGrant()}>Grant</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setAdding(false); setFormError(null); }}>Cancel</Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div style={{ fontSize: 12, color: 'var(--color-danger)' }}>Could not load grants: {error}</div>
      ) : isLoading && !data ? (
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading grants…</div>
      ) : grants.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          No envelope is granted to this sprint yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {grants.map((g) => (
            <div key={g.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              border: '1px solid var(--color-border)', borderRadius: 6, padding: '8px 10px',
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, flex: '1 1 140px', minWidth: 0 }}>
                {g.granteeName ?? g.granteePersonId}
              </span>
              {editId === g.id ? (
                <>
                  <input style={{ ...inputStyle, width: 110 }} inputMode="decimal"
                    aria-label="Envelope amount (USD)"
                    value={editAmount} onChange={(e) => setEditAmount(e.target.value)} />
                  <input style={{ ...inputStyle, flex: '1 1 160px', minWidth: 120 }}
                    aria-label="Grant note" placeholder="Note (optional)"
                    value={editNote} onChange={(e) => setEditNote(e.target.value)} />
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveEdit(g.id)}>Save</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditId(null)}>Cancel</Button>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 13 }}>{usd(g.allocatedUsd)}</span>
                  {g.note ? (
                    <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', flex: '1 1 140px', minWidth: 0 }}>
                      {g.note}
                    </span>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => { setEditId(g.id); setEditAmount(String(g.allocatedUsd)); setEditNote(g.note ?? ''); setFormError(null); }}>Edit</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke(g)}>Revoke</Button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
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

  const { can } = useCapabilities();
  const canManageSprints = can('ManageSprints');
  const canManageBudgets = can('ManageBudgets');

  const [scope, setScope] = useState<'mine' | 'all'>(canRequestAll ? 'all' : 'mine');
  const [activeOnly, setActiveOnly] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newSprintOpen, setNewSprintOpen] = useState(false);
  // Cards scan by shape, the table scans by column — with the org-wide scope a
  // release manager is reading 14 initiatives' sprints, and that is a table
  // job. Device pref, preserved across tenant switches like projects-view.
  const [view, setView] = useState<'cards' | 'table'>(() => {
    try { return (localStorage.getItem('sprints-view') as 'cards' | 'table') ?? 'cards'; } catch { return 'cards'; }
  });
  const setViewPref = (v: 'cards' | 'table') => {
    setView(v);
    try { localStorage.setItem('sprints-view', v); } catch { /* ignore */ }
  };

  const url = `/api/sprints?scope=${scope}${activeOnly ? '&status=active' : ''}`;
  const { data, isLoading, error, refresh } = useFetch<SprintsResponse>(url, 60_000);

  const sprints = useMemo(() => data?.sprints ?? [], [data]);

  // Keep a selection valid across scope/filter changes rather than silently
  // rendering a detail panel for a sprint no longer in the list.
  useEffect(() => {
    if (sprints.length === 0) { setSelectedId(null); return; }
    setSelectedId((cur) => (cur && sprints.some((s) => s.id === cur) ? cur : sprints[0]!.id));
  }, [sprints]);

  const selected = sprints.find((s) => s.id === selectedId) ?? null;
  const personId = data?.personId ?? null;

  // A freshly-created sprint would otherwise vanish: the list defaults to
  // active-only and the New Sprint form defaults to 'planned'. If the created
  // sprint wouldn't survive the current filter, drop the filter and select it
  // so the user lands on exactly what they just made. Changing `activeOnly`
  // repoints the fetch URL (useFetch refetches on url change); when it is
  // already off, refresh() picks up the new row.
  const handleCreated = (created: Sprint) => {
    if (activeOnly && created.status !== 'active') setActiveOnly(false);
    setSelectedId(created.id);
    refresh();
  };

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
            value={view}
            onChange={(v) => setViewPref(v as 'cards' | 'table')}
            options={[
              { label: 'Cards', value: 'cards' },
              { label: 'Table', value: 'table' },
            ]}
          />
          <SegmentedControl
            size="sm"
            value={activeOnly ? 'active' : 'any'}
            onChange={(v) => setActiveOnly(v === 'active')}
            options={[
              { label: 'Active', value: 'active' },
              { label: 'All time', value: 'any' },
            ]}
          />
          {canManageSprints ? (
            <Button size="sm" variant="primary" onClick={() => setNewSprintOpen(true)}>+ New sprint</Button>
          ) : null}
        </div>
      }
    >
      <NewSprintModal open={newSprintOpen} onClose={() => setNewSprintOpen(false)} onCreated={handleCreated} />
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
            {/* These totals sum only the sprints currently loaded, so under the
                default active-only filter they are an active-sprint subtotal,
                not an org-wide figure — the hint says which, mirroring the
                "My sprints" tile above. */}
            <StatCard
              label="Envelopes granted"
              value={usd(totals.granted)}
              hint={activeOnly
                ? 'Budget grants on the active sprints only'
                : 'Sum of the budget grants scoped to these sprints'}
            />
            <StatCard
              label="Initiative spend in windows"
              value={usd(totals.spend)}
              hint={activeOnly
                ? 'Attributed to initiatives — active sprints only'
                : 'Attributed to the initiatives, not to people'}
            />
          </KPIGrid>

          {scope === 'mine' && totals.myOpen > 0 ? (
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              {totals.myOpen} open item{totals.myOpen === 1 ? '' : 's'} assigned to you across these sprints.
            </div>
          ) : null}

          {view === 'cards' ? (
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
          ) : (
            <SprintTable sprints={sprints} onSelect={setSelectedId} />
          )}

          {selected ? (
            <SprintDetail
              s={selected}
              personId={personId}
              canManageSprints={canManageSprints}
              canManageBudgets={canManageBudgets}
              onChanged={refresh}
            />
          ) : null}
        </div>
      )}
    </PageSection>
  );
}
