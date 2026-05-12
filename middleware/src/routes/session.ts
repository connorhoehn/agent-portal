import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import {
  ROLES,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  type Role,
} from '../lib/session.js';

export const sessionRouter = Router();

sessionRouter.get('/me', (req, res) => {
  res.json({
    sub: req.session?.sub ?? 'demo-user',
    role: req.session?.role ?? 'member',
    availableRoles: ROLES,
  });
});

sessionRouter.post('/role', asyncHandler(async (req, res) => {
  const { role } = req.body as { role?: string };
  if (!role || !ROLES.includes(role as Role)) {
    res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
    return;
  }
  const sub = req.session?.sub ?? 'demo-user';
  const cookie = await signSession({ sub, role: role as Role, iat: Math.floor(Date.now() / 1000) });
  setSessionCookie(res, cookie);
  res.json({ sub, role });
}));

sessionRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});
