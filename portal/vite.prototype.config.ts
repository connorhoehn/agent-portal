// Visual prototypes — a second Vite root beside the app.
//
// WHY IT LIVES INSIDE `portal/`. A prototype is only worth looking at if it is
// painted by the real library and the real tokens, and both are already
// resolved here: `@connorhoehnslalom/ui-components` is installed in
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
//   npm run prototype          # dev server on :5190
//   npm run prototype:build    # one self-contained .html in prototypes/build
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname, 'prototypes'),
  // Its own cache, so switching between the app and a prototype does not make
  // each one re-optimize the other's dependency graph.
  cacheDir: resolve(import.meta.dirname, 'node_modules/.vite-prototypes'),
  plugins: [react(), tailwindcss()],
  // The library and the app must agree on one React, or hooks throw.
  resolve: { dedupe: ['react', 'react-dom', '@xyflow/react'] },
  server: { host: '127.0.0.1', port: 5190, strictPort: true },
  build: {
    outDir: resolve(import.meta.dirname, 'prototypes/build'),
    emptyOutDir: true,
    // Inline every asset, so `inline.mjs` only has to fold in the entry chunk
    // and the stylesheet to leave one file somebody can open or send.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
});
