// Cognito Hosted-UI OIDC helpers for the BFF sign-in flow.
//
// The middleware is a confidential OAuth client: it drives the authorization-
// code flow with PKCE, exchanges the code server-side using the client secret,
// verifies the returned ID token against the Cognito JWKS, and then mints the
// app's own signed session cookie from the resolved OrgIQ user. The browser
// never sees a Cognito token — the session cookie remains the only credential,
// exactly as with the picker login. See routes/auth.ts for the endpoints.

import { createHash, randomBytes } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { config } from '../config.js';

/** True when the Hosted-UI sign-in path is configured. */
export function cognitoEnabled(): boolean {
  const c = config.cognito;
  return !!(c.userPoolId && c.clientId && c.domain && c.callbackUrl);
}

function domainBase(): string {
  // Accept either a bare host or a full https URL in COGNITO_DOMAIN.
  const d = config.cognito.domain;
  return d.startsWith('http') ? d.replace(/\/$/, '') : `https://${d}`;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A high-entropy URL-safe token for the state nonce and the PKCE verifier. */
export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

/** S256 PKCE challenge for a given verifier. */
export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

/** The Hosted-UI /authorize URL that begins the login. */
export function authorizeUrl(state: string, codeChallenge: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: config.cognito.clientId,
    redirect_uri: config.cognito.callbackUrl,
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${domainBase()}/oauth2/authorize?${q.toString()}`;
}

/** The Hosted-UI /logout URL that clears the Cognito session cookie. */
export function hostedLogoutUrl(): string {
  const q = new URLSearchParams({
    client_id: config.cognito.clientId,
    logout_uri: config.cognito.logoutRedirectUrl,
  });
  return `${domainBase()}/logout?${q.toString()}`;
}

export interface TokenSet {
  id_token: string;
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

/** Exchange an authorization code for tokens at the Cognito token endpoint.
 * Confidential client: authenticates with the client secret via HTTP Basic. */
export async function exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.cognito.clientId,
    code,
    redirect_uri: config.cognito.callbackUrl,
    code_verifier: codeVerifier,
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (config.cognito.clientSecret) {
    const basic = Buffer.from(`${config.cognito.clientId}:${config.cognito.clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${basic}`;
  }
  const res = await fetch(`${domainBase()}/oauth2/token`, { method: 'POST', headers, body: body.toString() });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`token exchange failed: ${res.status} ${detail}`);
  }
  return res.json() as Promise<TokenSet>;
}

export interface IdClaims {
  sub: string;
  email?: string;
  name?: string;
}

// The verifier caches the Cognito JWKS internally after the first fetch.
let _verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
function verifier() {
  if (!_verifier) {
    _verifier = CognitoJwtVerifier.create({
      userPoolId: config.cognito.userPoolId,
      tokenUse: 'id',
      clientId: config.cognito.clientId,
    });
  }
  return _verifier;
}

/** Verify the ID token signature/claims against Cognito and extract identity. */
export async function verifyIdToken(idToken: string): Promise<IdClaims> {
  const p = await verifier().verify(idToken);
  const pick = (k: string): string | undefined => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
  return {
    sub: String(p.sub),
    email: pick('email'),
    name: pick('name') ?? pick('cognito:username') ?? pick('email'),
  };
}
