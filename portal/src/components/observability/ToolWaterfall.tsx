// ToolWaterfall — gantt-style horizontal bar chart for tool calls within an
// invocation. Each row is one tool call; the bar's horizontal position is
// proportional to startedAt within the overall span; bar length is durationMs.
//
// Bar color:
//   success (green) — !errored
//   danger  (red)   — errored
//
// If durations don't sum cleanly (sub-ms or missing values), we fall back to
// a small visible width so the row is still selectable/readable. Empty input
// renders an empty-state message.

import { useState } from 'react';
import type { CSSProperties } from 'react';

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  startedAt: string;
  durationMs: number | null;
  errored: boolean;
  errorMessage?: string | null;
}

type Mode = 'timeline' | 'duration';

interface Props {
  toolCalls: ToolCall[];
}

const fmtDur = (ms: number | null): string => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}m`;
};

export function ToolWaterfall({ toolCalls }: Props) {
  // Researcher-friendly mode toggle:
  //   timeline — bars positioned on real time axis (includes "thinking gaps"
  //              between tool calls). Useful for spotting slow agent
  //              deliberation between calls.
  //   duration — bars start at 0 and scale to max duration. Useful when you
  //              don't care WHEN each tool fired, only how long it took.
  const [mode, setMode] = useState<Mode>('timeline');

  const calls = Array.isArray(toolCalls) ? toolCalls : [];

  if (calls.length === 0) {
    return (
      <div style={empty}>No tool calls recorded for this invocation.</div>
    );
  }

  // Compute the overall time span. Defensive: parse may NaN.
  const starts = calls.map((c) => Date.parse(c.startedAt));
  const ends = calls.map((c, i) =>
    starts[i] + (c.durationMs != null && Number.isFinite(c.durationMs) ? c.durationMs : 0),
  );
  const validStarts = starts.filter((s) => Number.isFinite(s));
  const validEnds = ends.filter((e) => Number.isFinite(e));
  const t0 = validStarts.length > 0 ? Math.min(...validStarts) : 0;
  const t1 = validEnds.length > 0 ? Math.max(...validEnds) : t0 + 1;
  const totalSpanMs = Math.max(1, t1 - t0);
  // For duration mode: normalize each bar against the longest call.
  const maxDurationMs = Math.max(
    1,
    ...calls.map((c) => (c.durationMs != null && Number.isFinite(c.durationMs) ? c.durationMs : 0)),
  );

  // Order by start time so the visual descends chronologically.
  const ordered = calls
    .map((c, i) => ({ call: c, start: starts[i], end: ends[i] }))
    .sort((a, b) => {
      const sa = Number.isFinite(a.start) ? a.start : 0;
      const sb = Number.isFinite(b.start) ? b.start : 0;
      return sa - sb;
    });

  return (
    <div style={container}>
      <div style={modeRow}>
        <button
          type="button"
          onClick={() => setMode('timeline')}
          style={modeBtn(mode === 'timeline')}
          title="Positions bars on real time. Gaps between bars = agent thinking time between tool calls."
        >
          By time
        </button>
        <button
          type="button"
          onClick={() => setMode('duration')}
          style={modeBtn(mode === 'duration')}
          title="Each bar starts at 0; width scaled to longest call. Use when you only care about which tool was slow."
        >
          By duration
        </button>
        <span style={modeHint}>
          {mode === 'timeline'
            ? 'Bars positioned on real time — gaps = agent deliberation.'
            : 'Bars normalized to longest call — pure duration ranking.'}
        </span>
      </div>
      <div style={axisRow}>
        <div style={axisGutter} />
        <div style={axisTrack}>
          <span style={axisLabelLeft}>0ms</span>
          <span style={axisLabelRight}>
            {fmtDur(mode === 'timeline' ? totalSpanMs : maxDurationMs)}
          </span>
        </div>
        <div style={axisDuration}>Duration</div>
      </div>
      {ordered.map(({ call, start, end }) => {
        const safeStart = Number.isFinite(start) ? start : t0;
        const safeEnd = Number.isFinite(end) ? end : safeStart;
        let leftPct: number;
        let rawPct: number;
        if (mode === 'timeline') {
          leftPct = ((safeStart - t0) / totalSpanMs) * 100;
          rawPct = ((safeEnd - safeStart) / totalSpanMs) * 100;
        } else {
          leftPct = 0;
          const dur = call.durationMs != null && Number.isFinite(call.durationMs)
            ? call.durationMs : 0;
          rawPct = (dur / maxDurationMs) * 100;
        }
        // Even short calls get a small visible width so the bar is selectable.
        const widthPct = Math.max(rawPct, 0.5);
        const bg = call.errored
          ? 'var(--color-danger, #ef4444)'
          : 'var(--color-success, #16a34a)';
        // Show label inside bar if width is decently large; otherwise outside.
        const labelInside = widthPct >= 18;
        const title = call.errored
          ? `${call.toolName} — ${call.errorMessage ?? 'errored'} (${fmtDur(call.durationMs)})`
          : `${call.toolName} (${fmtDur(call.durationMs)})`;

        return (
          <div key={call.toolCallId} style={barRow} title={title}>
            <div style={gutter} title={call.toolName}>
              {call.toolName}
            </div>
            <div style={track}>
              <div
                style={{
                  ...bar,
                  background: bg,
                  left: `${leftPct}%`,
                  width: `${widthPct}%`,
                }}
              >
                {labelInside && (
                  <span style={barLabelInside}>{call.toolName}</span>
                )}
              </div>
              {!labelInside && (
                <span
                  style={{
                    ...barLabelOutside,
                    left: `calc(${leftPct + widthPct}% + 6px)`,
                  }}
                >
                  {call.toolName}
                </span>
              )}
            </div>
            <div style={duration}>{fmtDur(call.durationMs)}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const container: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const modeRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginBottom: 8,
};

const modeHint: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--color-text-tertiary)',
  fontStyle: 'italic',
};

function modeBtn(active: boolean): CSSProperties {
  return {
    padding: '3px 10px',
    fontSize: 11,
    fontWeight: active ? 500 : 400,
    background: active ? 'var(--color-primary)' : 'var(--color-surface)',
    color: active ? 'white' : 'var(--color-text-secondary)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
  };
}

const axisRow: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '140px 1fr 80px',
  alignItems: 'center',
  gap: 8,
  fontSize: 10,
  color: 'var(--color-text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  fontWeight: 600,
  marginBottom: 4,
};

const axisGutter: CSSProperties = {};

const axisTrack: CSSProperties = {
  position: 'relative',
  height: 12,
  borderTop: '1px dashed var(--color-border)',
};

const axisLabelLeft: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
};

const axisLabelRight: CSSProperties = {
  position: 'absolute',
  right: 0,
  top: 0,
};

const axisDuration: CSSProperties = {
  textAlign: 'right',
};

const barRow: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '140px 1fr 80px',
  alignItems: 'center',
  gap: 8,
  height: 24,
  fontSize: 11,
};

const gutter: CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 11,
  color: 'var(--color-text-secondary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const track: CSSProperties = {
  position: 'relative',
  height: 18,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 3,
  overflow: 'hidden',
};

const bar: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  borderRadius: 2,
  display: 'flex',
  alignItems: 'center',
  paddingLeft: 6,
  paddingRight: 6,
  boxSizing: 'border-box',
  minWidth: 2,
};

const barLabelInside: CSSProperties = {
  color: '#fff',
  fontSize: 11,
  fontWeight: 500,
  fontFamily: 'ui-monospace, monospace',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const barLabelOutside: CSSProperties = {
  position: 'absolute',
  top: 2,
  fontSize: 11,
  fontFamily: 'ui-monospace, monospace',
  color: 'var(--color-text-secondary)',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
};

const duration: CSSProperties = {
  textAlign: 'right',
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontFamily: 'ui-monospace, monospace',
  whiteSpace: 'nowrap',
};

const empty: CSSProperties = {
  padding: 24,
  textAlign: 'center',
  fontSize: 12,
  color: 'var(--color-text-tertiary)',
};

export default ToolWaterfall;
