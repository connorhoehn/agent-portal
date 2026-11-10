// The dev flag must not put the permissive dev process on the network.
import { listenHost } from '../bind-host.js';

describe('listenHost (index.ts server.listen)', () => {
  it('binds loopback under INSECURE_DEV_MODE (npm run dev, dev:mock)', () => {
    expect(listenHost({ INSECURE_DEV_MODE: 'true', NODE_ENV: 'development' })).toBe('127.0.0.1');
    expect(listenHost({ INSECURE_DEV_MODE: 'true' })).toBe('127.0.0.1');
  });

  it('keeps 0.0.0.0 without the dev flag: production and the deployed task are unchanged', () => {
    expect(listenHost({})).toBe('0.0.0.0');
    expect(listenHost({ NODE_ENV: 'production' })).toBe('0.0.0.0');
    // NODE_ENV=production vetoes the flag, so it is not dev mode at all.
    expect(listenHost({ NODE_ENV: 'production', INSECURE_DEV_MODE: 'true' })).toBe('0.0.0.0');
  });

  it('an explicit BIND_HOST wins either way (a dev container publishing its port)', () => {
    expect(listenHost({ INSECURE_DEV_MODE: 'true', BIND_HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(listenHost({ BIND_HOST: '127.0.0.1' })).toBe('127.0.0.1');
    expect(listenHost({ INSECURE_DEV_MODE: 'true', BIND_HOST: '  ' })).toBe('127.0.0.1');
  });
});
