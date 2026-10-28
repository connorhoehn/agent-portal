// Open the deployed realtime gateway's /ws as a seeded user and send raw
// frames. The token is signed with the deployed orgiq-realtime-jwt-secret by
// the middleware's own signRealtimeToken, carrying the user's real grants and
// session epoch from Aurora, so principal revalidation passes.
//
//   npx tsx gateway-probe.mts --portal https://<id>.cloudfront.net --user u-farah --tenant social \
//     [--role participant] [--send '{"service":"call","action":"watch","lobbyName":"social:room:x"}']... \
//     [--seconds 8] [--presence]
//
// Prints every inbound frame (presence frames only with --presence). A 401 on
// upgrade means the token or the principal (tenant, role, epoch) did not pass.
import { arg, args, assertLabAccount, directoryUser, mwImport, mwSource, secretValue } from './lib.mts';

assertLabAccount();
const portal = arg('portal') ?? process.env.CLOUD_PORTAL_URL;
const userId = arg('user');
const tenant = arg('tenant');
if (!portal || !userId || !tenant) throw new Error('--portal, --user and --tenant are required');
const user = directoryUser(userId);
const role = arg('role') ?? user.grants[tenant]?.[0];
if (!role || !user.grants[tenant]?.includes(role)) throw new Error(`${userId} holds no ${role ?? 'role'} in ${tenant}: ${JSON.stringify(user.grants)}`);

const { realtimeClaims, signRealtimeToken } = await mwSource('src/lib/realtime-token.ts');
const { default: WebSocket } = await mwImport('ws');
const session = { sub: userId, name: user.name, tenant, role, grants: user.grants, epoch: user.epoch, iat: Math.floor(Date.now() / 1000) };
const { token } = await signRealtimeToken(realtimeClaims(session as never), secretValue('orgiq-realtime-jwt-secret'));

const url = `${portal.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
const ws = new WebSocket(url, ['bearer-token-v1', token], { headers: { Origin: portal } });
const t0 = Date.now();
const stamp = () => `+${Date.now() - t0}ms`;
ws.on('open', () => {
  console.log(`${stamp()} OPEN as ${userId} (${tenant}/${role}, epoch ${user.epoch})`);
  for (const frame of args('send')) { ws.send(frame); console.log(`${stamp()} → ${frame}`); }
});
ws.on('message', (data: unknown) => {
  const text = String(data);
  if (!process.argv.includes('--presence') && text.includes('"type":"presence"')) return;
  console.log(`${stamp()} ← ${text.slice(0, 400)}`);
});
ws.on('unexpected-response', (_req: unknown, res: { statusCode: number }) => { console.log(`REJECTED ${res.statusCode}`); process.exit(1); });
ws.on('close', (code: number, reason: unknown) => { console.log(`${stamp()} CLOSED ${code} ${String(reason)}`); process.exit(0); });
ws.on('error', (e: Error) => { console.log(`ERROR ${e.message}`); process.exit(1); });
setTimeout(() => { ws.close(); process.exit(0); }, Number(arg('seconds', '8')) * 1000);
