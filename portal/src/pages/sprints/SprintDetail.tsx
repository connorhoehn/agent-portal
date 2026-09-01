// The panel under the picker: one sprint, in full.
//
// Three concerns used to sit stacked in a single undifferentiated slab —
// four money tiles, then the board, then the grants list, separated by nothing
// but a margin. The money tiles in particular read as a duplicate of the
// page-level rollup thirty pixels above them ("Points", "Envelope granted",
// "Initiative spend in window" appear in both), which is most of why the page
// looked cluttered. Tabs give the three a hierarchy and put only one of them on
// screen at a time; the default is Work, because that is what the SME the page
// was written for opens it to see.

import { useState } from 'react';
import { Link } from 'react-router';
import {
  Card,
  Chip,
  DetailHeader,
  InlineAlert,
  KPIGrid,
  MetaLine,
  ProgressBar,
  Stack,
  StatCard,
  TabPanel,
  Tabs,
} from '@connorhoehnslalom/ui-components/shared';
import { SprintBoard } from './SprintBoard';
import { GrantsPanel } from './GrantsPanel';
import { dateRange, isOverEnvelope, STATUS_TONE, timeLeftLabel, usd, windowProgress } from './sprintFormat';
import type { Sprint } from './types';

function SprintMoney({ s }: { s: Sprint }) {
  const overEnvelope = isOverEnvelope(s);
  return (
    <Stack gap="sm">
      <KPIGrid columns={4}>
        <StatCard
          label="Points"
          value={`${s.pointsDone} / ${s.pointsTotal}`}
          hint={`${s.doneItemCount} of ${s.itemCount} items done`}
        />
        <StatCard
          label="Planned cost"
          value={usd(s.estimatedCostUsd)}
          hint="Sum of the sprint's work-item dollar estimates"
        />
        <StatCard
          label="Envelope granted"
          value={s.grantCount > 0 ? usd(s.grantedUsd) : '—'}
          hint={s.grantCount > 0
            ? `${s.grantCount} grant${s.grantCount === 1 ? '' : 's'} to ${s.stewardName ?? 'the steward'}`
            : 'No budget grant scoped to this sprint'}
        />
        <StatCard
          label="Initiative spend in window"
          value={usd(s.initiativeSpendInWindowUsd)}
          danger={overEnvelope}
          // The label is load-bearing, not decoration. bot_runs record the
          // initiative and the bot that paid, never the person whose envelope
          // authorized it — so this is what the initiative spent between these
          // dates, and calling it the steward's burn would be a number the data
          // cannot support.
          hint={`All agent spend attributed to this initiative ${dateRange(s)} — not a personal burn figure`}
        />
      </KPIGrid>
      {overEnvelope ? (
        <InlineAlert tone="warning">
          The initiative spent more inside this window than the sprint's envelope holds. That
          spend is the initiative's, not necessarily this sprint's — cron maintenance on the
          same repos lands in the same window.
        </InlineAlert>
      ) : null}
    </Stack>
  );
}

export function SprintDetail({ s, personId, canManageSprints, canManageBudgets, onChanged }: {
  s: Sprint; personId: string | null;
  canManageSprints: boolean; canManageBudgets: boolean; onChanged: () => void;
}) {
  const [selectedTab, setTab] = useState('work');
  // Losing ManageBudgets while the Envelopes tab is open would otherwise leave
  // the detail showing tabs with nothing under them.
  const tab = selectedTab === 'grants' && !canManageBudgets ? 'work' : selectedTab;
  const progress = windowProgress(s);

  const tabs = [
    { id: 'work', label: 'Work', badge: <Chip tone="neutral" size="sm">{s.itemCount}</Chip> },
    { id: 'money', label: 'Money' },
    ...(canManageBudgets
      ? [{ id: 'grants', label: 'Envelopes', badge: <Chip tone="neutral" size="sm">{s.grantCount}</Chip> }]
      : []),
  ];

  return (
    <Card padding="md">
      <Stack gap="md">
        <DetailHeader
          title={s.name}
          badge={<Chip tone={STATUS_TONE[s.status] ?? 'neutral'} size="sm">{s.status}</Chip>}
          description={s.goal ?? undefined}
          meta={
            <MetaLine
              size="sm"
              items={[
                <Link key="init" to={`/iq/projects/${encodeURIComponent(s.orgProjectId)}`}>
                  {s.orgProjectName ?? s.orgProjectId}
                </Link>,
                // The steward is the SME accountable for the sprint; the
                // envelope on the Money tab is granted to them.
                `Steward: ${s.stewardName ?? 'unassigned'}`,
                dateRange(s),
                s.status !== 'done' ? timeLeftLabel(s.endsOn) : null,
              ]}
            />
          }
          aside={
            <>
              {progress !== null ? (
                <ProgressBar
                  value={Math.round(progress * 100)}
                  max={100}
                  showRatio={false}
                  label="Elapsed"
                  size="sm"
                />
              ) : null}
              <ProgressBar
                value={s.pointsDone}
                max={Math.max(s.pointsTotal, 1)}
                label="Points done"
                size="sm"
              />
            </>
          }
        />

        <Tabs
          items={tabs}
          value={tab}
          onValueChange={setTab}
          variant="underline"
          idPrefix="sprint-detail"
          aria-label="Sprint detail sections"
        />

        <TabPanel id="work" when={tab} idPrefix="sprint-detail">
          <SprintBoard
            sprintId={s.id}
            orgProjectId={s.orgProjectId}
            personId={personId}
            canManageSprints={canManageSprints}
            onChanged={onChanged}
          />
        </TabPanel>
        <TabPanel id="money" when={tab} idPrefix="sprint-detail">
          <SprintMoney s={s} />
        </TabPanel>
        {canManageBudgets ? (
          <TabPanel id="grants" when={tab} idPrefix="sprint-detail">
            <GrantsPanel sprint={s} onChanged={onChanged} />
          </TabPanel>
        ) : null}
      </Stack>
    </Card>
  );
}
