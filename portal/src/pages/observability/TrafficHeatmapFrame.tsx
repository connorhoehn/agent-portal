// Hour-of-week traffic heatmap — 7 rows (Mon..Sun) x 24 columns (0..23).
//
// No composite in ui-components renders a data grid with per-cell CSS Grid
// placement and a fixed 40px label column ahead of `repeat(24, minmax(...))`
// tracks — `Stack`/`Inline` are flex-only and cannot host that column
// template. Composed here once, fed pre-bucketed cell classes from
// `trafficFormat.ts` (so no runtime `style=` is needed for the color scale).
// ≤ 12 raw elements: 1 header-row grid + 1 per-day-row grid template (map) = 2.
import { T } from './Text';
import { Inline, Stack } from '@connorhoehnslalom/ui-components/shared';
import { heatmapBucketClass } from './trafficFormat';

const GRID_COLS = 'grid-cols-[40px_repeat(24,minmax(20px,1fr))]';
const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LEGEND_STOPS = [0.1, 0.3, 0.5, 0.75, 0.95];

function HeatmapCell({
  count,
  max,
  title,
  ariaLabel,
}: {
  count: number;
  max: number;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <T
      as="div"
      className={`h-[22px] rounded-sm border border-border cursor-default ${heatmapBucketClass(count, max)}`}
      title={title}
      aria-label={ariaLabel}
    />
  );
}

export function TrafficHeatmapFrame({ grid, max }: { grid: number[][]; max: number }) {
  return (
    <Stack gap="xs" className="text-[10px] text-text-tertiary overflow-x-auto">
      <div className={`grid ${GRID_COLS} gap-0.5 items-center`}>
        <T className="w-10" />
        {Array.from({ length: 24 }).map((_, h) => (
          <T key={h} as="div" className="text-center text-[9px] text-text-tertiary">
            {h % 3 === 0 ? h : ''}
          </T>
        ))}
      </div>
      {grid.map((row, rIdx) => (
        <div key={rIdx} className={`grid ${GRID_COLS} gap-0.5 items-center`}>
          <T className="text-[10px] font-semibold text-text-secondary w-10">{DOW_LABELS[rIdx]}</T>
          {row.map((count, h) => (
            <HeatmapCell
              key={h}
              count={count}
              max={max}
              title={`${DOW_LABELS[rIdx]} ${String(h).padStart(2, '0')}:00 — ${count} invocations`}
              ariaLabel={`${DOW_LABELS[rIdx]} ${h}:00, ${count} invocations`}
            />
          ))}
        </div>
      ))}
      <Inline gap="xs" align="center" className="mt-2 ml-[42px] text-[10px] text-text-tertiary">
        <T className="tabular-nums">0</T>
        {LEGEND_STOPS.map((t) => (
          <HeatmapCell key={t} count={Math.ceil(t * max)} max={max} />
        ))}
        <T className="tabular-nums">{max.toLocaleString()}</T>
      </Inline>
    </Stack>
  );
}
