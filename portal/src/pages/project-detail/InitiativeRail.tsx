// The mission-control rail.
//
// This was five independent panels stacked down a 300px column — agents,
// computers, environments, lab memory and outcomes — each with its own header
// and its own border, all on screen at once beside the work column. That stack
// is the "competing panels" half of the clutter. The panels themselves are
// unchanged; they are now two tabs, so one concern is on screen at a time and
// the rest are one click away.

import { useState } from 'react';
import { Link } from 'react-router';
import {
  Card,
  CardHeader,
  Chip,
  Inline,
  Stack,
  TabPanel,
  Tabs,
} from '@connorhoehnslalom/ui-components/shared';
import {
  AgentsRailCard,
  OutcomesRailCard,
  type useInitiativeAgentActivity,
} from '../../components/marketplace/InitiativeAgentRail';
import { ComputersRailCard } from '../../components/marketplace/InitiativeComputeRail';
import { EnvironmentsRailCard } from '../../components/marketplace/InitiativeEnvironmentsRail';
import { LabMemoryRailCard } from '../../components/marketplace/InitiativeLabMemoryRail';
import type { Codebase } from './types';

type AgentActivity = ReturnType<typeof useInitiativeAgentActivity>;

const RAIL_TABS = [
  { id: 'agents', label: 'Agents' },
  { id: 'compute', label: 'Compute' },
];

/** The code that delivers this initiative — the other half of the repo ↔
 *  initiative join. Each chip lands on the codebase's console. */
function DeliveredBy({ codebases }: { codebases: Codebase[] }) {
  if (codebases.length === 0) return null;
  return (
    <Card padding="none" className="overflow-hidden">
      <CardHeader title="Delivered by" />
      <Inline gap="sm" className="px-3 pb-3">
        {codebases.map((cb) => (
          <Link
            key={cb.id}
            to={`/admin/projects?project=${cb.id}`}
            title="Open this codebase — runs, changes, workspace"
            className="no-underline"
          >
            <Chip tone="info" size="xs" mono>{cb.repoFullName}</Chip>
          </Link>
        ))}
      </Inline>
    </Card>
  );
}

export function InitiativeRail({
  initiativeId,
  activity,
  codebases,
}: {
  initiativeId: string | undefined;
  activity: AgentActivity;
  codebases: Codebase[];
}) {
  const [tab, setTab] = useState('agents');

  return (
    <Stack gap="sm">
      <DeliveredBy codebases={codebases} />

      <Tabs
        idPrefix="initiative-rail"
        aria-label="Initiative rail"
        variant="segmented"
        size="sm"
        items={RAIL_TABS}
        value={tab}
        onValueChange={setTab}
      />

      <TabPanel id="agents" when={tab} idPrefix="initiative-rail">
        <Stack gap="sm">
          <AgentsRailCard activity={activity} />
          <OutcomesRailCard activity={activity} />
        </Stack>
      </TabPanel>

      <TabPanel id="compute" when={tab} idPrefix="initiative-rail">
        <Stack gap="sm">
          <ComputersRailCard initiativeId={initiativeId} />
          <EnvironmentsRailCard initiativeId={initiativeId} />
          <LabMemoryRailCard initiativeId={initiativeId} />
        </Stack>
      </TabPanel>
    </Stack>
  );
}
