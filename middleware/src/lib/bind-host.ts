// Which interface the HTTP server listens on.
//
// Under INSECURE_DEV_MODE the process hands out a permissive demo identity,
// signs with published dev keys and trusts seed policies — fine on a laptop,
// not on the café Wi-Fi. So a dev process binds loopback unless BIND_HOST
// says otherwise; a container that publishes the port sets BIND_HOST=0.0.0.0
// (docker-compose.yml does). Without the dev flag — production, the deployed
// task — nothing changes: 0.0.0.0, as the load balancer needs.

import { insecureDevMode } from './insecure-dev-mode.js';

export function listenHost(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env['BIND_HOST'] ?? '').trim();
  if (explicit) return explicit;
  return insecureDevMode(env) ? '127.0.0.1' : '0.0.0.0';
}
