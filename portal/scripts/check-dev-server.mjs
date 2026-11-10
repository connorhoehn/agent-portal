// Fails when the dev server's defaults drift: it must listen on loopback, on
// 5183, without strictPort, and vite.config.ts must take them from
// devServerOptions rather than a literal; a non-loopback API_PROXY_TARGET must
// print the session-cookie warning. Run: npm run check:dev-server
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HOST, DEFAULT_PORT, devServerOptions, isLoopbackTarget, proxyTargetWarning } from './dev-server.mjs';

const problems = [];
const expect = (ok, message) => { if (!ok) problems.push(message); };

const def = devServerOptions({});
expect(def.host === '127.0.0.1', `default host is ${def.host}, expected 127.0.0.1`);
expect(DEFAULT_HOST === '127.0.0.1', 'DEFAULT_HOST must be 127.0.0.1');
expect(def.port === 5183 && DEFAULT_PORT === 5183, `default port is ${def.port}, expected 5183`);
expect(!('strictPort' in def), 'strictPort must not be set by default');
expect(devServerOptions({ BIND_HOST: '  ' }).host === '127.0.0.1', 'a blank BIND_HOST must keep loopback');
expect(devServerOptions({ BIND_HOST: '0.0.0.0' }).host === '0.0.0.0', 'BIND_HOST=0.0.0.0 must widen');
const chosen = devServerOptions({ PORTAL_PORT: '5137' });
expect(chosen.port === 5137 && chosen.strictPort === true, 'PORTAL_PORT must set the port and strictPort');
let threw = false;
try { devServerOptions({ PORTAL_PORT: 'abc' }); } catch { threw = true; }
expect(threw, 'a non-numeric PORTAL_PORT must throw');

for (const t of ['http://127.0.0.1:3001', 'http://localhost:3001', 'http://127.0.0.2:3927', 'http://[::1]:3001', 'http://app.localhost:3001']) {
  expect(isLoopbackTarget(t) && proxyTargetWarning(t) === null, `${t} is loopback and must print no warning`);
}
for (const t of ['http://middleware:3001', 'https://api.example.com', 'http://10.0.0.5:3001', 'http://127.0.0.1.example.com', 'http://[::2]:3001', 'not a url']) {
  const w = proxyTargetWarning(t);
  expect(!isLoopbackTarget(t) && typeof w === 'string' && /session cookies/.test(w), `${t} is not loopback and must print the cookie warning`);
}
expect(/middleware:3001/.test(proxyTargetWarning('http://middleware:3001') ?? ''), 'the warning must name the host');

const config = readFileSync(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8');
expect(/devServerOptions\(/.test(config), 'vite.config.ts must take host and port from devServerOptions');
expect(!/host:\s*['"]0\.0\.0\.0['"]/.test(config), "vite.config.ts must not hardcode host: '0.0.0.0'");
expect(/proxyTargetWarning\(target\)/.test(config) && /target,\n/.test(config),
  'vite.config.ts must warn through proxyTargetWarning about the same target the /api proxy uses');

if (problems.length) {
  console.error(`check-dev-server: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('check-dev-server: loopback by default, BIND_HOST and PORTAL_PORT honoured, non-loopback proxy target warned');
