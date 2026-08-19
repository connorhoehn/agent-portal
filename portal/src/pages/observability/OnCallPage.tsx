// On-call / incident-response dashboard. The view an AI EA opens at 3am when
// a drift alarm fires.
//
// Composes 5 signals into one timeline so a researcher can correlate
// "judge dropped at 03:14, drift spiked, and there was a deploy 12 minutes
// prior" — that's the correlation that solves an incident.
//
// Data sources (all under /api/observability/oncall):
//   GET /timeline?windowHours=&bucketMin=     — buckets + deployMarkers + alarms
//   GET /alarms                               — synthesized alarm state
//   GET /hitl-sla?windowHours=                — pending depth + decision percentiles
//   GET /recent-events?limit=                 — unified deploy/alarm/hitl feed
//
// Polling: 15s for the page (operational), 30s for the events feed.

import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router';
import {
  Card,
  Chip,
  PageSection,
} from '@connorhoehnslalom/ui-components/shared';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from 'recharts';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';

// ── API contracts (mirrors middleware/src/routes/oncall.ts) ────────────────

interface TimelineBucket {
  bucketStart: string;
  driftP95: number | null;
  judgeP05: number | null;
  errorRate: number;
  hitlPending: number;
  hitlDecided: number;
  costUsd: number;
  invocations: number;
}

interface DeployMarker {
  registeredAt: string;
  agentId: string;
  promptVersion: string;
  notes: string | null;
}

interface AlarmState {
  name: string;
  severity: 'critical' | 'warning' | 'ok' | 'unknown';
  reason: string;
  firedAt: string | null;
  affectedAgent: string | null;
}

interface TimelineResponse {
  buckets: TimelineBucket[];
  deployMarkers: DeployMarker[];
  activeAlarms: AlarmState[];
}

interface HitlSlaResponse {
  pendingCount: number;
  oldestPendingAgeSeconds: number | null;
  decidedInWindow: number;
  p50DecisionSeconds: number;
  p99DecisionSeconds: number;
  expiredInWindow: number;
  slaCompliantFraction: number;
  slaThresholdSeconds: number;
}

type EventKind = 'deploy' | 'alarm' | 'hitl-decided' | 'hitl-expired' | 'judge-spike';

interface RecentEvent {
  ts: string;
  kind: EventKind;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  relatedInvocationId?: string;
  relatedAgentId?: string;
}

// ── Window picker (mirrors DriftPage so the operator's muscle memory works) ─

const WINDOW_OPTIONS: Array<{ label: string; hours: number; bucket: number }> = [
  { label: '1h',  hours: 1,   bucket: 5  },
  { label: '6h',  hours: 6,   bucket: 15 },
  { label: '24h', hours: 24,  bucket: 60 },
  { label: '7d',  hours: 168, bucket: 360 },
];

function OnCallPage() {
  const navigate = useNavigate();
  const [windowIdx, setWindowIdx] = useState(2); // 24h default
  const win = WINDOW_OPTIONS[windowIdx]!;

  // Timeline (drift/judge/cost/errors + deploy markers + alarms in one shot).
  // 15s poll — faster than other pages, this is operational.
  const { data: timeline, error: timelineError, refresh: refreshTimeline } = useFetch<TimelineResponse>(
    `/api/observability/oncall/timeline?windowHours=${win.hours}&bucketMin=${win.bucket}`,
    15_000,
  );

  // HITL SLA — 30s is fine, this isn't a fast-moving number.
  const { data: hitl } = useFetch<HitlSlaResponse>(
    `/api/observability/oncall/hitl-sla?windowHours=${win.hours}`,
    30_000,
  );

  // Unified event feed.
  const { data: eventsData } = useFetch<{ events: RecentEvent[] }>(
    `/api/observability/oncall/recent-events?limit=50`,
    30_000,
  );

  const buckets = useMemo(() => timeline?.buckets ?? [], [timeline]);
  const deployMarkers = useMemo(() => timeline?.deployMarkers ?? [], [timeline]);
  const alarms = useMemo(() => timeline?.activeAlarms ?? [], [timeline]);
  const events = useMemo(() => eventsData?.events ?? [], [eventsData]);

  // Derived: alarm counts for header subline.
  const activeAlarms = alarms.filter((a) => a.severity !== 'ok');
  const criticalCount = activeAlarms.filter((a) => a.severity === 'critical').length;
  const warningCount = activeAlarms.filter((a) => a.severity === 'warning').length;

  // Last-incident-ago: latest alarm fire OR latest judge-spike event.
  const lastIncident = useMemo(() => {
    const ts: string[] = [];
    for (const a of activeAlarms) if (a.firedAt) ts.push(a.firedAt);
    for (const e of events) if (e.kind === 'alarm' || e.kind === 'judge-spike') ts.push(e.ts);
    if (ts.length === 0) return null;
    return ts.sort().reverse()[0]!;
  }, [activeAlarms, events]);

  // Reshape timeline buckets for Recharts. Add a friendly label.
  const chartData = useMemo(() => {
    return buckets.map((b) => ({
      bucketStart: b.bucketStart,
      label: shortTime(b.bucketStart, win.hours),
      driftP95: b.driftP95 ?? null,
      judgeP05: b.judgeP05 ?? null,
      costUsd: Number(b.costUsd.toFixed(4)),
      errors: Math.round(b.errorRate * b.invocations),
      invocations: b.invocations,
    }));
  }, [buckets, win.hours]);

  // Map deploy timestamps to nearest bucket label for ReferenceLine x-coords.
  const deployLines = useMemo(() => {
    if (chartData.length === 0 || deployMarkers.length === 0) return [];
    const bucketTimes = chartData.map((c) => ({ label: c.label, t: Date.parse(c.bucketStart) }));
    const out: Array<{ label: string; markerLabel: string; agentId: string }> = [];
    for (const dm of deployMarkers) {
      const dt = Date.parse(dm.registeredAt);
      if (!Number.isFinite(dt)) continue;
      // Snap to the nearest bucket whose start is <= dt; fall back to first.
      let chosen = bucketTimes[0]!;
      for (const b of bucketTimes) {
        if (b.t <= dt) chosen = b;
      }
      out.push({
        label: chosen.label,
        markerLabel: `${dm.agentId}@${dm.promptVersion.slice(0, 6)}`,
        agentId: dm.agentId,
      });
    }
    return out;
  }, [chartData, deployMarkers]);

  return (
    <PageSection
      title="On-Call"
      description={undefined}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <WindowPicker value={windowIdx} onChange={setWindowIdx} />
          <button onClick={refreshTimeline} style={refreshBtn} title="Refresh now">
            Refresh
          </button>
        </div>
      }
    >
      {/* Alarms and the incident timeline both come from here. An empty
          timeline during an outage would read as "nothing is wrong". */}
      {timelineError && (
        <UnavailableNotice
          error={timelineError}
          what="the on-call timeline"
          source="Alarms and incidents are computed from Aurora and CloudWatch"
          onRetry={refreshTimeline}
          className="mb-4"
        />
      )}

      {/* Status strip */}
      <Card padding="md">
        <div style={subline}>
          <SeverityDot severity={criticalCount > 0 ? 'critical' : warningCount > 0 ? 'warning' : 'ok'} />
          <span>
            {activeAlarms.length === 0
              ? 'no active alarms'
              : `${activeAlarms.length} active alarm${activeAlarms.length === 1 ? '' : 's'}`}
          </span>
          <span style={dotSep}>·</span>
          <span>
            <strong>{hitl?.pendingCount ?? 0}</strong> pending approval
            {hitl?.pendingCount === 1 ? '' : 's'}
          </span>
          <span style={dotSep}>·</span>
          <span>
            last incident {lastIncident ? timeAgo(lastIncident) : '—'}
          </span>
        </div>
      </Card>

      {/* Active alarms */}
      <Card padding="md">
        <h3 style={h3}>
          Active Alarms{' '}
          <span style={hint}>computed from last 1h of signals · 15s refresh</span>
        </h3>
        {activeAlarms.length === 0 ? (
          <div style={allClearRow}>
            <SeverityDot severity="ok" />
            <span style={allClearText}>
              All clear · all signals within thresholds
            </span>
          </div>
        ) : (
          <div style={alarmList}>
            {activeAlarms.map((a) => (
              <AlarmChip key={a.name} alarm={a} />
            ))}
          </div>
        )}
      </Card>

      {/* Timeline composed chart */}
      <Card padding="md">
        <div style={headerRow}>
          <h3 style={h3}>
            Incident Timeline{' '}
            <span style={hint}>
              drift · judge · cost · errors · deploys · bucket {win.bucket}m · {win.label}
            </span>
          </h3>
          {deployLines.length > 0 && (
            <span style={legendHint}>
              <span style={{ color: 'var(--color-warning, #f59e0b)' }}>↑</span> deploy markers
            </span>
          )}
        </div>
        {chartData.length === 0 ? (
          <EmptyState text="No invocations in this window yet — timeline activates after the first sampled call." />
        ) : (
          <div style={{ width: '100%', height: 320 }}>
            <ResponsiveContainer>
              <ComposedChart
                data={chartData}
                margin={{ top: 8, right: 48, bottom: 4, left: 0 }}
              >
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} />
                <YAxis
                  yAxisId="left"
                  domain={[0, 1]}
                  tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                  width={36}
                  label={{
                    value: 'score',
                    angle: -90,
                    position: 'insideLeft',
                    style: { fontSize: 10, fill: 'var(--color-text-tertiary)' },
                  }}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }}
                  width={48}
                  label={{
                    value: '$ / errors',
                    angle: 90,
                    position: 'insideRight',
                    style: { fontSize: 10, fill: 'var(--color-text-tertiary)' },
                  }}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, border: '1px solid var(--color-border)' }}
                  formatter={(value, name) => {
                    const n = typeof value === 'number' ? value : Number(value);
                    if (!Number.isFinite(n)) return [String(value ?? '—'), String(name ?? '')];
                    if (name === 'cost ($)') return [n.toFixed(4), String(name)];
                    if (name === 'errors') return [String(n), String(name)];
                    return [n.toFixed(3), String(name)];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} iconType="circle" />

                <Bar
                  yAxisId="right"
                  dataKey="errors"
                  name="errors"
                  fill="var(--color-danger, #ef4444)"
                  opacity={0.35}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="judgeP05"
                  name="judge P05"
                  stroke="#10b981"
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="driftP95"
                  name="drift P95"
                  stroke="#ef4444"
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="costUsd"
                  name="cost ($)"
                  stroke="#6366f1"
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />

                {deployLines.map((d, i) => (
                  <ReferenceLine
                    key={`${d.label}-${i}`}
                    yAxisId="left"
                    x={d.label}
                    stroke="var(--color-warning, #f59e0b)"
                    strokeDasharray="4 4"
                    label={{
                      value: d.markerLabel,
                      position: 'insideTopRight',
                      style: { fontSize: 10, fill: 'var(--color-warning, #f59e0b)' },
                    }}
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* HITL SLA card + Recent events — side-by-side on wide, stacked on narrow */}
      <div style={twoColRow}>
        <Card padding="md">
          <h3 style={h3}>
            HITL SLA{' '}
            <span style={hint}>approval-queue health · window {win.label}</span>
          </h3>
          {hitl ? (
            <HitlSlaBody hitl={hitl} onViewQueue={() => navigate('/admin/observability/approvals')} />
          ) : (
            <EmptyState text="Loading approval-queue stats…" />
          )}
        </Card>

        <Card padding="md">
          <h3 style={h3}>
            Recent Events{' '}
            <span style={hint}>
              deploys · alarms · HITL · judge regressions · {events.length} event{events.length === 1 ? '' : 's'}
            </span>
          </h3>
          {events.length === 0 ? (
            <EmptyState text="No recent events." />
          ) : (
            <div style={eventList}>
              {events.map((e, i) => (
                <EventRow
                  key={`${e.ts}-${i}`}
                  event={e}
                  onClick={() => {
                    if (e.relatedInvocationId) {
                      navigate(`/admin/observability/invocations/${e.relatedInvocationId}`);
                    }
                  }}
                />
              ))}
            </div>
          )}
        </Card>
      </div>
    </PageSection>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function AlarmChip({ alarm }: { alarm: AlarmState }) {
  // 'unknown' must not fall through to the success branch. A probe that could
  // not run rendered as a green tick here, which is the same false all-clear
  // the server used to emit.
  const tone = alarm.severity === 'critical' ? 'danger'
    : alarm.severity === 'warning' ? 'warning'
    : alarm.severity === 'unknown' ? 'neutral'
    : 'success';
  const glyph = alarm.severity === 'critical' ? '✗'
    : alarm.severity === 'warning' ? '⚠'
    : alarm.severity === 'unknown' ? '?'
    : '✓';
  return (
    <div style={alarmChipBox(alarm.severity)}>
      <span style={alarmGlyph(alarm.severity)}>{glyph}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <div style={alarmTitleRow}>
          <span style={alarmName}>{alarm.name}</span>
          <Chip tone={tone} size="xs">{alarm.severity}</Chip>
        </div>
        <span style={alarmReason}>{alarm.reason}</span>
      </div>
    </div>
  );
}

function HitlSlaBody({
  hitl,
  onViewQueue,
}: {
  hitl: HitlSlaResponse;
  onViewQueue: () => void;
}) {
  const oldestMin = hitl.oldestPendingAgeSeconds == null
    ? null
    : Math.floor(hitl.oldestPendingAgeSeconds / 60);
  const slaPct = (hitl.slaCompliantFraction * 100).toFixed(1);
  const slaTone: 'success' | 'warning' | 'danger' =
    hitl.slaCompliantFraction >= 0.95 ? 'success'
      : hitl.slaCompliantFraction >= 0.85 ? 'warning'
      : 'danger';

  return (
    <div style={hitlBody}>
      <div style={hitlBigRow}>
        <div style={hitlBigNumber}>
          <div style={hitlBigDigit}>{hitl.pendingCount}</div>
          <div style={hitlBigLabel}>pending</div>
        </div>
        {oldestMin != null && oldestMin >= 5 && (
          <div style={hitlAgeBox}>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>oldest</span>
            <span style={hitlAgeText}>{oldestMin}m</span>
          </div>
        )}
      </div>
      <div style={hitlChipRow}>
        <Chip tone="neutral" size="xs">
          p50 {hitl.p50DecisionSeconds.toFixed(1)}s
        </Chip>
        <Chip tone="neutral" size="xs">
          p99 {hitl.p99DecisionSeconds.toFixed(1)}s
        </Chip>
        <Chip tone={slaTone} size="xs">
          SLA {slaPct}%
        </Chip>
        {hitl.expiredInWindow > 0 && (
          <Chip tone="danger" size="xs">
            {hitl.expiredInWindow} expired
          </Chip>
        )}
      </div>
      <div style={{ marginTop: 12 }}>
        <button onClick={onViewQueue} style={viewQueueBtn} type="button">
          View queue →
        </button>
      </div>
    </div>
  );
}

const EVENT_GLYPH: Record<EventKind, string> = {
  'deploy': '↑',
  'alarm': '⚠',
  'hitl-decided': '✓',
  'hitl-expired': '✗',
  'judge-spike': '↓',
};

function EventRow({ event, onClick }: { event: RecentEvent; onClick: () => void }) {
  const tone: 'success' | 'warning' | 'danger' | 'info' =
    event.severity === 'critical' ? 'danger'
      : event.severity === 'warning' ? 'warning'
      : 'info';
  const clickable = !!event.relatedInvocationId;
  return (
    <div
      onClick={clickable ? onClick : undefined}
      style={{
        ...eventRowStyle,
        cursor: clickable ? 'pointer' : 'default',
      }}
      title={clickable ? 'Open invocation detail' : undefined}
    >
      <span style={eventGlyph(event.severity)}>{EVENT_GLYPH[event.kind]}</span>
      <SeverityDot severity={event.severity === 'info' ? 'ok' : event.severity} />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
        <span style={eventTitle}>{event.title}</span>
        {event.detail && <span style={eventDetail}>{event.detail}</span>}
      </div>
      <span style={eventTs}>{new Date(event.ts).toLocaleTimeString()}</span>
      {tone === 'danger' && <Chip tone="danger" size="xs">crit</Chip>}
    </div>
  );
}

function SeverityDot({
  severity,
}: {
  severity: 'critical' | 'warning' | 'ok' | 'unknown';
}) {
  const color = severity === 'critical'
    ? 'var(--color-danger, #ef4444)'
    : severity === 'warning'
    ? 'var(--color-warning, #f59e0b)'
    : 'var(--color-success, #10b981)';
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        display: 'inline-block',
        flexShrink: 0,
      }}
    />
  );
}

function WindowPicker({ value, onChange }: { value: number; onChange: (i: number) => void }) {
  return (
    <div style={{ display: 'inline-flex', gap: 4 }}>
      {WINDOW_OPTIONS.map((w, i) => (
        <button
          key={w.label}
          onClick={() => onChange(i)}
          style={{
            fontSize: 11,
            padding: '4px 10px',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            background: i === value ? 'var(--color-primary)' : 'var(--color-surface)',
            color: i === value ? 'white' : 'var(--color-text-secondary)',
            cursor: 'pointer',
            fontWeight: i === value ? 500 : 400,
          }}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
      {text}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function shortTime(iso: string, hours: number): string {
  const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return iso;
  if (hours <= 48) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString([], { hour: '2-digit' });
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const dt = Date.now() - t;
  const min = Math.floor(dt / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

// ── Styles ─────────────────────────────────────────────────────────────────

const headerRow: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  marginBottom: 8, gap: 12, flexWrap: 'wrap',
};
const h3: CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 12 };
const subline: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 8,
  fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4, flexWrap: 'wrap',
};
const hint: CSSProperties = { fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 };
const legendHint: CSSProperties = { fontSize: 11, color: 'var(--color-text-tertiary)' };
const dotSep: CSSProperties = { color: 'var(--color-text-tertiary)' };

const refreshBtn: CSSProperties = {
  fontSize: 11, padding: '4px 10px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-secondary)',
  cursor: 'pointer',
};

const allClearRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '6px 4px',
};
const allClearText: CSSProperties = {
  fontSize: 12, color: 'var(--color-text-secondary)',
};
const alarmList: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8,
};

const alarmChipBox = (sev: AlarmState['severity']): CSSProperties => ({
  display: 'flex', alignItems: 'flex-start', gap: 10,
  padding: '8px 12px',
  border: `1px solid ${
    sev === 'critical'
      ? 'var(--color-danger, #ef4444)'
      : sev === 'warning'
      ? 'var(--color-warning, #f59e0b)'
      : 'var(--color-border)'
  }`,
  borderRadius: 'var(--radius-sm, 4px)',
  background: sev === 'critical'
    ? 'rgba(239,68,68,0.06)'
    : sev === 'warning'
    ? 'rgba(245,158,11,0.06)'
    : 'transparent',
});

const alarmGlyph = (sev: AlarmState['severity']): CSSProperties => ({
  fontSize: sev === 'critical' ? 18 : 14,
  lineHeight: 1,
  color: sev === 'critical'
    ? 'var(--color-danger, #ef4444)'
    : sev === 'warning'
    ? 'var(--color-warning, #f59e0b)'
    : 'var(--color-success, #10b981)',
  flexShrink: 0,
  marginTop: 1,
});

const alarmTitleRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
};
const alarmName: CSSProperties = {
  fontSize: 12, fontWeight: 600,
  fontFamily: 'ui-monospace, monospace',
  color: 'var(--color-text-primary)',
};
const alarmReason: CSSProperties = {
  fontSize: 11, color: 'var(--color-text-secondary)',
};

const twoColRow: CSSProperties = {
  display: 'grid', gap: 24,
  gridTemplateColumns: 'minmax(280px, 1fr) minmax(0, 2fr)',
};

const hitlBody: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 12,
};
const hitlBigRow: CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap',
};
const hitlBigNumber: CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: 6,
};
const hitlBigDigit: CSSProperties = {
  fontSize: 32, fontWeight: 600, lineHeight: 1,
  fontFamily: 'ui-monospace, monospace',
};
const hitlBigLabel: CSSProperties = {
  fontSize: 11, color: 'var(--color-text-tertiary)',
};
const hitlAgeBox: CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: 4,
  padding: '4px 8px',
  border: '1px solid var(--color-warning, #f59e0b)',
  borderRadius: 'var(--radius-sm, 4px)',
  background: 'rgba(245,158,11,0.06)',
};
const hitlAgeText: CSSProperties = {
  fontSize: 16, fontWeight: 600,
  color: 'var(--color-warning, #f59e0b)',
  fontFamily: 'ui-monospace, monospace',
};
const hitlChipRow: CSSProperties = {
  display: 'flex', gap: 6, flexWrap: 'wrap',
};

const viewQueueBtn: CSSProperties = {
  fontSize: 11, padding: '4px 10px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'transparent',
  color: 'var(--color-primary, #6366f1)',
  cursor: 'pointer',
};

const eventList: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4,
  maxHeight: 420, overflowY: 'auto',
};
const eventRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 8px',
  borderRadius: 'var(--radius-sm, 4px)',
  borderBottom: '1px solid var(--color-border)',
};
const eventGlyph = (sev: RecentEvent['severity']): CSSProperties => ({
  fontSize: 13, lineHeight: 1, width: 14, textAlign: 'center',
  color: sev === 'critical'
    ? 'var(--color-danger, #ef4444)'
    : sev === 'warning'
    ? 'var(--color-warning, #f59e0b)'
    : 'var(--color-text-secondary)',
});
const eventTitle: CSSProperties = {
  fontSize: 12, fontWeight: 500,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const eventDetail: CSSProperties = {
  fontSize: 11, color: 'var(--color-text-tertiary)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const eventTs: CSSProperties = {
  fontSize: 11, color: 'var(--color-text-tertiary)',
  fontFamily: 'ui-monospace, monospace',
  whiteSpace: 'nowrap', flexShrink: 0,
};

export default OnCallPage;
