import { useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router';
import { useFetch } from '../hooks/useFetch';

// ─── Types ────────────────────────────────────────────────────────────────────

type WorkItemType   = 'epic' | 'feature' | 'story' | 'task';
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

// Status indicator colors use semantic tokens from app.css.
// `in_review` and `merged` keep their purple identity (not in token palette
// for purple-tinted "review" state) — kept as inline hex by design.
const STATUS_STYLES: Record<WorkItemStatus, { bg: string; text: string; dot: string }> = {
  open:        { bg: 'var(--color-bg)',         text: 'var(--color-text-secondary)', dot: 'var(--color-text-tertiary)' },
  in_progress: { bg: 'var(--color-info-bg)',    text: 'var(--color-primary)',        dot: 'var(--color-info)' },
  in_review:   { bg: '#fdf4ff',                 text: '#7e22ce',                     dot: '#a855f7' },
  done:        { bg: 'var(--color-success-bg)', text: 'var(--color-success)',        dot: 'var(--color-success)' },
  cancelled:   { bg: 'var(--color-danger-bg)',  text: 'var(--color-danger)',         dot: 'var(--color-danger)' },
};

const PRIORITY_STYLES: Record<WorkItemPriority, { color: string; label: string }> = {
  critical: { color: 'var(--color-danger)',         label: '🔴 Critical' },
  high:     { color: 'var(--color-warning)',        label: '🟠 High' },
  medium:   { color: 'var(--color-warning)',        label: '🟡 Medium' },
  low:      { color: 'var(--color-text-secondary)', label: '⚪ Low' },
};

// `merged` purple identity is intentional — distinguishes merged PRs from open
// (success) and closed (danger); no purple token exists in app.css yet.
const PR_STYLES: Record<PrStatus, { bg: string; text: string; icon: string }> = {
  merged: { bg: '#f5f3ff',                  text: '#7c3aed',                     icon: '⬡' },
  open:   { bg: 'var(--color-success-bg)',  text: 'var(--color-success)',        icon: '⊙' },
  draft:  { bg: 'var(--color-bg)',          text: 'var(--color-text-secondary)', icon: '⊘' },
  closed: { bg: 'var(--color-danger-bg)',   text: 'var(--color-danger)',         icon: '✕' },
};

const DECISION_STATUS: Record<string, { bg: string; text: string }> = {
  escalated: { bg: 'var(--color-danger-bg)',  text: 'var(--color-danger)' },
  open:      { bg: 'var(--color-warning-bg)', text: 'var(--color-warning)' },
  resolved:  { bg: 'var(--color-success-bg)', text: 'var(--color-success)' },
  rejected:  { bg: 'var(--color-bg)',         text: 'var(--color-text-secondary)' },
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
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.open;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '1px 8px', borderRadius: 9999,
      fontSize: 11, fontWeight: 600,
      background: s.bg, color: s.text,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.dot }} />
      {status.replace('_', ' ')}
    </span>
  );
}

function PrBadge({ prStatus, prUrl }: { prStatus: PrStatus; prUrl: string | null }) {
  const st = PR_STYLES[prStatus];
  const el = (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      padding: '1px 7px', borderRadius: 4,
      fontSize: 11, fontWeight: 600,
      background: st.bg, color: st.text,
    }}>
      {st.icon} PR · {prStatus}
    </span>
  );
  if (prUrl) {
    return (
      <a href={prUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}
        onClick={(e) => e.stopPropagation()}>
        {el}
      </a>
    );
  }
  return el;
}

function countPoints(item: WorkItemTree): { done: number; total: number } {
  let done = 0, total = 0;
  function walk(node: WorkItemTree) {
    if (node.type === 'story' || node.type === 'task') {
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

// ─── New Work Item inline form ────────────────────────────────────────────────

interface NewItemFormProps {
  projectId: string;
  parentId: string | null;
  defaultType: WorkItemType;
  onSave: (item: { title: string; type: WorkItemType; priority: WorkItemPriority }) => void;
  onCancel: () => void;
}

function NewItemForm({ projectId: _projectId, parentId: _parentId, defaultType, onSave, onCancel }: NewItemFormProps) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<WorkItemType>(defaultType);
  const [priority, setPriority] = useState<WorkItemPriority>('medium');

  const TYPES: WorkItemType[] = ['epic', 'feature', 'story', 'task'];
  const PRIORITIES: WorkItemPriority[] = ['critical', 'high', 'medium', 'low'];

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
          if (e.key === 'Enter' && title.trim()) onSave({ title: title.trim(), type, priority });
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
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={onCancel} style={{
            padding: '4px 12px', borderRadius: 6, border: '1px solid var(--color-border)',
            background: 'var(--color-surface)', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer',
          }}>Cancel</button>
          <button
            disabled={!title.trim()}
            onClick={() => title.trim() && onSave({ title: title.trim(), type, priority })}
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

// ─── Task row ─────────────────────────────────────────────────────────────────

function TaskRow({ item, onStatusToggle }: { item: WorkItemTree; onStatusToggle: (id: string, current: WorkItemStatus) => void }) {
  const isDone = item.status === 'done';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '6px 12px',
      borderRadius: 6,
      background: isDone ? 'var(--color-bg)' : 'var(--color-surface)',
      opacity: isDone ? 0.7 : 1,
    }}>
      <input
        type="checkbox"
        checked={isDone}
        onChange={() => onStatusToggle(item.id, item.status)}
        style={{ cursor: 'pointer', accentColor: 'var(--color-primary)', width: 15, height: 15, flexShrink: 0 }}
      />
      <span style={{ flex: 1, fontSize: 13, color: isDone ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
        textDecoration: isDone ? 'line-through' : 'none' }}>
        {item.title}
      </span>
      {item.assigneeName && (
        <Avatar name={item.assigneeName} size={20} />
      )}
      <StatusChip status={item.status} />
    </div>
  );
}

// ─── Story row ────────────────────────────────────────────────────────────────

function StoryRow({
  item,
  onStatusToggle,
  depth = 0,
}: {
  item: WorkItemTree;
  onStatusToggle: (id: string, current: WorkItemStatus) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasTasks = item.children.length > 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => hasTasks && setExpanded((v) => !v)}
        aria-expanded={hasTasks ? expanded : undefined}
        aria-controls={hasTasks ? `detail-${item.id}` : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          width: '100%', textAlign: 'left',
          padding: `7px ${14 + depth * 12}px`,
          borderRadius: 6,
          cursor: hasTasks ? 'pointer' : 'default',
          background: item.status === 'done' ? 'var(--color-bg)' : 'var(--color-surface)',
          transition: 'background 0.1s',
          border: 'none',
        }}
        onMouseEnter={(e) => { if (item.status !== 'done') (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-panel)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = item.status === 'done' ? 'var(--color-bg)' : 'var(--color-surface)'; }}
      >
        {/* Expand chevron for tasks */}
        <span aria-hidden="true" style={{ width: 14, flexShrink: 0, color: 'var(--color-text-tertiary)', fontSize: 10 }}>
          {hasTasks ? (expanded ? '▾' : '▸') : ''}
        </span>

        {/* Story number / icon — soft indigo identity for story rows (data-viz, leave) */}
        <span aria-hidden="true" style={{ fontSize: 12, color: '#a5b4fc', fontFamily: 'monospace', flexShrink: 0 }}>■</span>

        {/* Title */}
        <span style={{
          flex: 1, fontSize: 13, fontWeight: 500,
          color: item.status === 'done' ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
          textDecoration: item.status === 'done' ? 'line-through' : 'none',
        }}>
          {item.title}
        </span>

        {/* Labels */}
        {item.labels.slice(0, 2).map((l) => (
          <span key={l} style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3,
            background: 'var(--color-surface-hover)', color: 'var(--color-text-secondary)' }}>{l}</span>
        ))}

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
      </button>

      {/* Tasks */}
      {expanded && hasTasks && (
        <div id={`detail-${item.id}`} style={{ marginLeft: 28, borderLeft: '2px solid var(--color-border)', paddingLeft: 8, marginTop: 2, marginBottom: 4 }}>
          {item.children.map((task) => (
            <TaskRow key={task.id} item={task} onStatusToggle={onStatusToggle} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Feature section ──────────────────────────────────────────────────────────

function FeatureSection({
  item,
  onStatusToggle,
  projectId,
  onAddItem,
}: {
  item: WorkItemTree;
  onStatusToggle: (id: string, current: WorkItemStatus) => void;
  projectId: string;
  onAddItem: (parentId: string, type: WorkItemType, title: string, priority: WorkItemPriority) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [addingStory, setAddingStory] = useState(false);
  const stories = item.status !== 'done' ? item.children : item.children;
  const storyStats = countStories(item);

  return (
    <div style={{ marginBottom: 6 }}>
      {/* Feature header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={`detail-${item.id}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          width: '100%', textAlign: 'left',
          padding: '8px 10px', borderRadius: 8,
          background: 'var(--color-surface-panel)', cursor: 'pointer',
          border: '1px solid var(--color-border)',
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 10, color: 'var(--color-text-tertiary)', width: 14 }}>{expanded ? '▾' : '▸'}</span>
        {/* Feature glyph — soft indigo identity (data-viz, leave) */}
        <span aria-hidden="true" style={{ fontSize: 12, color: '#818cf8', fontFamily: 'monospace', flexShrink: 0 }}>◈</span>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{item.title}</span>
        {storyStats.total > 0 && (
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {storyStats.done}/{storyStats.total} stories
          </span>
        )}
        {item.prStatus && <PrBadge prStatus={item.prStatus} prUrl={item.prUrl} />}
        {item.assigneeName && <Avatar name={item.assigneeName} size={20} />}
        <StatusChip status={item.status} />
      </button>

      {expanded && (
        <div id={`detail-${item.id}`} style={{ paddingLeft: 20, paddingTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {stories.map((story) => (
            <StoryRow key={story.id} item={story} onStatusToggle={onStatusToggle} />
          ))}
          {stories.length === 0 && (
            <div style={{ padding: '6px 14px', fontSize: 12, color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
              No stories yet
            </div>
          )}
          {addingStory ? (
            <NewItemForm
              projectId={projectId}
              parentId={item.id}
              defaultType="story"
              onSave={({ title, type, priority }) => {
                onAddItem(item.id, type, title, priority);
                setAddingStory(false);
              }}
              onCancel={() => setAddingStory(false)}
            />
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setAddingStory(true); }}
              style={{
                padding: '4px 10px', borderRadius: 5, border: '1px dashed var(--color-border-emphasis)',
                background: 'transparent', color: 'var(--color-text-tertiary)', fontSize: 12, cursor: 'pointer',
                textAlign: 'left', marginTop: 2,
              }}>
              + Add story
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Epic card ────────────────────────────────────────────────────────────────

function EpicCard({
  item,
  onStatusToggle,
  projectId,
  onAddItem,
}: {
  item: WorkItemTree;
  onStatusToggle: (id: string, current: WorkItemStatus) => void;
  projectId: string;
  onAddItem: (parentId: string, type: WorkItemType, title: string, priority: WorkItemPriority) => void;
}) {
  const [expanded, setExpanded] = useState(item.status !== 'done');
  const [addingFeature, setAddingFeature] = useState(false);
  const pts = countPoints(item);
  const stories = countStories(item);
  const pct = pts.total > 0 ? Math.round((pts.done / pts.total) * 100) : 0;
  const pStyle = PRIORITY_STYLES[item.priority] ?? PRIORITY_STYLES.medium;

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
        <span style={{ fontSize: 11, color: pStyle.color, fontWeight: 600, flexShrink: 0 }}>
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

      {/* Epic body */}
      {expanded && (
        <div id={`detail-${item.id}`} style={{ padding: '12px 16px', background: 'var(--color-surface-inset)' }}>
          {item.description && (
            <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
              {item.description}
            </p>
          )}

          {/* Features */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {item.children.map((feature) => (
              <FeatureSection
                key={feature.id}
                item={feature}
                onStatusToggle={onStatusToggle}
                projectId={projectId}
                onAddItem={onAddItem}
              />
            ))}
          </div>

          {/* Add feature */}
          {addingFeature ? (
            <div style={{ marginTop: 10 }}>
              <NewItemForm
                projectId={projectId}
                parentId={item.id}
                defaultType="feature"
                onSave={({ title, type, priority }) => {
                  onAddItem(item.id, type, title, priority);
                  setAddingFeature(false);
                }}
                onCancel={() => setAddingFeature(false)}
              />
            </div>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setAddingFeature(true); }}
              style={{
                marginTop: 10, padding: '5px 12px', borderRadius: 6,
                border: '1px dashed var(--color-border-emphasis)', background: 'transparent',
                color: 'var(--color-text-tertiary)', fontSize: 12, cursor: 'pointer',
              }}>
              + Add feature
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
        const ds = DECISION_STATUS[d.status] ?? DECISION_STATUS.open;
        return (
          <div key={d.id} style={{
            background: 'var(--color-surface)', border: '1.5px solid var(--color-border)', borderRadius: 8,
            padding: '14px 16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
              <span style={{
                padding: '2px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 700,
                background: ds.bg, color: ds.text, flexShrink: 0, textTransform: 'uppercase',
              }}>
                {d.status}
              </span>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1 }}>{d.topic}</span>
              {d.requiredRole && (
                <span style={{
                  padding: '2px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 600,
                  // purple "needs role" badge — distinct from status colors (kept as raw hex by design)
                  background: '#f5f3ff', color: '#5b21b6', flexShrink: 0,
                }}>
                  needs {d.requiredRole}
                </span>
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

function BoardCard({ item }: { item: WorkItemTree }) {
  const priColor: Record<WorkItemPriority, string> = {
    critical: 'var(--color-danger)',
    high:     'var(--color-warning)',
    medium:   'var(--color-warning)',
    low:      'var(--color-text-tertiary)',
  };
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
      {/* Type badge + title */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 6 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
          background: item.type === 'story' ? 'var(--color-info-bg)' : 'var(--color-success-bg)',
          color: item.type === 'story' ? 'var(--color-primary)' : 'var(--color-success)',
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
      {/* Footer: assignee + points + PR */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
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
  );
}

function EpicSwimlane({ epic }: { epic: WorkItemTree }) {
  const stories = flattenByType([epic], ['story', 'task']);
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
            {items.map(item => <BoardCard key={item.id} item={item} />)}
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

function BoardView({ epics }: { epics: WorkItemTree[] }) {
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
            n + flattenByType([epic], ['story', 'task']).filter(it => it.status === s).length, 0);
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
      {epics.map(epic => <EpicSwimlane key={epic.id} epic={epic} />)}
    </div>
  );
}

// ─── Contributors table ───────────────────────────────────────────────────────

function ContributorsTable({ contributors }: { contributors: ProjectDetail['contributors'] }) {
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
          {contributors.map((c, idx) => (
            <tr key={c.personId} style={{
              borderBottom: idx < contributors.length - 1 ? '1px solid var(--color-border)' : 'none',
              cursor: 'pointer',
            }}
              onClick={() => navigate(`/iq/explore?person=${encodeURIComponent(c.name)}`)}
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
              <td style={{ padding: '11px 16px', fontSize: 13, color: 'var(--color-text-secondary)' }}>{c.role ?? '—'}</td>
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
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type Tab = 'work' | 'decisions' | 'contributors';
type WorkView = 'tree' | 'board';

function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('work');
  const [workView, setWorkView] = useState<WorkView>('tree');
  const [localItems, setLocalItems] = useState<WorkItemTree[] | null>(null);

  const { data: project, isLoading: projLoading, error: projError } =
    useFetch<ProjectDetail>(id ? `/api/graph/projects/${encodeURIComponent(id)}` : '');

  const { data: rawTree, isLoading: workLoading } =
    useFetch<WorkItemTree[]>(id ? `/api/graph/projects/${encodeURIComponent(id)}/work` : '');

  const { data: decisions } =
    useFetch<ProjectDecision[]>(id ? `/api/graph/projects/${encodeURIComponent(id)}/decisions` : '');

  const workTree = localItems ?? rawTree ?? [];

  // Optimistic status toggle
  const handleStatusToggle = useCallback((itemId: string, current: WorkItemStatus) => {
    const newStatus: WorkItemStatus = current === 'done' ? 'open' : 'done';
    // Optimistic update
    function patchTree(nodes: WorkItemTree[]): WorkItemTree[] {
      return nodes.map((n) => ({
        ...n,
        status: n.id === itemId ? newStatus : n.status,
        children: patchTree(n.children),
      }));
    }
    setLocalItems(patchTree(localItems ?? rawTree ?? []));
    // Fire-and-forget to API
    fetch(`/api/graph/work-items/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    }).catch(() => {/* silent — mock mode */});
  }, [localItems, rawTree]);

  // Add item optimistically
  const handleAddItem = useCallback((parentId: string, type: WorkItemType, title: string, priority: WorkItemPriority) => {
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
      storyPoints: null,
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

    // Fire-and-forget
    fetch('/api/graph/work-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: id, parentId, type, title, priority }),
    }).catch(() => {});
  }, [id, project, localItems, rawTree]);

  const [addingEpic, setAddingEpic] = useState(false);

  const handleAddEpic = useCallback(({ title, type, priority }: { title: string; type: WorkItemType; priority: WorkItemPriority }) => {
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
      labels: [], storyPoints: null, prUrl: null, prStatus: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null, childCount: 0, childDoneCount: 0,
      children: [],
    };
    setLocalItems([...(localItems ?? rawTree ?? []), newEpic]);
    setAddingEpic(false);
    fetch('/api/graph/work-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: id, parentId: null, type: 'epic', title, priority }),
    }).catch(() => {});
  }, [id, project, localItems, rawTree]);

  if (projLoading) {
    return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading project…</div>;
  }
  if (projError) {
    return (
      <div style={{ padding: 24 }}>
        <Link to="/iq/projects" style={{ fontSize: 13, color: 'var(--color-text-secondary)', textDecoration: 'none' }}>
          ← Back to Projects
        </Link>
        <div style={{ marginTop: 12, color: 'var(--color-danger)' }}>Failed to load: {projError}</div>
      </div>
    );
  }
  if (!project) {
    return (
      <div style={{ padding: 24 }}>
        <Link to="/iq/projects" style={{ fontSize: 13, color: 'var(--color-text-secondary)', textDecoration: 'none' }}>← Back to Projects</Link>
        <div style={{ marginTop: 12, color: 'var(--color-text-tertiary)' }}>Project not found.</div>
      </div>
    );
  }

  const projColors = PROJECT_STATUS_COLORS[project.status ?? ''] ?? PROJECT_STATUS_COLORS['planning']!;
  const escalatedCount = (decisions ?? []).filter((d) => d.status === 'escalated').length;

  // Aggregate point stats from work tree
  let totalDone = 0, totalPts = 0;
  function sumPoints(nodes: WorkItemTree[]) {
    for (const n of nodes) {
      if ((n.type === 'story' || n.type === 'task') && n.storyPoints) {
        totalPts += n.storyPoints;
        if (n.status === 'done') totalDone += n.storyPoints;
      }
      sumPoints(n.children);
    }
  }
  sumPoints(workTree);
  const overallPct = totalPts > 0 ? Math.round((totalDone / totalPts) * 100) : 0;

  return (
    <div style={{ padding: '0 0 60px', maxWidth: 900 }}>
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
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-text-primary)' }}>{project.contributors.length}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>contributors</div>
            </div>
            {escalatedCount > 0 && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-danger)' }}>{escalatedCount}</div>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>escalated</div>
              </div>
            )}
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

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '1.5px solid var(--color-border)' }}>
        {([
          { key: 'work',         label: 'Work Items', badge: workTree.length > 0 ? `${workTree.length} epics` : undefined },
          { key: 'decisions',    label: 'Decisions',  badge: escalatedCount > 0 ? `${escalatedCount} escalated` : undefined },
          { key: 'contributors', label: 'Contributors', badge: undefined },
        ] as { key: Tab; label: string; badge?: string }[]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '8px 18px', border: 'none', background: 'transparent', cursor: 'pointer',
              fontSize: 14, fontWeight: tab === t.key ? 700 : 500,
              color: tab === t.key ? 'var(--color-primary)' : 'var(--color-text-secondary)',
              borderBottom: tab === t.key ? '2.5px solid var(--color-primary)' : '2.5px solid transparent',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
            {t.label}
            {t.badge && (
              <span style={{
                padding: '1px 7px', borderRadius: 9999, fontSize: 10, fontWeight: 700,
                background: t.key === 'decisions' ? 'var(--color-danger-bg)' : 'var(--color-info-bg)',
                color: t.key === 'decisions' ? 'var(--color-danger)' : 'var(--color-primary)',
              }}>
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Work Items tab */}
      {tab === 'work' && (
        <div>
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
            <BoardView epics={workTree} />
          ) : (
            <>
              {!workLoading && workTree.length === 0 && !addingEpic && (
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
                  No epics yet. Create the first epic to start tracking work.
                </div>
              )}
              {workTree.map((epic) => (
                <EpicCard
                  key={epic.id}
                  item={epic}
                  onStatusToggle={handleStatusToggle}
                  projectId={id ?? ''}
                  onAddItem={handleAddItem}
                />
              ))}
              {addingEpic ? (
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
        </div>
      )}

      {/* Decisions tab */}
      {tab === 'decisions' && (
        <DecisionQueue decisions={decisions ?? []} />
      )}

      {/* Contributors tab */}
      {tab === 'contributors' && (
        <ContributorsTable contributors={project.contributors} />
      )}
    </div>
  );
}

export default ProjectDetailPage;
