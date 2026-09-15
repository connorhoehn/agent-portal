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
import { useNavigate } from 'react-router';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  Inline,
  InlineAlert,
  PageSection,
  Stack,
  StatCard,
  StatusDot,
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
import { T } from './Text';
import { parsePgTimestampAsUtc } from '../../lib/pgTimestamp';
import { WindowPicker } from './WindowPicker';

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
        <Inline align="center" gap="sm">
          <WindowPicker options={WINDOW_OPTIONS} value={windowIdx} onChange={setWindowIdx} />
          <Button variant="secondary" size="sm" onClick={refreshTimeline} title="Refresh now">
            Refresh
          </Button>
        </Inline>
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
        <Inline gap="sm" align="center" wrap className="text-[12px] text-text-secondary">
          <SeverityDot severity={criticalCount > 0 ? 'critical' : warningCount > 0 ? 'warning' : 'ok'} />
          <T>
            {activeAlarms.length === 0
              ? 'no active alarms'
              : `${activeAlarms.length} active alarm${activeAlarms.length === 1 ? '' : 's'}`}
          </T>
          <T className="text-text-tertiary">·</T>
          <T>
            <strong>{hitl?.pendingCount ?? 0}</strong> pending approval
            {hitl?.pendingCount === 1 ? '' : 's'}
          </T>
          <T className="text-text-tertiary">·</T>
          <T>
            last incident {lastIncident ? timeAgo(lastIncident) : '—'}
          </T>
        </Inline>
      </Card>

      {/* Active alarms */}
      <Card padding="md">
        <CardHeader title="Active Alarms" subtitle="computed from last 1h of signals · 15s refresh" />
        {activeAlarms.length === 0 ? (
          <Inline gap="sm" align="center" className="py-1.5 px-1">
            <SeverityDot severity="ok" />
            <T className="text-[12px] text-text-secondary">
              All clear · all signals within thresholds
            </T>
          </Inline>
        ) : (
          <Stack gap="sm">
            {activeAlarms.map((a) => (
              <AlarmChip key={a.name} alarm={a} />
            ))}
          </Stack>
        )}
      </Card>

      {/* Timeline composed chart */}
      <Card padding="md">
        <CardHeader
          title="Incident Timeline"
          subtitle={`errors = real failures (guardrail / schema-invalid) · judge P05 = answer-quality floor · drift · cost · deploys · bucket ${win.bucket}m · ${win.label}`}
          action={
            deployLines.length > 0 ? (
              <T className="text-[11px] text-text-tertiary">
                <T className="text-warning">↑</T> deploy markers
              </T>
            ) : undefined
          }
        />
        {chartData.length === 0 ? (
          <EmptyState text="No invocations in this window yet — timeline activates after the first sampled call." />
        ) : (
          <Stack className="w-full h-[320px]">
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
                    const label = String(name ?? '');
                    const n = typeof value === 'number' ? value : Number(value);
                    // A missing signal (e.g. no judge score in the bucket) reads
                    // as an em dash, never NaN — quality and failures are
                    // distinct stories and neither is fabricated when absent.
                    if (!Number.isFinite(n)) return ['—', label];
                    if (label.startsWith('cost')) return [n.toFixed(4), label];
                    if (label.startsWith('errors')) return [String(n), label];
                    // drift P95 / judge P05 are 0..1 scores.
                    return [n.toFixed(3), label];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} iconType="circle" />

                <Bar
                  yAxisId="right"
                  dataKey="errors"
                  name="errors (failures)"
                  fill="var(--color-danger)"
                  opacity={0.35}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="judgeP05"
                  name="judge P05 (quality)"
                  stroke="var(--color-success)"
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
                  stroke="var(--color-danger)"
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
                  stroke="var(--color-brand)"
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
                    stroke="var(--color-warning)"
                    strokeDasharray="4 4"
                    label={{
                      value: d.markerLabel,
                      position: 'insideTopRight',
                      style: { fontSize: 10, fill: 'var(--color-warning)' },
                    }}
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </Stack>
        )}
      </Card>

      {/* HITL SLA card + Recent events — side-by-side on wide, stacked on narrow */}
      <Inline gap="lg" wrap align="start">
        <Stack className="flex-1 min-w-[280px]">
          <Card padding="md">
            <CardHeader title="HITL SLA" subtitle={`approval-queue health · window ${win.label}`} />
            {hitl ? (
              <HitlSlaBody hitl={hitl} onViewQueue={() => navigate('/admin/observability/approvals')} />
            ) : (
              <EmptyState text="Loading approval-queue stats…" />
            )}
          </Card>
        </Stack>

        <Stack className="flex-[2] min-w-0">
          <Card padding="md">
            <CardHeader
              title="Recent Events"
              subtitle={`deploys · alarms · HITL · judge regressions · ${events.length} event${events.length === 1 ? '' : 's'}`}
            />
            {events.length === 0 ? (
              <EmptyState text="No recent events." />
            ) : (
              <Stack gap="xs" className="max-h-[420px] overflow-y-auto">
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
              </Stack>
            )}
          </Card>
        </Stack>
      </Inline>
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
  const alertTone = alarm.severity === 'critical' ? 'error'
    : alarm.severity === 'warning' ? 'warning'
    : alarm.severity === 'unknown' ? 'info'
    : 'success';
  return (
    <InlineAlert tone={alertTone}>
      <Stack gap="none">
        <Inline gap="sm" align="center" wrap>
          <T className="text-[12px] font-semibold font-mono">{alarm.name}</T>
          <Chip tone={tone} size="xs">{alarm.severity}</Chip>
        </Inline>
        <T className="text-[11px] text-text-secondary">{alarm.reason}</T>
      </Stack>
    </InlineAlert>
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
    <Stack gap="md">
      <Inline align="baseline" gap="md" wrap>
        <StatCard label="Pending" value={hitl.pendingCount} />
        {oldestMin != null && oldestMin >= 5 && (
          <Chip tone="warning" size="sm">
            oldest {oldestMin}m
          </Chip>
        )}
      </Inline>
      <Inline gap="xs" wrap>
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
      </Inline>
      <Button variant="secondary" size="sm" className="mt-3 self-start" onClick={onViewQueue} type="button">
        View queue →
      </Button>
    </Stack>
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
  const dotColor = event.severity === 'critical'
    ? 'var(--color-danger)'
    : event.severity === 'warning'
    ? 'var(--color-warning)'
    : 'var(--color-success)';
  const glyphClass = event.severity === 'critical'
    ? 'text-danger'
    : event.severity === 'warning'
    ? 'text-warning'
    : 'text-text-secondary';
  return (
    <Inline
      align="center"
      gap="sm"
      className={`px-2 py-1.5 rounded-sm border-b border-border ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
      onClick={clickable ? onClick : undefined}
      title={clickable ? 'Open invocation detail' : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      } : undefined}
    >
      <T className={`text-[13px] w-3.5 text-center shrink-0 ${glyphClass}`}>{EVENT_GLYPH[event.kind]}</T>
      <StatusDot color={dotColor} size="xs" />
      <Stack gap="none" className="min-w-0 flex-1">
        <T as="div" className="text-[12px] font-medium truncate">{event.title}</T>
        {event.detail && <T as="div" className="text-[11px] text-text-tertiary truncate">{event.detail}</T>}
      </Stack>
      <T className="text-[11px] text-text-tertiary font-mono whitespace-nowrap shrink-0">
        {new Date(event.ts).toLocaleTimeString()}
      </T>
      {tone === 'danger' && <Chip tone="danger" size="xs">crit</Chip>}
    </Inline>
  );
}

function SeverityDot({
  severity,
}: {
  severity: 'critical' | 'warning' | 'ok' | 'unknown';
}) {
  const color = severity === 'critical'
    ? 'var(--color-danger)'
    : severity === 'warning'
    ? 'var(--color-warning)'
    : 'var(--color-success)';
  return <StatusDot color={color} size="sm" />;
}


function EmptyState({ text }: { text: string }) {
  return (
    <T as="div" className="p-6 text-center text-[12px] text-text-tertiary">
      {text}
    </T>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function shortTime(iso: string, hours: number): string {
  const d = parsePgTimestampAsUtc(iso) ?? new Date(Number.NaN);
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

export default OnCallPage;
