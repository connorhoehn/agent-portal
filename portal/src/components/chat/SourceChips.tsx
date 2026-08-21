// SourceChips — the citations extractSources() pulled out of an answer,
// rendered as a compact wrapping row of numbered chips (¹ perf-Theo Williams …)
// instead of raw s3:// URIs in the prose. The full URI lives in the tooltip;
// http(s) sources open in a new tab, s3 sources are informational.

import type { CSSProperties } from 'react';
import type { AnswerSource } from './answerSources';

const SUPERSCRIPT_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

function superscript(n: number): string {
  return String(n)
    .split('')
    .map((d) => SUPERSCRIPT_DIGITS[Number(d)] ?? d)
    .join('');
}

const rowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  marginTop: 6,
};

const chipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  maxWidth: 260,
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 12,
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface-hover)',
  color: 'var(--color-text-tertiary)',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export function SourceChips({ sources }: { sources: AnswerSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div style={rowStyle} aria-label="Sources">
      {sources.map((s) => {
        const label = (
          <>
            <span aria-hidden="true">{superscript(s.n)}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.label}</span>
          </>
        );
        return /^https?:\/\//i.test(s.uri) ? (
          <a key={s.uri} href={s.uri} target="_blank" rel="noreferrer" title={s.uri} style={chipStyle}>
            {label}
          </a>
        ) : (
          <span key={s.uri} title={s.uri} style={chipStyle}>
            {label}
          </span>
        );
      })}
    </div>
  );
}

export default SourceChips;
