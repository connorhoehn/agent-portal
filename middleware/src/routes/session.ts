// Session lifecycle: login (user picker), role/tenant switching validated
// against the user's grants, and Cedar-gated masquerade with provenance.
//
// Every switch re-signs the cookie; nothing here trusts client-supplied
// tenant/role beyond checking it against session.grants, which were loaded
// server-side at login.

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import {
  TENANTS,
  ADMIN_ROLE,
  hasGrant,
  rolesForTenant,
  mintSession,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  demoSession,
  demoFallbackAllowed,
  type Role,
  type Session,
  type Tenant,
  demoScopedGrants,
  switchableGrants,
} from '../lib/session.js';
import { isAllowed, CAPABILITY_ACTIONS } from '../lib/authz.js';
import { eventFromSession, logAuthz } from '../lib/audit.js';
import { rateLimit } from '../lib/rate-limit.js';
import { cognitoEnabled } from '../lib/oidc.js';
import { demoModeEnabled, ssoAvailable } from '../lib/session.js';
import { listUsers, getUser, bumpSessionEpoch } from '../providers/identity.js';

export const sessionRouter = Router();

// Identity switching is the credential surface of this app — brake it.
// Reads (/me, /users) stay unthrottled; the portal polls them.
const loginLimit = rateLimit('session-login', 15, 60_000);
const switchLimit = rateLimit('session-switch', 30, 60_000);

function publicView(session: Session) {
  return {
    sub: session.sub,
    name: session.name ?? session.sub,
    role: session.role,
    tenant: session.tenant,
    grants: session.grants,
    // What this identity may still BECOME. For a real user that is its
    // grants; for the cookie-less demo persona it is every persona, even
    // though the cookie has been narrowed to the one it picked — the picker
    // offers personas from this, the session's authority comes from `grants`.
    switchable: switchableGrants(session.sub, session.grants),
    availableRoles: rolesForTenant(session.grants, session.tenant),
    availableTenants: TENANTS.filter(t => rolesForTenant(session.grants, t).length > 0),
    masquerading: session.act ? { asUser: session.sub, actor: session.act.sub } : null,
  };
}

async function issue(res: import('express').Response, session: Session) {
  setSessionCookie(res, await signSession(session));
  res.json(publicView(session));
}

/**
 * The epoch to stamp on a session-switch's re-minted cookie. A real (non-
 * masquerade) switch bumps app_users.session_epoch, which invalidates every
 * OTHER cookie this user holds at the next grants-refresh. Masquerade must NOT
 * bump: an operator switching tenant/role inside an impersonation must not kill
 * the impersonated user's real sessions. A switch must never hard-fail on the
 * epoch write, so an Aurora blip falls back to the cookie's current epoch.
 */
async function nextEpochForSwitch(session: Session): Promise<number | undefined> {
  if (session.act) return session.epoch;
  try {
    return await bumpSessionEpoch(session.sub);
  } catch (err) {
    console.warn(`[session] epoch bump failed for ${session.sub}, keeping current epoch: ${(err as Error).message}`);
    return session.epoch;
  }
}

/** The caller's session, or the demo fallback while it's still allowed. Null
 * means anonymous with a real IdP configured — respond 401 { ssoRequired } so
 * the portal routes through Cognito instead of showing demo-user forever. */
function sessionOrNull(req: import('express').Request): Session | null {
  return req.session ?? (demoFallbackAllowed() ? demoSession() : null);
}

function unauthenticated(res: import('express').Response): void {
  res.status(401).json({ error: 'Unauthenticated', ssoRequired: ssoAvailable() });
}

sessionRouter.get('/me', (req, res) => {
  const session = sessionOrNull(req);
  if (!session) { unauthenticated(res); return; }
  res.json(publicView(session));
});

// Which org-graph person this session's account is connected to
// (app_users.person_id), if any.
//
// Why a separate read rather than a field on /me: "Mine" views (initiatives,
// sprints) resolve through this link server-side, and an unlinked account gets
// an empty list — indistinguishable, to the page, from a linked person who
// simply owns nothing. The two need different copy and different remedies
// ("connect your profile" vs "nobody has listed you yet"), so the page has to
// ask. /me is polled and re-minted on every switch; this is a directory read
// that can fail on its own without taking the session down with it.
//
// `demo-user` (the cookie-less dev persona) has no app_users row and reads as
// unlinked, which is the truth. A masquerade reads the IMPERSONATED account's
// link, since that is whose "Mine" the operator is looking at. The name is not
// carried here: GET /api/graph/people/:id already owns person lookups.
sessionRouter.get('/person', asyncHandler(async (req, res) => {
  const session = sessionOrNull(req);
  if (!session) { unauthenticated(res); return; }
  const user = await getUser(session.sub);
  const personId = user?.personId ?? null;
  res.json({ linked: personId != null, personId });
}));

// Every UI-gated Cedar action evaluated for the current session, through the
// exact same path requireAction uses (isAllowed → evaluate + decision cache),
// so a `true` here means the corresponding route would pass its guard. The
// portal uses this to hide/disable controls instead of surfacing 403s.
//
// An AVP outage must not 500 this endpoint: a failed evaluation reports the
// action as `false` and flips `degraded` so the UI can choose to show the
// control and let the server decide (which would then 503, not 500).
// Actions whose Cedar policies condition on resource attributes can never
// pass a bare capability probe (no resource → the `resource has X` guard
// fails). Probe them with a representative resource that can satisfy the
// condition — the per-instance decision still happens at the real endpoint.
const CAPABILITY_PROBE_ATTRS: Record<string, Record<string, number | string | boolean>> = {
  ApproveTransaction: { amount: 20000 },
};

sessionRouter.get('/capabilities', asyncHandler(async (req, res) => {
  const session = sessionOrNull(req);
  if (!session) { unauthenticated(res); return; }
  let degraded = false;
  const entries = await Promise.all(
    CAPABILITY_ACTIONS.map(async (action): Promise<[string, boolean]> => {
      try {
        return [action, await isAllowed(session, action, CAPABILITY_PROBE_ATTRS[action])];
      } catch {
        degraded = true;
        return [action, false];
      }
    }),
  );
  res.json({
    role: session.role,
    tenant: session.tenant,
    degraded,
    actions: Object.fromEntries(entries) as Record<string, boolean>,
  });
}));

// The passwordless picker and its directory exist only in demo mode. Missing
// or incomplete SSO configuration must not open either endpoint in production.
function requireDemoPicker(res: import('express').Response): boolean {
  if (demoModeEnabled()) return true;
  const ssoEnabled = cognitoEnabled();
  res.status(403).json({
    error: ssoEnabled ? 'Picker login is disabled; sign in with SSO' : 'Picker login is disabled',
    ssoEnabled,
  });
  return false;
}

sessionRouter.get('/users', asyncHandler(async (_req, res) => {
  if (!requireDemoPicker(res)) return;
  const users = await listUsers();
  res.json(users.map(u => ({
    id: u.id,
    displayName: u.displayName,
    email: u.email,
    tenants: Object.entries(u.grants).map(([tenant, roles]) => ({ tenant, roles })),
  })));
}));

sessionRouter.post('/login', loginLimit, asyncHandler(async (req, res) => {
  if (!requireDemoPicker(res)) return;
  const { userId } = req.body as { userId?: string };
  if (!userId) { res.status(400).json({ error: 'userId is required' }); return; }
  const user = await getUser(userId);
  if (!user) { res.status(404).json({ error: `unknown user ${userId}` }); return; }
  // Mint at the user's CURRENT epoch, not 0 — a user who has ever switched has
  // epoch > 0, and a fresh login below it would be rejected at grants-refresh.
  const session = mintSession({ id: user.id, displayName: user.displayName, epoch: user.epoch }, user.grants);
  if (!session) { res.status(403).json({ error: `${userId} holds no tenant grants` }); return; }
  logAuthz(eventFromSession(session, 'Login', 'ALLOW', { path: '/api/session/login' }));
  // Defense in depth: drop any prior identity's cookie before minting the new
  // one, so no stale session material survives a user switch.
  clearSessionCookie(res);
  await issue(res, session);
}));

sessionRouter.post('/role', switchLimit, asyncHandler(async (req, res) => {
  const { role } = req.body as { role?: string };
  const session = sessionOrNull(req);
  if (!session) { unauthenticated(res); return; }
  if (!role) { res.status(400).json({ error: 'role is required' }); return; }
  const switchable = switchableGrants(session.sub, session.grants);
  if (!hasGrant(switchable, session.tenant, role)) {
    logAuthz(eventFromSession(session, 'SwitchRole', 'DENY', {
      path: req.path, reason: `no grant for role=${role} in tenant=${session.tenant}`,
    }));
    res.status(403).json({
      error: `no grant for role '${role}' in tenant '${session.tenant}'`,
      availableRoles: rolesForTenant(switchable, session.tenant),
    });
    return;
  }
  const epoch = await nextEpochForSwitch(session);
  // The demo identity BECOMES the chosen role (see demoScopedGrants); a real
  // user's grants are theirs and pass through unchanged.
  const grants = demoScopedGrants(session.sub, session.tenant, role, session.grants);
  await issue(res, { ...session, role: role as Role, grants, iat: Math.floor(Date.now() / 1000), epoch });
}));

sessionRouter.post('/tenant', switchLimit, asyncHandler(async (req, res) => {
  const { tenant } = req.body as { tenant?: string };
  const session = sessionOrNull(req);
  if (!session) { unauthenticated(res); return; }
  if (!tenant || !TENANTS.includes(tenant as Tenant)) {
    res.status(400).json({ error: `tenant must be one of ${TENANTS.join(', ')}` });
    return;
  }
  const held = rolesForTenant(switchableGrants(session.sub, session.grants), tenant);
  if (held.length === 0) {
    // The cross-pollination guard: no grant in the target tenant, no switch.
    logAuthz(eventFromSession(session, 'SwitchTenant', 'DENY', {
      path: req.path, reason: `no grants in tenant=${tenant}`,
    }));
    res.status(403).json({ error: `no grants in tenant '${tenant}'` });
    return;
  }
  // Carry the role over only if it's also held in the target tenant;
  // otherwise fall back to the first non-admin role held there.
  const role = held.includes(session.role)
    ? session.role
    : (held.find(r => r !== ADMIN_ROLE) ?? held[0]!) as Role;
  const epoch = await nextEpochForSwitch(session);
  const grants = demoScopedGrants(session.sub, tenant, role, session.grants);
  await issue(res, {
    ...session, tenant: tenant as Tenant, role, grants, iat: Math.floor(Date.now() / 1000), epoch,
  });
}));

// "Sign out my other sessions": bump this user's epoch so every OTHER cookie
// they hold is rejected at its next grants-refresh, then re-issue THIS cookie at
// the new epoch so the caller survives. The bound is ≤ GRANTS_REFRESH_S (120s):
// other sessions only re-check the epoch when their cached grants next refresh.
// Refused while masquerading — an operator can't sign out the impersonated
// user's real sessions from inside an impersonation.
sessionRouter.post('/revoke-others', switchLimit, asyncHandler(async (req, res) => {
  const session = sessionOrNull(req);
  if (!session) { unauthenticated(res); return; }
  if (session.act) {
    res.status(409).json({ error: 'cannot revoke other sessions while masquerading — stop first' });
    return;
  }
  const epoch = await bumpSessionEpoch(session.sub);
  logAuthz(eventFromSession(session, 'RevokeOtherSessions', 'ALLOW', { path: req.path }));
  await issue(res, { ...session, iat: Math.floor(Date.now() / 1000), epoch });
}));

// Masquerade: adopt another user's identity + grants, keeping the real
// identity in session.act for audit and restore. Gated by the Cedar
// Masquerade action (granted to the admin role only in the seeds).
sessionRouter.post('/masquerade', loginLimit, asyncHandler(async (req, res) => {
  const { userId } = req.body as { userId?: string };
  const session = sessionOrNull(req);
  if (!session) { unauthenticated(res); return; }
  if (!userId) { res.status(400).json({ error: 'userId is required' }); return; }
  if (session.act) {
    res.status(409).json({ error: 'already masquerading — stop first' });
    return;
  }
  let allowed = false;
  try {
    allowed = await isAllowed(session, 'Masquerade');
  } catch (err) {
    // AVP outage — authorization infrastructure failure, not a DENY. Without
    // this catch the error bubbled through asyncHandler to the generic 500.
    logAuthz(eventFromSession(session, 'Masquerade', 'DENY', {
      path: req.path, reason: `authz-error: ${(err as Error).message}`,
    }));
    res.status(503).json({ error: 'authorization unavailable', action: 'Masquerade' });
    return;
  }
  logAuthz(eventFromSession(session, 'Masquerade', allowed ? 'ALLOW' : 'DENY', {
    path: req.path, reason: allowed ? `as ${userId}` : undefined,
  }));
  if (!allowed) { res.status(403).json({ error: 'Forbidden', action: 'Masquerade' }); return; }
  const target = await getUser(userId);
  if (!target) { res.status(404).json({ error: `unknown user ${userId}` }); return; }
  const masqueraded = mintSession(
    // The impersonated session carries the TARGET's epoch — a target who has
    // switched has epoch > 0, and a masquerade cookie below it would be
    // rejected at grants-refresh.
    { id: target.id, displayName: target.displayName, epoch: target.epoch },
    target.grants,
    { tenant: session.tenant },
    {
      sub: session.sub,
      ...(session.name ? { name: session.name } : {}),
      role: session.role,
      tenant: session.tenant,
      grants: session.grants,
      // Freeze the operator's epoch so masquerade/stop restores it, not 0.
      ...(session.epoch !== undefined ? { epoch: session.epoch } : {}),
    },
  );
  if (!masqueraded) { res.status(403).json({ error: `${userId} holds no tenant grants` }); return; }
  await issue(res, masqueraded);
}));

sessionRouter.post('/masquerade/stop', asyncHandler(async (req, res) => {
  const session = req.session;
  if (!session?.act) { res.status(400).json({ error: 'not masquerading' }); return; }
  const restored: Session = {
    sub: session.act.sub,
    ...(session.act.name ? { name: session.act.name } : {}),
    role: session.act.role,
    tenant: session.act.tenant,
    grants: session.act.grants,
    iat: Math.floor(Date.now() / 1000),
    // Restore the operator at their frozen epoch, not 0.
    ...(session.act.epoch !== undefined ? { epoch: session.act.epoch } : {}),
  };
  logAuthz(eventFromSession(restored, 'MasqueradeStop', 'ALLOW', { path: req.path }));
  await issue(res, restored);
}));

sessionRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});
