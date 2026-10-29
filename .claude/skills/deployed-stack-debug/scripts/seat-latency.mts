// join on /ws, then poll POST /api/realtime/call-seat until allowed; print the
// latency and what the allowing answer itself took (platform-api asks this
// route on every call-binding, so its cost is on the media path too).
//   npx tsx seat-latency.mts [--base http://127.0.0.1:3031]
import { arg, directoryUser, mwImport, mwSource, secretValue } from './lib.mts';
const base = arg('base', 'http://127.0.0.1:3031')!;
const user = directoryUser('u-farah');
const { realtimeClaims, signRealtimeToken } = await mwSource('src/lib/realtime-token.ts');
const { default: WebSocket } = await mwImport('ws');
const session = { sub: 'u-farah', name: user.name, tenant: 'social', role: 'participant', grants: user.grants, epoch: user.epoch, iat: Math.floor(Date.now() / 1000) };
const { token } = await signRealtimeToken(realtimeClaims(session as never), secretValue('orgiq-realtime-jwt-secret'));
const lobbyName = 'social:room:cloud-call-smoke', callId = `call-seat-${Date.now()}`;
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, ['bearer-token-v1', token], { headers: { Origin: base } });
const clientId: string = await new Promise((res, rej) => {
  ws.on('message', (d: unknown) => { const m = JSON.parse(String(d)); if (m.type === 'session') res(m.clientId); });
  ws.on('error', rej);
});
const t0 = Date.now();
ws.send(JSON.stringify({ service: 'call', action: 'join', callId, lobbyName }));
for (;;) {
  const asked = Date.now();
  const r = await fetch(`${base}/api/realtime/call-seat`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ callId, lobbyName, clientId }) });
  if (r.status === 200) { console.log(`seat allowed after ${Date.now() - t0} ms (that answer took ${Date.now() - asked} ms)`); break; }
  if (Date.now() - t0 > 30000) { console.log(`never allowed (last ${r.status})`); break; }
  await new Promise(r => setTimeout(r, 100));
}
ws.close(); process.exit(0);
