import type { Server } from 'node:http';

/** The BFF has no WebSocket protocol; reject before accepting or allocating one. */
export function rejectUnsupportedUpgrades(server: Server): void {
  server.on('upgrade', (_req, socket) => {
    socket.on('error', () => { /* peer may close before reading the rejection */ });
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
}
