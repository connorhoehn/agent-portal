jest.mock('../../config.js', () => ({ config: { cognito: { portalOrigin: 'https://portal.example.com' } } }));

import express from 'express';
import request from '../../test-support/http.js';
import { browserOrigin } from '../browser-origin.js';

const priorEnv = process.env['NODE_ENV'];
const priorOrigins = process.env['CORS_ALLOWED_ORIGINS'];
beforeEach(() => { process.env['NODE_ENV'] = 'production'; delete process.env['CORS_ALLOWED_ORIGINS']; });
afterEach(() => {
  if (priorEnv === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = priorEnv;
  if (priorOrigins === undefined) delete process.env['CORS_ALLOWED_ORIGINS']; else process.env['CORS_ALLOWED_ORIGINS'] = priorOrigins;
});

function app() {
  const app = express();
  app.use(browserOrigin);
  app.post('/', (_req, res) => res.json({ reached: true }));
  return app;
}

it.each(['https://evil.example.com', 'null', 'https://portal.example.com.evil.test', 'http://localhost:5183'])('blocks untrusted production origin %s before the handler', async origin => {
  const res = await request(app()).post('/').set('Origin', origin);
  expect(res.status).toBe(403);
  expect(res.body.reached).toBeUndefined();
  expect(res.headers['access-control-allow-origin']).toBeUndefined();
});

it('allows the configured portal with credentialed CORS', async () => {
  const res = await request(app()).post('/').set('Origin', 'https://portal.example.com');
  expect(res.status).toBe(200);
  expect(res.headers['access-control-allow-origin']).toBe('https://portal.example.com');
  expect(res.headers['access-control-allow-credentials']).toBe('true');
});

it('allows same-origin requests and non-browser service clients', async () => {
  expect((await request(app()).post('/').set('Host', 'api.example.com').set('Origin', 'http://api.example.com')).status).toBe(200);
  expect((await request(app()).post('/')).status).toBe(200);
});

it('allows an explicitly configured additional frontend', async () => {
  process.env['CORS_ALLOWED_ORIGINS'] = 'https://alternate.example.com';
  expect((await request(app()).post('/').set('Origin', 'https://alternate.example.com')).status).toBe(200);
});

it('handles preflight for the configured frontend', async () => {
  const res = await request(app()).options('/').set('Origin', 'https://portal.example.com')
    .set('Access-Control-Request-Method', 'POST');
  expect(res.status).toBe(204);
  expect(res.headers['access-control-allow-origin']).toBe('https://portal.example.com');
});

it('allows loopback development ports but still rejects arbitrary websites', async () => {
  process.env['NODE_ENV'] = 'development';
  expect((await request(app()).post('/').set('Origin', 'http://localhost:5183')).status).toBe(200);
  expect((await request(app()).post('/').set('Origin', 'https://evil.example.com')).status).toBe(403);
});
