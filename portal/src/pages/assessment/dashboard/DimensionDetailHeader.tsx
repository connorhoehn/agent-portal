// The detail-pane header for a selected dimension: a small "Dimension 0N"
// eyebrow above the title, with the assessment basis and the two
// certification tracks — a verified LevelBadge plus a warning chip when the
// team claims higher (docs/assessment-ux-goal.md) — stacked on the right.
// `DetailHeader` puts its title first and any caption (via `meta`) below it —
// here the eyebrow leads, which is the one thing DetailHeader cannot reorder
// — so this is composed once per docs/ui-components-queue.md rather than
// fought into a shape it doesn't fit.

import { Chip, Inline, SectionLabel, Stack } from '@connorhoehnslalom/ui-components/shared';
import type { Dimension } from '../types';
import { railTracks } from '../assessmentFormat';
import { LevelBadge } from './LevelBadge';

const confidenceLabel = (confidence: string) => confidence.replace(/_/g, ' ');

export function DimensionDetailHeader({ dimension, index }: { dimension: Dimension; index: number }) {
  const tracks = railTracks(dimension);
  return (
    <Inline align="start" justify="between" wrap gap="md" className="p-5 pb-4">
      <Stack gap="none" className="min-w-0">
        <SectionLabel as="div">Dimension {String(index + 1).padStart(2, '0')}</SectionLabel>
        <h2 className="mt-0.5 text-sm font-semibold text-text-primary">{dimension.title}</h2>
      </Stack>
      <Inline gap="sm" align="center" wrap={false} className="shrink-0">
        <SectionLabel as="div" className="hidden sm:block">
          {dimension.certification?.basis ?? confidenceLabel(dimension.confidence)}
        </SectionLabel>
        {tracks.claimOpen && (
          <Chip tone="warning" size="xs" mono title={`Team claims Level ${tracks.claimed}; verified to the badge level`}>
            ↑{tracks.claimed}
          </Chip>
        )}
        <LevelBadge level={dimension.certification?.verified_level ?? dimension.current_level} isNa={dimension.is_na} />
      </Inline>
    </Inline>
  );
}
