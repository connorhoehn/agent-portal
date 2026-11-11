// InitiativeComputeRail — "obviously I can go to the initiative and see the
// computers running against it and what they're doing." The fleet is one
// app-wide ComputeProvider (ComputeHost, mounted in App.tsx); this card just
// filters it down to this initiative's cost centre and links each row into
// the Computer Lab.

import { Link } from 'react-router';
import {
  Card, Chip, EntityCell, Inline, MetaLine, SectionLabel, Stack,
} from '@connorhoehn/ui-components/shared';
import { COMPUTE_STATUS, useComputeOptional } from '@connorhoehn/ui-components/compute';
import { computersForInitiative, truncateTask } from '../../lib/computeInitiative';

export function ComputersRailCard({ initiativeId }: { initiativeId: string | undefined }) {
  const compute = useComputeOptional();

  // No provider (a test rendering the page in isolation) or no ManageDevbox
  // capability (ComputeHost mounts the provider with enabled=false and
  // canManage=false for anyone lacking it, rather than never mounting it) —
  // either way there is nothing this viewer can reach in the Lab, so the
  // section doesn't render at all rather than showing a dead, empty panel.
  if (!compute || !compute.canManage) return null;

  const mine = computersForInitiative(compute.computers, initiativeId);

  return (
    <Card padding="none" className="overflow-hidden">
      <Inline gap="sm" align="center" className="px-3 py-2.5 border-b border-border">
        <SectionLabel>COMPUTERS</SectionLabel>
        {mine.length > 0 && <Chip tone="neutral" size="xs" mono className="ml-auto">{mine.length}</Chip>}
      </Inline>

      {mine.length === 0 ? (
        <MetaLine
          size="xs"
          className="px-3 py-3 leading-relaxed"
          items={['No computers charged to this initiative.']}
        />
      ) : (
        mine.map((c) => {
          const meta = COMPUTE_STATUS[c.status ?? 'idle'];
          const task = truncateTask(c.currentTask);
          return (
            <Stack key={c.id} gap="none" className="px-3 py-2 border-b border-border last:border-b-0">
              <Inline gap="xs" align="center" wrap className="min-w-0">
                <Chip tone={meta.tone} size="xs" dot={meta.pulse ? 'pulse' : 'static'} title={meta.help}>
                  {meta.label}
                </Chip>
                <EntityCell label={c.label} className="min-w-0" />
                {c.spendUsd != null && (
                  <MetaLine
                    size="xs"
                    className="ml-auto tabular-nums whitespace-nowrap"
                    items={[`$${c.spendUsd.toFixed(2)}`]}
                  />
                )}
                <Link
                  to={`/iq/computers?computer=${encodeURIComponent(c.id)}`}
                  className="text-primary no-underline hover:underline text-xs whitespace-nowrap"
                  title="Open this computer in the Lab"
                >
                  open in lab →
                </Link>
              </Inline>
              {task && (
                <MetaLine size="xs" className="mt-0.5 truncate" items={[<span key="t" title={c.currentTask}>{task}</span>]} />
              )}
            </Stack>
          );
        })
      )}
    </Card>
  );
}
