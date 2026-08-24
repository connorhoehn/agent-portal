import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Avatar,
  Chip,
  PageSection,
  SkeletonCard,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';

// The operating model: one person runs each initiative, a few SMEs cut across
// them directing agents. The cards show that — owner + SMEs + real work
// rollups + agent spend — not fabricated activity feeds or ten-avatar walls.

interface ProjectSummary {
  id: string;
  name: string;
  status: string | null;
  description?: string | null;
  contributorCount: number;
  topContributorNames?: string[];
  lastActivityAt?: string | null;
  createdAt: string | null;
  // Operating-model rollups. All null/[] on pre-migration clusters — render
  // what's present, omit cleanly what isn't.
  ownerId?: string | null;
  ownerName?: string | null;
  smeNames?: string[];
  openStories?: number | null;
  openBugs?: number | null;
  pointsDone?: number | null;
  pointsTotal?: number | null;
  agentSpendUsd?: number | null;
  lastAgentActivityAt?: string | null;
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const STATUS_OPTIONS = ['all', 'active', 'in_progress', 'planning', 'completed', 'archived'];
const STATUS_LABELS: Record<string, string> = {
  all: 'All', active: 'Active', in_progress: 'In Progress',
  planning: 'Planning', completed: 'Completed', archived: 'Archived',
};

// ─── Status color helpers ─────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string; accent: string }> = {
  active:       { bg: '#f0fdf4', border: '#86efac', text: '#166534', accent: '#16a34a' },
  in_progress:  { bg: '#eff6ff', border: '#93c5fd', text: '#1e40af', accent: '#3b82f6' },
  completed:    { bg: '#f0fdf4', border: '#86efac', text: '#166534', accent: '#16a34a' },
  archived:     { bg: '#f9fafb', border: '#d1d5db', text: '#6b7280', accent: '#9ca3af' },
  planning:     { bg: '#fefce8', border: '#fde047', text: '#713f12', accent: '#eab308' },
  paused:       { bg: '#fff7ed', border: '#fdba74', text: '#9a3412', accent: '#f97316' },
};

// ─── Project key derivation ───────────────────────────────────────────────────

// Short keys for the canonical initiatives, where derived initials would be
// unhelpful ('Observability Platform' → 'OP') or collide ('Design System v3'
// and 'Design System API' both → 'DS'). Anything unlisted falls through to the
// initials rule below.
const KNOWN_KEYS: Record<string, string> = {
  'p-observability':      'OBS',
  'p-auth-migration':     'AUTH',
  'p-llm-platform':       'LLM',
  'p-cost-opt':           'COST',
  'p-realtime-analytics': 'RTA',
  'p-data-lake':          'LAKE',
  'p-feature-store':      'FEAT',
  'p-mobile-redesign':    'MOB',
  'p-design-v3':          'DSV3',
  'p-design-system-api':  'DSAP',
  'p-inference-platform': 'INF',
  'p-rag-search':         'RAG',
  'p-soc2':               'SOC2',
  'p-zero-trust':         'ZT',
};

function deriveProjectKey(projectId: string, projectName: string): string {
  if (KNOWN_KEYS[projectId]) return KNOWN_KEYS[projectId]!;
  // Take uppercase initials of words with 2+ letters, max 4 chars.
  const initials = projectName
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .map(w => w[0]!.toUpperCase())
    .join('');
  if (initials.length >= 2) return initials.slice(0, 4);
  return projectName.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 4);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(isoDate: string | null | undefined): string {
  if (!isoDate) return '';
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)  return `${days}d ago`;
  return new Date(isoDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function presenceColor(isoDate: string | null | undefined): string {
  if (!isoDate) return '#d1d5db';
  const mins = Math.floor((Date.now() - new Date(isoDate).getTime()) / 60000);
  if (mins < 60)  return '#22c55e';
  if (mins < 480) return '#f59e0b';
  return '#d1d5db';
}

/** "{openStories} stories · {openBugs} bugs · {done}/{total} pts" — parts the
 *  rollup didn't provide (pre-migration clusters) are omitted, not zeroed. */
function workLine(p: ProjectSummary): string | null {
  const parts: string[] = [];
  if (p.openStories != null) parts.push(`${p.openStories} ${p.openStories === 1 ? 'story' : 'stories'}`);
  if (p.openBugs != null) parts.push(`${p.openBugs} ${p.openBugs === 1 ? 'bug' : 'bugs'}`);
  if (p.pointsDone != null && p.pointsTotal != null) parts.push(`${p.pointsDone}/${p.pointsTotal} pts`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── StatusChip ──────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string | null }) {
  const label = status ?? 'unknown';
  const colors = STATUS_COLORS[label] ?? { bg: '#f3f4f6', border: '#d1d5db', text: '#374151', accent: '#6b7280' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 9px', borderRadius: 9999,
      fontSize: 10, fontWeight: 700,
      background: colors.bg, color: colors.text,
      border: `1px solid ${colors.border}`,
      textTransform: 'uppercase', letterSpacing: '0.04em',
      whiteSpace: 'nowrap', flexShrink: 0,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: colors.accent }} />
      {label.replace(/_/g, ' ')}
    </span>
  );
}

// ─── Grid card ────────────────────────────────────────────────────────────────
// Local card, not the library ProjectCard: that component is built around an
// activity feed + avatar wall, which is exactly the synthetic noise this page
// dropped. At most one owner avatar + up to three SME chips.

const MAX_SME_CHIPS = 3;

function InitiativeCard({ project, onClick }: { project: ProjectSummary; onClick: () => void }) {
  const rawStatus = (project.status ?? 'unknown').toLowerCase().replace(/ /g, '_');
  const colors = STATUS_COLORS[rawStatus] ?? STATUS_COLORS['planning']!;
  const smes = project.smeNames ?? [];
  const work = workLine(project);
  const spend = project.agentSpendUsd ?? 0;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', flexDirection: 'column', gap: 10,
        padding: '14px 16px', minHeight: 150,
        background: '#fff', borderRadius: 10,
        border: '1.5px solid #e5e7eb', borderTop: `3px solid ${colors.accent}`,
        cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'inherit',
        transition: 'box-shadow 0.15s, border-color 0.15s',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 12px rgba(0,0,0,0.07)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'none'; }}
    >
      {/* Name + status */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: '#111827', lineHeight: 1.3 }}>
          {project.name}
        </div>
        <StatusChip status={project.status} />
      </div>

      {/* Owner — the one person running it */}
      {project.ownerName ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <Avatar name={project.ownerName} size={20} />
          <span style={{ fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Run by <span style={{ fontWeight: 600 }}>{project.ownerName}</span>
          </span>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: '#9ca3af' }}>No owner yet</div>
      )}

      {/* SMEs — the cross-initiative specialists directing agents */}
      {smes.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          {smes.slice(0, MAX_SME_CHIPS).map(name => (
            <Chip key={name} tone="info" size="xs" title={`SME: ${name}`}>{name}</Chip>
          ))}
          {smes.length > MAX_SME_CHIPS && (
            <span style={{ fontSize: 10, color: '#9ca3af' }}>+{smes.length - MAX_SME_CHIPS}</span>
          )}
        </div>
      )}

      {/* Work + agent rollups */}
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {work && <div style={{ fontSize: 12, color: '#6b7280' }}>{work}</div>}
        {spend > 0 ? (
          <div style={{ fontSize: 12, color: '#374151' }}>
            <span style={{ fontWeight: 600 }}>{usd(spend)}</span> agent spend
            {project.lastAgentActivityAt && <> · last run {relativeTime(project.lastAgentActivityAt)}</>}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#9ca3af' }}>no agent runs yet</div>
        )}
      </div>

      {/* Footer: freshness */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, borderTop: '1px solid #f3f4f6', paddingTop: 8 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: presenceColor(project.lastActivityAt), flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: '#9ca3af' }}>
          {relativeTime(project.lastActivityAt ?? project.createdAt)}
        </span>
      </div>
    </button>
  );
}

// ─── List-view row ────────────────────────────────────────────────────────────

// Shared column template — must match header exactly.
// accent | name | status | owner | spend | updated
const LIST_COLS = '3px 1fr 132px 176px 96px 82px';

function ProjectListRow({ project, onClick }: { project: ProjectSummary; onClick: () => void }) {
  const rawStatus = (project.status ?? 'unknown').toLowerCase().replace(/ /g, '_');
  const colors = STATUS_COLORS[rawStatus] ?? STATUS_COLORS['planning']!;
  const activityDot = presenceColor(project.lastActivityAt);
  const activityLabel = relativeTime(project.lastActivityAt ?? project.createdAt);
  const key = deriveProjectKey(project.id, project.name);
  const spend = project.agentSpendUsd ?? 0;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: LIST_COLS,
        alignItems: 'center',
        gap: 0,
        padding: '0 16px',
        background: '#fff',
        borderTop: 'none',
        borderLeft: 'none',
        borderRight: 'none',
        borderBottom: '1px solid #f3f4f6',
        cursor: 'pointer',
        transition: 'background 0.1s',
        minHeight: 52,
        width: '100%',
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
      }}
      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = '#f9fafb'}
      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = '#fff'}
    >
      {/* Accent bar */}
      <div style={{ width: 3, height: 36, borderRadius: 2, background: colors.accent }} />

      {/* Name + slug */}
      <div style={{ minWidth: 0, paddingLeft: 10, paddingRight: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {project.name}
        </div>
        <div style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'ui-monospace, monospace', marginTop: 1 }}>
          {key}
        </div>
      </div>

      {/* Status chip — fixed column, left-aligned */}
      <div><StatusChip status={project.status} /></div>

      {/* Owner — replaces the old avatar-wall team column */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, paddingRight: 12 }}>
        {project.ownerName ? (
          <>
            <Avatar name={project.ownerName} size={20} />
            <span style={{ fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {project.ownerName}
            </span>
          </>
        ) : (
          <span style={{ fontSize: 11, color: '#9ca3af' }}>—</span>
        )}
      </div>

      {/* Agent spend */}
      <div style={{ fontSize: 12, textAlign: 'right', paddingRight: 12, whiteSpace: 'nowrap' }}>
        {spend > 0 ? (
          <span style={{ color: '#374151', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{usd(spend)}</span>
        ) : (
          <span style={{ color: '#9ca3af' }}>—</span>
        )}
      </div>

      {/* Updated — fixed column, right-aligned within cell */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: activityDot, flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>{activityLabel}</span>
      </div>
    </button>
  );
}

// ─── View toggle icons ─────────────────────────────────────────────────────────

function GridIcon({ active }: { active: boolean }) {
  const c = active ? '#6366f1' : '#9ca3af';
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <rect x="1" y="1" width="5.5" height="5.5" rx="1" fill={c} />
      <rect x="8.5" y="1" width="5.5" height="5.5" rx="1" fill={c} />
      <rect x="1" y="8.5" width="5.5" height="5.5" rx="1" fill={c} />
      <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1" fill={c} />
    </svg>
  );
}

function ListIcon({ active }: { active: boolean }) {
  const c = active ? '#6366f1' : '#9ca3af';
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <rect x="1" y="2" width="13" height="2.5" rx="1" fill={c} />
      <rect x="1" y="6.25" width="13" height="2.5" rx="1" fill={c} />
      <rect x="1" y="10.5" width="13" height="2.5" rx="1" fill={c} />
    </svg>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

function ProjectsPage() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useFetch<ProjectSummary[]>('/api/graph/projects?limit=100');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    try { return (localStorage.getItem('projects-view') as 'grid' | 'list') ?? 'grid'; } catch { return 'grid'; }
  });

  function switchView(mode: 'grid' | 'list') {
    setViewMode(mode);
    try { localStorage.setItem('projects-view', mode); } catch { /* ignore */ }
  }

  const statuses = useMemo(() => {
    if (!data) return new Set<string>();
    return new Set(data.map(p => (p.status ?? '').toLowerCase().replace(/ /g, '_')));
  }, [data]);

  const visibleOptions = STATUS_OPTIONS.filter(s => s === 'all' || statuses.has(s));

  const filtered = useMemo(() => {
    if (!data) return [];
    if (statusFilter === 'all') return data;
    return data.filter(p => (p.status ?? '').toLowerCase().replace(/ /g, '_') === statusFilter);
  }, [data, statusFilter]);

  if (isLoading) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14, padding: '0 0 40px' }}>
        {[1,2,3,4,5,6].map(i => (
          <SkeletonCard key={i} height={190} />
        ))}
      </div>
    );
  }
  if (error) return <div style={{ padding: 24, color: '#dc2626' }}>Failed to load projects: {error}</div>;
  if (!data || data.length === 0) {
    return (
      <div style={{ padding: 40, maxWidth: 560 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>No projects yet</h2>
        <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.6 }}>
          Run <code style={{ background: '#f3f4f6', padding: '1px 6px', borderRadius: 4 }}>python schema/seed.py</code> to seed Aurora.
        </p>
      </div>
    );
  }

  return (
    <PageSection
      title="Projects"
      description="Initiatives: who runs each one, the work in flight, and what agents have spent delivering it."
      actions={
        <div style={{
          display: 'flex', border: '1.5px solid #e5e7eb', borderRadius: 7,
          overflow: 'hidden', flexShrink: 0,
        }}>
          {(['grid', 'list'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => switchView(mode)}
              title={mode === 'grid' ? 'Card view' : 'List view'}
              style={{
                padding: '6px 10px',
                background: viewMode === mode ? '#f5f3ff' : '#fff',
                border: 'none', cursor: 'pointer',
                borderRight: mode === 'grid' ? '1.5px solid #e5e7eb' : 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {mode === 'grid' ? <GridIcon active={viewMode === 'grid'} /> : <ListIcon active={viewMode === 'list'} />}
            </button>
          ))}
        </div>
      }
    >
      {/* ── Filter chips ── */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {visibleOptions.map(s => {
          const active = statusFilter === s;
          return (
            <button key={s} onClick={() => setStatusFilter(s)} style={{
              padding: '4px 14px', borderRadius: 9999, cursor: 'pointer',
              border: active ? '2px solid #6366f1' : '1.5px solid #e5e7eb',
              background: active ? '#6366f1' : 'transparent',
              color: active ? '#fff' : '#6b7280',
              fontSize: 12, fontWeight: active ? 600 : 400,
              transition: 'all 0.15s', fontFamily: 'inherit',
            }}>
              {STATUS_LABELS[s] ?? s}
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: 40, color: '#9ca3af', textAlign: 'center' }}>No projects match the selected filter.</div>
      ) : viewMode === 'list' ? (
        /* ── List view ── */
        <div style={{ border: '1.5px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
          {/* Column headers — must match LIST_COLS exactly */}
          <div style={{
            display: 'grid', gridTemplateColumns: LIST_COLS,
            alignItems: 'center', gap: 0, padding: '0 16px',
            background: '#f9fafb', borderBottom: '1px solid #e5e7eb',
            minHeight: 34,
          }}>
            <div />
            <span style={{ fontSize: 10.5, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', paddingLeft: 10 }}>Project</span>
            <span style={{ fontSize: 10.5, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Status</span>
            <span style={{ fontSize: 10.5, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Owner</span>
            <span style={{ fontSize: 10.5, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'right', paddingRight: 12 }}>Spend</span>
            <span style={{ fontSize: 10.5, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'right' }}>Updated</span>
          </div>
          {filtered.map(project => (
            <ProjectListRow
              key={project.id}
              project={project}
              onClick={() => navigate(`/iq/projects/${project.id}`)}
            />
          ))}
        </div>
      ) : (
        /* ── Grid view ── */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {filtered.map(project => (
            <InitiativeCard
              key={project.id}
              project={project}
              onClick={() => navigate(`/iq/projects/${project.id}`)}
            />
          ))}
        </div>
      )}
    </PageSection>
  );
}

export default ProjectsPage;
