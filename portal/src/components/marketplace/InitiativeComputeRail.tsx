// InitiativeComputeRail — "obviously I can go to the initiative and see the
// computers running against it and what they're doing." The fleet is one
// app-wide ComputeProvider (ComputeHost, mounted in App.tsx); this card just
// filters it down to this initiative's cost centre and links each row into
// the Computer Lab.

import { Link } from 'react-router';
import { Card, Chip } from '@connorhoehnslalom/ui-components/shared';
import { COMPUTE_STATUS, useComputeOptional } from '@connorhoehnslalom/ui-components/compute';
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
      <div className="px-3 py-2.5 border-b border-border flex items-center gap-2">
        <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">COMPUTERS</span>
        <div className="flex-1" />
        {mine.length > 0 && (
          <Chip tone="neutral" size="xs" mono>{mine.length}</Chip>
        )}
      </div>

      {mine.length === 0 ? (
        <div className="px-3 py-3 text-[11.5px] text-text-tertiary leading-relaxed">
          No computers charged to this initiative.
        </div>
      ) : (
        mine.map((c) => {
          const meta = COMPUTE_STATUS[c.status ?? 'idle'];
          const task = truncateTask(c.currentTask);
          return (
            <div key={c.id} className="px-3 py-2 border-b border-border last:border-b-0">
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                <Chip tone={meta.tone} size="xs" dot={meta.pulse ? 'pulse' : 'static'} title={meta.help}>
                  {meta.label}
                </Chip>
                <span className="text-[12px] font-semibold text-text-primary truncate" title={c.label}>
                  {c.label}
                </span>
                <div className="flex-1" />
                {c.spendUsd != null && (
                  <span className="text-[10.5px] text-text-tertiary tabular-nums whitespace-nowrap">
                    ${c.spendUsd.toFixed(2)}
                  </span>
                )}
                <Link
                  to={`/admin/devbox?box=${encodeURIComponent(c.id)}`}
                  className="text-primary no-underline hover:underline text-[10.5px] whitespace-nowrap"
                  title="Open this computer in the Lab"
                >
                  open in lab →
                </Link>
              </div>
              {task && (
                <div className="mt-0.5 text-[10.5px] text-text-tertiary truncate" title={c.currentTask}>
                  {task}
                </div>
              )}
            </div>
          );
        })
      )}
    </Card>
  );
}
