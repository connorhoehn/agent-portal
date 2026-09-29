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

import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { ChevronIcon, DropdownMenu, type DropdownMenuItem } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { useOrgiqShellPolls, useRefreshSessionOnDeny } from './orgiqShellPolls';

interface WireRun {
  id: string;
  workItemId: string | null;
  workItemTitle: string | null;
  projectId: string | null;
  trigger: string;
  startedAt: string;
  outcome?: { boxId?: string } | null;
}

// 10s: fast enough that a run started on another tab shows up while the
// operator is still wondering where it went, slow enough not to be a poll
// storm. The lab itself streams — this is glanceable status, not a tail.
const POLL_MS = 10_000;

export function ActiveRunsBadge() {
  const navigate = useNavigate();
  // Where a run leads depends on what the caller may open. ManageDevbox is
  // held by hr-admin and sme — NOT by org-leader, who can still dispatch. A
  // link to /admin/devbox for that role hits RequireRole and bounces to
  // /select, which is exactly the dead end this widget exists to remove: the
  // run was not merely hard to find, it was behind a door the operator who
  // started it could not open.
  const { can } = useCapabilities();
  const mayOpenLab = can('ManageDevbox');
  // `/api/bots/*` is requireTenant('orgiq') — gate the fetch BEFORE it fires
  // rather than letting an assessment session 403 on every poll and swallow
  // it as `error` (orgiqShellPolls.ts says why the tenant alone is not enough).
  const orgiq = useOrgiqShellPolls();
  const { data, error } = useFetch<{ runs: WireRun[] }>(
    orgiq ? '/api/bots/active-runs' : null,
    POLL_MS,
  );
  useRefreshSessionOnDeny(error);
  const runs = useMemo(() => data?.runs ?? [], [data]);

  const items = useMemo<DropdownMenuItem[]>(() => runs.map((run) => {
    const boxId = run.outcome?.boxId;
    return {
      // The work item is what the operator dispatched and what they will
      // recognise; the id is the fallback for a run with no item behind it
      // (a bot firing), which is still a live cost centre worth listing.
      label: run.workItemTitle ?? run.workItemId ?? run.trigger,
      description: `Started ${relativeTime(run.startedAt)} · ${mayOpenLab && boxId ? 'Open computer & logs' : 'Open work item'}`,
      icon: <span aria-hidden="true" className="inline-block size-2 rounded-full bg-success" />,
      onSelect: () => {
        // Straight to the box that is doing the work — that is where the logs
        // are — but only for a role the lab will actually admit.
        if (mayOpenLab && boxId) {
          navigate(`/admin/devbox?box=${encodeURIComponent(boxId)}`);
          return;
        }
        // Otherwise the work item on its initiative: the run's state, its
        // spend and its Compute rail are all there, and it is in-tenant and
        // reachable by every role that can dispatch. A destination that
        // redirects to /select is worse than no link at all.
        if (run.projectId && run.workItemId) {
          navigate(`/iq/projects/${encodeURIComponent(run.projectId)}?item=${encodeURIComponent(run.workItemId)}`);
          return;
        }
        navigate(mayOpenLab ? '/admin/devbox' : '/iq/projects');
      },
    };
  }), [runs, navigate, mayOpenLab]);

  if (runs.length === 0) return null;

  return (
    <DropdownMenu
      trigger={(
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />
          <span>{runs.length} running</span>
          <ChevronIcon dir="down" size={12} aria-hidden="true" />
        </span>
      )}
      triggerClassName="px-2 py-1 text-xs leading-4 font-medium text-text-secondary"
      triggerLabel={`${runs.length} agent run${runs.length === 1 ? '' : 's'} in progress`}
      triggerTitle={mayOpenLab
        ? 'Running now — select one to open its computer and tail the logs'
        : 'Running now — select one to open the work item it is delivering'}
      align="end"
      className="w-[min(28rem,calc(100vw-2rem))] [&_[role=menuitem]]:whitespace-normal"
      sections={[{ label: 'Running now', items }]}
      data-testid="active-runs-badge"
    />
  );
}
