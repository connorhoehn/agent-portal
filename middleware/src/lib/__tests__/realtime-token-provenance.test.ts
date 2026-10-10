jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));

import type { IncomingMessage } from 'node:http';
import { SignJWT } from 'jose';
import { authenticateGatewayUpgrade } from '../realtime-gateway.js';
import { realtimeClaims, signRealtimeToken, verifyRealtimeToken, REALTIME_TOKEN_ISSUER, REALTIME_TOKEN_AUDIENCE } from '../realtime-token.js';
import type { Session } from '../session.js';

const secret = 'token-provenance-test';
const original = process.env['REALTIME_JWT_SECRET'];
const session: Session = { sub: 'effective', name: 'Effective User', tenant: 'orgiq', role: 'member', grants: { orgiq: ['member'] }, iat: 100, epoch: 5,
  act: { sub: 'operator', role: 'admin', tenant: 'orgiq', epoch: 7, grants: { orgiq: ['admin'], social: ['admin'] } } };
beforeAll(() => { process.env['REALTIME_JWT_SECRET'] = secret; });
afterAll(() => { if (original === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = original; });

it('adds effective/actor epoch provenance without exposing the actor’s grants or role', async () => {
  const claims = realtimeClaims(session);
  expect(claims.epoch).toBe(5); expect(claims.act).toEqual({ sub: 'operator', epoch: 7 });
  const { token } = await signRealtimeToken(claims, secret);
  expect(await verifyRealtimeToken(token, secret)).toMatchObject({ sub: 'effective', epoch: 5, act: { sub: 'operator', epoch: 7 } });
  const ctx = await authenticateGatewayUpgrade({ headers: { 'sec-websocket-protocol': `bearer-token-v1, ${token}` } } as IncomingMessage);
  expect(ctx).toMatchObject({ userId: 'effective', epoch: 5, act: { sub: 'operator', epoch: 7 } });
});

it('accepts old epoch-less signed tokens conservatively as generation zero', async () => {
  const claims = realtimeClaims({ ...session, act: undefined }); delete claims.epoch;
  const { token } = await signRealtimeToken(claims, secret);
  const ctx = await authenticateGatewayUpgrade({ headers: { 'sec-websocket-protocol': `bearer-token-v1, ${token}` } } as IncomingMessage);
  expect(ctx.epoch).toBe(0);
});

it.each([{ epoch: -1 }, { epoch: '5' }, { act: { sub: 'operator', epoch: -2 } }, { act: { epoch: 0 } }])
  ('rejects malformed generation/provenance in a cryptographically valid token: %p', async override => {
    const token = await new SignJWT({ ...realtimeClaims(session), ...override }).setProtectedHeader({ alg: 'HS256' })
      .setIssuer(REALTIME_TOKEN_ISSUER).setAudience(REALTIME_TOKEN_AUDIENCE).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(secret));
    await expect(verifyRealtimeToken(token, secret)).rejects.toThrow(/epoch|provenance/);
  });
