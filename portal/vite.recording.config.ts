import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

// Fixtures own all API responses. Any omitted interception fails closed,
// without probing or reaching the primary application/runtime.
export default defineConfig(async env => {
  process.env.API_PROXY_TARGET = 'http://127.0.0.1:9';
  return mergeConfig(await (base as unknown as (env: unknown) => Promise<import('vite').UserConfig>)(env), {
    cacheDir: 'node_modules/.vite-recording-fixtures',
    server: { host: '127.0.0.1', port: 5283, strictPort: true },
  });
});
