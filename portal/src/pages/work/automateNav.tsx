// The Automate sub-nav — ONE spec shared by IqLayout (/iq/work*) and
// AdminLayout (/admin/bots*, /admin/changes*), so the rail never disappears
// mid-hierarchy: Bots is a child of Automate, not a top-level door, and
// clicking it keeps you inside the same frame. Code review (/admin/changes)
// is no longer in this rail: it belongs to the org graph (learning loop, lane E6).
//
// Keep operational views compact; configuration and code review retain
// their existing role gates.

import type { SubNavItem } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import type { Summary } from './workShared';
import { useSession } from '../../lib/auth';

export interface AutomateSpec {
  title: string;
  items: SubNavItem[];
  storageKey: string;
}

const RUN_ITEMS: SubNavItem[] = [
  { path: '/iq/work', label: 'Inbox' },
  { path: '/iq/work/queue', label: 'Runs' },
  { path: '/iq/work/findings', label: 'Findings' },
  { path: '/iq/work/changes', label: 'Changes' },
];
const BOTS_ITEM: SubNavItem = { path: '/admin/bots', label: 'Automations' };

/** Roles that reach the Bots surface — mirrors the /admin/bots route gate
 *  (and Cedar's ManageBots). Exported so QueuePulse's roster rows link into
 *  a bot's own page for exactly the roles that can actually open it. */
export const BOTS_ROLES = ['hr-admin', 'sme', 'program-owner', 'org-leader', 'admin'];
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
  const { data, error, degraded } = useFetch<Summary>(session?.tenant === 'orgiq' ? '/api/work/summary' : null, 15_000, { share: true });
  const counts = !error && !degraded ? data : null;
  return {
    title: 'Automate',
    items: [
      ...RUN_ITEMS.map((item) => ({ ...item, ...(counts && item.path === '/iq/work' ? { count: (counts.consults?.pending ?? 0) + (counts.jobs.awaiting_review ?? 0) + (counts.proposals.pending ?? 0) } : {}), ...(counts && item.path === '/iq/work/findings' ? { count: counts.findings.open } : {}) })),
      ...(BOTS_ROLES.includes(role) ? [BOTS_ITEM] : []),
    ],
    storageKey: 'automate-subnav',
  };
}
