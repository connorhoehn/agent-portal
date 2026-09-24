import type { Server } from 'node:http';

/**
 * The BFF speaks no WebSocket protocol except realtime's own path (see
 * lib/distillation-realtime.ts). Every other upgrade is refused before a
 * socket is accepted or allocated.
 *
 * `allowPaths` are left alone for the listener that owns them — realtime's
 * handler is registered with the same path and answers those upgrades itself.
 * Matching is exact-or-under (`/realtime`, `/realtime/…`), the rule
 * realtime-modules' own `path` filter applies, so the two listeners can never
 * both claim, or both drop, one request.
 */
export function rejectUnsupportedUpgrades(server: Server, opts: { allowPaths?: readonly string[] } = {}): void {
  const allow = opts.allowPaths ?? [];
  server.on('upgrade', (req, socket) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (allow.some((p) => path === p || path.startsWith(`${p}/`))) return;
    socket.on('error', () => { /* peer may close before reading the rejection */ });
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
}
