// Enterprise sign-in (Cognito Hosted UI, OIDC authorization-code + PKCE).
//
//   GET  /api/auth/config    → { ssoEnabled } so the portal knows whether to
//                              show the SSO button.
//   GET  /api/auth/login     → sets a signed state+PKCE cookie, 302 to Hosted UI.
//   GET  /api/auth/callback  → validates state, exchanges the code, verifies the
//                              ID token, resolves the OrgIQ user (by external_sub
//                              then email, linking on first login), mints the
//                              app session cookie, 302 back to the portal.
//   POST /api/auth/logout    → clears the session cookie (+ Cognito logout URL).
//
// The BFF is a confidential client; the browser only ever holds the app's own
// signed session cookie — identical to the picker login, just authenticated.

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { config } from '../config.js';
import {
  cognitoEnabled, randomToken, pkceChallenge, authorizeUrl,
  exchangeCode, verifyIdToken, hostedLogoutUrl,
} from '../lib/oidc.js';
import {
  signValue, verifyValue, mintSession, signSession,
  setSessionCookie, clearSessionCookie, cookieSecure,
} from '../lib/session.js';
import { getUserByExternalSub, getUserByEmail, linkExternalSub } from '../providers/identity.js';
import { eventFromSession, logAuthz } from '../lib/audit.js';
import { rateLimit } from '../lib/rate-limit.js';

export const authRouter = Router();

const OIDC_STATE_COOKIE = 'orgiq.oidc';
const STATE_TTL_MS = 10 * 60 * 1000;
const loginLimit = rateLimit('auth-login', 30, 60_000);

interface OidcState { state: string; verifier: string; returnTo: string; exp: number; }

// Only same-origin relative paths may come from the query string — anything
// else falls back to the configured post-login URL, so ?returnTo= can't be an
// open redirect to an attacker's site.
function safeReturnTo(raw: unknown): string {
  // Must be a same-origin ABSOLUTE PATH. The check is a whitelist rather than
  // a "not //" blacklist because browsers normalise a backslash to a slash
  // before resolving: `/\evil.com` becomes protocol-relative `//evil.com`, and
  // `new URL('/\\evil.com', origin)` resolves to https://evil.com/. The old
  // `!startsWith('//')` test let that straight through, which is an open
  // redirect out of the login flow wherever the portal shares this origin —
  // i.e. production, where PORTAL_ORIGIN is empty and nothing else rewrites it.
  if (typeof raw === 'string' && /^\/(?![/\\])/.test(raw)) return raw;
  return config.cognito.postLoginUrl;
}

/**
 * Resolve a post-login destination against the portal's origin.
 *
 * A relative path resolves against whoever serves the redirect — this
 * middleware. That is right in production, where the portal shares its origin,
 * and wrong in dev, where the portal is on another port and the browser landed
 * on a middleware 404 after a perfectly successful login. Only a configured
 * origin is ever prefixed, never anything from the request, so this cannot
 * become an open redirect.
 */
export function resolveRedirect(target: string, portalOrigin: string): string {
  if (!portalOrigin) return target;
  if (!target.startsWith('/') || target.startsWith('//')) return target;
  return `${portalOrigin.replace(/\/+$/, '')}${target}`;
}

authRouter.get('/config', (_req, res) => {
  res.json({ ssoEnabled: cognitoEnabled() });
});

authRouter.get('/login', loginLimit, asyncHandler(async (req, res) => {
  if (!cognitoEnabled()) { res.status(404).json({ error: 'SSO is not configured' }); return; }
  const state = randomToken();
  const verifier = randomToken();
  const returnTo = safeReturnTo(req.query['returnTo']);
  const oidcState: OidcState = { state, verifier, returnTo, exp: Date.now() + STATE_TTL_MS };
  const cookie = await signValue(oidcState);
  res.cookie(OIDC_STATE_COOKIE, cookie, {
    httpOnly: true,
    sameSite: 'lax',
    // Same rule as the session cookie, from the same helper on purpose: a
    // `Secure` state cookie over plain http is dropped by the browser, so the
    // callback finds no state and the SSO round trip fails as "invalid state"
    // rather than as the scheme mismatch it is.
    secure: cookieSecure(res),
    maxAge: STATE_TTL_MS,
    path: '/',
  });
  res.redirect(authorizeUrl(state, pkceChallenge(verifier)));
}));

authRouter.get('/callback', loginLimit, asyncHandler(async (req, res) => {
  if (!cognitoEnabled()) { res.status(404).json({ error: 'SSO is not configured' }); return; }
  const { code, state, error: oauthError } = req.query as { code?: string; state?: string; error?: string };

  const raw = (req as unknown as { cookies?: Record<string, string> }).cookies?.[OIDC_STATE_COOKIE];
  res.clearCookie(OIDC_STATE_COOKIE, { path: '/' });

  if (oauthError) { res.status(400).send(`Sign-in failed at the identity provider: ${oauthError}`); return; }
  const st = raw ? await verifyValue<OidcState>(raw) : null;
  if (!st || st.exp < Date.now() || !code || !state || state !== st.state) {
    res.status(400).send('Sign-in state expired or invalid. Please start again.');
    return;
  }

  let claims;
  try {
    const tokens = await exchangeCode(code, st.verifier);
    claims = await verifyIdToken(tokens.id_token);
  } catch (err) {
    console.warn('[auth] token exchange/verify failed:', (err as Error).message);
    res.status(502).send('Could not complete sign-in with the identity provider.');
    return;
  }

  // Resolve the federated identity to an OrgIQ user: by external_sub first,
  // then by email on first login (and link the sub so it's direct next time).
  let user = await getUserByExternalSub(claims.sub);
  if (!user && claims.email) {
    user = await getUserByEmail(claims.email);
    if (user) await linkExternalSub(user.id, claims.sub);
  }
  if (!user) {
    logAuthz({
      decision: 'DENY', action: 'Login', sub: claims.email ?? claims.sub, role: '-',
      path: '/api/auth/callback', reason: 'no OrgIQ account for federated identity',
    });
    res.status(403).send('Your identity is authenticated but not provisioned in Work. Ask an administrator to add you.');
    return;
  }

  const session = mintSession({ id: user.id, displayName: user.displayName }, user.grants);
  if (!session) {
    res.status(403).send('Your account holds no tenant grants.');
    return;
  }
  logAuthz(eventFromSession(session, 'Login', 'ALLOW', { path: '/api/auth/callback', reason: 'sso' }));
  setSessionCookie(res, await signSession(session));
  res.redirect(resolveRedirect(st.returnTo || config.cognito.postLoginUrl, config.cognito.portalOrigin));
}));

authRouter.post('/logout', asyncHandler(async (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true, ...(cognitoEnabled() ? { ssoLogoutUrl: hostedLogoutUrl() } : {}) });
}));
