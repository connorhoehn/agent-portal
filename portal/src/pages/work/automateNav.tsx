// The Automate sub-nav — ONE spec shared by IqLayout (/iq/work*) and
// AdminLayout (/admin/bots*, /admin/changes*), so the rail never disappears
// mid-hierarchy: Bots and Changes are children of Automate now, not top-level
// doors, and clicking them keeps you inside the same frame.
//
// The grouping is the loop itself: RUN (overview → queue → findings/DLQ),
// CONFIGURE (the bot missions that feed the queue), REVIEW (the
// human-in-the-loop gate everything ships through).

import type { SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import { useSession } from '../../lib/auth';

export interface AutomateSpec {
  title: string;
  items: SubNavItem[];
  storageKey: string;
}

const RUN_ITEMS: SubNavItem[] = [
  { path: '/iq/work',          label: 'Overview', hint: 'The loop at a glance + what needs you', group: 'Run' },
  { path: '/iq/work/queue',    label: 'Queue',    hint: 'Jobs in flight + work ready to assign', group: 'Run' },
  { path: '/iq/work/findings', label: 'Findings', hint: 'Sweep findings + the dead-letter queue', group: 'Run' },
];

const BOTS_ITEM: SubNavItem = {
  path: '/admin/bots', label: 'Bots', hint: 'The standing missions that feed the queue', group: 'Configure',
};

// What reached the org graph. It always lived inside the Automate frame
// (breadcrumb Build › Automate › Graph updates, a palette entry, a link from
// the Queue page) but had no rail row, so it opened with nothing lit beside
// a row named "Changes" that is the code-review queue — a different page.
// Readable by every signed-in role, like the Run pages.
const GRAPH_UPDATES_ITEM: SubNavItem = {
  path: '/iq/work/changes', label: 'Graph updates', hint: 'What reached the org graph', group: 'Review',
};

const CHANGES_ITEM: SubNavItem = {
  path: '/admin/changes', label: 'Changes', hint: 'Human review of what the bots shipped', group: 'Review',
};

/** Roles that reach the Bots surface — mirrors the /admin/bots route gate
 *  (and Cedar's ManageBots). Exported so QueuePulse's roster rows link into
 *  a bot's own page for exactly the roles that can actually open it. */
export const BOTS_ROLES = ['hr-admin', 'sme', 'program-owner', 'org-leader', 'admin'];
/** Roles that reach change review — mirrors the /admin/changes route gate. */
const CHANGES_ROLES = ['hr-admin', 'program-owner', 'admin'];
/** Roles that reach the Computer Lab — mirrors the /admin/devbox route gate
 *  (App.tsx). A member's role isn't in this list, so the Overview page's
 *  inline "Computer Lab" mention must not render as a link for them — the
 *  route redirects a member straight back to /iq/projects with no
 *  explanation, so a live link only teaches "this breaks." */
// Mirrors Cedar: only `sme.cedar` and `hr-admin.cedar` grant ManageDevbox
// (admin's wildcard covers it). Widening this list without widening Cedar
// only produces a rail item that 403s.
export const DEVBOX_ROLES = ['hr-admin', 'sme', 'admin'];

export function useAutomateSpec(): AutomateSpec {
  const { session } = useSession();
  const role = session?.role ?? '';
  return {
    title: 'Automate',
    items: [
      ...RUN_ITEMS,
      ...(BOTS_ROLES.includes(role) ? [BOTS_ITEM] : []),
      GRAPH_UPDATES_ITEM,
      ...(CHANGES_ROLES.includes(role) ? [CHANGES_ITEM] : []),
    ],
    storageKey: 'automate-subnav',
  };
}
