// lib/trusted-proxy.ts `upgradeScheme` — the scheme a WebSocket upgrade's
// browser page used. Upgrades never pass through Express, so they used to read
// the scheme off the socket alone, which behind the ALB is always plain TCP.
import { upgradeScheme } from '../trusted-proxy.js';

const prior = process.env['TRUST_PROXY_HOPS'];
afterEach(() => {
  if (prior === undefined) delete process.env['TRUST_PROXY_HOPS']; else process.env['TRUST_PROXY_HOPS'] = prior;
});
const req = (headers: Record<string, string>, encrypted = false) => ({ headers, socket: { encrypted } });

describe('upgradeScheme', () => {
  it('direct (no hops declared): the socket decides and forwarding headers are ignored', () => {
    delete process.env['TRUST_PROXY_HOPS'];
    expect(upgradeScheme(req({ 'x-forwarded-proto': 'https', 'cloudfront-forwarded-proto': 'https' }))).toBe('http');
    expect(upgradeScheme(req({}, true))).toBe('https');
  });

  it('one hop (the ALB): X-Forwarded-Proto, first value', () => {
    process.env['TRUST_PROXY_HOPS'] = '1';
    expect(upgradeScheme(req({ 'x-forwarded-proto': 'https' }))).toBe('https');
    expect(upgradeScheme(req({ 'x-forwarded-proto': 'HTTPS, http' }))).toBe('https');
    // CloudFront's header is not trusted at one hop.
    expect(upgradeScheme(req({ 'x-forwarded-proto': 'http', 'cloudfront-forwarded-proto': 'https' }))).toBe('http');
  });

  it('two hops (CloudFront → ALB): CloudFront-Forwarded-Proto beats the ALB\'s http', () => {
    process.env['TRUST_PROXY_HOPS'] = '2';
    expect(upgradeScheme(req({ 'x-forwarded-proto': 'http', 'cloudfront-forwarded-proto': 'https' }))).toBe('https');
    expect(upgradeScheme(req({ 'x-forwarded-proto': 'https' }))).toBe('https');
    expect(upgradeScheme(req({}))).toBe('http');
  });
});
