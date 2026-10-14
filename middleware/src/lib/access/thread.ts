// The request discussion `access:req:<id>` (decision A8): who the gateway
// admits to it. The answer is the REST read rule of GET /api/access/requests/:id
// (lib/access/rules.ts `mayRead`) asked against the directory NOW — the
// requester, the beneficiary, the beneficiary's manager, anyone who decided a
// step or may decide an open one (resolved live, lib/access/chain.ts), and the
// access admins. lib/page-resources.ts asks this for the `access-request`
// resource on every channel decision and every unread/mention recipient
// (lib/live-principal.ts, lib/social-notify.ts); nothing caches a verdict.

import { listCatalog, listRequests, listSteps, loadDirectory, withDirectoryUser } from '../../providers/access.js';
import { mayRead, type AccessActor } from './rules.js';

export const ACCESS_THREAD_PREFIX = 'access:req:';

/** `access:req:<id>` → the request id, or null. */
export function requestIdOfThread(bare: string): string | null {
  if (!bare.startsWith(ACCESS_THREAD_PREFIX)) return null;
  const id = bare.slice(ACCESS_THREAD_PREFIX.length);
  return /^req-[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
}

/**
 * May `userId` read request `requestId` right now? An unknown request, an
 * unknown user and an unavailable store are one refusal. The role the read
 * rule weighs is the user's own `access` grant (access-admin reads every
 * request; the cross-tenant admin likewise), not a session's active role: the
 * family's tenant/action half (ViewAccess, standing in `access`) is decided by
 * the gateway before this is asked.
 */
export async function requestReadableBy(requestId: string, userId: string): Promise<boolean> {
  try {
    const request = listRequests().find((r) => r.id === requestId);
    if (!request) return false;
    const dir = await withDirectoryUser(await loadDirectory(), userId);
    const user = dir.users.find((u) => u.id === userId);
    if (!user) return false;
    const roles = user.grants['access'] ?? [];
    const role = roles.includes('access-admin') ? 'access-admin' : roles.includes('admin') ? 'admin' : roles[0] ?? 'none';
    const actor: AccessActor = { id: user.id, personId: user.personId, role, mayDecide: false, mayProvision: false };
    const item = listCatalog().find((i) => i.id === request.itemId);
    return mayRead(actor, request, listSteps(request.id), item, dir);
  } catch {
    return false;
  }
}
