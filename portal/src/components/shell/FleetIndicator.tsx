// FleetIndicator — the header's one grouped fleet control: "● 3 · ☁ 2 · 🖥 1 ▾".
//
// Replaces three separate badges (ActiveRunsBadge, LocalComputeBadge,
// GatewayStatusBadge). Each count keeps its OWN source — nothing is summed:
//   ●  dispatched agent runs      — `/api/bots/active-runs` (ActiveRunsBadge's poll)
//   ☁  readable cloud computers   — the devbox fleet the Computer Lab reads (ComputeHost)
//   🖥 the caller's local computers — `/api/local-compute/nodes` (LocalComputeBadge's poll)
// A segment is omitted when the caller cannot read its source, so a 0 always
// means "none" and never "not allowed". The gateway's status is a row in the
// menu, since the mockup has no separate dots.

import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  ChevronIcon, CloudIcon, DropdownMenu, Inline, MonitorIcon, StatusDot, type DropdownMenuItem, type DropdownMenuSection,
} from '@connorhoehnslalom/ui-components/shared';
import { useComputeOptional } from '@connorhoehnslalom/ui-components/compute';
import { useCapabilities } from '../../lib/capabilities';
import { useSession } from '../../lib/auth';
import { COMPUTER_LAB_PATH, LOCAL_COMPUTE_PATH, canOpenComputerLab } from '../../lib/devboxAccess';
import { DISPATCHED_RUNS_PATH } from '../../pages/work/dispatchedRuns';
import { isLocalMachineId } from '../compute/localMachines';
import { useActiveRuns } from './ActiveRunsBadge';
import { useLocalNodes } from './LocalComputeBadge';
import { GatewayStatusBadge } from './GatewayStatusBadge';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function FleetIndicator() {
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const { session } = useSession();
  const { runs, items, polling: runsReadable } = useActiveRuns();
  const { nodes, polling: localReadable } = useLocalNodes();
  const compute = useComputeOptional();

  const labReadable = ready && canOpenComputerLab(can('ManageDevbox'), session?.role)
    && session?.tenant === 'orgiq' && !!compute;
  const cloudCount = useMemo(
    () => (compute?.computers ?? []).filter((c) => !isLocalMachineId(c.id)).length,
    [compute?.computers],
  );

  if (!runsReadable && !labReadable && !localReadable) return <GatewayStatusBadge />;

  const labels: string[] = [];
  if (runsReadable) labels.push(`${plural(runs.length, 'agent run')} in progress`);
  if (labReadable) labels.push(plural(cloudCount, 'cloud computer'));
  if (localReadable) labels.push(plural(nodes.length, 'local computer'));

  const fleetItems: DropdownMenuItem[] = [];
  if (runsReadable) {
    fleetItems.push({
      label: 'Dispatched runs', description: 'Agent runs started from work items, not queue jobs',
      icon: <StatusDot size="sm" color="var(--color-success)" />, trailing: String(runs.length),
      onSelect: () => navigate(DISPATCHED_RUNS_PATH),
    });
  }
  if (labReadable) {
    fleetItems.push({
      label: 'Cloud computers', description: 'Open Computer Lab',
      icon: <CloudIcon size={14} aria-hidden="true" />, trailing: String(cloudCount),
      onSelect: () => navigate(COMPUTER_LAB_PATH),
    });
  }
  if (localReadable) {
    fleetItems.push({
      label: 'Local computers', description: 'Your paired machines',
      icon: <MonitorIcon size={14} aria-hidden="true" />, trailing: String(nodes.length),
      onSelect: () => navigate(LOCAL_COMPUTE_PATH),
    });
  }
  const sections: DropdownMenuSection[] = [{ label: 'Fleet', items: fleetItems }];
  if (items.length > 0) sections.push({ label: 'Running now', items });
  sections.push({
    items: [{ label: 'Realtime gateway', icon: <GatewayStatusBadge />, description: 'HTTP and WebSocket status' }],
  });

  return (
    <DropdownMenu
      trigger={(
        <Inline as="span" gap="sm" wrap={false} className="inline-flex items-center tabular-nums">
          {runsReadable && (
            <Inline as="span" gap="xs" wrap={false} className="inline-flex items-center">
              <StatusDot size="xs" color={runs.length > 0 ? 'var(--color-success)' : 'var(--color-text-tertiary)'} />
              <span>{runs.length}</span>
            </Inline>
          )}
          {labReadable && (
            <Inline as="span" gap="xs" wrap={false} className="inline-flex items-center">
              <CloudIcon size={14} aria-hidden="true" /><span>{cloudCount}</span>
            </Inline>
          )}
          {localReadable && (
            <Inline as="span" gap="xs" wrap={false} className="inline-flex items-center">
              <MonitorIcon size={14} aria-hidden="true" /><span>{nodes.length}</span>
            </Inline>
          )}
          <ChevronIcon dir="down" size={12} aria-hidden="true" />
        </Inline>
      )}
      triggerClassName="px-2.5 py-1 text-sm leading-5 font-medium text-text-secondary"
      triggerLabel={`Fleet: ${labels.join(', ')}`}
      triggerTitle={labels.join(' · ')}
      align="end"
      className="w-[min(28rem,calc(100vw-2rem))] [&_[role=menuitem]]:whitespace-normal"
      sections={sections}
      data-testid="fleet-indicator"
    />
  );
}
