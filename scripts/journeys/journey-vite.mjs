#!/usr/bin/env node
// The journeys' portal dev server (run-demo-moments.mjs starts it): the portal's
// own vite.config.ts with two things a headless journey needs and a working
// dev server does not.
//
//   - No HMR websocket (`server.ws: false`). A journey never edits source, and
//     the vite client reloads the page whenever that socket drops ("server
//     connection lost. Polling for restart…", then location.reload()), which
//     the server never logs. On a loaded machine that reload landed under a
//     live voice session (journey:voice-coverage C4, 10 November: the session
//     closed with cause "beforeunload" two seconds in, and the step waited out
//     its timeout on a session that no longer existed).
//   - Its own optimized-dependency cache (VITE_CACHE_DIR, under
//     portal/node_modules as vite.config.ts asks), so another dev server
//     re-optimizing the shared node_modules/.vite never rewrites this one's
//     dependencies mid-run, and this one never rewrites anyone else's.
//
//   node scripts/journeys/journey-vite.mjs --port 5166
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORTAL = path.join(ROOT, 'portal');
const at = process.argv.indexOf('--port');
const port = Number(at >= 0 ? process.argv[at + 1] : NaN);
if (!Number.isInteger(port) || port <= 0) {
  console.error('usage: journey-vite.mjs --port <port>');
  process.exit(2);
}
process.env.VITE_CACHE_DIR ??= path.join(PORTAL, 'node_modules', `.vite-journey-${port}`);

const vitePath = createRequire(path.join(PORTAL, 'package.json')).resolve('vite');
const { createServer } = await import(pathToFileURL(vitePath).href);
const server = await createServer({
  root: PORTAL,
  configFile: path.join(PORTAL, 'vite.config.ts'),
  server: { port, strictPort: true, ws: false },
});
await server.listen();
server.printUrls();
const stop = async () => { await server.close().catch(() => undefined); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
