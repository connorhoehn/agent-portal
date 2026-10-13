// Both certification tracks are explicit; confidence describes the assessment,
// never its eligibility. railTracks remains the source of the domain values.
import { Chip, Inline, T } from '@connorhoehnslalom/ui-components/shared';
import { railTracks } from '../assessmentFormat';
import type { Dimension } from '../types';
import { LevelBadge } from './LevelBadge';

const confidenceLabel = (confidence: string) => {
  const label = confidence.replace(/_/g, ' ').trim();
  return label ? label[0].toUpperCase() + label.slice(1) : 'Unknown';
};

export function DimensionRailBadges({ dimension }: { dimension: Dimension }) {
  const tracks = railTracks(dimension);
  return <>
    <Inline gap="xs" align="center" wrap={false}>
      <T as="span" size="xs" tone="secondary">Verified</T>
      <LevelBadge level={dimension.certification?.verified_level ?? dimension.current_level} size="xs" />
    </Inline>
    {/* md: the rail row is a button, and the xs chip's 10px label is off the
        control scale (12/14). */}
    {tracks.claimed && <Chip tone={tracks.claimOpen ? 'warning' : 'neutral'} size="md"
      title={`Team claims Level ${tracks.claimed}${tracks.claimOpen ? '; evidence is requested above verification' : ''}`}>
      Claim L{tracks.claimed}
    </Chip>}
  </>;
}

export function DimensionRailSubline({ dimension }: { dimension: Dimension }) {
  const tracks = railTracks(dimension);
  const assessed = tracks.verified !== '' && tracks.verified !== 'na';
  return <Inline gap="xs" align="center" wrap className="dimension-rail-metadata"
    data-claimed={tracks.claimed} data-verified={tracks.verified}>
    {dimension.is_na ? <T as="span" size="xs" tone="secondary">Not applicable</T>
      : !assessed && !tracks.claimed ? <T as="span" size="xs" tone="secondary">Not yet assessed</T>
        : <>
          <DimensionRailBadges dimension={dimension} />
          {assessed && <T as="span" size="xs" tone="secondary" className="dimension-rail-confidence">
            {confidenceLabel(dimension.confidence)} confidence
          </T>}
        </>}
  </Inline>;
}
