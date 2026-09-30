// lib/redis-lite.ts — the RESP2 client behind the gateway's Redis call state.
// A fake server on a real socket answers with canned replies, split across
// TCP chunks, so the parser's framing is what is under test:
//   - commands are encoded as RESP arrays of bulk strings, in order;
//   - replies of every type map as ioredis would (HGETALL → a record,
//     SMEMBERS → string[], a nil bulk → null, SETNX → 1/0);
//   - an error reply rejects that command only;
//   - AUTH/SELECT run first when the URL carries a password and a db;
//   - rediss:// is refused rather than silently downgraded.

import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { RedisLite, notificationRedisClient } from '../redis-lite.js';

let server: net.Server;
let port: number;
const seen: string[][] = [];

/** Parse RESP arrays of bulk strings from the client (enough for tests). */
function parseCommands(buf: string): { cmds: string[][]; rest: string } {
  const cmds: string[][] = [];
  let i = 0;
  for (;;) {
    if (buf[i] !== '*') break;
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) break;
    const n = Number(buf.slice(i + 1, nl));
    let at = nl + 2;
    const args: string[] = [];
    let complete = true;
    for (let k = 0; k < n; k++) {
      const l = buf.indexOf('\r\n', at);
      if (l < 0) { complete = false; break; }
      const len = Number(buf.slice(at + 1, l));
      if (buf.length < l + 2 + len + 2) { complete = false; break; }
      args.push(buf.slice(l + 2, l + 2 + len));
      at = l + 2 + len + 2;
    }
    if (!complete) break;
    cmds.push(args);
    i = at;
  }
  return { cmds, rest: buf.slice(i) };
}

const REPLIES: Record<string, string> = {
  AUTH: '+OK\r\n',
  SELECT: '+OK\r\n',
  PING: '+PONG\r\n',
  HGETALL: '*4\r\n$6\r\ncaller\r\n$6\r\nu-vera\r\n$5\r\nlobby\r\n$22\r\norgiq:dm:u-nora:u-vera\r\n',
  SMEMBERS: '*2\r\n$2\r\nc1\r\n$2\r\nc2\r\n',
  GET: '$-1\r\n',
  SETNX: ':1\r\n',
  EXPIRE: '-ERR invalid expire time\r\n',
  QUIT: '+OK\r\n',
  ZRANGE: '*2\r\n$3\r\n{a}\r\n$3\r\n{b}\r\n',
  ZCARD: ':2\r\n',
};

beforeAll(async () => {
  server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      const { cmds, rest } = parseCommands(buf + chunk.toString('utf8'));
      buf = rest;
      for (const c of cmds) {
        seen.push(c);
        const reply = REPLIES[c[0]!.toUpperCase()] ?? ':1\r\n';
        // Split every reply across two writes to exercise partial frames.
        const mid = Math.floor(reply.length / 2);
        sock.write(reply.slice(0, mid));
        setTimeout(() => sock.write(reply.slice(mid)), 2);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => { seen.length = 0; });

it('authenticates, selects the db, then maps each reply type', async () => {
  const r = new RedisLite(`redis://:s3cret@127.0.0.1:${port}/2`);
  try {
    expect(await r.ping()).toBe('PONG');
    expect(await r.hgetall('call:1')).toEqual({ caller: 'u-vera', lobby: 'orgiq:dm:u-nora:u-vera' });
    expect(await r.smembers('call:1:participants')).toEqual(['c1', 'c2']);
    expect(await r.get('accepted:1')).toBeNull();
    expect(await r.setNX('accepted:1', '1')).toBe(1);
    expect(await r.sadd('s', 'a', 'b')).toBe(1);
    expect(seen.slice(0, 2)).toEqual([['AUTH', 's3cret'], ['SELECT', '2']]);
    expect(seen).toContainEqual(['SADD', 's', 'a', 'b']);
  } finally { await r.quit(); }
});

it('rejects only the command that got an error reply', async () => {
  const r = new RedisLite(`redis://127.0.0.1:${port}`);
  try {
    await expect(r.expire('k', 10)).rejects.toThrow('invalid expire time');
    expect(await r.ping()).toBe('PONG');
  } finally { await r.quit(); }
});

it('refuses rediss:// instead of connecting in plaintext', () => {
  expect(() => new RedisLite('rediss://example:6380')).toThrow(/no TLS/);
});

it('speaks the notification inbox\'s sorted sets, and the node-redis-shaped adapter maps onto them', async () => {
  const r = new RedisLite(`redis://127.0.0.1:${port}`);
  try {
    const c = notificationRedisClient(r);
    await c.zAdd('notif:list:u-jonas', { score: 1700000000000, value: '{a}' });
    expect(await c.zRange('notif:list:u-jonas', 0, -1)).toEqual(['{a}', '{b}']);
    expect(await c.zCard('notif:list:u-jonas')).toBe(2);
    await c.zRemRangeByRank('notif:list:u-jonas', 0, -201);
    await c.hSet('notif:read:u-jonas', 'n1', '1');
    expect(seen).toEqual(expect.arrayContaining([
      ['ZADD', 'notif:list:u-jonas', '1700000000000', '{a}'],
      ['ZRANGE', 'notif:list:u-jonas', '0', '-1'],
      ['ZCARD', 'notif:list:u-jonas'],
      ['ZREMRANGEBYRANK', 'notif:list:u-jonas', '0', '-201'],
      ['HSET', 'notif:read:u-jonas', 'n1', '1'],
    ]));
  } finally { await r.quit(); }
});
