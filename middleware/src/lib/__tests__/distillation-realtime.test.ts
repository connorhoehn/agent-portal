// lib/distillation-realtime.ts — realtime-modules attached on /realtime, over
// a real http.Server and a raw `ws` client carrying a real signed session
// cookie. Pinned:
//   - a subscribed client receives orgiq:distill:jobs frames as a compaction runs,
//     each phase in order, ending `succeeded` — plus orgiq:distill:levels after it;
//   - orgiq:distill:review arrives after a sample is decided, with counted totals;
//   - a channel outside orgiq:distill:* is refused (no ack — the catalog's
//     rule), and so is the pre-2026-10-01 bare `distill:*` spelling;
//   - an assessment-tenant cookie, a cross-site Origin, and (outside demo
//     mode) no cookie are all refused at the upgrade;
//   - every other upgrade path is still answered 404.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' },
    mock: { aurora: true }, messageQueue: { mock: true },
  },
}));
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send() { return Promise.resolve({}); } },
  ListPromptsCommand: class {},
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachDistillationRealtime, REALTIME_PATH, DISTILL_CHANNELS } from '../distillation-realtime.js';
import { rejectUnsupportedUpgrades } from '../unsupported-upgrades.js';
import { signSession, COOKIE_NAME, type Session } from '../session.js';
import { compactNow, decideReview, __resetDistillationMock, __setCompactRunMs } from '../../providers/distillation.js';

type Frame = Record<string, unknown> & { type: string; channel?: string };

let server: http.Server;
let detach: () => Promise<void>;
let port: number;

beforeAll(async () => {
  __setCompactRunMs(0);
  server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const handle = attachDistillationRealtime(server, { debounceMs: 5 });
  detach = handle.detach;
  rejectUnsupportedUpgrades(server, { allowPaths: [REALTIME_PATH] });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await detach();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  __resetDistillationMock();
});

beforeEach(() => __resetDistillationMock());

async function cookieFor(over: Partial<Session>): Promise<string> {
  const session: Session = {
    sub: 'u-theo', role: 'member', tenant: 'orgiq', grants: { orgiq: ['member'] },
    iat: Math.floor(Date.now() / 1000), ...over,
  } as Session;
  return `${COOKIE_NAME}=${encodeURIComponent(await signSession(session))}`;
}

/** Open a socket and collect frames. Resolves once open, or with the refusal. */
function connect(opts: { path?: string; cookie?: string; origin?: string } = {}): Promise<{ ws: WebSocket; frames: Frame[] } | { refused: number }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers['cookie'] = opts.cookie;
    if (opts.origin) headers['origin'] = opts.origin;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${opts.path ?? REALTIME_PATH}`, { headers });
    const frames: Frame[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('unexpected-response', (_req, res) => { resolve({ refused: res.statusCode ?? 0 }); ws.terminate(); });
    ws.on('error', () => { /* surfaced through unexpected-response */ });
  });
}

async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for frames');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function subscribed(cookie: string, channels: string[]): Promise<{ ws: WebSocket; frames: Frame[] }> {
  const conn = await connect({ cookie, origin: 'http://localhost:5183' });
  if ('refused' in conn) throw new Error(`refused ${conn.refused}`);
  for (const channel of channels) conn.ws.send(JSON.stringify({ service: 'subscribe', action: 'subscribe', channel }));
  await until(() => channels.every((c) => conn.frames.some((f) => f.type === 'subscribe' && f['action'] === 'subscribed' && f.channel === c)));
  return conn;
}

describe('distill channels', () => {
  it('a subscribed client receives orgiq:distill:jobs frames as a compaction runs, then orgiq:distill:levels', async () => {
    const { ws, frames } = await subscribed(await cookieFor({}), [DISTILL_CHANNELS.jobs, DISTILL_CHANNELS.levels]);
    try {
      const job = await compactNow('L1', 'Test Operator');
      await until(() => frames.some((f) => f.type === 'job' && (f['job'] as { status: string }).status === 'succeeded'));
      const jobFrames = frames.filter((f) => f.type === 'job').map((f) => f['job'] as { id: string; status: string; phase: string; percent: number });
      expect(jobFrames.every((j) => j.id === job.id)).toBe(true);
      expect(frames.filter((f) => f.type === 'job').every((f) => f.channel === DISTILL_CHANNELS.jobs)).toBe(true);
      expect(jobFrames.map((j) => j.phase)).toEqual(['queued', 'claim', 'read', 'merge', 'write', 'done']);
      expect(jobFrames.map((j) => j.status)).toEqual(['queued', 'running', 'running', 'running', 'running', 'succeeded']);
      const percents = jobFrames.map((j) => j.percent);
      expect(percents).toEqual(percents.slice().sort((a, b) => a - b));
      await until(() => frames.some((f) => f.type === 'levels'));
      const levels = frames.find((f) => f.type === 'levels')!;
      expect(levels.channel).toBe(DISTILL_CHANNELS.levels);
      expect((levels['levels'] as Array<{ level: string; digest: string }>).map((l) => l.level)).toEqual(['L0', 'L1', 'L2']);
    } finally {
      ws.close();
    }
  });

  it('orgiq:distill:review carries counted pending/decided after a verdict', async () => {
    const { ws, frames } = await subscribed(await cookieFor({ role: 'org-leader' }), [DISTILL_CHANNELS.review]);
    try {
      await decideReview('rev-003', { verdict: 'agree', note: null }, 'Test');
      await until(() => frames.some((f) => f.type === 'review'));
      const review = frames.find((f) => f.type === 'review')!;
      expect(review.channel).toBe(DISTILL_CHANNELS.review);
      expect(typeof review['pending']).toBe('number');
      expect(typeof review['decided']).toBe('number');
    } finally {
      ws.close();
    }
  });

  it('refuses a subscription outside orgiq:distill:* (no subscribed ack; since realtime-modules 0.98.6 a refusal frame)', async () => {
    const conn = await connect({ cookie: await cookieFor({}) });
    if ('refused' in conn) throw new Error('refused');
    conn.ws.send(JSON.stringify({ service: 'subscribe', action: 'subscribe', channel: 'chat:general' }));
    conn.ws.send(JSON.stringify({ service: 'subscribe', action: 'subscribe', channel: 'distill:jobs' }));
    conn.ws.send(JSON.stringify({ service: 'subscribe', action: 'subscribe', channel: DISTILL_CHANNELS.jobs }));
    await until(() => conn.frames.some((f) => f.channel === DISTILL_CHANNELS.jobs));
    // 0.98.6 answers a refused subscribe with an error frame that names the
    // channel (`AUTHZ_CHANNEL_DENIED`); what must never arrive is a
    // subscribed ack or data for it.
    for (const name of ['chat:general', 'distill:jobs']) {
      const foreign = conn.frames.filter((f) => f.channel === name);
      expect(foreign.every((f) => f['type'] === 'error')).toBe(true);
      expect(foreign.some((f) => f['type'] !== 'error')).toBe(false);
    }
    conn.ws.close();
  });
});

describe('upgrade auth', () => {
  it('refuses an assessment-tenant session', async () => {
    const res = await connect({ cookie: await cookieFor({ role: 'assessor', tenant: 'assessment', grants: { assessment: ['assessor'] } }) });
    expect(res).toEqual({ refused: 401 });
  });

  it('refuses a cross-site Origin even with a valid cookie', async () => {
    const res = await connect({ cookie: await cookieFor({}), origin: 'https://evil.example' });
    expect(res).toEqual({ refused: 401 });
  });

  it('refuses a tampered cookie and, outside demo mode, no cookie at all', async () => {
    const prev = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    process.env['SESSION_SIGNING_KEY_DEV'] = 'orgiq-dev-signing-key-change-me';
    try {
      expect(await connect({})).toEqual({ refused: 401 });
      const good = await cookieFor({});
      expect(await connect({ cookie: `${good.slice(0, -4)}AAAA` })).toEqual({ refused: 401 });
    } finally {
      process.env['NODE_ENV'] = prev;
      delete process.env['SESSION_SIGNING_KEY_DEV'];
    }
  });

  it('still answers 404 to every other upgrade path', async () => {
    expect(await connect({ path: '/api/agents/stream', cookie: await cookieFor({}) })).toEqual({ refused: 404 });
    expect(await connect({ path: '/realtimeX', cookie: await cookieFor({}) })).toEqual({ refused: 404 });
  });
});
