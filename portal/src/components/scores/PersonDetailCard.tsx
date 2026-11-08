import { useEffect } from 'react';
import { Button, Card, Chip, CollapsibleSection, EntityCell, Inline, MetaLine, SectionLabel, Stack } from '@connorhoehn/ui-components/shared';
import { PersonDetail } from './types';
import { relativeTime } from '../../lib/relativeTime';
import { formatScore } from './scoresFormat';
import { RadarChart, type RadarAxes } from './RadarChart';
import { TrendLine } from './TrendLine';
import { ScoreContributions, type ContributionsResponse } from './ScoreContributions';
import { useFetch } from '../../hooks/useFetch';

interface RadarResponse {
  personId: string;
  person: RadarAxes;
  peerMax: RadarAxes;
}

interface HistoryResponse {
  personId: string;
  samples: Array<{ ts: string; score: number }>;
  deltaVs7d: number | null;
}

interface Props {
  detail: PersonDetail;
  /** The row's composite, already 0-100 (see Leaderboard.tsx) — null while
   * the matching leaderboard row hasn't loaded yet (e.g. opened via a
   * connection the current filter/search excludes). */
  compositeScore: number | null;
  /** The row's influence, same units and same null case as `compositeScore`
   * above — DEFECTS.md org-leader #11. This panel used to show
   * `detail.influenceScore` from `/api/graph/people/:id`, a raw PageRank
   * value from a different endpoint than the leaderboard's `influence`
   * field; the two are genuinely different numbers; not just different
   * scales, so no amount of `formatScore` normalizing made them agree. The
   * fix is to stop reading a second source for a number the leaderboard
   * already showed, and show that same figure here. */
  influenceScore: number | null;
  deptColors: Record<string, string>;
  onClose: () => void;
  onSelectConnection: (id: string) => void;
}

const SECTION_HEADER = 'text-xs font-semibold text-text-tertiary uppercase tracking-wider mt-4 mb-1.5';

export function PersonDetailCard({ detail, compositeScore, influenceScore, deptColors, onClose, onSelectConnection }: Props) {
  const { data: radar } = useFetch<RadarResponse>(
    detail.id ? `/api/scores/${encodeURIComponent(detail.id)}/radar` : '',
  );
  const { data: history, degraded: historyDegraded } = useFetch<HistoryResponse>(
    detail.id ? `/api/scores/${encodeURIComponent(detail.id)}/history?days=30` : '',
  );
  // Fetched as soon as the panel is up, same as `radar`/`history` above, not
  // gated on the "Why this score?" disclosure being open — see
  // ScoreContributions.tsx for why the old open-gated fetch left the section
  // showing "Loading…" (or, worse, nothing) on every first expand.
  const { data: contributions } = useFetch<ContributionsResponse>(
    detail.id ? `/api/scores/${encodeURIComponent(detail.id)}/contributions` : '',
  );

  // Escape-to-close and focus management — the only dialog-ish surface in
  // the app not built on the library Modal/InlinePopover, so it never got
  // either for free. Runs once per mount, not per `detail` change: jumping
  // to a connection (`onSelectConnection`) swaps `detail` on this SAME
  // instance rather than remounting it (ScoresPage renders this card with
  // no `key`), so re-running on every `detail` change would capture the
  // connection row — a plain `onClick` `Inline` with no tabIndex, never the
  // keyboard focus — as the thing to restore focus to, discarding the real
  // trigger the panel traces back to. Focus target for restore-on-close is
  // re-queried by a stable `data-*` selector rather than held as a node
  // ref, same reasoning as pages/budgets/InitiativesReport.tsx:100-124 —
  // the element that opened this panel lives in a sibling component
  // (Leaderboard) that can re-render its rows independently.
  useEffect(() => {
    const active = document.activeElement;
    const returnFocusSelector = '[data-person-card-return-focus="true"]';
    let taggedActive = false;
    if (active instanceof HTMLElement && !active.dataset.personCardReturnFocus) {
      active.dataset.personCardReturnFocus = 'true';
      taggedActive = true;
    }
    document.querySelector<HTMLButtonElement>('[data-person-card-close]')?.focus({ preventScroll: true });
    return () => {
      const el = document.querySelector<HTMLElement>(returnFocusSelector);
      el?.focus({ preventScroll: true });
      if (taggedActive) delete el?.dataset.personCardReturnFocus;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <Card padding="md" className="mt-4">
      <Inline align="start" justify="between" className="mb-2">
        <Stack gap="none">
          <EntityCell label={detail.name} labelClassName="" />
          <MetaLine size="sm" tone="secondary" items={[detail.title]} />
          {/* Department colour is data, not design: it comes from the graph's
              own per-department palette, so it stays a style rather than
              becoming a class Tailwind could not build from a runtime key. */}
          <MetaLine
            size="xs"
            className="mt-0.5"
            items={[<Inline as="span" gap="none" key="d" style={{ color: deptColors[detail.department] ?? 'var(--color-text-tertiary)' }}>{detail.department}</Inline>]}
          />
        </Stack>
        <Button data-person-card-close="true" variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </Inline>

      <SectionLabel as="div" className={SECTION_HEADER}>Skills</SectionLabel>
      <Inline gap="xs" wrap>
        {detail.skills.length === 0 ? (
          <MetaLine size="xs" items={['none recorded']} />
        ) : (
          detail.skills.map((sk) => <Chip key={sk} size="xs">{sk}</Chip>)
        )}
      </Inline>

      <SectionLabel as="div" className={SECTION_HEADER}>Radar</SectionLabel>
      <RadarChart radar={radar} />

      <SectionLabel as="div" className={SECTION_HEADER}>Trend</SectionLabel>
      <TrendLine history={history} degraded={historyDegraded} />

      <SectionLabel as="div" className={SECTION_HEADER}>
        Top Connections ({detail.connections.length} total)
      </SectionLabel>
      <Stack gap="xs" className="max-h-[280px] overflow-y-auto">
        {detail.connections
          .slice()
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 12)
          .map((c, i) => (
            <Inline
              key={`${c.source}-${c.target}-${i}`}
              justify="between"
              align="center"
              onClick={() => c.otherPerson && onSelectConnection(c.otherPerson.id)}
              className={`py-1 px-2 rounded-[3px] ${c.otherPerson ? 'cursor-pointer' : 'cursor-default'}`}
            >
              <MetaLine size="sm" items={[c.otherPerson?.name ?? c.target]} />
              <MetaLine
                size="xs"
                items={[`${c.type.replace(/_/g, ' ')} · ${Math.round(c.strength * 100)}%`]}
              />
            </Inline>
          ))}
      </Stack>

      <MetaLine size="xs" className="mt-3" items={[`Scored ${relativeTime(detail.scoredAt)}`]} />

      {/* One control, one surface (see ScoreContributions.tsx): this used to
          be a `▾` disclosure toggle that opened a separate `Drawer` of the
          same name, fetched lazily on open. It's the same `CollapsibleSection`
          every other disclosure on this page uses, and `contributions` is
          already loaded above by the time someone expands it. */}
      <CollapsibleSection title="Why this score?" className="mt-2">
        <ScoreContributions contributions={contributions} />
      </CollapsibleSection>

      {/* Both figures below go through the same `formatScore` the leaderboard
          row and stat strip use, on the same 0-100 scale, sourced from the
          same `ScoreEntry` the row rendered — DEFECTS.md org-leader #11 was
          this panel showing a different metric (raw PageRank from a second
          endpoint) beside the row it was opened from. Both are null together
          in the one case the row itself is unavailable (opened via a
          connection outside the current filter/search), so both hide
          together rather than one showing a number that no longer has a row
          to agree with. */}
      {compositeScore !== null && influenceScore !== null && (
        <Stack gap="xs" className="mt-3 pt-3 border-t border-border">
          <Inline justify="between" align="center">
            <MetaLine size="sm" tone="secondary" items={['Composite']} />
            <EntityCell label={String(formatScore(compositeScore))} />
          </Inline>
          <Inline justify="between" align="center">
            <MetaLine size="sm" tone="secondary" items={['Influence']} />
            <EntityCell label={String(formatScore(influenceScore))} />
          </Inline>
        </Stack>
      )}
    </Card>
  );
}
