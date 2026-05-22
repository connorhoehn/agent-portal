// CanaryDeploymentsView — Full-page table of controller decisions for the
// active canary experiment. Renders at /iq/canary?focus=decisions, bypassing
// the live graph and setup wizard entirely.
//
// Data source: canaryStore.recentDecisions — populated from Aurora via the
// decisions poller → broker ring buffer → SSE replay on connect. The store
// holds the last 20 decisions; the broker ring buffer holds the last 500
// events so a freshly-opened tab catches up from Aurora immediately.
//
// Empty table shown when Aurora has no decisions recorded yet.

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { useCanaryStore } from './canaryStore.js';
import type { ControllerAction, Decision } from './types.js';

// ── Action metadata ───────────────────────────────────────────────────────────

const ACTION_META: Record<ControllerAction, { label: string; bg: string; fg: string }> = {
  PROMOTE:            { label: 'Promote',           bg: '#dcfce7', fg: '#166534' },
  ROLLBACK:           { label: 'Rollback',           bg: '#fee2e2', fg: '#991b1b' },
  HOLD:               { label: 'Hold',               bg: '#fef3c7', fg: '#92400e' },
  SKIPPED_OVERRIDE:   { label: 'Skip — override',    bg: '#e0e7ff', fg: '#3730a3' },
  SKIPPED_COOLDOWN:   { label: 'Skip — cooldown',    bg: '#e2e8f0', fg: '#475569' },
  SKIPPED_NO_SAMPLES: { label: 'Skip — no data',     bg: '#e2e8f0', fg: '#475569' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function DeltaCell({ delta }: { delta: number | undefined }): React.ReactElement {
  if (delta === undefined) {
    return <span style={{ color: 'var(--color-text-tertiary, #94a3b8)' }}>—</span>;
  }
  const color =
    delta > 0.005 ? '#16a34a' :
    delta < -0.005 ? '#dc2626' :
    'var(--color-text-secondary, #475569)';
  return (
    <span style={{ fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' }}>
      {delta >= 0 ? '+' : ''}{delta.toFixed(3)}
    </span>
  );
}

// ── Decision row (collapsible reason) ────────────────────────────────────────

function DecisionRow({ decision, index }: { decision: Decision; index: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(index === 0 && !!decision.reason);
  const meta = ACTION_META[decision.action];
  const hasReason = !!decision.reason;

  const trafficColor =
    decision.to > decision.from ? '#16a34a' :
    decision.to < decision.from ? '#dc2626' :
    'var(--color-text-secondary, #475569)';

  return (
    <>
      <tr
        aria-expanded={hasReason ? expanded : undefined}
        style={{
          borderBottom: expanded ? 'none' : '1px solid var(--color-border, #e2e8f0)',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => { if (hasReason) (e.currentTarget as HTMLTableRowElement).style.background = 'var(--color-bg, #f8fafc)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'; }}
      >
        {/* Time */}
        <td style={tdStyle}>
          <span style={timeStyle}>{fmtDate(decision.ts)}</span>
        </td>
        {/* Outcome chip */}
        <td style={tdStyle}>
          <span style={{ ...chipStyle, background: meta.bg, color: meta.fg }}>
            {meta.label}
          </span>
        </td>
        {/* Traffic B: before → after */}
        <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ color: 'var(--color-text-secondary, #475569)', fontWeight: 500 }}>
            {decision.from}%
          </span>
          <span style={{ margin: '0 6px', color: 'var(--color-text-tertiary, #94a3b8)' }}>→</span>
          <span style={{ color: trafficColor, fontWeight: 700 }}>
            {decision.to}%
          </span>
        </td>
        {/* Score delta */}
        <td style={{ ...tdStyle, textAlign: 'center' }}>
          <DeltaCell delta={decision.deltaScore} />
        </td>
        {/* Reason preview */}
        <td style={{ ...tdStyle, maxWidth: 0 }}>
          {hasReason ? (
            <span style={reasonPreviewStyle}>
              {decision.reason}
            </span>
          ) : (
            <span style={{ color: 'var(--color-text-tertiary, #94a3b8)', fontSize: 11 }}>—</span>
          )}
        </td>
        {/* Expand caret */}
        <td style={{ ...tdStyle, width: 28, textAlign: 'center', paddingLeft: 0 }}>
          {hasReason && (
            <button
              type="button"
              onClick={() => setExpanded(v => !v)}
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse reason' : 'Expand reason'}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: '100%', background: 'transparent', border: 'none',
                cursor: 'pointer', padding: 0,
                fontSize: 10, color: 'var(--color-text-tertiary, #94a3b8)',
              }}
            >
              <span aria-hidden="true">{expanded ? '▲' : '▼'}</span>
            </button>
          )}
        </td>
      </tr>
      {/* Expanded reason */}
      {expanded && hasReason && (
        <tr style={{ borderBottom: '1px solid var(--color-border, #e2e8f0)', background: 'var(--color-bg, #f8fafc)' }}>
          <td colSpan={6} style={{ padding: '8px 16px 12px 16px' }}>
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--color-text-secondary, #475569)', lineHeight: 1.65, fontStyle: 'italic' }}>
              {decision.reason}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState(): React.ReactElement {
  return (
    <tr>
      <td colSpan={6} style={{ padding: '56px 24px', textAlign: 'center' }}>
        <div style={emptyInnerStyle}>
          <span style={emptyIconStyle}>🧪</span>
          <p style={emptyHeadStyle}>No canary decisions recorded yet</p>
          <p style={emptySubStyle}>
            Start a canary experiment to let the automated controller evaluate A/B prompt
            performance. Each PROMOTE, ROLLBACK, or HOLD decision appears here as a row,
            sourced from <code style={{ fontFamily: 'monospace', fontSize: 11 }}>observability.canary_decisions</code> in Aurora.
          </p>
          <Link to="/iq/canary" style={emptyBtnStyle}>
            Configure experiment →
          </Link>
        </div>
      </td>
    </tr>
  );
}

// ── View ──────────────────────────────────────────────────────────────────────

export function CanaryDeploymentsView(): React.ReactElement {
  const decisions = useCanaryStore((s) => s.recentDecisions);
  const experimentState = useCanaryStore((s) => s.experimentState);
  // Newest-first display
  const sorted = [...decisions].reverse();

  return (
    <div style={wrapStyle}>
      {/* Page header */}
      <div style={pageHeaderStyle}>
        <div>
          <h2 style={pageTitleStyle}>Canary Deployments</h2>
          <p style={pageSubtitleStyle}>
            Controller decisions from{' '}
            <code style={codeStyle}>observability.canary_decisions</code>
            {decisions.length > 0 && (
              <span style={{ marginLeft: 6 }}>— {decisions.length} decision{decisions.length !== 1 ? 's' : ''} loaded</span>
            )}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {experimentState === 'running' && (
            <Link to="/iq/canary" style={liveBtnStyle}>
              ● Live view
            </Link>
          )}
          <Link
            to={experimentState === 'running' ? '/iq/canary' : '/iq/canary'}
            style={newBtnStyle}
          >
            {experimentState === 'setup' ? '+ New experiment' : 'View experiment'}
          </Link>
        </div>
      </div>

      {/* Table */}
      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr style={theadRowStyle}>
              <th style={{ ...thStyle, width: 170 }}>Time</th>
              <th style={{ ...thStyle, width: 150 }}>Outcome</th>
              <th style={{ ...thStyle, width: 130 }}>Traffic B</th>
              <th style={{ ...thStyle, width: 90, textAlign: 'center' }}>Δ Score</th>
              <th style={{ ...thStyle }}>Reason</th>
              <th style={{ ...thStyle, width: 28 }} />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <EmptyState />
            ) : (
              sorted.map((d, i) => (
                <DecisionRow key={`${d.ts}-${i}`} decision={d} index={i} />
              ))
            )}
          </tbody>
        </table>
      </div>

      {decisions.length > 0 && (
        <div style={footerStyle}>
          Showing {decisions.length} most recent decision{decisions.length !== 1 ? 's' : ''}.
          Decisions older than the current session are loaded from Aurora on connect.
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100%',
  minHeight: 0,
  background: 'var(--color-bg, #f8fafc)',
};

const pageHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  padding: '20px 24px 16px',
  background: 'var(--color-surface, #fff)',
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
  flexShrink: 0,
  gap: 16,
};

const pageTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 700,
  color: 'var(--color-text-primary, #0f172a)',
  lineHeight: 1.2,
};

const pageSubtitleStyle: CSSProperties = {
  margin: '4px 0 0',
  fontSize: 12,
  color: 'var(--color-text-tertiary, #94a3b8)',
};

const codeStyle: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 11,
  background: 'var(--color-bg, #f8fafc)',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 3,
  padding: '1px 4px',
  color: 'var(--color-text-secondary, #475569)',
};

const newBtnStyle: CSSProperties = {
  display: 'inline-block',
  padding: '6px 16px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 6,
  border: '1px solid var(--color-border, #e2e8f0)',
  background: 'var(--color-surface, #fff)',
  color: 'var(--color-text-primary, #0f172a)',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};

const liveBtnStyle: CSSProperties = {
  display: 'inline-block',
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 6,
  border: '1px solid #bbf7d0',
  background: '#f0fdf4',
  color: '#166534',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
};

const tableWrapStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  overflowX: 'auto',
};

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
  background: 'var(--color-surface, #fff)',
};

const theadRowStyle: CSSProperties = {
  borderBottom: '2px solid var(--color-border, #e2e8f0)',
  position: 'sticky',
  top: 0,
  background: 'var(--color-surface, #fff)',
  zIndex: 2,
};

const thStyle: CSSProperties = {
  padding: '10px 16px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-text-tertiary, #94a3b8)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  whiteSpace: 'nowrap',
};

const tdStyle: CSSProperties = {
  padding: '10px 16px',
  verticalAlign: 'middle',
};

const timeStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary, #475569)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
};

const chipStyle: CSSProperties = {
  display: 'inline-block',
  padding: '2px 9px',
  fontSize: 11,
  fontWeight: 700,
  borderRadius: 4,
  letterSpacing: '0.02em',
  whiteSpace: 'nowrap',
};

const reasonPreviewStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary, #475569)',
  display: '-webkit-box',
  WebkitLineClamp: 1,
  WebkitBoxOrient: 'vertical' as const,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontStyle: 'italic',
  lineHeight: 1.5,
};

const emptyInnerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  maxWidth: 440,
  margin: '0 auto',
};

const emptyIconStyle: CSSProperties = {
  fontSize: 36,
  marginBottom: 12,
  opacity: 0.6,
};

const emptyHeadStyle: CSSProperties = {
  margin: '0 0 8px',
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--color-text-primary, #0f172a)',
};

const emptySubStyle: CSSProperties = {
  margin: '0 0 20px',
  fontSize: 13,
  color: 'var(--color-text-tertiary, #94a3b8)',
  lineHeight: 1.65,
  textAlign: 'center',
};

const emptyBtnStyle: CSSProperties = {
  display: 'inline-block',
  padding: '8px 20px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 7,
  background: 'var(--color-primary, #6366f1)',
  color: '#fff',
  textDecoration: 'none',
  cursor: 'pointer',
};

const footerStyle: CSSProperties = {
  flexShrink: 0,
  padding: '10px 24px',
  fontSize: 11,
  color: 'var(--color-text-tertiary, #94a3b8)',
  borderTop: '1px solid var(--color-border, #e2e8f0)',
  background: 'var(--color-surface, #fff)',
};
