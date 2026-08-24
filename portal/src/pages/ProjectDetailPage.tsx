import { useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router';
import { Card, Chip, CollapsibleSection, PageSection, StatusDot, type ChipTone } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { useCapabilities } from '../lib/capabilities';
import { toastError, toastInfo } from '../lib/toastStore';
import { EstimateDrawer } from '../components/marketplace/EstimateDrawer';
import { OwnerEditor, RoleCycleChip } from '../components/marketplace/GovernanceEditor';
import {
  useInitiativeAgentActivity,
  AgentsRailCard,
  OutcomesRailCard,
} from '../components/marketplace/InitiativeAgentRail';
import type { BotRun } from './bots/BotsPage';

// ─── Types ────────────────────────────────────────────────────────────────────

// The taxonomy is deliberately flat: epics contain stories and bugs, and
// that's the tree. Stories and bugs are the dispatchable units; the server
// migrates legacy feature/task rows to story.
type WorkItemType   = 'epic' | 'story' | 'bug';
type WorkItemStatus = 'open' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
type WorkItemPriority = 'critical' | 'high' | 'medium' | 'low';
type PrStatus = 'open' | 'draft' | 'merged' | 'closed';

interface WorkItem {
  id: string;
  projectId: string;
  projectName: string;
  parentId: string | null;
  type: WorkItemType;
  title: string;
  description: string | null;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeDept: string | null;
  labels: string[];
  storyPoints: number | null;
  prUrl: string | null;
  prStatus: PrStatus | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  childCount: number;
  childDoneCount: number;
}

interface WorkItemTree extends WorkItem {
  children: WorkItemTree[];
}

interface ProjectDecision {
  id: string;
  topic: string;
  summary: string | null;
  status: string;
  requiredRole: string | null;
  escalatedAt: string | null;
  workItemId: string | null;
  workItemTitle: string | null;
}

interface ProjectDetail {
  id: string;
  name: string;
  status: string | null;
  description?: string | null;
  githubUrl?: string | null;
  // Owner — who runs this initiative. Optional: render when present, omit
  // cleanly when the detail response doesn't carry it yet.
  ownerId?: string | null;
  ownerName?: string | null;
  createdAt: string | null;
  contributors: Array<{
    personId: string;
    name: string;
    title: string | null;
    role: string | null;
    weight: number;
  }>;
}

// ─── Design tokens ────────────────────────────────────────────────────────────

// Status tone lookups — Chip carries the colour, StatusDot the leading dot.
const STATUS_TONE: Record<WorkItemStatus, ChipTone> = {
  open:        'neutral',
  in_progress: 'info',
  in_review:   'purple',
  done:        'success',
  cancelled:   'danger',
};

const STATUS_DOT_COLOR: Record<WorkItemStatus, string> = {
  open:        'var(--color-text-tertiary)',
  in_progress: 'var(--color-info)',
  in_review:   '#a855f7',
  done:        'var(--color-success)',
  cancelled:   'var(--color-danger)',
};

const PRIORITY_COLOR: Record<WorkItemPriority, string> = {
  critical: 'var(--color-danger)',
  high:     'var(--color-warning)',
  medium:   'var(--color-warning)',
  low:      'var(--color-text-secondary)',
};

const PR_TONE: Record<PrStatus, ChipTone> = {
  merged: 'purple',
  open:   'success',
  draft:  'neutral',
  closed: 'danger',
};

const PR_ICONS: Record<PrStatus, string> = {
  merged: '⬡',
  open:   '⊙',
  draft:  '⊘',
  closed: '✕',
};

const DECISION_TONE: Record<string, ChipTone> = {
  escalated: 'danger',
  open:      'warning',
  resolved:  'success',
  rejected:  'neutral',
};

const PROJECT_STATUS_COLORS: Record<string, { accent: string; bg: string; text: string }> = {
  active:   { accent: 'var(--color-success)',        bg: 'var(--color-success-bg)', text: 'var(--color-success)' },
  planning: { accent: 'var(--color-info)',           bg: 'var(--color-info-bg)',    text: 'var(--color-primary)' },
  archived: { accent: 'var(--color-text-tertiary)',  bg: 'var(--color-bg)',         text: 'var(--color-text-secondary)' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  // Categorical palette hashed by first-letter — kept as raw hex by design
  // (data-viz identity, not UI chrome).
  const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6'];
  const idx = name.charCodeAt(0) % colors.length;
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: colors[idx], color: 'var(--color-surface)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 700, flexShrink: 0,
    }}>
      {initials(name)}
    </div>
  );
}

function StatusChip({ status }: { status: WorkItemStatus }) {
  return (
    <span className="inline-flex items-center gap-1">
      <StatusDot color={STATUS_DOT_COLOR[status]} size="xs" />
      <Chip tone={STATUS_TONE[status] ?? 'neutral'} size="xs">
        {status.replace('_', ' ')}
      </Chip>
    </span>
  );
}

function PrBadge({ prStatus, prUrl }: { prStatus: PrStatus; prUrl: string | null }) {
  const el = (
    <Chip tone={PR_TONE[prStatus]} size="xs">
      {PR_ICONS[prStatus]} PR · {prStatus}
    </Chip>
  );
  if (prUrl) {
    return (
      <a
        href={prUrl}
        target="_blank"
        rel="noreferrer"
        className="no-underline"
        onClick={(e) => e.stopPropagation()}
      >
        {el}
      </a>
    );
  }
  return el;
}

function countPoints(item: WorkItemTree): { done: number; total: number } {
  let done = 0, total = 0;
  function walk(node: WorkItemTree) {
    if (node.type === 'story' || node.type === 'bug') {
      if (node.storyPoints) {
        total += node.storyPoints;
        if (node.status === 'done') done += node.storyPoints;
      }
    }
    for (const c of node.children) walk(c);
  }
  walk(item);
  return { done, total };
}

function countStories(item: WorkItemTree): { done: number; total: number } {
  let done = 0, total = 0;
  function walk(node: WorkItemTree) {
    if (node.type === 'story') {
      total++;
      if (node.status === 'done') done++;
    }
    for (const c of node.children) walk(c);
  }
  walk(item);
  return { done, total };
}

/** Aurora timestamps arrive without T/Z — same normalization as the bots pages. */
function parseTs(iso: string): number {
  return new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime();
}

// ─── Optimistic-write plumbing ────────────────────────────────────────────────
// Board edits apply locally first and are confirmed against the server. Every
// one of them used to be `.catch(() => {})`, which only fires on a network
// error: a 403, 404, 400 or 503 RESOLVES, so the response was thrown away and
// the local state kept showing a change the server had refused. These helpers
// make the confirm explicit — the caller reverts or reconciles on failure.

/** Rewrite every node in a tree, children first. */
function mapTree(nodes: WorkItemTree[], fn: (n: WorkItemTree) => WorkItemTree): WorkItemTree[] {
  return nodes.map((n) => fn({ ...n, children: mapTree(n.children, fn) }));
}

/** Drop one node (by id) wherever it sits in the tree. */
function dropFromTree(nodes: WorkItemTree[], id: string): WorkItemTree[] {
  return nodes
    .filter((n) => n.id !== id)
    .map((n) => ({ ...n, children: dropFromTree(n.children, id) }));
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Send a write and insist on an answer. Non-2xx throws with the server's own
 *  message, so a refusal can never be mistaken for success. */
async function sendJson<T>(url: string, method: 'POST' | 'PATCH', body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new HttpError(res.status, payload.error ?? `HTTP ${res.status}`);
  return payload as T;
}

/** Say what actually went wrong. 403 is a missing authority, not a bug; a
 *  client-minted id that never reached the server is a 404 worth naming. */
function surfaceWriteError(err: unknown, what: string): void {
  if (err instanceof HttpError && err.status === 403) {
    toastInfo('Needs dispatch rights', `${what} requires the DispatchAgentRun authority on this initiative.`);
    return;
  }
  toastError(null, `${what} failed`, err instanceof Error ? err.message : String(err));
}

/** True for an id this page minted for an item the server has not acknowledged
 *  — writing against one can only 404. */
function isPendingId(id: string): boolean {
  return id.startsWith('wi-new-');
}

// ─── Marketplace affordances (shared by tree rows and board cards) ────────────

/** The Estimate chip — opens the estimate → authorize drawer. Only on open,
    pointed stories and bugs, and only for sessions holding DispatchAgentRun;
    sized so it doesn't fight the row's own click. */
function EstimateChip({ item, onEstimate }: { item: WorkItemTree; onEstimate: (item: WorkItemTree) => void }) {
  const { can, ready } = useCapabilities();
  if (item.status !== 'open' || item.storyPoints == null) return null;
  if (!ready || !can('DispatchAgentRun')) return null;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onEstimate(item); }}
      title="Estimate cost & duration, then authorize an agent run"
      style={{
        fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 9999,
        border: '1px solid var(--color-primary)', background: 'transparent',
        color: 'var(--color-primary)', cursor: 'pointer', flexShrink: 0,
        letterSpacing: '0.02em',
      }}
    >
      ⚡ Estimate
    </button>
  );
}

/** Live marketplace state for a work item: a pulsing chip while an agent is on
    it (linking to its Computers box), and a review link once a change landed. */
function RunStateChips({ item, run }: { item: WorkItemTree; run: BotRun | undefined }) {
  return (
    <>
      {run?.status === 'running' && (
        run.outcome?.boxId ? (
          <Link
            to={`/admin/devbox?box=${encodeURIComponent(run.outcome.boxId)}`}
            className="no-underline"
            onClick={(e) => e.stopPropagation()}
            title="An agent is working this item — open its Computers box"
          >
            <Chip tone="info" size="xs" dot="pulse">agent working</Chip>
          </Link>
        ) : (
          <Chip tone="info" size="xs" dot="pulse">agent working</Chip>
        )
      )}
      {item.status === 'in_review' && run?.outcome?.changeId && (
        <Link
          to="/admin/changes"
          onClick={(e) => e.stopPropagation()}
          title="The agent's change is waiting in the review queue"
          style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'none', flexShrink: 0, whiteSpace: 'nowrap' }}
        >
          → review
        </Link>
      )}
    </>
  );
}

// ─── New Work Item inline form ────────────────────────────────────────────────

interface NewItemFormProps {
  projectId: string;
  parentId: string | null;
  defaultType: WorkItemType;
  /** Which types the select offers — inside an epic that's story/bug only. */
  typeOptions?: WorkItemType[];
  onSave: (item: { title: string; type: WorkItemType; priority: WorkItemPriority; storyPoints: number | null }) => void;
  onCancel: () => void;
}

function NewItemForm({ projectId: _projectId, parentId: _parentId, defaultType, typeOptions, onSave, onCancel }: NewItemFormProps) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<WorkItemType>(defaultType);
  const [priority, setPriority] = useState<WorkItemPriority>('medium');
  // Optional points at creation — without this, UI-created stories/bugs could
  // never be estimated (the ⚡ Estimate chip requires storyPoints != null).
  const [points, setPoints] = useState('');

  const TYPES: WorkItemType[] = typeOptions ?? ['epic', 'story', 'bug'];
  const PRIORITIES: WorkItemPriority[] = ['critical', 'high', 'medium', 'low'];

  // Epics are containers — they aren't sized, so the field hides for them.
  const parsedPoints = (): number | null => {
    if (type === 'epic') return null;
    const n = parseInt(points, 10);
    return Number.isFinite(n) && n >= 1 && n <= 21 ? n : null;
  };
  const save = () => {
    if (!title.trim()) return;
    onSave({ title: title.trim(), type, priority, storyPoints: parsedPoints() });
  };

  return (
    <div style={{
      background: 'var(--color-surface-panel)', border: '1.5px solid var(--color-border)', borderRadius: 8,
      padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <input
        autoFocus
        placeholder="Title…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') onCancel();
        }}
        style={{
          padding: '6px 10px', borderRadius: 6, border: '1px solid var(--color-border-emphasis)',
          fontSize: 14, outline: 'none', background: 'var(--color-surface)',
        }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select value={type} onChange={(e) => setType(e.target.value as WorkItemType)}
          style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--color-border-emphasis)', fontSize: 12, background: 'var(--color-surface)' }}>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value as WorkItemPriority)}
          style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--color-border-emphasis)', fontSize: 12, background: 'var(--color-surface)' }}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {type !== 'epic' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            pts
            <input
              type="number"
              min={1}
              max={21}
              placeholder="—"
              title="Story points (1–21, optional) — sized items can be estimated and dispatched"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') onCancel();
              }}
              style={{ width: 52, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--color-border-emphasis)', fontSize: 12, background: 'var(--color-surface)' }}
            />
          </label>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={onCancel} style={{
            padding: '4px 12px', borderRadius: 6, border: '1px solid var(--color-border)',
            background: 'var(--color-surface)', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer',
          }}>Cancel</button>
          <button
            disabled={!title.trim()}
            onClick={save}
            style={{
              padding: '4px 12px', borderRadius: 6, border: 'none',
              background: title.trim() ? 'var(--color-primary)' : 'var(--color-border)',
              color: title.trim() ? 'var(--color-surface)' : 'var(--color-text-tertiary)', fontSize: 12, cursor: 'pointer',
            }}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Story / bug row ──────────────────────────────────────────────────────────
// The dispatchable unit. No expansion — the two-level tree ends here.

function ItemRow({
  item,
  onStatusToggle,
  run,
  onEstimate,
}: {
  item: WorkItemTree;
  onStatusToggle: (id: string, current: WorkItemStatus) => void;
  run: BotRun | undefined;
  onEstimate: (item: WorkItemTree) => void;
}) {
  const isDone = item.status === 'done';
  const isBug = item.type === 'bug';
  const { can, ready } = useCapabilities();
  const canEdit = ready && can('DispatchAgentRun');

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '7px 14px',
      borderRadius: 6,
      background: isDone ? 'var(--color-bg)' : 'var(--color-surface)',
      transition: 'background 0.1s',
    }}
      onMouseEnter={(e) => { if (!isDone) (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-panel)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = isDone ? 'var(--color-bg)' : 'var(--color-surface)'; }}
    >
      {/* The done-toggle PATCHes the item — DispatchAgentRun only. Viewers
          still see the status via the glyph, strikethrough and status chip. */}
      {canEdit && (
        <input
          type="checkbox"
          checked={isDone}
          onChange={() => onStatusToggle(item.id, item.status)}
          style={{ cursor: 'pointer', accentColor: 'var(--color-primary)', width: 15, height: 15, flexShrink: 0 }}
        />
      )}

      {/* Type glyph — stories keep the soft indigo square (data-viz, leave);
          bugs read danger so they can't be mistaken for stories at a glance. */}
      {isBug ? (
        <span aria-hidden="true" title="bug" style={{ fontSize: 12, color: 'var(--color-danger)', fontFamily: 'monospace', flexShrink: 0 }}>◆</span>
      ) : (
        <span aria-hidden="true" title="story" style={{ fontSize: 12, color: '#a5b4fc', fontFamily: 'monospace', flexShrink: 0 }}>■</span>
      )}
      {isBug && <Chip tone="danger" size="xs">bug</Chip>}

      {/* Title */}
      <span style={{
        flex: 1, fontSize: 13, fontWeight: 500,
        color: isDone ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
        textDecoration: isDone ? 'line-through' : 'none',
      }}>
        {item.title}
      </span>

      {/* Labels */}
      {item.labels.slice(0, 2).map((l) => (
        <span key={l} style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3,
          background: 'var(--color-surface-hover)', color: 'var(--color-text-secondary)' }}>{l}</span>
      ))}

      {/* Marketplace: estimate affordance + live run state */}
      <EstimateChip item={item} onEstimate={onEstimate} />
      <RunStateChips item={item} run={run} />

      {/* PR badge */}
      {item.prStatus && <PrBadge prStatus={item.prStatus} prUrl={item.prUrl} />}

      {/* Story points */}
      {item.storyPoints != null && (
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)',
          background: 'var(--color-surface-hover)', padding: '1px 6px', borderRadius: 9999, minWidth: 24, textAlign: 'center' }}>
          {item.storyPoints}
        </span>
      )}

      {/* Assignee */}
      {item.assigneeName && <Avatar name={item.assigneeName} size={22} />}

      {/* Status */}
      <StatusChip status={item.status} />
    </div>
  );
}

// ─── Epic card ────────────────────────────────────────────────────────────────
// Directly contains its stories and bugs — the feature tier is gone.

function EpicCard({
  item,
  onStatusToggle,
  projectId,
  onAddItem,
  marketRuns,
  onEstimate,
}: {
  item: WorkItemTree;
  onStatusToggle: (id: string, current: WorkItemStatus) => void;
  projectId: string;
  onAddItem: (parentId: string, type: WorkItemType, title: string, priority: WorkItemPriority, storyPoints: number | null) => void;
  marketRuns: Record<string, BotRun>;
  onEstimate: (item: WorkItemTree) => void;
}) {
  const [expanded, setExpanded] = useState(item.status !== 'done');
  const [addingItem, setAddingItem] = useState(false);
  const { can, ready } = useCapabilities();
  const canEdit = ready && can('DispatchAgentRun');
  const pts = countPoints(item);
  const stories = countStories(item);
  const pct = pts.total > 0 ? Math.round((pts.done / pts.total) * 100) : 0;
  const priorityColor = PRIORITY_COLOR[item.priority] ?? PRIORITY_COLOR.medium;

  return (
    <div style={{
      border: '1.5px solid var(--color-border)',
      borderRadius: 10,
      overflow: 'hidden',
      marginBottom: 16,
    }}>
      {/* Epic header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={`detail-${item.id}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          width: '100%', textAlign: 'left',
          padding: '12px 16px',
          background: item.status === 'done' ? 'var(--color-bg)' : 'var(--color-surface)',
          cursor: 'pointer',
          border: 'none',
          borderBottom: expanded ? '1px solid var(--color-border)' : 'none',
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 11, color: 'var(--color-text-tertiary)', width: 14, flexShrink: 0 }}>
          {expanded ? '▾' : '▸'}
        </span>
        <span aria-hidden="true" style={{ fontSize: 14, flexShrink: 0 }}>⚡</span>
        <span style={{ flex: 1, fontSize: 15, fontWeight: 700, color: item.status === 'done' ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)' }}>
          {item.title}
        </span>

        {/* Priority */}
        <span style={{ fontSize: 11, color: priorityColor, fontWeight: 600, flexShrink: 0 }}>
          {item.priority === 'critical' ? '🔴' : item.priority === 'high' ? '🟠' : item.priority === 'medium' ? '🟡' : '⚪'}
        </span>

        {/* Story progress */}
        {stories.total > 0 && (
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
            {stories.done}/{stories.total} stories
          </span>
        )}

        {/* Point progress bar */}
        {pts.total > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <div style={{ width: 60, height: 5, borderRadius: 9999, background: 'var(--color-border)', overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 9999,
                background: pct >= 80 ? 'var(--color-success)' : pct >= 40 ? 'var(--color-primary)' : 'var(--color-warning)',
                width: `${pct}%`,
              }} />
            </div>
            <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 28 }}>{pct}%</span>
          </div>
        )}

        {/* Assignee */}
        {item.assigneeName && <Avatar name={item.assigneeName} size={24} />}

        {/* Status chip */}
        <StatusChip status={item.status} />
      </button>

      {/* Epic body — stories and bugs, directly */}
      {expanded && (
        <div id={`detail-${item.id}`} style={{ padding: '12px 16px', background: 'var(--color-surface-inset)' }}>
          {item.description && (
            <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
              {item.description}
            </p>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {item.children.map((child) => (
              <ItemRow
                key={child.id}
                item={child}
                onStatusToggle={onStatusToggle}
                run={marketRuns[child.id]}
                onEstimate={onEstimate}
              />
            ))}
            {item.children.length === 0 && (
              <div style={{ padding: '6px 14px', fontSize: 12, color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
                No stories or bugs yet
              </div>
            )}
          </div>

          {/* Add story / bug — creation POSTs a work item (DispatchAgentRun) */}
          {!canEdit ? null : addingItem ? (
            <div style={{ marginTop: 10 }}>
              <NewItemForm
                projectId={projectId}
                parentId={item.id}
                defaultType="story"
                typeOptions={['story', 'bug']}
                onSave={({ title, type, priority, storyPoints }) => {
                  onAddItem(item.id, type, title, priority, storyPoints);
                  setAddingItem(false);
                }}
                onCancel={() => setAddingItem(false)}
              />
            </div>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setAddingItem(true); }}
              style={{
                marginTop: 10, padding: '5px 12px', borderRadius: 6,
                border: '1px dashed var(--color-border-emphasis)', background: 'transparent',
                color: 'var(--color-text-tertiary)', fontSize: 12, cursor: 'pointer',
              }}>
              + Add story / bug
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Decision queue ───────────────────────────────────────────────────────────

function DecisionQueue({ decisions }: { decisions: ProjectDecision[] }) {
  if (decisions.length === 0) {
    return (
      <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
        No decisions linked to this project yet.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {decisions.map((d) => {
        const decisionTone = DECISION_TONE[d.status] ?? 'warning';
        return (
          <div key={d.id} style={{
            background: 'var(--color-surface)', border: '1.5px solid var(--color-border)', borderRadius: 8,
            padding: '14px 16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
              <Chip tone={decisionTone} size="xs" className="uppercase font-bold shrink-0">
                {d.status}
              </Chip>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1 }}>{d.topic}</span>
              {d.requiredRole && (
                <Chip tone="purple" size="xs" className="shrink-0">
                  needs {d.requiredRole}
                </Chip>
              )}
            </div>
            {d.summary && (
              <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                {d.summary}
              </p>
            )}
            <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {d.workItemTitle && (
                <span>🔗 {d.workItemTitle}</span>
              )}
              {d.escalatedAt && (
                <span>Escalated {new Date(d.escalatedAt).toLocaleDateString()}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Swimlane board ───────────────────────────────────────────────────────────

const BOARD_STATUSES: WorkItemStatus[] = ['open', 'in_progress', 'in_review', 'done'];
const BOARD_STATUS_LABELS: Record<WorkItemStatus, string> = {
  open: 'Open', in_progress: 'In Progress', in_review: 'In Review',
  done: 'Done', cancelled: 'Cancelled',
};

function flattenByType(nodes: WorkItemTree[], types: WorkItemType[]): WorkItemTree[] {
  const acc: WorkItemTree[] = [];
  function walk(node: WorkItemTree) {
    if (types.includes(node.type)) acc.push(node);
    node.children.forEach(walk);
  }
  nodes.forEach(walk);
  return acc;
}

function BoardCard({
  item,
  run,
  onEstimate,
}: {
  item: WorkItemTree;
  run: BotRun | undefined;
  onEstimate: (item: WorkItemTree) => void;
}) {
  const priColor: Record<WorkItemPriority, string> = {
    critical: 'var(--color-danger)',
    high:     'var(--color-warning)',
    medium:   'var(--color-warning)',
    low:      'var(--color-text-tertiary)',
  };
  const isBug = item.type === 'bug';
  return (
    <div style={{
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderLeft: `3px solid ${priColor[item.priority]}`,
      borderRadius: 6,
      padding: '8px 10px',
      marginBottom: 6,
      cursor: 'default',
    }}>
      {/* Type badge + title — bugs carry the danger tone */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 6 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
          background: isBug ? 'var(--color-danger-bg)' : 'var(--color-info-bg)',
          color: isBug ? 'var(--color-danger)' : 'var(--color-primary)',
          textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0, marginTop: 1,
        }}>
          {item.type}
        </span>
        <span style={{
          fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)', lineHeight: 1.35,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {item.title}
        </span>
      </div>
      {/* Footer: assignee + points + marketplace state + PR */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {item.assigneeName && (
            <Avatar name={item.assigneeName} size={18} />
          )}
          {item.storyPoints && (
            <span style={{
              fontSize: 9.5, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
              background: 'var(--color-surface-hover)', color: 'var(--color-text-secondary)',
            }}>
              {item.storyPoints}pt
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <EstimateChip item={item} onEstimate={onEstimate} />
          <RunStateChips item={item} run={run} />
          {item.prStatus && (
            <span style={{
              fontSize: 9.5, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
              background: item.prStatus === 'merged' ? 'var(--color-success-bg)' : item.prStatus === 'open' ? 'var(--color-info-bg)' : 'var(--color-bg)',
              color: item.prStatus === 'merged' ? 'var(--color-success)' : item.prStatus === 'open' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
            }}>
              {item.prStatus === 'merged' ? '⎇ merged' : item.prStatus === 'open' ? '⎇ open' : item.prStatus}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function EpicSwimlane({
  epic,
  marketRuns,
  onEstimate,
}: {
  epic: WorkItemTree;
  marketRuns: Record<string, BotRun>;
  onEstimate: (item: WorkItemTree) => void;
}) {
  const stories = flattenByType([epic], ['story', 'bug']);
  const byStatus = new Map<WorkItemStatus, WorkItemTree[]>();
  BOARD_STATUSES.forEach(s => byStatus.set(s, []));
  stories.forEach(item => {
    const bucket = byStatus.get(item.status) ?? byStatus.get('open')!;
    bucket.push(item);
  });
  const hasAny = stories.length > 0;

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '160px repeat(4, 1fr)',
      borderBottom: '1px solid var(--color-border)',
    }}>
      {/* Epic label */}
      <div style={{
        padding: '12px 12px', borderRight: '1px solid var(--color-border)',
        background: 'var(--color-bg)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
      }}>
        <span style={{
          fontSize: 9, fontWeight: 700, color: 'var(--color-text-tertiary)', textTransform: 'uppercase',
          letterSpacing: '0.05em', marginBottom: 4,
        }}>Epic</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', lineHeight: 1.35 }}>
          {epic.title}
        </span>
        {epic.assigneeName && (
          <div style={{ marginTop: 6 }}><Avatar name={epic.assigneeName} size={16} /></div>
        )}
      </div>

      {/* Status columns */}
      {BOARD_STATUSES.map((status, ci) => {
        const items = byStatus.get(status) ?? [];
        return (
          <div key={status} style={{
            padding: '10px 8px',
            borderRight: ci < 3 ? '1px solid var(--color-border)' : 'none',
            minHeight: hasAny ? undefined : 52,
            // `done` column gets a faint cool-white tint to subtly distinguish completed swim cells
            background: status === 'done' ? '#fafffe' : 'var(--color-surface)',
          }}>
            {items.map(item => (
              <BoardCard key={item.id} item={item} run={marketRuns[item.id]} onEstimate={onEstimate} />
            ))}
            {items.length === 0 && (
              <div style={{
                height: 36, border: '1.5px dashed var(--color-border)', borderRadius: 6,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span style={{ fontSize: 10, color: 'var(--color-border)' }}>—</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BoardView({
  epics,
  marketRuns,
  onEstimate,
}: {
  epics: WorkItemTree[];
  marketRuns: Record<string, BotRun>;
  onEstimate: (item: WorkItemTree) => void;
}) {
  if (epics.length === 0) {
    return (
      <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
        No epics yet — create one to see the board.
      </div>
    );
  }
  return (
    <div style={{ overflowX: 'auto', borderRadius: 10, border: '1.5px solid var(--color-border)', background: 'var(--color-surface)' }}>
      {/* Column headers */}
      <div style={{
        display: 'grid', gridTemplateColumns: '160px repeat(4, 1fr)',
        background: 'var(--color-bg)', borderBottom: '1.5px solid var(--color-border)',
        position: 'sticky', top: 0, zIndex: 2,
      }}>
        <div style={{ padding: '8px 12px', borderRight: '1px solid var(--color-border)' }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Swimlane
          </span>
        </div>
        {BOARD_STATUSES.map((s, i) => {
          const count = epics.reduce((n, epic) =>
            n + flattenByType([epic], ['story', 'bug']).filter(it => it.status === s).length, 0);
          return (
            <div key={s} style={{
              padding: '8px 10px', borderRight: i < 3 ? '1px solid var(--color-border)' : 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {BOARD_STATUS_LABELS[s]}
              </span>
              {count > 0 && (
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 9999,
                  background: s === 'done' ? 'var(--color-success-bg)' : 'var(--color-surface-hover)',
                  color: s === 'done' ? 'var(--color-success)' : 'var(--color-text-secondary)',
                }}>
                  {count}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {/* Swimlane rows */}
      {epics.map(epic => (
        <EpicSwimlane key={epic.id} epic={epic} marketRuns={marketRuns} onEstimate={onEstimate} />
      ))}
    </div>
  );
}

// ─── Contributors table ───────────────────────────────────────────────────────

function ContributorsTable({
  contributors,
  projectId,
  onRole,
}: {
  contributors: ProjectDetail['contributors'];
  projectId: string;
  /** Optimistic apply / revert of one contributor's role. */
  onRole: (personId: string, role: string | null) => void;
}) {
  const navigate = useNavigate();
  if (contributors.length === 0) {
    return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>No contributors recorded.</div>;
  }
  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'var(--color-bg)', borderBottom: '1px solid var(--color-border)' }}>
            {['Name', 'Title', 'Role', 'Weight'].map((col) => (
              <th key={col} style={{
                padding: '10px 16px', textAlign: col === 'Weight' ? 'right' : 'left',
                fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)',
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {contributors.map((c, idx) => {
            // Reserved roles get chips — owner runs the initiative, SMEs
            // direct agents across the initiatives they're attached to. The
            // cell is a compact cycle control ('—' → sme → owner) that PATCHes
            // the role optimistically; a 403 reverts with a quiet toast.
            return (
            <tr key={c.personId} style={{
              borderBottom: idx < contributors.length - 1 ? '1px solid var(--color-border)' : 'none',
              cursor: 'pointer',
            }}
              onClick={() => navigate(`/iq/explore?focus=${encodeURIComponent(c.personId)}`)}
              onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-inset)'}
              onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.background = 'var(--color-surface)'}
            >
              <td style={{ padding: '11px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Avatar name={c.name} size={28} />
                  <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text-primary)' }}>{c.name}</span>
                </div>
              </td>
              <td style={{ padding: '11px 16px', fontSize: 13, color: 'var(--color-text-secondary)' }}>{c.title ?? '—'}</td>
              <td style={{ padding: '11px 16px', fontSize: 13, color: 'var(--color-text-secondary)' }}>
                <RoleCycleChip
                  projectId={projectId}
                  personId={c.personId}
                  role={c.role}
                  onRole={onRole}
                />
              </td>
              <td style={{ padding: '11px 16px', textAlign: 'right' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 60, height: 5, borderRadius: 3, background: 'var(--color-border)', overflow: 'hidden' }}>
                    <div style={{
                      width: `${Math.min(c.weight * 100, 100)}%`, height: '100%',
                      background: 'var(--color-primary)', borderRadius: 3,
                    }} />
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', minWidth: 36, textAlign: 'right' }}>
                    {(c.weight * 100).toFixed(0)}%
                  </span>
                </div>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Agent spend header stat ──────────────────────────────────────────────────
// One number with a clear provenance. The server-computed figure (the same one
// the Initiatives list shows) wins; the client-side sum of visible runs is the
// fallback, and it is only reported when the runs were actually visible. When
// neither holds, the stat says the spend is unknown rather than printing $0.00,
// which is the one thing it must never do — "$0.00 agent spend" on an
// initiative that has spent money is a budget statement that is simply false.

function AgentSpendStat({
  serverSpendUsd, serverPending, clientSpendUsd, clientBlind, clientPending,
}: {
  serverSpendUsd: number | null;
  serverPending: boolean;
  clientSpendUsd: number;
  clientBlind: boolean;
  clientPending: boolean;
}) {
  let value: string;
  let title: string;
  if (serverSpendUsd != null) {
    value = `$${serverSpendUsd.toFixed(2)}`;
    title = 'Every agent run attributed to this initiative, totalled by the server — the same figure the Initiatives list shows.';
  } else if (serverPending || clientPending) {
    value = '…';
    title = 'Loading agent spend.';
  } else if (clientBlind) {
    value = '—';
    title = 'Agent spend is unknown to this role: the bot roster needs the ManageDevbox authority, and the server has no rollup for this initiative. Unknown, not zero.';
  } else {
    value = `$${clientSpendUsd.toFixed(2)}`;
    title = 'Totalled from the agent runs visible to this session — the server reported no rollup for this initiative.';
  }

  return (
    <div style={{ textAlign: 'center' }} title={title}>
      <div style={{
        fontSize: 22, fontWeight: 800,
        color: value === '—' ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
      }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
        {value === '—' ? 'agent spend unknown' : 'agent spend'}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
// Mission control for an initiative: one owner, SMEs directing agents. The
// work is always front and center; agents, outcomes, codebases and the
// org-graph attribution live in the rail.

type WorkView = 'tree' | 'board';

function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [workView, setWorkView] = useState<WorkView>('tree');
  const [localItems, setLocalItems] = useState<WorkItemTree[] | null>(null);
  const { can: canDo, ready: capsReady } = useCapabilities();
  const canDispatch = capsReady && canDo('DispatchAgentRun');

  // Governance edits are optimistic: overrides sit on top of the fetched
  // project until the next reload; the editors revert them on PATCH failure.
  const [ownerOverride, setOwnerOverride] = useState<{ ownerId: string | null; ownerName: string | null } | null>(null);
  const [roleOverrides, setRoleOverrides] = useState<Record<string, string | null>>({});
  const handleRoleOverride = useCallback((personId: string, role: string | null) => {
    setRoleOverrides((prev) => ({ ...prev, [personId]: role }));
  }, []);

  const { data: project, isLoading: projLoading, error: projError } =
    useFetch<ProjectDetail>(id ? `/api/graph/projects/${encodeURIComponent(id)}` : '');

  const { data: rawTree, isLoading: workLoading } =
    useFetch<WorkItemTree[]>(id ? `/api/graph/projects/${encodeURIComponent(id)}/work` : '');

  const { data: decisions } =
    useFetch<ProjectDecision[]>(id ? `/api/graph/projects/${encodeURIComponent(id)}/decisions` : '');

  // The codebases that deliver this initiative — the Build side of the join.
  // The endpoint is hr-admin-gated (ManageDevbox); for anyone else the fetch
  // 403s and the strip simply doesn't render.
  const { data: codebasesData } = useFetch<{ projects: Array<{
    id: string; repoFullName: string; orgProjectId: string | null;
  }> }>('/api/agent-projects', 60_000);
  const codebases = (codebasesData?.projects ?? []).filter((p) => p.orgProjectId === id);

  // Bot-less marketplace runs for this initiative — polled while the page is
  // open so "agent working" chips appear/disappear live.
  const { data: marketData } = useFetch<{ runs: BotRun[] }>(
    id ? `/api/bots/marketplace-runs?orgProjectId=${encodeURIComponent(id)}` : null,
    10_000,
  );
  const marketplaceRuns = marketData?.runs ?? [];

  // Bots targeting this initiative + their runs merged with the marketplace
  // runs — feeds the rail's Agents/Outcomes cards.
  const agentActivity = useInitiativeAgentActivity(id, codebases, marketplaceRuns);

  // Agent spend, server-computed. The header used to sum agentActivity.runs
  // client-side, but both of that hook's inputs (/api/bots, /api/agent-projects)
  // are ManageDevbox-gated while /iq/projects has no role gate — so an SME or
  // member reaching this page got 403s, summed nothing, and read "$0.00 agent
  // spend" for an initiative that GET /api/graph/projects reports as $4.10 one
  // click away. That list endpoint is tenant-gated only and every role that can
  // open this page can read it, so take the number from there and let the
  // Initiatives list and this header agree by construction.
  const { data: projectList, isLoading: projectListLoading } =
    useFetch<Array<{ id: string; agentSpendUsd: number | null }>>('/api/graph/projects', 60_000);
  const serverSpendUsd = (projectList ?? []).find((p) => p.id === id)?.agentSpendUsd ?? null;

  // The run that speaks for each work item: a running one wins, else newest.
  const marketRuns: Record<string, BotRun> = {};
  for (const r of marketplaceRuns) {
    if (!r.workItemId) continue;
    const prev = marketRuns[r.workItemId];
    if (!prev) { marketRuns[r.workItemId] = r; continue; }
    if (prev.status === 'running' && r.status !== 'running') continue;
    if (r.status === 'running' && prev.status !== 'running') { marketRuns[r.workItemId] = r; continue; }
    if (parseTs(r.startedAt) > parseTs(prev.startedAt)) marketRuns[r.workItemId] = r;
  }

  const workTree = localItems ?? rawTree ?? [];

  // Status toggle — optimistic, then confirmed. A failure puts the row back
  // where it was and says why, rather than leaving a tick the server refused.
  const handleStatusToggle = useCallback((itemId: string, current: WorkItemStatus) => {
    const newStatus: WorkItemStatus = current === 'done' ? 'open' : 'done';
    const setStatus = (want: WorkItemStatus) => (nodes: WorkItemTree[]) =>
      mapTree(nodes, (n) => (n.id === itemId ? { ...n, status: want } : n));

    setLocalItems(setStatus(newStatus)(localItems ?? rawTree ?? []));

    // An item this page created but the server never acknowledged has a
    // client-side id; PATCHing it can only 404, and the row would silently
    // stay ticked until the next reload dropped it.
    if (isPendingId(itemId)) {
      setLocalItems((prev) => setStatus(current)(prev ?? rawTree ?? []));
      toastError(null, 'Not saved', 'This item has not been created on the server yet — reload and try again.');
      return;
    }

    void (async () => {
      try {
        await sendJson(`/api/graph/work-items/${encodeURIComponent(itemId)}`, 'PATCH', { status: newStatus });
      } catch (err) {
        setLocalItems((prev) => setStatus(current)(prev ?? rawTree ?? []));
        surfaceWriteError(err, 'Updating this item');
      }
    })();
  }, [localItems, rawTree]);

  // Add item optimistically
  const handleAddItem = useCallback((parentId: string, type: WorkItemType, title: string, priority: WorkItemPriority, storyPoints: number | null) => {
    const newItem: WorkItemTree = {
      id: `wi-new-${Date.now()}`,
      projectId: id ?? '',
      projectName: project?.name ?? '',
      parentId,
      type,
      title,
      description: null,
      status: 'open',
      priority,
      assigneeId: null,
      assigneeName: null,
      assigneeDept: null,
      labels: [],
      storyPoints,
      prUrl: null,
      prStatus: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      childCount: 0,
      childDoneCount: 0,
      children: [],
    };

    function insertInto(nodes: WorkItemTree[]): WorkItemTree[] {
      return nodes.map((n) => {
        if (n.id === parentId) {
          return { ...n, children: [...n.children, newItem] };
        }
        return { ...n, children: insertInto(n.children) };
      });
    }
    setLocalItems(insertInto(localItems ?? rawTree ?? []));

    // Reconcile the placeholder with the row the server actually created —
    // without this the item keeps its `wi-new-…` id forever, so the first tick
    // on it PATCHes an id no row has and the change vanishes on reload.
    void (async () => {
      try {
        const created = await sendJson<Partial<WorkItem> & { id?: string }>(
          '/api/graph/work-items', 'POST',
          { projectId: id, parentId, type, title, priority, storyPoints },
        );
        if (!created.id) throw new HttpError(502, 'the server did not return the created item');
        setLocalItems((prev) => mapTree(prev ?? rawTree ?? [], (n) =>
          n.id === newItem.id ? { ...n, ...created, children: n.children } : n));
      } catch (err) {
        setLocalItems((prev) => dropFromTree(prev ?? rawTree ?? [], newItem.id));
        surfaceWriteError(err, `Adding this ${type}`);
      }
    })();
  }, [id, project, localItems, rawTree]);

  const [addingEpic, setAddingEpic] = useState(false);

  const handleAddEpic = useCallback(({ title, type, priority, storyPoints }: { title: string; type: WorkItemType; priority: WorkItemPriority; storyPoints: number | null }) => {
    const newEpic: WorkItemTree = {
      id: `wi-new-epic-${Date.now()}`,
      projectId: id ?? '',
      projectName: project?.name ?? '',
      parentId: null,
      type: type,
      title,
      description: null,
      status: 'open',
      priority,
      assigneeId: null, assigneeName: null, assigneeDept: null,
      labels: [], storyPoints, prUrl: null, prStatus: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null, childCount: 0, childDoneCount: 0,
      children: [],
    };
    setLocalItems([...(localItems ?? rawTree ?? []), newEpic]);
    setAddingEpic(false);
    void (async () => {
      try {
        const created = await sendJson<Partial<WorkItem> & { id?: string }>(
          '/api/graph/work-items', 'POST',
          { projectId: id, parentId: null, type, title, priority, storyPoints },
        );
        if (!created.id) throw new HttpError(502, 'the server did not return the created item');
        setLocalItems((prev) => mapTree(prev ?? rawTree ?? [], (n) =>
          n.id === newEpic.id ? { ...n, ...created, children: n.children } : n));
      } catch (err) {
        setLocalItems((prev) => dropFromTree(prev ?? rawTree ?? [], newEpic.id));
        surfaceWriteError(err, `Adding this ${type}`);
      }
    })();
  }, [id, project, localItems, rawTree]);

  // Marketplace: the item being estimated, and the optimistic flip on 202.
  const [estimateItem, setEstimateItem] = useState<WorkItemTree | null>(null);

  const handleDispatched = useCallback((workItemId: string, _run: BotRun) => {
    function patchTree(nodes: WorkItemTree[]): WorkItemTree[] {
      return nodes.map((n) => ({
        ...n,
        status: n.id === workItemId ? ('in_progress' as WorkItemStatus) : n.status,
        children: patchTree(n.children),
      }));
    }
    setLocalItems(patchTree(localItems ?? rawTree ?? []));
  }, [localItems, rawTree]);

  if (projLoading) {
    return (
      <PageSection title="Project">
        <div style={{ color: 'var(--color-text-tertiary)' }}>Loading project…</div>
      </PageSection>
    );
  }
  if (projError) {
    return (
      <PageSection title="Project">
        <Link to="/iq/projects" style={{ fontSize: 13, color: 'var(--color-text-secondary)', textDecoration: 'none' }}>
          ← Back to Projects
        </Link>
        <div style={{ marginTop: 12, color: 'var(--color-danger)' }}>Failed to load: {projError}</div>
      </PageSection>
    );
  }
  if (!project) {
    return (
      <PageSection title="Project">
        <Link to="/iq/projects" style={{ fontSize: 13, color: 'var(--color-text-secondary)', textDecoration: 'none' }}>← Back to Projects</Link>
        <div style={{ marginTop: 12, color: 'var(--color-text-tertiary)' }}>Project not found.</div>
      </PageSection>
    );
  }

  const projColors = PROJECT_STATUS_COLORS[project.status ?? ''] ?? PROJECT_STATUS_COLORS['planning']!;
  const escalatedCount = (decisions ?? []).filter((d) => d.status === 'escalated').length;
  const openDecisionCount = (decisions ?? []).filter((d) => d.status === 'open' || d.status === 'escalated').length;
  // Governance, with optimistic overrides applied on top of the fetch.
  const contributors = project.contributors.map((c) =>
    c.personId in roleOverrides ? { ...c, role: roleOverrides[c.personId] ?? null } : c,
  );
  const ownerId = ownerOverride ? ownerOverride.ownerId : project.ownerId ?? null;
  const ownerName = ownerOverride ? ownerOverride.ownerName : project.ownerName ?? null;
  // Cross-initiative SMEs — the people directing agents here.
  const smes = contributors.filter((c) => (c.role ?? '').toLowerCase() === 'sme');

  // Aggregate point stats from work tree
  let totalDone = 0, totalPts = 0;
  function sumPoints(nodes: WorkItemTree[]) {
    for (const n of nodes) {
      if ((n.type === 'story' || n.type === 'bug') && n.storyPoints) {
        totalPts += n.storyPoints;
        if (n.status === 'done') totalDone += n.storyPoints;
      }
      sumPoints(n.children);
    }
  }
  sumPoints(workTree);
  const overallPct = totalPts > 0 ? Math.round((totalDone / totalPts) * 100) : 0;

  return (
    <div style={{ padding: '0 0 60px', maxWidth: 1240 }}>
      {/* Back link */}
      <Link to="/iq/projects" style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 13, color: 'var(--color-text-secondary)', textDecoration: 'none', marginBottom: 20,
      }}>
        ← Projects
      </Link>

      {/* Header card */}
      <div style={{
        background: 'var(--color-surface)',
        border: `1.5px solid var(--color-border)`,
        borderTop: `4px solid ${projColors.accent}`,
        borderRadius: 10,
        padding: '20px 24px',
        marginBottom: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: 'var(--color-text-primary)' }}>{project.name}</h1>
              <span style={{
                padding: '2px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 700,
                background: projColors.bg, color: projColors.text,
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                {project.status ?? 'unknown'}
              </span>
            </div>
            {/* Identity line — one owner runs the initiative, SMEs direct agents.
                The edit affordance only renders for sessions holding
                DispatchAgentRun (OwnerEditor gates itself). */}
            {(ownerName || smes.length > 0 || contributors.length > 0) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12, color: 'var(--color-text-secondary)', flexWrap: 'wrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {ownerName && <Avatar name={ownerName} size={18} />}
                  <span>
                    Run by{' '}
                    {ownerName && ownerId ? (
                      <Link
                        to={`/iq/explore?focus=${encodeURIComponent(ownerId)}`}
                        style={{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600 }}
                      >
                        {ownerName}
                      </Link>
                    ) : ownerName ? (
                      <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{ownerName}</span>
                    ) : (
                      <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>
                    )}
                  </span>
                  <OwnerEditor
                    projectId={id ?? ''}
                    contributors={contributors}
                    ownerId={ownerId}
                    ownerName={ownerName}
                    onOwner={(oid, oname) => setOwnerOverride({ ownerId: oid, ownerName: oname })}
                    onRole={handleRoleOverride}
                  />
                </span>
                {smes.map((s) => (
                  <Link
                    key={s.personId}
                    to={`/iq/explore?focus=${encodeURIComponent(s.personId)}`}
                    className="no-underline"
                    title={`${s.name} — SME directing agents on this initiative`}
                  >
                    <Chip tone="info" size="xs">SME · {s.name}</Chip>
                  </Link>
                ))}
              </div>
            )}
            {project.description && (
              <p style={{ margin: 0, fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                {project.description}
              </p>
            )}
          </div>

          {/* Stats */}
          <div style={{ display: 'flex', gap: 24, flexShrink: 0, flexWrap: 'wrap' }}>
            {totalPts > 0 && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: projColors.accent }}>{overallPct}%</div>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{totalDone}/{totalPts} pts</div>
              </div>
            )}
            <AgentSpendStat
              serverSpendUsd={serverSpendUsd}
              serverPending={projectListLoading}
              clientSpendUsd={agentActivity.spendUsd}
              clientBlind={agentActivity.botsError != null}
              clientPending={agentActivity.botsLoading}
            />
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: escalatedCount > 0 ? 'var(--color-danger)' : 'var(--color-text-primary)' }}>
                {openDecisionCount}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>open decisions</div>
            </div>
            {project.githubUrl && (
              <a href={project.githubUrl} target="_blank" rel="noreferrer"
                style={{ display: 'flex', alignItems: 'center', gap: 4,
                  fontSize: 12, color: 'var(--color-primary)', textDecoration: 'none', alignSelf: 'center' }}>
                ↗ GitHub
              </a>
            )}
          </div>
        </div>

        {/* Overall progress bar */}
        {totalPts > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ height: 6, borderRadius: 9999, background: 'var(--color-border)', overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 9999,
                background: overallPct >= 80 ? 'var(--color-success)' : overallPct >= 40 ? 'var(--color-primary)' : 'var(--color-warning)',
                width: `${overallPct}%`, transition: 'width 0.4s',
              }} />
            </div>
          </div>
        )}
      </div>

      {/* ── Two-column body: the work (main) + mission-control rail ── */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* ── MAIN — the work, always visible ── */}
        <div style={{ flex: '1 1 520px', minWidth: 0 }}>
          {/* Tree / Board toggle */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              {workTree.length > 0 ? `${workTree.length} epic${workTree.length !== 1 ? 's' : ''}` : ''}
            </div>
            <div style={{ display: 'flex', border: '1.5px solid var(--color-border)', borderRadius: 7, overflow: 'hidden' }}>
              {([['tree', '≡ List'], ['board', '⊞ Board']] as [WorkView, string][]).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setWorkView(mode)}
                  style={{
                    padding: '5px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500,
                    background: workView === mode ? 'var(--color-primary-soft)' : 'var(--color-surface)',
                    color: workView === mode ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                    borderRight: mode === 'tree' ? '1.5px solid var(--color-border)' : 'none',
                    fontFamily: 'inherit',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {workLoading && (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, marginBottom: 16 }}>Loading work items…</div>
          )}

          {workView === 'board' ? (
            <BoardView epics={workTree} marketRuns={marketRuns} onEstimate={setEstimateItem} />
          ) : (
            <>
              {!workLoading && workTree.length === 0 && !addingEpic && (
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
                  {canDispatch
                    ? 'No work yet. Create an epic, add sized stories and bugs, and dispatch them to agents from here.'
                    : 'No work yet.'}
                </div>
              )}
              {workTree.map((epic) => (
                <EpicCard
                  key={epic.id}
                  item={epic}
                  onStatusToggle={handleStatusToggle}
                  projectId={id ?? ''}
                  onAddItem={handleAddItem}
                  marketRuns={marketRuns}
                  onEstimate={setEstimateItem}
                />
              ))}
              {!canDispatch ? null : addingEpic ? (
                <NewItemForm
                  projectId={id ?? ''}
                  parentId={null}
                  defaultType="epic"
                  onSave={handleAddEpic}
                  onCancel={() => setAddingEpic(false)}
                />
              ) : (
                <button
                  onClick={() => setAddingEpic(true)}
                  style={{
                    marginTop: 8, padding: '8px 18px', borderRadius: 8,
                    border: '1.5px dashed var(--color-border-emphasis)', background: 'transparent',
                    color: 'var(--color-text-tertiary)', fontSize: 13, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                  ⚡ New epic
                </button>
              )}
            </>
          )}

          {/* Decisions — reachable, no longer a headline */}
          <div style={{ marginTop: 24 }}>
            <CollapsibleSection
              title="Decisions"
              defaultOpen={false}
              badge={escalatedCount > 0
                ? <Chip tone="danger" size="xs">{escalatedCount} escalated</Chip>
                : (decisions ?? []).length > 0
                  ? <Chip tone="neutral" size="xs" mono>{(decisions ?? []).length}</Chip>
                  : undefined}
            >
              <DecisionQueue decisions={decisions ?? []} />
            </CollapsibleSection>
          </div>
        </div>

        {/* ── RIGHT RAIL — agents, outcomes, codebases, attribution ── */}
        <div style={{
          flex: '0 1 300px', width: 300, minWidth: 260,
          position: 'sticky', top: 16, alignSelf: 'flex-start',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          <AgentsRailCard activity={agentActivity} />
          <OutcomesRailCard activity={agentActivity} />

          {/* The code that delivers this initiative — the other half of the
              repo ↔ initiative join. Each chip lands on the codebase's console. */}
          {codebases.length > 0 && (
            <Card padding="none" className="overflow-hidden">
              <div className="px-3 py-2.5 border-b border-border">
                <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">DELIVERED BY</span>
              </div>
              <div style={{ padding: '10px 12px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {codebases.map((cb) => (
                  <Link
                    key={cb.id}
                    to={`/admin/projects?project=${cb.id}`}
                    title="Open this codebase — runs, changes, workspace"
                    style={{
                      fontSize: 12, fontFamily: 'monospace', textDecoration: 'none',
                      color: 'var(--color-primary)', background: 'var(--color-info-bg)',
                      padding: '2px 10px', borderRadius: 9999,
                    }}
                  >
                    {cb.repoFullName}
                  </Link>
                ))}
              </div>
            </Card>
          )}

          {/* Org-graph attribution — reachable, not a headline */}
          <CollapsibleSection
            title="Contributors"
            defaultOpen={false}
            badge={contributors.length > 0
              ? <Chip tone="neutral" size="xs" mono>{contributors.length}</Chip>
              : undefined}
          >
            <ContributorsTable
              contributors={contributors}
              projectId={id ?? ''}
              onRole={handleRoleOverride}
            />
          </CollapsibleSection>
        </div>
      </div>

      {/* Marketplace: estimate → authorize drawer */}
      <EstimateDrawer
        open={estimateItem != null}
        onClose={() => setEstimateItem(null)}
        item={estimateItem}
        codebases={codebases.map((cb) => ({ id: cb.id, repoFullName: cb.repoFullName }))}
        onDispatched={handleDispatched}
      />
    </div>
  );
}

export default ProjectDetailPage;
