import express from 'express';
import request from '../../test-support/http.js';
import { trustedProxyHops } from '../trusted-proxy.js';
import { rateLimit, resetRateLimits } from '../rate-limit.js';

beforeEach(resetRateLimits);

function appWithTrust(trust: boolean | number) {
  const app = express();
  app.set('trust proxy', trust);
  app.get('/', rateLimit('proxy-test', 1, 60_000), (_req, res) => res.json({ ok: true }));
  return app;
}

it('does not let a direct client evade limits by changing X-Forwarded-For', async () => {
  const app = appWithTrust(false);
  expect((await request(app).get('/').set('X-Forwarded-For', '192.0.2.1')).status).toBe(200);
  expect((await request(app).get('/').set('X-Forwarded-For', '192.0.2.2')).status).toBe(429);
});

it('uses the address appended by the trusted proxy, not a caller-supplied prefix', async () => {
  const app = appWithTrust(1);
  expect((await request(app).get('/').set('X-Forwarded-For', '192.0.2.1, 198.51.100.1')).status).toBe(200);
  expect((await request(app).get('/').set('X-Forwarded-For', '192.0.2.2, 198.51.100.1')).status).toBe(429);
  expect((await request(app).get('/').set('X-Forwarded-For', '198.51.100.2')).status).toBe(200);
});


it('the deployed default ignores forwarding headers unless the network proxy is explicit', async () => {
  const previous = process.env['TRUST_PROXY_HOPS'];
  try {
    delete process.env['TRUST_PROXY_HOPS'];
    const app = appWithTrust(trustedProxyHops());
    expect((await request(app).get('/').set('X-Forwarded-For', '192.0.2.1')).status).toBe(200);
    expect((await request(app).get('/').set('X-Forwarded-For', '192.0.2.2')).status).toBe(429);
    process.env['TRUST_PROXY_HOPS'] = '1';
    expect(trustedProxyHops()).toBe(1);
    process.env['TRUST_PROXY_HOPS'] = '2';
    expect(trustedProxyHops()).toBe(2);
    process.env['TRUST_PROXY_HOPS'] = 'true';
    expect(() => trustedProxyHops()).toThrow('TRUST_PROXY_HOPS');
  } finally {
    if (previous === undefined) delete process.env['TRUST_PROXY_HOPS'];
    else process.env['TRUST_PROXY_HOPS'] = previous;
  }
});

it('behind CloudFront → ALB the client is two entries from the end of X-Forwarded-For', async () => {
  // CloudFront appends the viewer's address; the ALB appends CloudFront's edge
  // address. With two hops trusted, a caller-typed prefix still cannot pick
  // its own bucket, and the edge address (shared by many viewers) is not the
  // bucket either.
  const app = appWithTrust(2);
  expect((await request(app).get('/').set('X-Forwarded-For', '192.0.2.1, 203.0.113.9, 198.51.100.1')).status).toBe(200);
  expect((await request(app).get('/').set('X-Forwarded-For', '192.0.2.2, 203.0.113.9, 198.51.100.1')).status).toBe(429);
  expect((await request(app).get('/').set('X-Forwarded-For', '203.0.113.10, 198.51.100.1')).status).toBe(200);
});
