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
