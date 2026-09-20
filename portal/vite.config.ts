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
    dedupe: ['react', 'react-dom', 'yjs', 'y-protocols', 'lib0'],
  },
  // TipTap and the shared canvas must use the same ProseMirror module instances.
  // Keep the CommonJS runtime optimized, while PM enters through native ESM.
  optimizeDeps: {
    include: [
      '@connorhoehnslalom/realtime-modules/client',
      '@connorhoehnslalom/realtime-modules/adapters/tiptap',
      'yjs', 'y-protocols/awareness', 'lib0/observable', '@tiptap/core', '@tiptap/react',
      'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime',
      // The excluded UI package hides these CJS-containing graphs from scanning.
      'react-markdown', 'remark-gfm', 'recharts', 'es-toolkit', 'es-toolkit/compat',
      'buffer', 'amazon-cognito-identity-js', 'ajv',
      'y-protocols/sync',
      'lib0/buffer', 'lib0/mutex', 'lib0/math', 'lib0/object', 'lib0/set',
      'lib0/diff', 'lib0/error', 'lib0/random', 'lib0/environment',
      'lib0/dom', 'lib0/eventloop', 'lib0/map', 'lib0/hash/sha256',
      '@tiptap/starter-kit', '@tiptap/extension-task-list', '@tiptap/extension-task-item',
      '@tiptap/extension-placeholder', '@tiptap/extension-collaboration',
    ],
    exclude: [
      '@connorhoehnslalom/ui-components',
      '@tiptap/pm/model', '@tiptap/pm/state', '@tiptap/pm/transform', '@tiptap/pm/view',
      'prosemirror-state', 'prosemirror-model', 'prosemirror-transform', 'prosemirror-view',
      'prosemirror-gapcursor', 'prosemirror-dropcursor', 'prosemirror-history',
      'prosemirror-keymap', 'prosemirror-commands', 'prosemirror-schema-list',
      'prosemirror-tables', 'prosemirror-changeset', '@tiptap/y-tiptap',
    ],
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
        // SSE: do not buffer, and do not let the proxy negotiate a compressed
        // upstream response. EventSource fires `onopen` on the response head,
        // so a proxy that holds the head back leaves every live surface in the
        // app reading "connecting…" until the first body byte — 25 seconds on
        // a quiet stream, which is most of them most of the time. Measured:
        // with the middleware flushing headers, :3001 answered instantly and
        // the same request through :5183 returned nothing for four seconds.
        headers: { 'Accept-Encoding': 'identity' },
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, req, res) => {
            if (String(proxyRes.headers['content-type'] ?? '').includes('text/event-stream')) {
              // Copy the head through immediately, then pipe. Without this the
              // response head waits for http-proxy's own flush.
              res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
              if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
                (res as { flushHeaders: () => void }).flushHeaders();
              }
            }
          });
        },
      },
    },
  },
}));
