// OIDC helper tests. config.ts uses import.meta and aws-jwt-verify is ESM —
// both are mocked so the CJS test build can load the module.
jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    cognito: {
      userPoolId: 'us-east-1_TEST',
      clientId: 'client123',
      clientSecret: 'secret',
      domain: 'orgiq-auth.auth.us-east-1.amazoncognito.com',
      callbackUrl: 'http://localhost:3001/api/auth/callback',
      postLoginUrl: 'http://localhost:5183/',
      logoutRedirectUrl: 'http://localhost:5183/',
    },
  },
}));
jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) },
}));

import { cognitoEnabled, authorizeUrl, hostedLogoutUrl, pkceChallenge, randomToken } from '../oidc.js';

describe('oidc helpers', () => {
  it('cognitoEnabled is true when the config is complete', () => {
    expect(cognitoEnabled()).toBe(true);
  });

  it('pkceChallenge matches the RFC 7636 S256 test vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
      .toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('authorizeUrl carries client, redirect, PKCE and scopes', () => {
    const u = new URL(authorizeUrl('state123', 'challengeABC'));
    expect(u.origin + u.pathname).toBe('https://orgiq-auth.auth.us-east-1.amazoncognito.com/oauth2/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('client123');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:3001/api/auth/callback');
    expect(u.searchParams.get('code_challenge')).toBe('challengeABC');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(u.searchParams.get('state')).toBe('state123');
  });

  it('hostedLogoutUrl carries the client and logout redirect', () => {
    const u = new URL(hostedLogoutUrl());
    expect(u.pathname).toBe('/logout');
    expect(u.searchParams.get('client_id')).toBe('client123');
    expect(u.searchParams.get('logout_uri')).toBe('http://localhost:5183/');
  });

  it('randomToken is url-safe and unique', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
