// The master-detail rail row for one dimension — a numbered index, a
// truncated title, a confidence label and a level badge, in both the
// expanded and collapsed (icon-only) rail widths. There is no library
// composite for "numbered rail row with a truncating title" (DataTable is
// for tabular data, not a single-column nav rail), so this is composed once
// here per docs/ui-components-queue.md and reused by DimensionMasterDetail.
// Modelled on project-detail/ItemRow.tsx, which hand-rolls the same class of
// row for the same reason.

import { Tooltip } from '@connorhoehnslalom/ui-components/shared';
import type { Dimension } from '../types';
import { LevelBadge } from './LevelBadge';

const confidenceLabel = (confidence: string) => confidence.replace(/_/g, ' ');

export function DimensionRailRow({ dimension, index }: { dimension: Dimension; index: number }) {
  return (
    <div className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left">
      <span className="w-6 shrink-0 text-xs font-bold text-text-tertiary">{String(index + 1).padStart(2, '0')}</span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" title={dimension.title}>
        {dimension.title}
      </span>
      <span className="hidden shrink-0 text-[10px] capitalize text-text-tertiary lg:inline">
        {confidenceLabel(dimension.confidence)}
      </span>
      <LevelBadge level={dimension.current_level} isNa={dimension.is_na} size="xs" />
    </div>
  );
}

export function DimensionCompactRailRow({ dimension, index }: { dimension: Dimension; index: number }) {
  return (
    <Tooltip content={dimension.title} placement="right">
      <div className="flex w-full flex-col items-center gap-1.5 px-2 py-2.5">
        <span className="text-xs font-bold text-text-tertiary">{String(index + 1).padStart(2, '0')}</span>
        <LevelBadge level={dimension.current_level} isNa={dimension.is_na} size="xs" />
      </div>
    </Tooltip>
  );
}
