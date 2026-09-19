import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rejectUnsupportedUpgrades } from '../unsupported-upgrades.js';

it('rejects unauthenticated cross-origin /ws upgrades without a WebSocket handshake', async () => {
  const server = createServer((_req, res) => res.end('SSE BFF'));
  rejectUnsupportedUpgrades(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/ws', headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', Origin: 'https://attacker.example',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
      } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('upgrade', (_res, socket) => { socket.destroy(); reject(new Error('unexpected accepted socket')); });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
