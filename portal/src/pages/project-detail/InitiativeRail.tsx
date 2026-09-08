// The mission-control rail.
//
// This was five independent panels stacked down a 300px column — agents,
// computers, environments, lab memory and outcomes — each with its own header
// and its own border, all on screen at once beside the work column. That stack
// is the "competing panels" half of the clutter. The panels themselves are
// unchanged; they are now two tabs, so one concern is on screen at a time and
// the rest are one click away.

import { useState } from 'react';
import { useFetch } from '../../hooks/useFetch';
import { Link } from 'react-router';
import {
  Card,
  Chip,
  Inline,
  SectionLabel,
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
import { T } from './Text';
import { ActivityPanel } from './ActivityPanel';
import type { BotRun } from '../bots/BotsPage';
import type { Codebase, WorkItemTree } from './types';

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
    <Card padding="sm">
      {/* Same header as every other rail card (Designs, Agents, Outcomes,
          Activity): a small uppercase label, not a card title. */}
      <SectionLabel className="text-[10px] font-semibold tracking-wide">Delivered by</SectionLabel>
      <Inline gap="sm" className="mt-2">
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

/** The initiative's design reviews — the ADR threads that steer this work.
 *  Without this card the two surfaces never met: designs knew their
 *  initiative, the initiative had no idea it was being designed. */
function DesignsRailCard({ initiativeId }: { initiativeId: string | undefined }) {
  const { data } = useFetch<{ reviews: Array<{
    id: string; title: string; status: string; openQuestions: number;
  }> }>(initiativeId ? `/api/designs?initiative=${encodeURIComponent(initiativeId)}` : null, 60_000);
  const reviews = data?.reviews ?? [];
  if (reviews.length === 0) return null;
  return (
    <Card padding="sm">
      <Inline justify="between" align="baseline" wrap={false}>
        <SectionLabel className="text-[10px] font-semibold tracking-wide">Designs</SectionLabel>
        <Link to="/iq/designs" className="text-[11px] text-primary no-underline hover:underline">all →</Link>
      </Inline>
      <Stack gap="xs" className="mt-2">
        {reviews.map((r) => (
          <Link key={r.id} to={`/iq/designs/${r.id}`} className="no-underline min-w-0">
            <Inline gap="xs" wrap={false}>
              <Chip
                tone={r.status === 'approved' ? 'success' : r.status === 'awaiting_input' ? 'warning' : 'info'}
                size="xs"
              >
                {r.status === 'awaiting_input' ? 'needs input' : r.status}
              </Chip>
              <T className="truncate text-[12px] text-text-secondary hover:text-primary">{r.title}</T>
            </Inline>
          </Link>
        ))}
      </Stack>
    </Card>
  );
}

export function InitiativeRail({
  initiativeId,
  activity,
  codebases,
  runs,
  workTree,
}: {
  initiativeId: string | undefined;
  activity: AgentActivity;
  codebases: Codebase[];
  /** Marketplace runs + the work tree — the day-by-day activity card derives
   *  its lines from the same objects the work pane shows. */
  runs: BotRun[];
  workTree: WorkItemTree[];
}) {
  const [tab, setTab] = useState('agents');

  return (
    <Stack gap="sm">
      <DeliveredBy codebases={codebases} />
      {/* Activity lives in the rail, not a tab: it is the context you read
          beside the work, and the rail stays on screen while the table
          scrolls. */}
      <ActivityPanel compact runs={runs} workTree={workTree} />
      <DesignsRailCard initiativeId={initiativeId} />

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
