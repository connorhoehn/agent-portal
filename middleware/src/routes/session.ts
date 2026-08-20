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
  type Role,
  type Session,
  type Tenant,
} from '../lib/session.js';
import { isAllowed } from '../lib/authz.js';
import { eventFromSession, logAuthz } from '../lib/audit.js';
import { rateLimit } from '../lib/rate-limit.js';
import { cognitoEnabled } from '../lib/oidc.js';
import { demoModeEnabled } from '../lib/session.js';
import { listUsers, getUser } from '../providers/identity.js';

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
    availableRoles: rolesForTenant(session.grants, session.tenant),
    availableTenants: TENANTS.filter(t => rolesForTenant(session.grants, t).length > 0),
    masquerading: session.act ? { asUser: session.sub, actor: session.act.sub } : null,
  };
}

async function issue(res: import('express').Response, session: Session) {
  setSessionCookie(res, await signSession(session));
  res.json(publicView(session));
}

sessionRouter.get('/me', (req, res) => {
  res.json(publicView(req.session ?? demoSession()));
});

// Login-able users for the picker. Deliberately open: this is the demo login
// surface, equivalent to the username list on a shared dev box.
sessionRouter.get('/users', asyncHandler(async (_req, res) => {
  const users = await listUsers();
  res.json(users.map(u => ({
    id: u.id,
    displayName: u.displayName,
    email: u.email,
    tenants: Object.entries(u.grants).map(([tenant, roles]) => ({ tenant, roles })),
  })));
}));

sessionRouter.post('/login', loginLimit, asyncHandler(async (req, res) => {
  // When SSO is configured, the picker is a dev-only convenience: disable it in
  // production (unless AUTH_DEMO_MODE explicitly re-opens it) so the only real
  // login path is the authenticated Cognito flow.
  if (cognitoEnabled() && !demoModeEnabled()) {
    res.status(403).json({ error: 'Picker login is disabled; sign in with SSO', ssoEnabled: true });
    return;
  }
  const { userId } = req.body as { userId?: string };
  if (!userId) { res.status(400).json({ error: 'userId is required' }); return; }
  const user = await getUser(userId);
  if (!user) { res.status(404).json({ error: `unknown user ${userId}` }); return; }
  const session = mintSession({ id: user.id, displayName: user.displayName }, user.grants);
  if (!session) { res.status(403).json({ error: `${userId} holds no tenant grants` }); return; }
  logAuthz(eventFromSession(session, 'Login', 'ALLOW', { path: '/api/session/login' }));
  await issue(res, session);
}));

sessionRouter.post('/role', switchLimit, asyncHandler(async (req, res) => {
  const { role } = req.body as { role?: string };
  const session = req.session ?? demoSession();
  if (!role) { res.status(400).json({ error: 'role is required' }); return; }
  if (!hasGrant(session.grants, session.tenant, role)) {
    logAuthz(eventFromSession(session, 'SwitchRole', 'DENY', {
      path: req.path, reason: `no grant for role=${role} in tenant=${session.tenant}`,
    }));
    res.status(403).json({
      error: `no grant for role '${role}' in tenant '${session.tenant}'`,
      availableRoles: rolesForTenant(session.grants, session.tenant),
    });
    return;
  }
  await issue(res, { ...session, role: role as Role, iat: Math.floor(Date.now() / 1000) });
}));

sessionRouter.post('/tenant', switchLimit, asyncHandler(async (req, res) => {
  const { tenant } = req.body as { tenant?: string };
  const session = req.session ?? demoSession();
  if (!tenant || !TENANTS.includes(tenant as Tenant)) {
    res.status(400).json({ error: `tenant must be one of ${TENANTS.join(', ')}` });
    return;
  }
  const held = rolesForTenant(session.grants, tenant);
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
  await issue(res, {
    ...session, tenant: tenant as Tenant, role, iat: Math.floor(Date.now() / 1000),
  });
}));

// Masquerade: adopt another user's identity + grants, keeping the real
// identity in session.act for audit and restore. Gated by the Cedar
// Masquerade action (granted to the admin role only in the seeds).
sessionRouter.post('/masquerade', loginLimit, asyncHandler(async (req, res) => {
  const { userId } = req.body as { userId?: string };
  const session = req.session ?? demoSession();
  if (!userId) { res.status(400).json({ error: 'userId is required' }); return; }
  if (session.act) {
    res.status(409).json({ error: 'already masquerading — stop first' });
    return;
  }
  const allowed = await isAllowed(session, 'Masquerade');
  logAuthz(eventFromSession(session, 'Masquerade', allowed ? 'ALLOW' : 'DENY', {
    path: req.path, reason: allowed ? `as ${userId}` : undefined,
  }));
  if (!allowed) { res.status(403).json({ error: 'Forbidden', action: 'Masquerade' }); return; }
  const target = await getUser(userId);
  if (!target) { res.status(404).json({ error: `unknown user ${userId}` }); return; }
  const masqueraded = mintSession(
    { id: target.id, displayName: target.displayName },
    target.grants,
    { tenant: session.tenant },
    {
      sub: session.sub,
      ...(session.name ? { name: session.name } : {}),
      role: session.role,
      tenant: session.tenant,
      grants: session.grants,
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
  };
  logAuthz(eventFromSession(restored, 'MasqueradeStop', 'ALLOW', { path: req.path }));
  await issue(res, restored);
}));

sessionRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});
