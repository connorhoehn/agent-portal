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

import { provenanceNote } from './answerSources';
import type { AnswerSource, SourceProvenance } from './answerSources';
import { Chip, Inline, MetaLine, Stack } from '@connorhoehnslalom/ui-components/shared';

const SUPERSCRIPT_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

function superscript(n: number): string {
  return String(n)
    .split('')
    .map((d) => SUPERSCRIPT_DIGITS[Number(d)] ?? d)
    .join('');
}

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
    <Stack gap="none" className="mt-1.5">
      {sources.length > 0 && (
        <Inline gap="xs" wrap aria-label="Sources">
          {sources.map((s) => {
            const title = s.detail ?? s.uri ?? s.label;
            const key = s.uri ?? `${s.kind}:${s.label}`;
            const isWebLink = !!s.uri && /^https?:\/\//i.test(s.uri);
            // A data origin (no uri) is not a link and should not look like
            // one — dashed border marks it as informational.
            const className = s.uri ? 'max-w-[260px] truncate' : 'max-w-[260px] truncate border-dashed';
            return (
              <Chip
                key={key}
                size="sm"
                title={title}
                className={className}
                {...(isWebLink ? { href: s.uri, external: true } : {})}
              >
                <Inline as="span" gap="none" aria-hidden>{superscript(s.n)}</Inline>{' '}
                <Inline as="span" gap="none" className="overflow-hidden truncate">{s.label}</Inline>
              </Chip>
            );
          })}
        </Inline>
      )}
      {note && <MetaLine size="xs" className="opacity-85 mt-0.5" items={[note]} />}
    </Stack>
  );
}

export default SourceChips;
