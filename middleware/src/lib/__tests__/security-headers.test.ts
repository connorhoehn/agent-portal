import express from 'express';
import request from '../../test-support/http.js';
import { securityHeaders } from '../security-headers.js';

function app(hops: number | false) {
  const a = express();
  a.set('trust proxy', hops);
  a.disable('x-powered-by');
  a.use(securityHeaders);
  a.get('/json', (_req, res) => { res.json({ ok: true }); });
  a.get('/download', (_req, res) => { res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.send('x'); });
  return a;
}

it('sets hardening headers and a locked-down CSP on JSON, without HSTS over plain http', async () => {
  const res = await request(app(false)).get('/json');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(res.headers['x-powered-by']).toBeUndefined();
  expect(res.headers['strict-transport-security']).toBeUndefined();
});

it('sends HSTS only for forwarded https behind a trusted proxy', async () => {
  const trusted = await request(app(1)).get('/json').set('X-Forwarded-Proto', 'https');
  expect(trusted.headers['strict-transport-security']).toMatch(/max-age=31536000/);
  const untrusted = await request(app(false)).get('/json').set('X-Forwarded-Proto', 'https');
  expect(untrusted.headers['strict-transport-security']).toBeUndefined();
});

it('lets a download route keep its own CSP', async () => {
  const res = await request(app(false)).get('/download');
  expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
});
