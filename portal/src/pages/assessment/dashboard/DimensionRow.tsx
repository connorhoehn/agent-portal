// The master-detail rail row for one dimension — a numbered index, a
// truncated title, the two certification tracks and a confidence meter, in
// both the expanded and collapsed (icon-only) rail widths. There is no
// library composite for "numbered rail row with a truncating title"
// (DataTable is for tabular data, not a single-column nav rail), so this is
// composed once here per docs/ui-components-queue.md and reused by
// DimensionMasterDetail. Modelled on project-detail/ItemRow.tsx, which
// hand-rolls the same class of row for the same reason.
//
// Two tracks on every row (docs/assessment-ux-goal.md): the badge is the
// VERIFIED level; when the team claims higher, a warning chip carries the
// claim ("↑5") so the rail itself shows where the verification gap is. The
// row's wrapper carries `data-claimed` / `data-verified` so a test — or an
// operator reading the DOM — can read both tracks without parsing text.

import { Chip, DotMeter, Tooltip } from '@connorhoehnslalom/ui-components/shared';
import { confidenceValue, railTracks } from '../assessmentFormat';
import type { Dimension } from '../types';
import { LevelBadge } from './LevelBadge';

const confidenceLabel = (confidence: string) => confidence.replace(/_/g, ' ');

export function DimensionRailRow({ dimension, index }: { dimension: Dimension; index: number }) {
  const tracks = railTracks(dimension);
  return (
    <div
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      data-claimed={tracks.claimed}
      data-verified={tracks.verified}
    >
      <span className="w-6 shrink-0 text-xs font-bold text-text-tertiary">{String(index + 1).padStart(2, '0')}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0 truncate text-sm font-medium text-text-primary" title={dimension.title}>
          {dimension.title}
        </span>
        {!dimension.is_na && dimension.current_level != null && (
          <DotMeter
            tone="surface"
            label={confidenceLabel(dimension.confidence)}
            segments={3}
            showPercent={false}
            warnAbove={1}
            value={confidenceValue(dimension.confidence)}
            note={tracks.claimOpen ? `claims L${tracks.claimed}` : undefined}
          />
        )}
      </span>
      {tracks.claimOpen && (
        <Chip tone="warning" size="xs" mono title={`Team claims Level ${tracks.claimed}; verified to the badge level`}>
          ↑{tracks.claimed}
        </Chip>
      )}
      <LevelBadge level={dimension.certification?.verified_level ?? dimension.current_level} isNa={dimension.is_na} size="xs" />
    </div>
  );
}

export function DimensionCompactRailRow({ dimension, index }: { dimension: Dimension; index: number }) {
  const tracks = railTracks(dimension);
  return (
    <Tooltip
      content={tracks.claimOpen ? `${dimension.title} · claims L${tracks.claimed}` : dimension.title}
      placement="right"
    >
      <div
        className="flex w-full flex-col items-center gap-1.5 px-2 py-2.5"
        data-claimed={tracks.claimed}
        data-verified={tracks.verified}
      >
        <span className="text-xs font-bold text-text-tertiary">{String(index + 1).padStart(2, '0')}</span>
        <LevelBadge level={dimension.certification?.verified_level ?? dimension.current_level} isNa={dimension.is_na} size="xs" />
        {tracks.claimOpen && <Chip tone="warning" size="xs" mono>↑{tracks.claimed}</Chip>}
      </div>
    </Tooltip>
  );
}
