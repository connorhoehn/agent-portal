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
import { Inline, Link, MetaLine, Stack } from '@connorhoehnslalom/ui-components/shared';

const SUPERSCRIPT_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

function superscript(n: number): string {
  return String(n)
    .split('')
    .map((d) => SUPERSCRIPT_DIGITS[Number(d)] ?? d)
    .join('');
}

// One chip's worth of chrome, as classes. `Chip` itself is close but takes no
// href and cannot be a link, and these chips are citations — half of them
// navigate.
const CHIP = 'inline-flex items-center gap-1 max-w-[260px] text-[11px] px-2 py-0.5 '
  + 'rounded-xl border border-border bg-surface-hover text-text-tertiary no-underline truncate';

// A data origin is not a link and should not look like one.
const ORIGIN_CHIP = CHIP.replace('bg-surface-hover', 'bg-transparent') + ' border-dashed';

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
            const label = (
              <>
                <Inline as="span" gap="none" aria-hidden>{superscript(s.n)}</Inline>
                <Inline as="span" gap="none" className="overflow-hidden truncate">{s.label}</Inline>
              </>
            );
            const title = s.detail ?? s.uri ?? s.label;
            const key = s.uri ?? `${s.kind}:${s.label}`;
            if (s.uri && /^https?:\/\//i.test(s.uri)) {
              return (
                <Link key={key} href={s.uri} external unstyled title={title} className={CHIP}>
                  {label}
                </Link>
              );
            }
            return (
              <Inline as="span" gap="none" key={key} title={title} className={s.uri ? CHIP : ORIGIN_CHIP}>
                {label}
              </Inline>
            );
          })}
        </Inline>
      )}
      {note && <MetaLine size="xs" className="opacity-85 mt-0.5" items={[note]} />}
    </Stack>
  );
}

export default SourceChips;
