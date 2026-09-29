// Whether the shell may poll the orgiq-only APIs (`/api/bots/*`,
// `/api/local-compute/*`, `/api/work/*` — all `requireTenant('orgiq')`), and
// what to do when one of those polls is refused anyway.
//
// `session.tenant === 'orgiq'` alone was not enough, for two reasons:
//
//   1. The page renders before the capability probe settles, and the probe is
//      what reflects the CURRENT cookie. The polls now wait for it (`ready`)
//      and require `ViewOrgChart` — the orgiq read floor every orgiq role
//      holds and no assessment role does. (Degraded authz makes `can`
//      permissive by design; the server still decides.)
//   2. The React session is read once from /me, but the cookie is shared by
//      every tab: sign in as an assessment user in one tab and an orgiq tab
//      kept asking the orgiq APIs with the new cookie — a 403 (and an authz
//      DENY) every 10–15 s until reload. A 403 on a shell poll now re-reads
//      the session once; if the tenant has moved, the gate above closes.

import { useEffect, useRef } from 'react';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';

export function useOrgiqShellPolls(): boolean {
  const { session } = useSession();
  const { can, ready } = useCapabilities();
  return session?.tenant === 'orgiq' && ready && can('ViewOrgChart');
}

/**
 * Re-read the session when a shell poll comes back 403 (useFetch's `error`
 * starts with the status). Once per session identity: a role that is really
 * refused keeps its error and does not spin on /me.
 */
export function useRefreshSessionOnDeny(error: string | null): void {
  const { session, refresh } = useSession();
  const key = session ? `${session.sub}|${session.tenant}|${session.role}` : null;
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!key || !error?.startsWith('403') || refreshedFor.current === key) return;
    refreshedFor.current = key;
    void refresh();
  }, [error, key, refresh]);
}
