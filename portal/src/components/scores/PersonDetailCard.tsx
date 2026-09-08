import { Button, Card, CollapsibleSection } from '@connorhoehnslalom/ui-components/shared';
import { PersonDetail, formatRelativeTime } from './types';
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

const SECTION_HEADER = 'text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mt-4 mb-1.5';

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
  return (
    <Card padding="md" className="mt-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <h2 className="text-base font-semibold">{detail.name}</h2>
          <div className="text-xs text-text-secondary">{detail.title}</div>
          <div
            className="text-[11px] mt-0.5"
            style={{ color: deptColors[detail.department] ?? 'var(--color-text-tertiary)' }}
          >
            {detail.department}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>

      <div className={SECTION_HEADER}>Skills</div>
      <div className="flex flex-wrap gap-1">
        {detail.skills.length === 0 ? (
          <span className="text-xs text-text-tertiary">none recorded</span>
        ) : (
          detail.skills.map(s => (
            <span key={s} className="text-[11px] py-0.5 px-2 bg-surface-hover rounded">{s}</span>
          ))
        )}
      </div>

      <div className={SECTION_HEADER}>Radar</div>
      <RadarChart radar={radar} />

      <div className={SECTION_HEADER}>Trend</div>
      <TrendLine history={history} degraded={historyDegraded} />

      <div className={SECTION_HEADER}>Top Connections ({detail.connections.length} total)</div>
      <div className="flex flex-col gap-1 max-h-[280px] overflow-y-auto">
        {detail.connections
          .slice()
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 12)
          .map((c, i) => (
            <div
              key={`${c.source}-${c.target}-${i}`}
              onClick={() => c.otherPerson && onSelectConnection(c.otherPerson.id)}
              className={`flex justify-between items-center text-xs py-1 px-2 rounded-[3px] ${c.otherPerson ? 'cursor-pointer' : 'cursor-default'}`}
            >
              <span>{c.otherPerson?.name ?? c.target}</span>
              <span className="text-[10px] text-text-tertiary">
                {c.type.replace(/_/g, ' ')} · {Math.round(c.strength * 100)}%
              </span>
            </div>
          ))}
      </div>

      <div className="text-[11px] text-text-tertiary mt-3">
        Scored {formatRelativeTime(detail.scoredAt)}
      </div>

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
        <div className="mt-3 pt-3 border-t border-border">
          <div className="flex justify-between items-center text-[13px]">
            <span className="text-text-secondary">Composite</span>
            <span className="font-semibold">{formatScore(compositeScore)}</span>
          </div>
          <div className="flex justify-between items-center text-[13px] mt-1">
            <span className="text-text-secondary">Influence</span>
            <span className="font-semibold">{formatScore(influenceScore)}</span>
          </div>
        </div>
      )}
    </Card>
  );
}
