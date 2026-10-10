// POST /api/realtime/lobby-access — platform-api's per-lobby question
// (docs/social-calls-plan.md, "Lobby admission at platform-api").
//
// platform-api mints call media tokens for any lobby a caller names, and its
// own check (`lobbyAccess`, platform-api src/lib/lobbyAccess.ts) knows only a
// lobby's tenant prefix and DM ids. Whether this person may use
// `orgiq:initiative:<id>`, `assessment:team:<id>`, `pipelines:run:<id>` or a
// private `social:ch:<slug>` is business authority only this BFF holds. So,
// when platform-api runs with LOBBY_AUTHORITY_REQUIRED=true, it forwards the
// caller's own realtime token here with the lobby name and refuses unless this
// answers 200 `{ allowed: true }`.
//
// The answer is the gateway's own call admission, asked now: the token is
// verified exactly as the /ws upgrade verifies it, then `admitCall`
// (lib/gateway/authority.ts over lib/live-principal.ts) re-reads the directory (epoch, grants, masquerade
// actor), applies `lobbyGuard`, the family's REST read gate, Social
// StartCall + membership and the page resource — the same decision a `join`
// frame on /ws gets. Nothing is cached or minted.
//
// Authentication is the bearer token alone, no service secret: the route only
// answers about the bearer's own identity, which that person can already learn
// by joining on /ws. A refusal is 403 `{ allowed: false }` whatever the reason
// (unknown lobby, outside the tenant, not a member), so nothing beyond yes/no
// is disclosed.

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { admitCall, callGuards, noStoredCall } from '../lib/gateway/authority.js';
import { gatewayAuthFromClaims } from '../lib/gateway/auth.js';
import { realtimeSigningSecret, verifyRealtimeToken } from '../lib/realtime-token.js';
import { callMediaProofRuntime } from '../lib/call-media-proof.js';
import { getLivePrincipal } from '../lib/live-principal.js';
import { AppError } from '../lib/async-handler.js';

export const MAX_LOBBY_NAME = 256;

export const realtimeLobbyAccessRouter = Router();

// The native video service forwards the caller's original bearer. A successful
// answer proves this exact connected accepted seat, not just page membership.
realtimeLobbyAccessRouter.post('/call-seat', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const secret = realtimeSigningSecret();
  if (!token) { res.status(401).json({ error: 'realtime token required' }); return; }
  if (!secret) { res.status(503).json({ error: 'realtime token verification unavailable' }); return; }
  let auth: Record<string, unknown>;
  try { auth = gatewayAuthFromClaims(await verifyRealtimeToken(token, secret)); }
  catch { res.status(401).json({ error: 'invalid or expired realtime token' }); return; }
  const input = req.body as Record<string, unknown> | null;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['callId', 'lobbyName', 'clientId'].includes(key))
    || !['callId', 'clientId'].every(key => typeof input[key] === 'string' && /^[A-Za-z0-9:_-]{1,256}$/.test(input[key] as string))
    || typeof input.lobbyName !== 'string' || !input.lobbyName || input.lobbyName.length > MAX_LOBBY_NAME) {
    res.status(400).json({ error: 'callId, lobbyName and clientId required' }); return;
  }
  try {
    const { session } = await getLivePrincipal(auth);
    res.json(await callMediaProofRuntime().get(session, input.callId as string, input.lobbyName, input.clientId as string));
  } catch (error) {
    if (error instanceof AppError && error.status >= 500) throw error;
    res.status(403).json({ allowed: false });
  }
}));

realtimeLobbyAccessRouter.post('/lobby-access', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) { res.status(401).json({ error: 'realtime token required' }); return; }
  const secret = realtimeSigningSecret();
  if (!secret) { res.status(503).json({ error: 'realtime token verification unavailable' }); return; }
  let auth: Record<string, unknown>;
  try {
    auth = gatewayAuthFromClaims(await verifyRealtimeToken(token, secret));
  } catch {
    res.status(401).json({ error: 'invalid or expired realtime token' }); return;
  }
  const lobbyName = (req.body as { lobbyName?: unknown } | undefined)?.lobbyName;
  if (typeof lobbyName !== 'string' || !lobbyName || lobbyName.length > MAX_LOBBY_NAME) {
    res.status(400).json({ error: 'lobbyName is required' }); return;
  }
  // No callId: the question is the lobby itself, never a stored call's.
  const allowed = await admitCall(auth, 'join', { lobbyName }, callGuards(noStoredCall));
  if (!allowed) {
    console.warn(`[lobby-access] refused lobby '${lobbyName}' for user '${String(auth['userId'])}' (org '${String(auth['org'])}')`);
    res.status(403).json({ allowed: false }); return;
  }
  res.json({ allowed: true });
}));
