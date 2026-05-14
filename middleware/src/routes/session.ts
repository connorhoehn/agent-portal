import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import {
  ROLES,
  TENANTS,
  DEFAULT_TENANT,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  type Role,
  type Tenant,
} from '../lib/session.js';

export const sessionRouter = Router();

sessionRouter.get('/me', (req, res) => {
  res.json({
    sub: req.session?.sub ?? 'demo-user',
    role: req.session?.role ?? 'member',
    tenant: req.session?.tenant ?? DEFAULT_TENANT,
    availableRoles: ROLES,
  });
});

sessionRouter.post('/role', asyncHandler(async (req, res) => {
  const { role } = req.body as { role?: string };
  if (!role || !ROLES.includes(role as typeof ROLES[number])) {
    res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
    return;
  }
  const sub = req.session?.sub ?? 'demo-user';
  const tenant = req.session?.tenant ?? DEFAULT_TENANT;
  const cookie = await signSession({ sub, role: role as Role, tenant, iat: Math.floor(Date.now() / 1000) });
  setSessionCookie(res, cookie);
  res.json({ sub, role, tenant });
}));

sessionRouter.post('/tenant', asyncHandler(async (req, res) => {
  const { tenant } = req.body as { tenant?: string };
  if (!tenant || !TENANTS.includes(tenant as Tenant)) {
    res.status(400).json({ error: `tenant must be one of ${TENANTS.join(', ')}` });
    return;
  }
  const sub = req.session?.sub ?? 'demo-user';
  const role = req.session?.role ?? 'member';
  const cookie = await signSession({ sub, role, tenant: tenant as Tenant, iat: Math.floor(Date.now() / 1000) });
  setSessionCookie(res, cookie);
  res.json({ tenant });
}));

sessionRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});
