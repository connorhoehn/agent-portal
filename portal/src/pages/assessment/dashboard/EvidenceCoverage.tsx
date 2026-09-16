// Evidence coverage — one strip across the 17 dimensions saying what KIND of
// evidence each verified level rests on (docs/assessment-ux-goal.md slice 4).
// The three classes are the tenant's own vocabulary (docs/assessment-tenant.md):
// attested = the team's word, documented = something written down, observed =
// we looked ourselves. A team "verified to L3 on 14 of 17" reads very
// differently when 12 of those 14 are attested, and nothing else on the
// scorecard says so in one glance.
//
// Composed from Chip/Inline/MetaLine/SectionLabel — the strip is a legend
// plus seventeen toned chips, which is exactly what those primitives are.

import { Chip, Inline, MetaLine, SectionLabel, Stack, Tooltip, type ChipTone } from '@connorhoehnslalom/ui-components/shared';
import { evidenceClassOf, evidenceCoverage, type EvidenceClassKey } from '../assessmentFormat';
import type { Dimension } from '../types';

const CLASS_LABEL: Record<EvidenceClassKey, string> = {
  attested: 'Attested',
  documented: 'Documented',
  observed: 'Observed',
  na: 'N/A',
  unassessed: 'Unassessed',
};

const CLASS_TONE: Record<EvidenceClassKey, ChipTone> = {
  attested: 'warning',
  documented: 'accent',
  observed: 'success',
  na: 'neutral',
  unassessed: 'neutral',
};

const CLASS_MEANING: Record<EvidenceClassKey, string> = {
  attested: 'rests on what the team told us',
  documented: 'the team pointed at something written down',
  observed: 'we looked at the practice ourselves',
  na: 'not applicable for this team',
  unassessed: 'not assessed yet',
};

export function EvidenceCoverage({ dimensions }: { dimensions: Dimension[] }) {
  const counts = evidenceCoverage(dimensions);
  const legend = (['attested', 'documented', 'observed'] as const).map((k) => `${CLASS_LABEL[k]} ${counts[k]}`);
  if (counts.na > 0) legend.push(`N/A ${counts.na}`);
  if (counts.unassessed > 0) legend.push(`Unassessed ${counts.unassessed}`);

  return (
    <Stack gap="xs" data-testid="evidence-coverage">
      <Inline gap="sm" align="baseline" wrap>
        <SectionLabel as="div">Evidence coverage</SectionLabel>
        <MetaLine items={legend} />
      </Inline>
      <Inline gap="xs" wrap>
        {dimensions.map((d, i) => {
          const cls = evidenceClassOf(d);
          const n = String(i + 1).padStart(2, '0');
          return (
            <Tooltip key={d.id} content={`${n} ${d.title} — ${CLASS_LABEL[cls]}: ${CLASS_MEANING[cls]}`} placement="top">
              <Chip
                tone={CLASS_TONE[cls]}
                size="xs"
                mono
                solid={cls === 'observed'}
                data-testid={`evidence-coverage-${d.id}`}
                className={cls === 'unassessed' ? 'opacity-60' : undefined}
              >
                {n}
              </Chip>
            </Tooltip>
          );
        })}
      </Inline>
    </Stack>
  );
}
