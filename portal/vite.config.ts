import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

// The API target. Node resolves `localhost` to ::1 first, and another
// project's server listening on IPv6 :3001 silently answers every /api call
// with 404s — so this probes candidates for the OrgIQ middleware's own health
// signature and picks the first that IS ours. API_PROXY_TARGET still wins.
async function apiTarget(): Promise<string> {
  if (process.env.API_PROXY_TARGET) return process.env.API_PROXY_TARGET;
  const candidates = ['http://127.0.0.1:3001', 'http://127.0.0.1:3011'];
  for (const base of candidates) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(800) });
      const body = (await res.json()) as { service?: string };
      if (body.service === 'orgiq-middleware') return base;
    } catch { /* not ours, or not up */ }
  }
  return candidates[0]!;
}

export default defineConfig(async () => ({
  define: {
    global: 'globalThis',
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
    preserveSymlinks: true,
  },
  server: {
    port: 5183,
    host: '0.0.0.0',
    // macOS bind mounts don't deliver inotify events to Linux containers, so
    // chokidar never sees host file changes. Polling is the standard workaround.
    watch: {
      usePolling: true,
      interval: 300,
    },
    proxy: {
      '/api': {
        target: await apiTarget(),
        changeOrigin: true,
      },
    },
  },
}));
