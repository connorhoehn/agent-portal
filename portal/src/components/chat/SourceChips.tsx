// SourceChips — where the answer came from, rendered as a compact row of
// numbered chips (¹ perf-Theo Williams …) plus, when there is nothing to chip,
// a one-line reason.
//
// The reason line is the point of this component now. Four situations used to
// render as an identical silent nothing: no retrieval ran, retrieval ran and
// matched nothing, the model cited something in a shape we do not parse, and
// the model cited something that was not a document at all. With zero
// documents ingested today the middle two are the normal case, so "no chips"
// has to read as a stated fact rather than an absence.
//
// Chips are typed: `document`/`web` carry a URI (http(s) opens in a new tab,
// s3 is informational), `graph` is a data origin with no URI — the org graph
// is a real source even though you cannot click it.

import type { CSSProperties } from 'react';
import { provenanceNote } from './answerSources';
import type { AnswerSource, SourceProvenance } from './answerSources';

const SUPERSCRIPT_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

function superscript(n: number): string {
  return String(n)
    .split('')
    .map((d) => SUPERSCRIPT_DIGITS[Number(d)] ?? d)
    .join('');
}

const wrapStyle: CSSProperties = {
  marginTop: 6,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
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

// A data origin is not a link and should not look like one.
const originChipStyle: CSSProperties = {
  ...chipStyle,
  borderStyle: 'dashed',
  background: 'transparent',
};

const noteStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  opacity: 0.85,
  marginTop: 2,
};

export function SourceChips({
  sources,
  provenance,
}: {
  sources: AnswerSource[];
  provenance?: SourceProvenance;
}) {
  const note = provenanceNote(sources, provenance);
  if (sources.length === 0 && !note) return null;

  return (
    <div style={wrapStyle}>
      {sources.length > 0 && (
        <div style={rowStyle} aria-label="Sources">
          {sources.map((s) => {
            const label = (
              <>
                <span aria-hidden="true">{superscript(s.n)}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.label}</span>
              </>
            );
            const title = s.detail ?? s.uri ?? s.label;
            const key = s.uri ?? `${s.kind}:${s.label}`;
            if (s.uri && /^https?:\/\//i.test(s.uri)) {
              return (
                <a key={key} href={s.uri} target="_blank" rel="noreferrer" title={title} style={chipStyle}>
                  {label}
                </a>
              );
            }
            return (
              <span key={key} title={title} style={s.uri ? chipStyle : originChipStyle}>
                {label}
              </span>
            );
          })}
        </div>
      )}
      {note && <div style={noteStyle}>{note}</div>}
    </div>
  );
}

export default SourceChips;
