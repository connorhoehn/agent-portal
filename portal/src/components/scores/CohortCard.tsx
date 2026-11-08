import { AccentStripe, Card, Chip, EntityCell, Histogram, Inline, MetaLine, SectionLabel, Stack, StatusDot, dataAccentProps } from '@connorhoehn/ui-components/shared';
import { DEPT_COLORS } from './types';

const BUCKET_LABELS = ['0–20', '20–40', '40–60', '60–80', '80–100'];

export interface BrokerSummary {
  id: string;
  name: string;
  departmentsTouched: number;
}

export interface CohortStats {
  department: string;
  count: number;
  medianComposite: number;
  meanComposite: number;
  compositeBuckets: [number, number, number, number, number];
  expertiseGini: number;
  brokers: BrokerSummary[];
}

interface CohortCardProps {
  cohort: CohortStats;
}

/**
 * Gini as a severity tone rather than three hand-mixed rgba triples.
 *
 * The thresholds are unchanged; only the colours move from literal
 * `backgroundColor`/`border` strings to the library's own tone scale, so a
 * theme change reaches this chip like it reaches every other one.
 */
function giniTone(gini: number): 'success' | 'warning' | 'danger' {
  if (gini < 0.3) return 'success';
  if (gini <= 0.5) return 'warning';
  return 'danger';
}

export function CohortCard({ cohort }: CohortCardProps) {
  const deptColor = DEPT_COLORS[cohort.department] ?? 'var(--color-text-tertiary)';

  return (
    <Card padding="none" className="flex overflow-hidden">
      {/* Left stripe: the department's colour (DEPT_COLORS, matching the radar) as a data accent. */}
      <AccentStripe accent={deptColor} />

      <Stack gap="none" className="flex-1 py-4 px-[18px] min-w-0">
        <Inline align="start" justify="between" gap="md" className="mb-3">
          <Stack gap="none" className="min-w-0">
            <EntityCell label={cohort.department} labelClassName="" className="min-w-0" />
            <MetaLine
              size="sm"
              tone="secondary"
              className="mt-0.5"
              items={[`${cohort.count} ${cohort.count === 1 ? 'person' : 'people'} · median ${cohort.medianComposite.toFixed(1)}`]}
            />
          </Stack>
          {/* Gini chip: the tone is computed from the value, so it is a real
              severity signal rather than decoration. */}
          <Chip size="xs" tone={giniTone(cohort.expertiseGini)} className="shrink-0">
            Gini {cohort.expertiseGini.toFixed(2)}
          </Chip>
        </Inline>

        <Histogram buckets={cohort.compositeBuckets} labels={BUCKET_LABELS} accent={deptColor} height={44} aria-label={`${cohort.department} composite score distribution`} />

        <Inline justify="between" className="mt-[3px]">
          {[0, 20, 40, 60, 80, 100].map((t) => (
            <MetaLine key={t} size="xs" items={[String(t)]} />
          ))}
        </Inline>

        {cohort.brokers.length > 0 && (
          <Stack gap="xs" className="mt-3 border-t border-border pt-[10px]">
            <SectionLabel as="div" className="mb-1.5">Brokers</SectionLabel>
            {cohort.brokers.map((b) => (
              <Inline key={b.id} gap="xs" align="center">
                <StatusDot size="sm" {...dataAccentProps(deptColor)} />
                <MetaLine size="sm" items={[b.name]} />
                <MetaLine size="xs" items={[`(touches ${b.departmentsTouched} teams)`]} />
              </Inline>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
