/**
 * OrgIQ-Authentication: the Cognito pool real users sign in to.
 *
 * docs/next-steps.md §7 found no MFA, the admin password flow on, symbols not
 * required, 30-day refresh tokens and localhost callbacks on every pool. Each
 * of those is now either off or behind `-c authDev=true`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AuthenticationStack } from '../lib/authentication-stack';

const CALLBACK = 'https://portal.example.com/api/auth/callback';

function auth(context: Record<string, string> = {}, callbackUrls: string[] | null = [CALLBACK]): Template {
  const app = new cdk.App({ context });
  return Template.fromStack(new AuthenticationStack(app, 'OrgIQ-Authentication', {
    prefix: 'orgiq', ...(callbackUrls ? { callbackUrls } : {}),
  }));
}

const pool = (t: Template) => Object.values<any>(t.findResources('AWS::Cognito::UserPool'))[0];
const client = (t: Template) => Object.values<any>(t.findResources('AWS::Cognito::UserPoolClient'))[0];

describe('the production pool (defaults)', () => {
  const t = auth();

  test('MFA is optional, by authenticator app (TOTP) only', () => {
    assert.equal(pool(t).Properties.MfaConfiguration, 'OPTIONAL');
    assert.deepEqual(pool(t).Properties.EnabledMfas, ['SOFTWARE_TOKEN_MFA']);
  });

  test('passwords need a symbol', () => {
    assert.equal(pool(t).Properties.Policies.PasswordPolicy.RequireSymbols, true);
  });

  test('deletion protection on and RETAIN (protectData)', () => {
    assert.equal(pool(t).Properties.DeletionProtection, 'ACTIVE');
    assert.equal(pool(t).DeletionPolicy, 'Retain');
  });

  test('no admin password flow, refresh tokens last 7 days', () => {
    const c = client(t).Properties;
    assert.ok(!c.ExplicitAuthFlows.includes('ALLOW_ADMIN_USER_PASSWORD_AUTH'), String(c.ExplicitAuthFlows));
    assert.equal(c.RefreshTokenValidity, 7 * 24 * 60);
  });

  test('no localhost callback or sign-out URL', () => {
    const c = client(t).Properties;
    assert.deepEqual(c.CallbackURLs, [CALLBACK]);
    assert.ok(!JSON.stringify(c.LogoutURLs ?? []).includes('localhost'));
  });

  test('with no callback at all, the client has OAuth off instead of a localhost fallback', () => {
    const c = client(auth({}, null)).Properties;
    assert.equal(c.CallbackURLs, undefined);
    assert.ok(!c.AllowedOAuthFlows || c.AllowedOAuthFlows.length === 0);
  });
});

describe('authDev=true (development pools)', () => {
  const t = auth({ authDev: 'true' });
  test('adds the localhost callbacks and the admin password flow', () => {
    const c = client(t).Properties;
    assert.ok(c.CallbackURLs.includes('http://localhost:3001/api/auth/callback'));
    assert.ok(c.CallbackURLs.includes(CALLBACK));
    assert.ok(c.ExplicitAuthFlows.includes('ALLOW_ADMIN_USER_PASSWORD_AUTH'));
  });
});

describe('protectData=false (throwaway stacks)', () => {
  test('the pool is DESTROY with deletion protection off', () => {
    const p = pool(auth({ protectData: 'false' }));
    assert.equal(p.DeletionPolicy, 'Delete');
    assert.equal(p.Properties.DeletionProtection, 'INACTIVE');
  });
});
