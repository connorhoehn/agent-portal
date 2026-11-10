// Where the portal's dev server listens. Kept out of vite.config.ts so
// scripts/check-dev-server.mjs can assert the defaults without starting vite.
//
// - port: 5183 unless PORTAL_PORT is set. strictPort only when it is set, so a
//   chosen port fails loudly if taken while the default still falls through.
// - host: loopback unless BIND_HOST says otherwise. The dev proxy hands the
//   middleware a loopback caller and the demo identity is permissive, so the
//   default must not be reachable from the network. BIND_HOST has the same
//   meaning as the middleware's (middleware/src/lib/bind-host.ts): any
//   non-empty address, e.g. 0.0.0.0 to listen on every interface.

export const DEFAULT_PORT = 5183;
export const DEFAULT_HOST = '127.0.0.1';

// The /api proxy forwards every request as the browser sent it, session cookie
// included. That is the point when the target is the local middleware; when
// API_PROXY_TARGET names another machine, the operator should know that
// machine now receives the session. Loopback means localhost (and its
// subdomains), 127.0.0.0/8 and ::1.
export function isLoopbackTarget(target) {
  let host;
  try { host = new URL(target).hostname.toLowerCase(); } catch { return false; }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  return host === '::1' || /^(?:0{1,4}:){7}0{0,3}1$/.test(host) || host === '::ffff:127.0.0.1' || host === '::ffff:7f00:1';
}

/** The one startup warning for a non-loopback proxy target, or null. */
export function proxyTargetWarning(target) {
  if (isLoopbackTarget(target)) return null;
  let where = target;
  try { where = new URL(target).host; } catch { /* print it as given */ }
  return `[portal] API_PROXY_TARGET is ${where}, not a loopback address: the dev server forwards session cookies on every /api request to that host.`;
}

export function devServerOptions(env = process.env) {
  const rawPort = (env.PORTAL_PORT ?? '').trim();
  const host = (env.BIND_HOST ?? '').trim() || DEFAULT_HOST;
  if (!rawPort) return { port: DEFAULT_PORT, host };
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORTAL_PORT must be a port number between 1 and 65535, got "${rawPort}"`);
  }
  return { port, strictPort: true, host };
}
