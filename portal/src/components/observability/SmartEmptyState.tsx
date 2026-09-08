// Researcher-friendly empty state. Renders a centered card with a title,
// optional detail, and 0-3 actions the user can take to make data appear.
// Each action can be a copy-paste shell command (`code`) and/or an in-app
// link (`href`).
//
// Visually consistent across observability pages: same max width, same
// padding, same spacing. Use this in place of generic "no data yet" copy.
//
// …UNLESS THE EMPTY IS A LIE. Every advice this component gives — "run the
// harness", "seed the calibration cases" — is advice about a system that is
// working and simply has nothing in it yet. When the server has told us it
// could NOT read (`degraded: true` on the wire, unwrapped by useFetch), that
// advice is wrong twice over: it blames the reader for an absence they did not
// cause, and it hides a broken query behind a chore. So this component is also
// the gate for the opposite treatment. Pass `degraded` and it renders
// `UnavailableNotice` instead — solid danger border, the server's own error
// line, a retry — leaving the dashed neutral card to mean exactly one thing:
// we looked, and there is genuinely nothing here.

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';

import { UnavailableNotice } from '../UnavailableNotice';

export interface SmartEmptyAction {
  label: string;
  detail?: string;
  code?: string;
  href?: string;
}

export interface SmartEmptyStateProps {
  title: string;
  detail?: string;
  actions?: SmartEmptyAction[];
  // Optional override slot — researchers sometimes need extra context (e.g. a
  // chart that already explains the empty state).
  children?: ReactNode;
  /**
   * The server's own error line when this region's read was `degraded` — i.e.
   * the emptiness below is not a reading of the world. `null`/absent is the
   * healthy path and renders the ordinary empty state.
   */
  degraded?: string | null;
  /**
   * What could not be read, as a noun phrase — "the cost chart", "the tool
   * error list". Defaults to the region's own title lower-cased, which is
   * usually a "No …" sentence and reads badly, so pass it.
   */
  degradedWhat?: string;
  /** Where the data comes from, so the reader knows where to go look. */
  degradedSource?: string;
  onRetry?: () => void;
}

export function SmartEmptyState({
  title,
  detail,
  actions = [],
  children,
  degraded,
  degradedWhat,
  degradedSource,
  onRetry,
}: SmartEmptyStateProps) {
  if (degraded) {
    return (
      <UnavailableNotice
        error={degraded}
        what={degradedWhat ?? title.replace(/^No /i, 'the ')}
        source={degradedSource}
        onRetry={onRetry}
      />
    );
  }
  return (
    <div style={wrapperStyle}>
      <div style={cardStyle}>
        <div style={titleStyle}>{title}</div>
        {detail && <div style={detailStyle}>{detail}</div>}
        {actions.length > 0 && (
          <div style={actionsListStyle}>
            {actions.map((a, i) => (
              <ActionRow key={i} action={a} />
            ))}
          </div>
        )}
        {children && <div style={childrenStyle}>{children}</div>}
      </div>
    </div>
  );
}

function ActionRow({ action }: { action: SmartEmptyAction }) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  function onCopy() {
    if (!action.code) return;
    try {
      void navigator.clipboard.writeText(action.code);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — silent failure is fine here
    }
  }

  const labelNode = action.href ? (
    action.href.startsWith('/') ? (
      <Link to={action.href} style={linkStyle}>
        {action.label}
      </Link>
    ) : (
      <a href={action.href} target="_blank" rel="noreferrer" style={linkStyle}>
        {action.label}
      </a>
    )
  ) : (
    <span style={labelStyle}>{action.label}</span>
  );

  return (
    <div style={actionRowStyle}>
      <div style={actionHeadStyle}>
        <span style={bulletStyle}>›</span>
        {labelNode}
      </div>
      {action.detail && <div style={actionDetailStyle}>{action.detail}</div>}
      {action.code && (
        <div style={codeWrapStyle}>
          <pre style={codeStyle}>{action.code}</pre>
          <button
            type="button"
            onClick={onCopy}
            style={copyBtnStyle}
            title="Copy command"
          >
            {copied ? '✓ copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
}

const wrapperStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  padding: '24px 16px',
};
const cardStyle: CSSProperties = {
  maxWidth: 560,
  width: '100%',
  padding: '20px 22px',
  border: '1px dashed var(--color-border)',
  borderRadius: 'var(--radius-md, 6px)',
  background: 'var(--color-surface)',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};
const titleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
};
const detailStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  lineHeight: 1.5,
};
const actionsListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  marginTop: 4,
};
const actionRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};
const actionHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  fontSize: 12.5,
};
const bulletStyle: CSSProperties = {
  color: 'var(--color-text-tertiary)',
  fontFamily: 'ui-monospace, monospace',
};
const labelStyle: CSSProperties = {
  color: 'var(--color-text-primary)',
  fontWeight: 500,
};
const linkStyle: CSSProperties = {
  color: 'var(--color-primary, #6366f1)',
  fontWeight: 500,
  textDecoration: 'none',
};
const actionDetailStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--color-text-tertiary)',
  paddingLeft: 14,
};
const codeWrapStyle: CSSProperties = {
  position: 'relative',
  marginLeft: 14,
};
const codeStyle: CSSProperties = {
  margin: 0,
  padding: '8px 64px 8px 10px',
  fontFamily: '"Fira Code", "Cascadia Code", ui-monospace, monospace',
  fontSize: 11.5,
  lineHeight: 1.5,
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  color: 'var(--color-text-primary)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};
const copyBtnStyle: CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 6,
  padding: '2px 8px',
  fontSize: 10.5,
  fontFamily: 'inherit',
  background: 'var(--color-surface)',
  color: 'var(--color-text-secondary)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
};
const childrenStyle: CSSProperties = {
  marginTop: 6,
};

export default SmartEmptyState;
