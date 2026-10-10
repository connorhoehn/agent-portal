import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

// These inert fixtures intercept every API request. Omitted mocks cannot reach
// the primary application or discover another service through the default proxy.
export default defineConfig(async env => {
  process.env.API_PROXY_TARGET = 'http://127.0.0.1:9';
  return mergeConfig(await (base as unknown as (env: unknown) => Promise<import('vite').UserConfig>)(env), {
    cacheDir: 'node_modules/.vite-prepare-job-fixtures',
    server: { host: '127.0.0.1', port: 5293, strictPort: true },
  });
});
