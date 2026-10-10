// The browser-facing realtime endpoints config.ts hands the token bridge
// (GET /api/session/realtime-token → gatewayUrl / platformApiUrl / videoUrl).
//
// The regression this pins: `platformApiUrl` fell back to PLATFORM_API_URL in
// every environment. That variable is the SERVER-side URL the work-graph
// producer posts to — in AWS a Cloud Map name (`social-platform.<ns>:3001`)
// no browser can resolve — so a deployment that set it but not
// REALTIME_PLATFORM_PUBLIC_URL told every browser to call an internal host.
// Locally the two are the same URL, so the fallback stays there.
//
// A subprocess for the same reason as config-capability-check.test.ts:
// config.ts uses import.meta and cannot be loaded by ts-jest, and a mocked
// config would only test the mock. DEV_OFFLINE keeps .env.aws out of it.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');

function realtimeConfig(env: Record<string, string>): Record<string, string | undefined> {
  const out = execFileSync(TSX, ['--eval', `import { config } from './src/config.ts';
    console.log(JSON.stringify(config.realtime));`], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      DEV_OFFLINE: 'true',
      CAPABILITY_STARTUP_CHECK: 'off',
      ...env,
    } as NodeJS.ProcessEnv,
  });
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

const INTERNAL = 'http://social-platform.orgiq-social.local:3001';

describe('config.realtime — the URLs browsers are told', () => {
  it('production never echoes the server-side PLATFORM_API_URL to the browser', () => {
    const r = realtimeConfig({ NODE_ENV: 'production', PLATFORM_API_URL: INTERNAL });
    expect(r['platformApiUrl']).toBeUndefined();
  });

  it('production uses REALTIME_PLATFORM_PUBLIC_URL and REALTIME_VIDEO_PUBLIC_URL', () => {
    const r = realtimeConfig({
      NODE_ENV: 'production',
      PLATFORM_API_URL: INTERNAL,
      REALTIME_GATEWAY_URL: 'wss://d111.cloudfront.net',
      REALTIME_PLATFORM_PUBLIC_URL: 'https://d222.cloudfront.net',
      REALTIME_VIDEO_PUBLIC_URL: 'https://d333.cloudfront.net',
    });
    expect(r).toEqual({
      gatewayUrl: 'wss://d111.cloudfront.net',
      platformApiUrl: 'https://d222.cloudfront.net',
      videoUrl: 'https://d333.cloudfront.net',
    });
  });

  it('outside production PLATFORM_API_URL is still the fallback (local: one host for both)', () => {
    const r = realtimeConfig({ NODE_ENV: 'development', PLATFORM_API_URL: 'http://localhost:13001' });
    expect(r['platformApiUrl']).toBe('http://localhost:13001');
  });
});
