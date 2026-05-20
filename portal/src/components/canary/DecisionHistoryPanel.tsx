// DecisionHistoryPanel — right-side rail listing controller decisions newest
// first. Styled after the AgentFlowPage drawer.

import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useCanaryStore } from './canaryStore.js';
import type { ControllerAction, Decision } from './types.js';

const ACTION_COLORS: Record<ControllerAction, { bg: string; fg: string }> = {
  PROMOTE:               { bg: '#dcfce7', fg: '#166534' },
  ROLLBACK:              { bg: '#fee2e2', fg: '#991b1b' },
  HOLD:                  { bg: '#fef3c7', fg: '#92400e' },
  SKIPPED_OVERRIDE:      { bg: '#e0e7ff', fg: '#3730a3' },
  SKIPPED_COOLDOWN:      { bg: '#e2e8f0', fg: '#475569' },
  SKIPPED_NO_SAMPLES:    { bg: '#e2e8f0', fg: '#475569' },
};

function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString();
}

export function DecisionHistoryPanel(): React.ReactElement {
  const decisions = useCanaryStore((s) => s.recentDecisions);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastLenRef = useRef(0);

  // Auto-scroll to top whenever a new decision arrives — the newest row is
  // at index 0 in our display list (we reverse before rendering).
  useEffect(() => {
    if (decisions.length > lastLenRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
    lastLenRef.current = decisions.length;
  }, [decisions.length]);

  // Newest first.
  const ordered: Decision[] = decisions.slice().reverse();

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span style={titleStyle}>Decision history</span>
        <span style={countStyle}>{ordered.length}</span>
      </div>
      <div ref={scrollRef} style={listStyle}>
        {ordered.length === 0 ? (
          <div style={emptyStyle}>No decisions yet. Waiting for controller…</div>
        ) : (
          ordered.map((d, i) => <DecisionRow key={`${d.ts}-${i}`} d={d} />)
        )}
      </div>
    </div>
  );
}

function DecisionRow({ d }: { d: Decision }): React.ReactElement {
  const palette = ACTION_COLORS[d.action];
  return (
    <div style={rowStyle}>
      <div style={rowHeaderStyle}>
        <span style={timeStyle}>{fmtTime(d.ts)}</span>
        <span style={{ ...chipStyle, background: palette.bg, color: palette.fg }}>
          {d.action}
        </span>
      </div>
      <div style={transitionStyle}>
        <span style={transitionNumStyle}>B {d.from}%</span>
        <span style={arrowStyle}>→</span>
        <span style={transitionNumStyle}>{d.to}%</span>
        {d.deltaScore !== undefined && (
          <span style={deltaStyle} title="composite_b - composite_a">
            Δ {d.deltaScore >= 0 ? '+' : ''}
            {d.deltaScore.toFixed(2)}
          </span>
        )}
      </div>
      <div style={reasonStyle}>{d.reason}</div>
    </div>
  );
}

// ── Styles (mirrors AgentFlowPage drawer) ────────────────────────────────────

const panelStyle: CSSProperties = {
  width: 320,
  height: '100%',
  background: 'var(--color-surface, #fff)',
  borderLeft: '1px solid var(--color-border, #e2e8f0)',
  display: 'flex',
  flexDirection: 'column',
  flexShrink: 0,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
};

const titleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-text-primary, #0f172a)',
};

const countStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary, #94a3b8)',
  background: 'var(--color-bg, #f8fafc)',
  border: '1px solid var(--color-border, #e2e8f0)',
  padding: '1px 6px',
  borderRadius: 8,
};

const listStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '8px 0',
};

const emptyStyle: CSSProperties = {
  padding: '20px 14px',
  fontSize: 12,
  color: 'var(--color-text-tertiary, #94a3b8)',
  fontStyle: 'italic',
  textAlign: 'center',
};

const rowStyle: CSSProperties = {
  padding: '8px 14px',
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const rowHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};

const timeStyle: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--color-text-tertiary, #94a3b8)',
  fontVariantNumeric: 'tabular-nums',
};

const chipStyle: CSSProperties = {
  padding: '1px 6px',
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 4,
  letterSpacing: '0.03em',
};

const transitionStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  color: 'var(--color-text-secondary, #475569)',
  fontVariantNumeric: 'tabular-nums',
};

const transitionNumStyle: CSSProperties = {
  fontWeight: 500,
};

const arrowStyle: CSSProperties = {
  color: 'var(--color-text-tertiary, #94a3b8)',
};

const deltaStyle: CSSProperties = {
  marginLeft: 'auto',
  fontSize: 10.5,
  color: 'var(--color-text-tertiary, #94a3b8)',
  fontVariantNumeric: 'tabular-nums',
};

const reasonStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-secondary, #475569)',
  lineHeight: 1.4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
};
