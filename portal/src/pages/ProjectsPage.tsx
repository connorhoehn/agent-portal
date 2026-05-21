import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Avatar, AvatarGroup } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';

// TODO(ui-components): ActivityFeed, ProjectCard are candidates
// for @connorhoehnslalom/ui-components/shared project-management domain.

interface ProjectSummary {
  id: string;
  name: string;
  status: string | null;
  description?: string | null;
  contributorCount: number;
  topContributorNames?: string[];
  lastActivityAt?: string | null;
  createdAt: string | null;
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string; accent: string }> = {
  active:       { bg: '#f0fdf4', border: '#86efac', text: '#166534', accent: '#16a34a' },
  in_progress:  { bg: '#eff6ff', border: '#93c5fd', text: '#1e40af', accent: '#3b82f6' },
  completed:    { bg: '#f0fdf4', border: '#86efac', text: '#166534', accent: '#16a34a' },
  archived:     { bg: '#f9fafb', border: '#d1d5db', text: '#6b7280', accent: '#9ca3af' },
  planning:     { bg: '#fefce8', border: '#fde047', text: '#713f12', accent: '#eab308' },
  paused:       { bg: '#fff7ed', border: '#fdba74', text: '#9a3412', accent: '#f97316' },
};

const STATUS_OPTIONS = ['all', 'active', 'in_progress', 'planning', 'completed', 'archived'];
const STATUS_LABELS: Record<string, string> = {
  all: 'All', active: 'Active', in_progress: 'In Progress',
  planning: 'Planning', completed: 'Completed', archived: 'Archived',
};

// ─── Activity feed types ──────────────────────────────────────────────────────

type ActivityType = 'task' | 'pr' | 'decision' | 'comment' | 'status';

interface ActivityItem {
  id: string;
  actor: string;     // full name, e.g. "Alex Chen"
  action: string;    // verb phrase, e.g. "completed"
  ticketId: string;  // Jira-style ID, e.g. "K8S-182"
  subject: string;   // short title, e.g. "Node pool autoscaler config"
  timeLabel: string;
  type: ActivityType;
}

const TYPE_DOT: Record<ActivityType, string> = {
  task:     '#10b981',
  pr:       '#6366f1',
  decision: '#f59e0b',
  comment:  '#94a3b8',
  status:   '#3b82f6',
};

// ─── Project key derivation ───────────────────────────────────────────────────

const KNOWN_KEYS: Record<string, string> = {
  'proj-k8s':     'K8S',
  'proj-istio':   'IST',
  'proj-cicd':    'CICD',
  'proj-otel':    'OTEL',
  'proj-cedar':   'CDR',
  'proj-onboard': 'OBD',
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

// ─── Mock activity feeds ──────────────────────────────────────────────────────
// ticketId: "KEY-NNN", subject: clean task title (no # prefix)

const MOCK_FEED: Record<string, ActivityItem[]> = {
  'proj-k8s': [
    { id: 'k1', actor: 'Alex Chen',    action: 'completed',         ticketId: 'K8S-182', subject: 'Node pool autoscaler config',     timeLabel: '2m ago',  type: 'task' },
    { id: 'k2', actor: 'Maria Santos', action: 'merged',            ticketId: 'K8S-179', subject: 'etcd backup script',              timeLabel: '8m ago',  type: 'pr' },
    { id: 'k3', actor: 'Priya Patel',  action: 'created',           ticketId: 'K8S-183', subject: 'Upgrade CoreDNS to 1.11',         timeLabel: '23m ago', type: 'task' },
    { id: 'k4', actor: 'Ahmed Hassan', action: 'commented on',      ticketId: 'K8S-176', subject: 'cluster version pinning',         timeLabel: '45m ago', type: 'comment' },
    { id: 'k5', actor: 'Alex Chen',    action: 'closed',            ticketId: 'K8S-171', subject: 'kube-proxy DaemonSet rollout',    timeLabel: '1h ago',  type: 'status' },
    { id: 'k6', actor: 'Maria Santos', action: 'merged',            ticketId: 'K8S-168', subject: 'node-local DNS cache',            timeLabel: '2h ago',  type: 'pr' },
    { id: 'k7', actor: "Ryan O'Brien", action: 'updated',           ticketId: 'K8S-162', subject: 'cluster upgrade runbook',         timeLabel: '3h ago',  type: 'task' },
    { id: 'k8', actor: 'Priya Patel',  action: 'created',           ticketId: 'K8S-184', subject: 'pod security admission controls', timeLabel: '4h ago',  type: 'task' },
  ],
  'proj-istio': [
    { id: 'i1', actor: 'Alex Chen',    action: 'merged',            ticketId: 'IST-91',  subject: 'mTLS policy for payments svc',    timeLabel: '5m ago',  type: 'pr' },
    { id: 'i2', actor: 'Sophie Turner',action: 'decided',           ticketId: 'IST-88',  subject: 'Adopt Ambient mesh mode',         timeLabel: '30m ago', type: 'decision' },
    { id: 'i3', actor: 'Priya Patel',  action: 'created',           ticketId: 'IST-92',  subject: 'Canary rollout for v1.20',        timeLabel: '1h ago',  type: 'task' },
    { id: 'i4', actor: "Ryan O'Brien", action: 'updated',           ticketId: 'IST-79',  subject: 'traffic routing docs',            timeLabel: '2h ago',  type: 'task' },
    { id: 'i5', actor: 'Alex Chen',    action: 'completed',         ticketId: 'IST-85',  subject: 'Envoy filter for JWT validation', timeLabel: '3h ago',  type: 'task' },
    { id: 'i6', actor: 'Sophie Turner',action: 'commented on',      ticketId: 'IST-83',  subject: 'sidecar injection defaults',      timeLabel: '4h ago',  type: 'comment' },
  ],
  'proj-cicd': [
    { id: 'c1', actor: 'Maria Santos', action: 'merged',            ticketId: 'CICD-247',subject: 'parallel test runner',            timeLabel: '12m ago', type: 'pr' },
    { id: 'c2', actor: 'Sophie Turner',action: 'created',           ticketId: 'CICD-251',subject: 'OIDC token caching for runners',  timeLabel: '35m ago', type: 'task' },
    { id: 'c3', actor: 'James Wright', action: 'completed',         ticketId: 'CICD-239',subject: 'Migrate repo to GitHub Actions',  timeLabel: '2h ago',  type: 'task' },
    { id: 'c4', actor: 'David Kim',    action: 'decided',           ticketId: 'CICD-232',subject: 'single pipeline template',        timeLabel: '3h ago',  type: 'decision' },
    { id: 'c5', actor: 'Maria Santos', action: 'opened PR',         ticketId: 'CICD-244',subject: 'artifact retention policy',       timeLabel: '5h ago',  type: 'pr' },
    { id: 'c6', actor: 'James Wright', action: 'commented on',      ticketId: 'CICD-228',subject: 'cache invalidation strategy',     timeLabel: '6h ago',  type: 'comment' },
  ],
  'proj-otel': [
    { id: 'o1', actor: 'Ben Foster',   action: 'completed',         ticketId: 'OTEL-64', subject: 'Collector gateway HA setup',      timeLabel: '18m ago', type: 'task' },
    { id: 'o2', actor: 'Alex Chen',    action: 'merged',            ticketId: 'OTEL-61', subject: 'span exporter for Aurora',        timeLabel: '1h ago',  type: 'pr' },
    { id: 'o3', actor: 'David Kim',    action: 'decided',           ticketId: 'OTEL-58', subject: 'Grafana Alloy as collector',      timeLabel: '2h ago',  type: 'decision' },
    { id: 'o4', actor: 'Ben Foster',   action: 'created',           ticketId: 'OTEL-65', subject: 'SLO dashboards for API latency',  timeLabel: '3h ago',  type: 'task' },
    { id: 'o5', actor: 'Alex Chen',    action: 'completed',         ticketId: 'OTEL-57', subject: 'instrument search agent OTEL',    timeLabel: '4h ago',  type: 'task' },
  ],
  'proj-cedar': [
    { id: 'ce1', actor: 'Sophie Turner',action: 'merged',           ticketId: 'CDR-48',  subject: 'Cedar policy for HR-admin',       timeLabel: '7m ago',  type: 'pr' },
    { id: 'ce2', actor: 'James Wright', action: 'completed',        ticketId: 'CDR-45',  subject: 'policy simulator test suite',     timeLabel: '40m ago', type: 'task' },
    { id: 'ce3', actor: 'David Kim',    action: 'decided',          ticketId: 'CDR-42',  subject: 'enforce deny-all baseline',       timeLabel: '1h ago',  type: 'decision' },
    { id: 'ce4', actor: 'Sophie Turner',action: 'created',          ticketId: 'CDR-49',  subject: 'Cedar policy for Bedrock KB',     timeLabel: '2h ago',  type: 'task' },
    { id: 'ce5', actor: 'James Wright', action: 'commented on',     ticketId: 'CDR-40',  subject: 'role hierarchy design',           timeLabel: '3h ago',  type: 'comment' },
  ],
  'proj-onboard': [
    { id: 'ob1', actor: 'David Kim',    action: 'created',          ticketId: 'OBD-12',  subject: 'Week 1 onboarding checklist',     timeLabel: '1h ago',  type: 'task' },
    { id: 'ob2', actor: 'James Wright', action: 'created',          ticketId: 'OBD-11',  subject: 'dev environment setup guide',     timeLabel: '3h ago',  type: 'task' },
    { id: 'ob3', actor: "Ryan O'Brien", action: 'updated',          ticketId: 'OBD-9',   subject: 'glossary of internal tools',      timeLabel: '5h ago',  type: 'task' },
    { id: 'ob4', actor: 'David Kim',    action: 'decided',          ticketId: 'OBD-7',   subject: 'buddy system for first 30 days',  timeLabel: '1d ago',  type: 'decision' },
    { id: 'ob5', actor: 'James Wright', action: 'commented on',     ticketId: 'OBD-5',   subject: 'knowledge base access policy',    timeLabel: '1d ago',  type: 'comment' },
  ],
};

// ─── Activity generator for real Aurora projects ──────────────────────────────

const GEN_ACTIONS: Array<{ action: string; type: ActivityType }> = [
  { action: 'completed',   type: 'task' },
  { action: 'merged',      type: 'pr' },
  { action: 'created',     type: 'task' },
  { action: 'opened PR',   type: 'pr' },
  { action: 'commented on',type: 'comment' },
  { action: 'decided',     type: 'decision' },
  { action: 'closed',      type: 'status' },
  { action: 'updated',     type: 'task' },
];

const GEN_SUBJECTS = [
  'refactor stale cache logic',   'add retry on timeout',      'update API schema',
  'fix null pointer in handler',  'improve error reporting',   'add integration tests',
  'bump dependency versions',     'extract shared util module', 'performance profiling',
  'review security headers',      'update runbook',            'add telemetry spans',
];

const GEN_TIMES = ['3m ago', '11m ago', '28m ago', '1h ago', '2h ago', '3h ago', '5h ago', '8h ago'];

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

function generateActivities(project: ProjectSummary): ActivityItem[] {
  const names = project.topContributorNames ?? [];
  if (names.length === 0) return [];
  const key = deriveProjectKey(project.id, project.name);
  const seed = djb2(project.id);
  // Starting ticket number: deterministic per project, 50–499
  const baseNum = 50 + (seed % 450);

  return Array.from({ length: Math.min(8, names.length + 4) }, (_, i) => {
    const h = djb2(project.id + String(i));
    const actor = names[i % names.length]!;
    const a = GEN_ACTIONS[h % GEN_ACTIONS.length]!;
    const subj = GEN_SUBJECTS[(h ^ (h >> 8)) % GEN_SUBJECTS.length]!;
    const ticketNum = baseNum + (i * 3);
    return {
      id: `${project.id}-g${i}`,
      actor,
      action: a.action,
      ticketId: `${key}-${ticketNum}`,
      subject: subj,
      timeLabel: GEN_TIMES[i % GEN_TIMES.length]!,
      type: a.type,
    };
  });
}

function getActivityItems(project: ProjectSummary): ActivityItem[] {
  return MOCK_FEED[project.id] ?? generateActivities(project);
}

// ─── Activity rotation hook ───────────────────────────────────────────────────

const SHOW = 3;
const ROTATE_MS = 4200;

function useActivityRotation(allItems: ActivityItem[], staggerMs: number): ActivityItem[] {
  const [visible, setVisible] = useState<ActivityItem[]>(() => allItems.slice(0, SHOW));
  const poolIdxRef = useRef(SHOW);

  useEffect(() => {
    setVisible(allItems.slice(0, SHOW));
    poolIdxRef.current = SHOW;
  }, [allItems]);

  useEffect(() => {
    if (allItems.length <= SHOW) return;
    let interval: ReturnType<typeof setInterval>;
    const start = setTimeout(() => {
      interval = setInterval(() => {
        const nextItem = allItems[poolIdxRef.current % allItems.length]!;
        poolIdxRef.current = (poolIdxRef.current + 1) % allItems.length;
        setVisible(prev => [nextItem, prev[0]!, prev[1]!]);
      }, ROTATE_MS);
    }, staggerMs);
    return () => {
      clearTimeout(start);
      clearInterval(interval);
    };
  }, [allItems, staggerMs]);

  return visible;
}

// ─── ActivityRow ──────────────────────────────────────────────────────────────

const ROW_OPACITIES = [1, 0.5, 0.18] as const;

// "Alex Chen" → "Alex C."
function shortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  const first = parts[0] ?? '';
  const lastInit = parts[1]?.[0] ?? '';
  return lastInit ? `${first} ${lastInit}.` : first;
}

function ActivityRow({ item, opacity }: { item: ActivityItem; opacity: number }) {
  const truncSubject = item.subject.length > 30 ? item.subject.slice(0, 28) + '…' : item.subject;
  return (
    <div
      className="proj-activity-row"
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '3.5px 0',
        opacity,
        transition: 'opacity 0.38s ease',
        overflow: 'hidden',
        minWidth: 0,
      }}
    >
      {/* Type dot */}
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: TYPE_DOT[item.type],
        flexShrink: 0,
      }} />

      {/* Mini avatar */}
      <Avatar name={item.actor} size={17} />


      {/* "Alex C. merged" */}
      <span style={{ fontSize: 11, color: '#374151', fontWeight: 500, flexShrink: 0 }}>
        {shortName(item.actor)}
      </span>
      <span style={{ fontSize: 11, color: '#9ca3af', flexShrink: 0 }}>
        {item.action}
      </span>

      {/* Ticket ID badge — Jira-style */}
      <span style={{
        fontSize: 10, fontWeight: 700,
        fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
        color: '#4f46e5',
        background: '#eef2ff',
        border: '1px solid #c7d2fe',
        borderRadius: 3,
        padding: '1px 5px',
        flexShrink: 0,
        letterSpacing: '0.01em',
        whiteSpace: 'nowrap',
      }}>
        {item.ticketId}
      </span>

      {/* Subject */}
      <span style={{
        fontSize: 11, color: '#6b7280',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        flex: 1, minWidth: 0,
      }} title={item.subject}>
        {truncSubject}
      </span>

      {/* Timestamp */}
      <span style={{
        fontSize: 10, color: '#d1d5db',
        flexShrink: 0, whiteSpace: 'nowrap',
      }}>
        {item.timeLabel}
      </span>
    </div>
  );
}

// ─── ActivityFeed ─────────────────────────────────────────────────────────────

function ActivityFeed({ project, staggerMs }: { project: ProjectSummary; staggerMs: number }) {
  const allItems = useMemo(() => getActivityItems(project), [project]);
  const visible = useActivityRotation(allItems, staggerMs);

  if (visible.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#e5e7eb' }}>No recent activity</span>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0, overflow: 'hidden' }}>
      {visible.map((item, i) => (
        <ActivityRow
          key={item.id}
          item={item}
          opacity={ROW_OPACITIES[i] ?? 0.1}
        />
      ))}
    </div>
  );
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

// ─── StatusChip ───────────────────────────────────────────────────────────────

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

// ─── ProjectCard ──────────────────────────────────────────────────────────────

function ProjectCard({ project, cardIndex, onClick }: {
  project: ProjectSummary;
  cardIndex: number;
  onClick: () => void;
}) {
  const rawStatus = (project.status ?? 'unknown').toLowerCase().replace(/ /g, '_');
  const colors = STATUS_COLORS[rawStatus] ?? STATUS_COLORS['planning']!;
  const topNames = project.topContributorNames ?? [];
  const activityDot = presenceColor(project.lastActivityAt);
  const activityLabel = relativeTime(project.lastActivityAt ?? project.createdAt);
  const overflow = project.contributorCount - topNames.length;
  // Stagger: 8 offsets × 525ms spread rotations across one ROTATE_MS cycle.
  const staggerMs = (cardIndex % 8) * 525;

  return (
    <div
      onClick={onClick}
      style={{
        background: '#fff',
        border: '1.5px solid #e5e7eb',
        borderTop: `3px solid ${colors.accent}`,
        borderRadius: 10,
        padding: '14px 16px 12px',
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 10,
        transition: 'box-shadow 0.15s, transform 0.1s',
        minHeight: 190,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)';
        (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)';
        (e.currentTarget as HTMLElement).style.borderColor = colors.border;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = 'none';
        (e.currentTarget as HTMLElement).style.transform = 'none';
        (e.currentTarget as HTMLElement).style.borderColor = '#e5e7eb';
      }}
    >
      {/* Title + status */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: '0 0 3px', fontSize: 13.5, fontWeight: 700, color: '#111827', lineHeight: 1.35 }}>
            {project.name}
          </h3>
          <span style={{
            fontSize: 10,
            fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
            color: '#9ca3af',
            letterSpacing: '0.02em',
          }}>
            {project.id}
          </span>
        </div>
        <StatusChip status={project.status} />
      </div>

      {/* Live activity ticker */}
      <ActivityFeed project={project} staggerMs={staggerMs} />

      {/* Footer: avatars + presence */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 8, borderTop: '1px solid #f3f4f6', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {topNames.length > 0 ? (
            <AvatarGroup names={topNames} maxVisible={5} size={24} />
          ) : (
            <span style={{ fontSize: 12, color: '#9ca3af' }}>
              <strong style={{ color: '#374151' }}>{project.contributorCount}</strong> contributors
            </span>
          )}
          {topNames.length > 0 && overflow > 0 && (
            <span style={{ fontSize: 11, color: '#9ca3af' }}>+{overflow} more</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: activityDot, flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>{activityLabel}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

// ─── List-view row ────────────────────────────────────────────────────────────

// Shared column template — must match header exactly.
const LIST_COLS = '3px 1fr 132px 188px 82px';

function ProjectListRow({ project, onClick }: { project: ProjectSummary; onClick: () => void }) {
  const rawStatus = (project.status ?? 'unknown').toLowerCase().replace(/ /g, '_');
  const colors = STATUS_COLORS[rawStatus] ?? STATUS_COLORS['planning']!;
  const topNames = project.topContributorNames ?? [];
  const activityDot = presenceColor(project.lastActivityAt);
  const activityLabel = relativeTime(project.lastActivityAt ?? project.createdAt);
  const overflow = project.contributorCount - topNames.length;
  const key = deriveProjectKey(project.id, project.name);
  return (
    <div
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: LIST_COLS,
        alignItems: 'center',
        gap: 0,
        padding: '0 16px',
        background: '#fff',
        borderBottom: '1px solid #f3f4f6',
        cursor: 'pointer',
        transition: 'background 0.1s',
        minHeight: 52,
      }}
      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = '#f9fafb'}
      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = '#fff'}
    >
      {/* Accent bar */}
      <div style={{ width: 3, height: 36, borderRadius: 2, background: colors.accent }} />

      {/* Name + slug — left gap from accent bar, right gap from Status */}
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

      {/* Team avatars — fixed column */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {topNames.length > 0 ? (
          <AvatarGroup names={topNames.slice(0, 3)} maxVisible={4} size={22} />
        ) : (
          <span style={{ fontSize: 11, color: '#9ca3af' }}>{project.contributorCount} people</span>
        )}
        {topNames.length > 0 && overflow > 0 && (
          <span style={{ fontSize: 10, color: '#9ca3af' }}>+{overflow}</span>
        )}
      </div>

      {/* Updated — fixed column, right-aligned within cell */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: activityDot, flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>{activityLabel}</span>
      </div>
    </div>
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
          <div key={i} style={{ height: 190, borderRadius: 10, background: '#f3f4f6', animation: 'pulse 1.4s ease-in-out infinite' }} />
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
    <>
      <style>{`
        @keyframes projActivityIn {
          from { opacity: 0; transform: translateY(-7px); }
          to   { transform: translateY(0); }
        }
        .proj-activity-row {
          animation: projActivityIn 0.25s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
      `}</style>

      <div style={{ padding: '0 0 40px' }}>
        {/* ── Page header ── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px', color: '#111827' }}>Projects</h1>
            <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
              Epics, features, stories and decisions across the organization.
            </p>
          </div>
          {/* Grid / List toggle */}
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
        </div>

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
              <span style={{ fontSize: 10.5, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Team</span>
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
            {filtered.map((project, idx) => (
              <ProjectCard
                key={project.id}
                project={project}
                cardIndex={idx}
                onClick={() => navigate(`/iq/projects/${project.id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export default ProjectsPage;
