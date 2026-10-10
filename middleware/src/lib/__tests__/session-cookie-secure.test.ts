// Login returned 200 and granted nothing.
//
// `setSessionCookie` marked the cookie `Secure` when `NODE_ENV === 'production'`,
// which conflates "production build" with "encrypted connection". On the
// deployed ECS middleware those came apart: the ALB serves plain **http** on
// purpose (Cognito rejects non-localhost http callbacks, so the stack leaves
// COGNITO_CALLBACK_URL unset and the user picker is the intended login there)
// while NODE_ENV is `production`. So `POST /api/session/login` answered 200 with
// a complete, correct session body and a `Set-Cookie` that no client would
// store — curl dropped it, a browser drops it — and every request after it was
// `Unauthenticated`. Nothing errored. The app was unreachable behind a green
// health check and a successful login.
//
// The predicate is now `req.secure`, which is the honest one and self-hardens:
// put TLS in front and the cookie becomes `Secure` with no code change. It only
// reads `X-Forwarded-Proto` because `index.ts` sets `trust proxy` — the two are
// coupled, so this test exercises them together rather than calling the helper
// in isolation. `SESSION_COOKIE_SECURE` overrides both ways for a proxy that
// cannot be trusted to report the scheme.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true }, sessionSigningSecretArn: '' },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { setSessionCookie } from '../session.js';

/** An app shaped like the real one: one proxy hop trusted, as index.ts sets. */
function app(opts: { trustProxy?: boolean; hops?: number } = {}): express.Express {
  const a = express();
  if (opts.trustProxy !== false) a.set('trust proxy', opts.hops ?? 1);
  a.get('/set', (_req, res) => {
    setSessionCookie(res, 'signed.session.value');
    res.json({ ok: true });
  });
  return a;
}

async function setCookieHeader(
  a: express.Express,
  headers: Record<string, string> = {},
): Promise<string> {
  const res = await request(a).get('/set').set(headers);
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [raw];
  const cookie = list.find((c) => typeof c === 'string' && c.startsWith('orgiq.session='));
  expect(cookie).toBeDefined();
  return cookie as string;
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('the session cookie Secure flag', () => {
  it('is NOT set over plain http, even in production', async () => {
    // The regression. This exact combination — NODE_ENV=production, http origin
    // — is the deployed configuration, and it is the one that used to mint an
    // unusable cookie.
    process.env['NODE_ENV'] = 'production';
    delete process.env['SESSION_COOKIE_SECURE'];
    expect(await setCookieHeader(app())).not.toMatch(/;\s*Secure/i);
  });

  it('IS set when the proxy reports https', async () => {
    // The other half: the fix must not simply drop the hardening. Put TLS in
    // front of the same build and the cookie tightens on its own.
    process.env['NODE_ENV'] = 'production';
    delete process.env['SESSION_COOKIE_SECURE'];
    const cookie = await setCookieHeader(app(), { 'X-Forwarded-Proto': 'https' });
    expect(cookie).toMatch(/;\s*Secure/i);
  });

  it('ignores X-Forwarded-Proto when no proxy is trusted', async () => {
    // Why `trust proxy` is load-bearing rather than incidental: without it the
    // header is not read at all, so a TLS-terminating ALB would still mint a
    // non-Secure cookie. Removing that line silently re-opens half this bug.
    process.env['NODE_ENV'] = 'production';
    delete process.env['SESSION_COOKIE_SECURE'];
    const cookie = await setCookieHeader(app({ trustProxy: false }), {
      'X-Forwarded-Proto': 'https',
    });
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });

  it('honours SESSION_COOKIE_SECURE=true over an http request', async () => {
    process.env['SESSION_COOKIE_SECURE'] = 'true';
    expect(await setCookieHeader(app())).toMatch(/;\s*Secure/i);
  });

  it('honours SESSION_COOKIE_SECURE=false over an https request', async () => {
    process.env['SESSION_COOKIE_SECURE'] = 'false';
    const cookie = await setCookieHeader(app(), { 'X-Forwarded-Proto': 'https' });
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });

  it('keeps HttpOnly and SameSite=Lax regardless of scheme', async () => {
    // The scheme decides Secure and nothing else — the other two protections
    // are unconditional and must not have been loosened along the way.
    delete process.env['SESSION_COOKIE_SECURE'];
    const schemes: Array<Record<string, string>> = [{}, { 'X-Forwarded-Proto': 'https' }];
    for (const headers of schemes) {
      const cookie = await setCookieHeader(app(), headers);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    }
  });

  describe('behind CloudFront → ALB (TRUST_PROXY_HOPS=2)', () => {
    // CloudFront reaches the ALB over plain HTTP (the ALB has no certificate in
    // the no-domain deployment), and the ALB sets X-Forwarded-Proto to the
    // scheme of THAT hop — so an https:// viewer arrived as `http` and the
    // cookie lost Secure. The viewer's scheme is CloudFront-Forwarded-Proto.
    beforeEach(() => {
      process.env['NODE_ENV'] = 'production';
      delete process.env['SESSION_COOKIE_SECURE'];
      process.env['TRUST_PROXY_HOPS'] = '2';
    });

    it('IS Secure when CloudFront says the viewer used https, though the ALB says http', async () => {
      const cookie = await setCookieHeader(app({ hops: 2 }), {
        'X-Forwarded-Proto': 'http', 'CloudFront-Forwarded-Proto': 'https',
      });
      expect(cookie).toMatch(/;\s*Secure/i);
    });

    it('is not Secure when CloudFront says http', async () => {
      const cookie = await setCookieHeader(app({ hops: 2 }), {
        'X-Forwarded-Proto': 'http', 'CloudFront-Forwarded-Proto': 'http',
      });
      expect(cookie).not.toMatch(/;\s*Secure/i);
    });

    it('ignores CloudFront-Forwarded-Proto unless two hops are declared', async () => {
      // A direct or ALB-only deployment must not take a client-typed header.
      process.env['TRUST_PROXY_HOPS'] = '1';
      const cookie = await setCookieHeader(app(), {
        'X-Forwarded-Proto': 'http', 'CloudFront-Forwarded-Proto': 'https',
      });
      expect(cookie).not.toMatch(/;\s*Secure/i);
    });
  });
});
