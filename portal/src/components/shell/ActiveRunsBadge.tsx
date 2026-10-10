// ActiveRunsBadge — "what is the fleet running right now", in the header.
//
// WHY THIS EXISTS. Pressing Run on a work item dispatched an agent into a
// microVM and then left no trail. The run was reachable only from the
// initiative you launched it from (`/api/bots/marketplace-runs` needs an
// orgProjectId) and from nowhere else — navigate away and it was gone, still
// burning money, with no list that could lead you back. The ⌘I quick-switch
// looks like the answer and is not: it lists COMPUTERS, and a box with no run
// is idle while a run whose box was reaped is still a live row.
//
// So this is deliberately a list of RUNS, keyed to where each one is working.
// Selecting one opens its box in the Computer Lab, which is where the logs are
// tailed — the run's own outcome carries the boxId, so the link is exact
// rather than a guess at which computer is probably the right one.
//
// Renders nothing when nothing is running, like LocalComputeBadge: the header
// states a fact when there is one and never nags.
//
// WHAT IT COUNTS. Dispatched runs (`bot_runs`), not queue jobs (`agent_jobs`).
// Automate › Runs and the Inbox's Current queue count the queue, so for a while
// this said "2 running" beside a page reading Running 0 and an SME following it
// found neither run. The menu now says which kind these are and ends on the
// Runs page, which lists them under their own heading (pages/work/dispatchedRuns.ts).

import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { ChevronIcon, DropdownMenu, Inline, StatusDot, type DropdownMenuItem } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { useOrgiqShellPolls, useRefreshSessionOnDeny } from './orgiqShellPolls';
import {
  ACTIVE_RUNS_URL, DISPATCHED_RUNS_PATH, dispatchedRunDestination, dispatchedRunLabel, dispatchedRunsNoun,
  type DispatchedRun,
} from '../../pages/work/dispatchedRuns';

// 10s: fast enough that a run started on another tab shows up while the
// operator is still wondering where it went, slow enough not to be a poll
// storm. The lab itself streams — this is glanceable status, not a tail.
const POLL_MS = 10_000;

/** The dispatched-runs poll, shared with FleetIndicator so both read one source. */
export function useActiveRuns(): { runs: DispatchedRun[]; items: DropdownMenuItem[]; polling: boolean } {
  const navigate = useNavigate();
  // Where a run leads depends on what the caller may open. ManageDevbox is
  // held by hr-admin and sme — NOT by org-leader, who can still dispatch. A
  // link to /admin/devbox for that role hits RequireRole and bounces to
  // /workspaces, which is exactly the dead end this widget exists to remove.
  const { can } = useCapabilities();
  const mayOpenLab = can('ManageDevbox');
  // `/api/bots/*` is requireTenant('orgiq') — gate the fetch BEFORE it fires
  // (orgiqShellPolls.ts says why the tenant alone is not enough).
  const orgiq = useOrgiqShellPolls();
  const { data, error } = useFetch<{ runs: DispatchedRun[] }>(
    orgiq ? ACTIVE_RUNS_URL : null,
    POLL_MS,
    { share: true },
  );
  useRefreshSessionOnDeny(error);
  const runs = useMemo(() => data?.runs ?? [], [data]);

  const items = useMemo<DropdownMenuItem[]>(() => runs.map((run) => {
    const dest = dispatchedRunDestination(run, mayOpenLab);
    return {
      label: dispatchedRunLabel(run),
      description: `Started ${relativeTime(run.startedAt)} · ${dest.kind === 'computer' ? 'Open computer & logs' : dest.kind === 'work-item' ? 'Open work item' : 'Open the list'}`,
      icon: <StatusDot size="sm" color="var(--color-success)" />,
      onSelect: () => navigate(dest.path),
    };
  }), [runs, navigate, mayOpenLab]);
  return { runs, items, polling: orgiq };
}

export function ActiveRunsBadge() {
  const navigate = useNavigate();
  const { runs, items } = useActiveRuns();

  if (runs.length === 0) return null;

  return (
    <DropdownMenu
      trigger={(
        <Inline as="span" gap="xs" wrap={false} className="inline-flex">
          <StatusDot size="xs" color="var(--color-success)" />
          <span>{runs.length} running</span>
          <ChevronIcon dir="down" size={12} aria-hidden="true" />
        </Inline>
      )}
      triggerClassName="px-2 py-1 text-xs leading-4 font-medium text-text-secondary"
      triggerLabel={`${dispatchedRunsNoun(runs.length)} in progress`}
      triggerTitle={`${dispatchedRunsNoun(runs.length)} running now — dispatched from work items, so they run on a computer directly and are not jobs on the queue`}
      align="end"
      className="w-[min(28rem,calc(100vw-2rem))] [&_[role=menuitem]]:whitespace-normal"
      sections={[
        { label: 'Dispatched runs · not queue jobs', items },
        {
          items: [{
            label: 'All dispatched runs on Automate › Runs',
            description: 'Listed above the job queue, with where each one is working',
            onSelect: () => navigate(DISPATCHED_RUNS_PATH),
          }],
        },
      ]}
      data-testid="active-runs-badge"
    />
  );
}
