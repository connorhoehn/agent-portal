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

const STATUS_STYLES: Record<WorkItemStatus, { bg: string; text: string; dot: string }> = {
  open:        { bg: '#f9fafb', text: '#6b7280', dot: '#9ca3af' },
  in_progress: { bg: '#eff6ff', text: '#1e40af', dot: '#3b82f6' },
  in_review:   { bg: '#fdf4ff', text: '#7e22ce', dot: '#a855f7' },
  done:        { bg: '#f0fdf4', text: '#166534', dot: '#16a34a' },
  cancelled:   { bg: '#fef2f2', text: '#991b1b', dot: '#ef4444' },
};

const PRIORITY_STYLES: Record<WorkItemPriority, { color: string; label: string }> = {
  critical: { color: '#dc2626', label: '🔴 Critical' },
  high:     { color: '#ea580c', label: '🟠 High' },
  medium:   { color: '#ca8a04', label: '🟡 Medium' },
  low:      { color: '#6b7280', label: '⚪ Low' },
};

const PR_STYLES: Record<PrStatus, { bg: string; text: string; icon: string }> = {
  merged: { bg: '#f5f3ff', text: '#7c3aed', icon: '⬡' },
  open:   { bg: '#f0fdf4', text: '#166534', icon: '⊙' },
  draft:  { bg: '#f9fafb', text: '#6b7280', icon: '⊘' },
  closed: { bg: '#fef2f2', text: '#991b1b', icon: '✕' },
};

const DECISION_STATUS: Record<string, { bg: string; text: string }> = {
  escalated: { bg: '#fef2f2', text: '#991b1b' },
  open:      { bg: '#fff7ed', text: '#9a3412' },
  resolved:  { bg: '#f0fdf4', text: '#166534' },
  rejected:  { bg: '#f9fafb', text: '#6b7280' },
};

const PROJECT_STATUS_COLORS: Record<string, { accent: string; bg: string; text: string }> = {
  active:   { accent: '#16a34a', bg: '#f0fdf4', text: '#166534' },
  planning: { accent: '#3b82f6', bg: '#eff6ff', text: '#1e40af' },
  archived: { accent: '#9ca3af', bg: '#f9fafb', text: '#6b7280' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6'];
  const idx = name.charCodeAt(0) % colors.length;
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: colors[idx], color: '#fff',
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
      background: '#f8fafc', border: '1.5px solid #e2e8f0', borderRadius: 8,
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
          padding: '6px 10px', borderRadius: 6, border: '1px solid #cbd5e1',
          fontSize: 14, outline: 'none', background: '#fff',
        }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select value={type} onChange={(e) => setType(e.target.value as WorkItemType)}
          style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#fff' }}>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value as WorkItemPriority)}
          style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, background: '#fff' }}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={onCancel} style={{
            padding: '4px 12px', borderRadius: 6, border: '1px solid #e2e8f0',
            background: '#fff', color: '#6b7280', fontSize: 12, cursor: 'pointer',
          }}>Cancel</button>
          <button
            disabled={!title.trim()}
            onClick={() => title.trim() && onSave({ title: title.trim(), type, priority })}
            style={{
              padding: '4px 12px', borderRadius: 6, border: 'none',
              background: title.trim() ? '#6366f1' : '#e2e8f0',
              color: title.trim() ? '#fff' : '#9ca3af', fontSize: 12, cursor: 'pointer',
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
      background: isDone ? '#f9fafb' : '#fff',
      opacity: isDone ? 0.7 : 1,
    }}>
      <input
        type="checkbox"
        checked={isDone}
        onChange={() => onStatusToggle(item.id, item.status)}
        style={{ cursor: 'pointer', accentColor: '#6366f1', width: 15, height: 15, flexShrink: 0 }}
      />
      <span style={{ flex: 1, fontSize: 13, color: isDone ? '#9ca3af' : '#374151',
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
      <div
        onClick={() => hasTasks && setExpanded((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: `7px ${14 + depth * 12}px`,
          borderRadius: 6,
          cursor: hasTasks ? 'pointer' : 'default',
          background: item.status === 'done' ? '#f9fafb' : '#fff',
          transition: 'background 0.1s',
        }}
        onMouseEnter={(e) => { if (item.status !== 'done') (e.currentTarget as HTMLElement).style.background = '#f8fafc'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = item.status === 'done' ? '#f9fafb' : '#fff'; }}
      >
        {/* Expand chevron for tasks */}
        <span style={{ width: 14, flexShrink: 0, color: '#9ca3af', fontSize: 10 }}>
          {hasTasks ? (expanded ? '▾' : '▸') : ''}
        </span>

        {/* Story number / icon */}
        <span style={{ fontSize: 12, color: '#a5b4fc', fontFamily: 'monospace', flexShrink: 0 }}>■</span>

        {/* Title */}
        <span style={{
          flex: 1, fontSize: 13, fontWeight: 500,
          color: item.status === 'done' ? '#9ca3af' : '#111827',
          textDecoration: item.status === 'done' ? 'line-through' : 'none',
        }}>
          {item.title}
        </span>

        {/* Labels */}
        {item.labels.slice(0, 2).map((l) => (
          <span key={l} style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3,
            background: '#f1f5f9', color: '#64748b' }}>{l}</span>
        ))}

        {/* PR badge */}
        {item.prStatus && <PrBadge prStatus={item.prStatus} prUrl={item.prUrl} />}

        {/* Story points */}
        {item.storyPoints != null && (
          <span style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af',
            background: '#f1f5f9', padding: '1px 6px', borderRadius: 9999, minWidth: 24, textAlign: 'center' }}>
            {item.storyPoints}
          </span>
        )}

        {/* Assignee */}
        {item.assigneeName && <Avatar name={item.assigneeName} size={22} />}

        {/* Status */}
        <StatusChip status={item.status} />
      </div>

      {/* Tasks */}
      {expanded && hasTasks && (
        <div style={{ marginLeft: 28, borderLeft: '2px solid #e2e8f0', paddingLeft: 8, marginTop: 2, marginBottom: 4 }}>
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
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 10px', borderRadius: 8,
          background: '#f8fafc', cursor: 'pointer',
          border: '1px solid #e2e8f0',
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{ fontSize: 10, color: '#94a3b8', width: 14 }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ fontSize: 12, color: '#818cf8', fontFamily: 'monospace', flexShrink: 0 }}>◈</span>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: '#374151' }}>{item.title}</span>
        {storyStats.total > 0 && (
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            {storyStats.done}/{storyStats.total} stories
          </span>
        )}
        {item.prStatus && <PrBadge prStatus={item.prStatus} prUrl={item.prUrl} />}
        {item.assigneeName && <Avatar name={item.assigneeName} size={20} />}
        <StatusChip status={item.status} />
      </div>

      {expanded && (
        <div style={{ paddingLeft: 20, paddingTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {stories.map((story) => (
            <StoryRow key={story.id} item={story} onStatusToggle={onStatusToggle} />
          ))}
          {stories.length === 0 && (
            <div style={{ padding: '6px 14px', fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
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
                padding: '4px 10px', borderRadius: 5, border: '1px dashed #cbd5e1',
                background: 'transparent', color: '#94a3b8', fontSize: 12, cursor: 'pointer',
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
      border: '1.5px solid #e2e8f0',
      borderRadius: 10,
      overflow: 'hidden',
      marginBottom: 16,
    }}>
      {/* Epic header */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px',
          background: item.status === 'done' ? '#f9fafb' : '#fff',
          cursor: 'pointer',
          borderBottom: expanded ? '1px solid #e2e8f0' : 'none',
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{ fontSize: 11, color: '#94a3b8', width: 14, flexShrink: 0 }}>
          {expanded ? '▾' : '▸'}
        </span>
        <span style={{ fontSize: 14, flexShrink: 0 }}>⚡</span>
        <span style={{ flex: 1, fontSize: 15, fontWeight: 700, color: item.status === 'done' ? '#9ca3af' : '#111827' }}>
          {item.title}
        </span>

        {/* Priority */}
        <span style={{ fontSize: 11, color: pStyle.color, fontWeight: 600, flexShrink: 0 }}>
          {item.priority === 'critical' ? '🔴' : item.priority === 'high' ? '🟠' : item.priority === 'medium' ? '🟡' : '⚪'}
        </span>

        {/* Story progress */}
        {stories.total > 0 && (
          <span style={{ fontSize: 12, color: '#6b7280', flexShrink: 0 }}>
            {stories.done}/{stories.total} stories
          </span>
        )}

        {/* Point progress bar */}
        {pts.total > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <div style={{ width: 60, height: 5, borderRadius: 9999, background: '#e5e7eb', overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 9999,
                background: pct >= 80 ? '#16a34a' : pct >= 40 ? '#6366f1' : '#f59e0b',
                width: `${pct}%`,
              }} />
            </div>
            <span style={{ fontSize: 11, color: '#6b7280', minWidth: 28 }}>{pct}%</span>
          </div>
        )}

        {/* Assignee */}
        {item.assigneeName && <Avatar name={item.assigneeName} size={24} />}

        {/* Status chip */}
        <StatusChip status={item.status} />
      </div>

      {/* Epic body */}
      {expanded && (
        <div style={{ padding: '12px 16px', background: '#fafafa' }}>
          {item.description && (
            <p style={{ margin: '0 0 12px', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
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
                border: '1px dashed #cbd5e1', background: 'transparent',
                color: '#94a3b8', fontSize: 12, cursor: 'pointer',
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
      <div style={{ padding: '32px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
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
            background: '#fff', border: '1.5px solid #e2e8f0', borderRadius: 8,
            padding: '14px 16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
              <span style={{
                padding: '2px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 700,
                background: ds.bg, color: ds.text, flexShrink: 0, textTransform: 'uppercase',
              }}>
                {d.status}
              </span>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#111827', flex: 1 }}>{d.topic}</span>
              {d.requiredRole && (
                <span style={{
                  padding: '2px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 600,
                  background: '#f5f3ff', color: '#5b21b6', flexShrink: 0,
                }}>
                  needs {d.requiredRole}
                </span>
              )}
            </div>
            {d.summary && (
              <p style={{ margin: '0 0 8px', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
                {d.summary}
              </p>
            )}
            <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#9ca3af' }}>
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
    critical: '#dc2626', high: '#ea580c', medium: '#ca8a04', low: '#9ca3af',
  };
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #e5e7eb',
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
          background: item.type === 'story' ? '#eff6ff' : '#f0fdf4',
          color: item.type === 'story' ? '#1d4ed8' : '#15803d',
          textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0, marginTop: 1,
        }}>
          {item.type}
        </span>
        <span style={{
          fontSize: 12, fontWeight: 500, color: '#111827', lineHeight: 1.35,
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
              background: '#f1f5f9', color: '#64748b',
            }}>
              {item.storyPoints}pt
            </span>
          )}
        </div>
        {item.prStatus && (
          <span style={{
            fontSize: 9.5, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
            background: item.prStatus === 'merged' ? '#f0fdf4' : item.prStatus === 'open' ? '#eff6ff' : '#f9fafb',
            color: item.prStatus === 'merged' ? '#16a34a' : item.prStatus === 'open' ? '#1d4ed8' : '#6b7280',
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
      borderBottom: '1px solid #e5e7eb',
    }}>
      {/* Epic label */}
      <div style={{
        padding: '12px 12px', borderRight: '1px solid #e5e7eb',
        background: '#f9fafb', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
      }}>
        <span style={{
          fontSize: 9, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase',
          letterSpacing: '0.05em', marginBottom: 4,
        }}>Epic</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#111827', lineHeight: 1.35 }}>
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
            borderRight: ci < 3 ? '1px solid #f3f4f6' : 'none',
            minHeight: hasAny ? undefined : 52,
            background: status === 'done' ? '#fafffe' : '#fff',
          }}>
            {items.map(item => <BoardCard key={item.id} item={item} />)}
            {items.length === 0 && (
              <div style={{
                height: 36, border: '1.5px dashed #f0f0f0', borderRadius: 6,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span style={{ fontSize: 10, color: '#e5e7eb' }}>—</span>
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
      <div style={{ padding: '40px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
        No epics yet — create one to see the board.
      </div>
    );
  }
  return (
    <div style={{ overflowX: 'auto', borderRadius: 10, border: '1.5px solid #e5e7eb', background: '#fff' }}>
      {/* Column headers */}
      <div style={{
        display: 'grid', gridTemplateColumns: '160px repeat(4, 1fr)',
        background: '#f9fafb', borderBottom: '1.5px solid #e5e7eb',
        position: 'sticky', top: 0, zIndex: 2,
      }}>
        <div style={{ padding: '8px 12px', borderRight: '1px solid #e5e7eb' }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Swimlane
          </span>
        </div>
        {BOARD_STATUSES.map((s, i) => {
          const count = epics.reduce((n, epic) =>
            n + flattenByType([epic], ['story', 'task']).filter(it => it.status === s).length, 0);
          return (
            <div key={s} style={{
              padding: '8px 10px', borderRight: i < 3 ? '1px solid #e5e7eb' : 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {BOARD_STATUS_LABELS[s]}
              </span>
              {count > 0 && (
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 9999,
                  background: s === 'done' ? '#f0fdf4' : '#f1f5f9',
                  color: s === 'done' ? '#16a34a' : '#64748b',
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
    return <div style={{ padding: 24, color: '#9ca3af' }}>No contributors recorded.</div>;
  }
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
            {['Name', 'Title', 'Role', 'Weight'].map((col) => (
              <th key={col} style={{
                padding: '10px 16px', textAlign: col === 'Weight' ? 'right' : 'left',
                fontSize: 11, fontWeight: 600, color: '#9ca3af',
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {contributors.map((c, idx) => (
            <tr key={c.personId} style={{
              borderBottom: idx < contributors.length - 1 ? '1px solid #f3f4f6' : 'none',
              cursor: 'pointer',
            }}
              onClick={() => navigate(`/iq/explore?person=${encodeURIComponent(c.name)}`)}
              onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.background = '#fafafa'}
              onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.background = '#fff'}
            >
              <td style={{ padding: '11px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Avatar name={c.name} size={28} />
                  <span style={{ fontSize: 14, fontWeight: 500, color: '#111827' }}>{c.name}</span>
                </div>
              </td>
              <td style={{ padding: '11px 16px', fontSize: 13, color: '#6b7280' }}>{c.title ?? '—'}</td>
              <td style={{ padding: '11px 16px', fontSize: 13, color: '#6b7280' }}>{c.role ?? '—'}</td>
              <td style={{ padding: '11px 16px', textAlign: 'right' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 60, height: 5, borderRadius: 3, background: '#e5e7eb', overflow: 'hidden' }}>
                    <div style={{
                      width: `${Math.min(c.weight * 100, 100)}%`, height: '100%',
                      background: '#6366f1', borderRadius: 3,
                    }} />
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 500, color: '#6b7280', minWidth: 36, textAlign: 'right' }}>
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
    return <div style={{ padding: 24, color: '#9ca3af' }}>Loading project…</div>;
  }
  if (projError) {
    return (
      <div style={{ padding: 24 }}>
        <Link to="/iq/projects" style={{ fontSize: 13, color: '#6b7280', textDecoration: 'none' }}>
          ← Back to Projects
        </Link>
        <div style={{ marginTop: 12, color: '#dc2626' }}>Failed to load: {projError}</div>
      </div>
    );
  }
  if (!project) {
    return (
      <div style={{ padding: 24 }}>
        <Link to="/iq/projects" style={{ fontSize: 13, color: '#6b7280', textDecoration: 'none' }}>← Back to Projects</Link>
        <div style={{ marginTop: 12, color: '#9ca3af' }}>Project not found.</div>
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
        fontSize: 13, color: '#6b7280', textDecoration: 'none', marginBottom: 20,
      }}>
        ← Projects
      </Link>

      {/* Header card */}
      <div style={{
        background: '#fff',
        border: `1.5px solid #e2e8f0`,
        borderTop: `4px solid ${projColors.accent}`,
        borderRadius: 10,
        padding: '20px 24px',
        marginBottom: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: '#111827' }}>{project.name}</h1>
              <span style={{
                padding: '2px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 700,
                background: projColors.bg, color: projColors.text,
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                {project.status ?? 'unknown'}
              </span>
            </div>
            {project.description && (
              <p style={{ margin: 0, fontSize: 14, color: '#6b7280', lineHeight: 1.6 }}>
                {project.description}
              </p>
            )}
          </div>

          {/* Stats */}
          <div style={{ display: 'flex', gap: 24, flexShrink: 0, flexWrap: 'wrap' }}>
            {totalPts > 0 && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: projColors.accent }}>{overallPct}%</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{totalDone}/{totalPts} pts</div>
              </div>
            )}
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#374151' }}>{project.contributors.length}</div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>contributors</div>
            </div>
            {escalatedCount > 0 && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#dc2626' }}>{escalatedCount}</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>escalated</div>
              </div>
            )}
            {project.githubUrl && (
              <a href={project.githubUrl} target="_blank" rel="noreferrer"
                style={{ display: 'flex', alignItems: 'center', gap: 4,
                  fontSize: 12, color: '#6366f1', textDecoration: 'none', alignSelf: 'center' }}>
                ↗ GitHub
              </a>
            )}
          </div>
        </div>

        {/* Overall progress bar */}
        {totalPts > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ height: 6, borderRadius: 9999, background: '#e5e7eb', overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 9999,
                background: overallPct >= 80 ? '#16a34a' : overallPct >= 40 ? '#6366f1' : '#f59e0b',
                width: `${overallPct}%`, transition: 'width 0.4s',
              }} />
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '1.5px solid #e5e7eb' }}>
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
              color: tab === t.key ? '#6366f1' : '#6b7280',
              borderBottom: tab === t.key ? '2.5px solid #6366f1' : '2.5px solid transparent',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
            {t.label}
            {t.badge && (
              <span style={{
                padding: '1px 7px', borderRadius: 9999, fontSize: 10, fontWeight: 700,
                background: t.key === 'decisions' ? '#fef2f2' : '#eff6ff',
                color: t.key === 'decisions' ? '#dc2626' : '#1d4ed8',
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
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              {workTree.length > 0 ? `${workTree.length} epic${workTree.length !== 1 ? 's' : ''}` : ''}
            </div>
            <div style={{ display: 'flex', border: '1.5px solid #e5e7eb', borderRadius: 7, overflow: 'hidden' }}>
              {([['tree', '≡ List'], ['board', '⊞ Board']] as [WorkView, string][]).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setWorkView(mode)}
                  style={{
                    padding: '5px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500,
                    background: workView === mode ? '#f5f3ff' : '#fff',
                    color: workView === mode ? '#6366f1' : '#6b7280',
                    borderRight: mode === 'tree' ? '1.5px solid #e5e7eb' : 'none',
                    fontFamily: 'inherit',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {workLoading && (
            <div style={{ color: '#9ca3af', fontSize: 13, marginBottom: 16 }}>Loading work items…</div>
          )}

          {workView === 'board' ? (
            <BoardView epics={workTree} />
          ) : (
            <>
              {!workLoading && workTree.length === 0 && !addingEpic && (
                <div style={{ padding: '40px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
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
                    border: '1.5px dashed #cbd5e1', background: 'transparent',
                    color: '#94a3b8', fontSize: 13, cursor: 'pointer',
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
