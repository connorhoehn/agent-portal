// Visual prototypes — a second Vite root beside the app.
//
// WHY IT LIVES INSIDE `portal/`. A prototype is only worth looking at if it is
// painted by the real library and the real tokens, and both are already
// resolved here: `@connorhoehn/ui-components` is installed in
// portal/node_modules, and `src/app.css` is the token sheet the app itself
// paints from (it also `@source`s the library's dist, so Tailwind emits the
// classes the library's own composites use). Running from this root means a
// prototype needs NO install of its own — which matters, because these
// dependencies resolve from `github:` over SSH and a fresh install is a
// five-minute operation that can fail halfway.
//
// `tsconfig.json` includes only `src`, so nothing here is typechecked by
// `npm run typecheck` or `npm run build`. That is deliberate: a prototype is a
// sketch to argue with, and it should never be able to break the app's gates.
//
// One directory per prototype under `prototypes/`, picked by name:
//
//   npm run prototype                          # active-now on :5190
//   PROTOTYPE=computer-lab-chat npm run prototype
//   npm run prototype:build                    # → prototypes/<name>/build/index.html
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

const name = process.env['PROTOTYPE'] ?? 'active-now';

export default defineConfig({
  root: resolve(import.meta.dirname, 'prototypes', name),
  // Its own cache, so switching between the app and a prototype does not make
  // each one re-optimize the other's dependency graph.
  cacheDir: resolve(import.meta.dirname, 'node_modules/.vite-prototypes'),
  plugins: [react(), tailwindcss()],
  resolve: {
    // The library and the app must agree on one React, or hooks throw.
    dedupe: ['react', 'react-dom', '@xyflow/react'],
    // A peer the app does not install because it never mounts the rich
    // composer; prototypes do. See prototypes/shims/tiptap-extension-mention.ts.
    alias: { '@tiptap/extension-mention': resolve(import.meta.dirname, 'prototypes/shims/tiptap-extension-mention.ts') },
  },
  server: { host: '127.0.0.1', port: 5190, strictPort: true },
  build: {
    outDir: resolve(import.meta.dirname, 'prototypes', name, 'build'),
    emptyOutDir: true,
    // Inline every asset, so `inline.mjs` only has to fold in the entry chunk
    // and the stylesheet to leave one file somebody can open or send.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
});
