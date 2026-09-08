// The detail-pane header for a selected dimension: a small "Dimension 0N"
// eyebrow above the title, with the assessment basis and the level badge
// stacked on the right. `DetailHeader` puts its title first and any caption
// (via `meta`) below it — here the eyebrow leads, which is the one thing
// DetailHeader cannot reorder — so this is composed once per
// docs/ui-components-queue.md rather than fought into a shape it doesn't fit.

import type { Dimension } from '../types';
import { LevelBadge } from './LevelBadge';

const confidenceLabel = (confidence: string) => confidence.replace(/_/g, ' ');

export function DimensionDetailHeader({ dimension, index }: { dimension: Dimension; index: number }) {
  return (
    <div className="flex items-start justify-between gap-4 p-5 pb-4">
      <div className="min-w-0">
        <p className="text-xs font-bold uppercase tracking-wide text-text-tertiary">
          Dimension {String(index + 1).padStart(2, '0')}
        </p>
        <h3 className="mt-0.5 text-lg font-bold text-text-primary">{dimension.title}</h3>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="hidden text-[10px] font-bold uppercase tracking-wide text-text-tertiary sm:inline">
          {dimension.certification?.basis ?? confidenceLabel(dimension.confidence)}
        </span>
        <LevelBadge level={dimension.current_level} isNa={dimension.is_na} />
      </div>
    </div>
  );
}
