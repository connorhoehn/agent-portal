// DecisionHistoryPanel — right-side rail listing controller decisions newest
// first. Collapsible when empty (or manually toggled).

import { useEffect, useRef, useState, useCallback } from 'react';
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
  // Start expanded so users can see what the panel does.
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (decisions.length > lastLenRef.current) {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      // Auto-expand when the first decision arrives.
      if (lastLenRef.current === 0) setCollapsed(false);
    }
    lastLenRef.current = decisions.length;
  }, [decisions.length]);

  const ordered: Decision[] = decisions.slice().reverse();

  return (
    <div style={{ ...panelStyle, width: collapsed ? 44 : 320, transition: 'width 0.2s ease' }}>
      <div
        style={{ ...headerStyle, cursor: 'pointer', justifyContent: collapsed ? 'center' : 'space-between' }}
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? 'Expand decision history' : 'Collapse'}
      >
        {collapsed ? (
          <span style={{ fontSize: 13, color: 'var(--color-text-tertiary, #94a3b8)' }} title="Decision history">⟩</span>
        ) : (
          <>
            <span style={titleStyle}>Decision history</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={countStyle}>{ordered.length}</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary, #94a3b8)' }}>⟨</span>
            </div>
          </>
        )}
      </div>
      {!collapsed && (
        <div ref={scrollRef} style={listStyle}>
          {ordered.length === 0 ? (
            <div style={emptyStyle}>
              <p style={{ margin: '0 0 8px', lineHeight: 1.5 }}>
                The controller compares rolling A/B judge scores and automatically adjusts traffic — PROMOTE shifts more to B, ROLLBACK pins back to A, HOLD waits for more data.
              </p>
              <p style={{ margin: 0, lineHeight: 1.5 }}>
                Click <b>▶ Scenarios</b> in the toolbar, generate a set of people, then hit <b>Run all</b> to generate traffic and trigger decisions.
              </p>
            </div>
          ) : (
            ordered.map((d, i) => <DecisionRow key={`${d.ts}-${i}`} d={d} index={i} />)
          )}
        </div>
      )}
    </div>
  );
}

function DecisionRow({ d, index }: { d: Decision; index: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(index === 0); // newest starts expanded
  const palette = ACTION_COLORS[d.action];
  const toggle = useCallback(() => setExpanded(v => !v), []);

  return (
    <div style={{ ...rowStyle, cursor: 'pointer' }} onClick={toggle}>
      <div style={rowHeaderStyle}>
        <span style={timeStyle}>{fmtTime(d.ts)}</span>
        <span style={{ ...chipStyle, background: palette.bg, color: palette.fg }}>
          {d.action}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--color-text-tertiary, #94a3b8)' }}>
          {expanded ? '▲' : '▼'}
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
      {expanded && (
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ ...reasonStyle, WebkitLineClamp: undefined, display: 'block', overflow: 'visible', fontSize: 11.5, color: 'var(--color-text-secondary, #475569)', fontStyle: 'italic' }}>
            {d.reason}
          </div>
          {d.deltaScore !== undefined && (
            <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary, #94a3b8)' }}>
              Score delta (composite_b − composite_a): <b style={{ fontVariantNumeric: 'tabular-nums' }}>{d.deltaScore >= 0 ? '+' : ''}{d.deltaScore.toFixed(4)}</b>
            </div>
          )}
          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary, #94a3b8)', fontVariantNumeric: 'tabular-nums' }}>
            {new Date(d.ts).toLocaleString()}
          </div>
        </div>
      )}
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
