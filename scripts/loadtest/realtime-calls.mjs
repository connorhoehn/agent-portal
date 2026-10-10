#!/usr/bin/env node
// Signalling load test for the middleware's realtime gateway (/ws).
//
// Spec: docs/realtime-capacity-100-calls-2026-10-01.md, "Load-test plan →
// A. Signalling at 100 calls, locally, no AWS". README.md beside this file
// says how to start a target and read the verdict.
//
// No dependencies of its own: `ws` and `jose` are resolved from
// middleware/node_modules. Every frame this driver sends is copied from the
// installed realtime-modules dist the portal ships:
//   call      client/video/useConversationCall.js (start → invite, accept →
//             accepted, announceSelf → participant-state, hangUp → cancelled /
//             user-status / ended, mount + reconnect → status)
//   chat      client/useChat.js (join, send)
//   presence  client/usePresence.js + client/presenceEntry.js (subscribe, set)
//             and PresenceService's `heartbeat` action
// and every frame it reads is the envelope the server dist builds:
//   { type:'call', action, data:{...}, timestamp }       call/CallService.js
//   { type:'chat', action:'message', channel, message }   chat/ChatService.js
//   { type:'presence', action:'update', presence }        presence/PresenceService.js
//   { type:'error', code:'AUTHZ_CHANNEL_DENIED', ... }    server-ws/channelAccess.js
//
// Names are ones the gateway's guards legitimately admit
// (middleware/src/lib/realtime-gateway.ts lobbyGuard/channelGuard): every
// call lobby and chat/presence channel is `social:dm:<sorted ids>` with the
// caller among the ids, and every token is org 'social', tenants ['social'].

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createHash, randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const requireMw = createRequire(resolve(repo, 'middleware', 'package.json'));
const WebSocket = requireMw('ws');
const { SignJWT } = requireMw('jose');

// ── args ────────────────────────────────────────────────────────────────────

const STANDARD_SCENARIOS = ['steady', 'ring-storm', 'glare', 'double-accept', 'churn'];
const SCENARIOS = [...STANDARD_SCENARIOS, 'soak', 'restart'];
const execFileAsync = promisify(execFile);

export function parseArgs(argv) {
  const o = {
    url: 'ws://127.0.0.1:3031/ws',
    peerUrls: [],
    peerContainers: [],
    sockets: 1000,
    calls: 100,
    groupSizes: [2],
    holdSeconds: 60,
    scenario: 'steady',
    // middleware/src/lib/realtime-token.ts DEV_REALTIME_SECRET: what the
    // middleware signs and verifies with when REALTIME_JWT_SECRET is unset
    // outside production.
    secret: process.env.REALTIME_JWT_SECRET || 'orgiq-dev-realtime',
    json: null,
    serverPid: null,
    healthUrl: null,
    rampPerSec: 50,
    chatEverySec: 30,
    chatStartup: 'spread',
    stateEverySec: 20,
    spreadSeconds: 60,
    org: 'social',
    origin: null,
    soakSeconds: 300,
    restartAfterSeconds: 150,
    recoveryTimeoutSeconds: 60,
    restartContainer: null,
    redisContainer: null,
    sampleContainer: null,
    driverContainer: null,
    tokenTtlSeconds: 600,
    identityManifest: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${a} needs a value`); return x; };
    switch (a) {
      case '--url': o.url = v(); break;
      case '--peer-url': o.peerUrls.push(v()); break;
      case '--peer-container': o.peerContainers.push(v()); break;
      case '--sockets': o.sockets = Number(v()); break;
      case '--calls': o.calls = Number(v()); break;
      case '--group-size': o.groupSizes = v().split(',').map(Number); break;
      case '--hold-seconds': o.holdSeconds = Number(v()); break;
      case '--scenario': o.scenario = v(); break;
      case '--secret': o.secret = v(); break;
      case '--json': o.json = v(); break;
      case '--server-pid': o.serverPid = Number(v()); break;
      case '--health-url': o.healthUrl = v(); break;
      case '--ramp-per-sec': o.rampPerSec = Number(v()); break;
      case '--chat-every': o.chatEverySec = Number(v()); break;
      case '--chat-startup': o.chatStartup = v(); break;
      case '--spread-seconds': o.spreadSeconds = Number(v()); break;
      case '--origin': o.origin = v(); break;
      case '--soak-seconds': o.soakSeconds = Number(v()); break;
      case '--restart-after-seconds': o.restartAfterSeconds = Number(v()); break;
      case '--recovery-timeout-seconds': o.recoveryTimeoutSeconds = Number(v()); break;
      case '--restart-container': o.restartContainer = v(); break;
      case '--redis-container': o.redisContainer = v(); break;
      case '--sample-container': o.sampleContainer = v(); break;
      case '--driver-container': o.driverContainer = v(); break;
      case '--token-ttl-seconds': o.tokenTtlSeconds = Number(v()); break;
      case '--identity-manifest': o.identityManifest = v(); break;
      case '-h': case '--help':
        console.log(`usage: node scripts/loadtest/realtime-calls.mjs [--url ws://127.0.0.1:3031/ws] [--peer-url ws://127.0.0.1:3032/ws] [--sockets 1000]
  [--calls 100] [--group-size 2|4|2,4] [--hold-seconds 60] [--scenario ${SCENARIOS.join('|')}|all]
  [--secret <HS256 secret>] [--json out.json] [--server-pid <pid>] [--health-url <url>]
  [--ramp-per-sec 50] [--chat-every 30] [--chat-startup spread|burst] [--spread-seconds 60] [--origin <allowed browser origin>]
  [--soak-seconds 300] [--restart-after-seconds 150] [--recovery-timeout-seconds 60]
  [--restart-container <exact local Docker name>] [--redis-container <exact local Docker name>]
  [--sample-container <exact local Docker name>] [--driver-container <this exact Docker name>]
  [--token-ttl-seconds 600] [--identity-manifest directory-identities.json]`);
        process.exit(0);
        break;
      default: throw new Error(`unknown flag ${a}`);
    }
  }
  if (o.scenario !== 'all' && !SCENARIOS.includes(o.scenario)) throw new Error(`--scenario must be one of ${SCENARIOS.join(', ')}, all`);
  for (const g of o.groupSizes) if (!Number.isInteger(g) || !(g >= 2 && g <= 8)) throw new Error('--group-size must be 2..8');
  if (!Number.isInteger(o.sockets) || !Number.isInteger(o.calls)) throw new Error('Socket and call counts must be integers');
  for (const [key, min, max] of [['sockets', 2, 100_000], ['calls', 1, 10_000], ['rampPerSec', 1, 10_000], ['holdSeconds', 1, 86_400], ['soakSeconds', 1, 86_400], ['recoveryTimeoutSeconds', 1, 120], ['tokenTtlSeconds', 10, 600]]) {
    if (!Number.isFinite(o[key]) || o[key] < min || o[key] > max) throw new Error(`${key} must be ${min}..${max}`);
  }
  if (!Number.isFinite(o.spreadSeconds) || o.spreadSeconds < 0 || !Number.isFinite(o.chatEverySec) || o.chatEverySec < 1) throw new Error('Invalid spread/chat interval');
  if (!['spread', 'burst'].includes(o.chatStartup)) throw new Error('--chat-startup must be spread or burst');
  for (const name of [o.restartContainer, o.redisContainer, o.sampleContainer, o.driverContainer, ...o.peerContainers]) if (name !== null) assertContainerName(name);
  const targets = [o.url, ...o.peerUrls].map(value => {
    const target = new URL(value);
    if (!['ws:', 'wss:'].includes(target.protocol) || target.pathname !== '/ws' || target.username || target.password || target.search || target.hash) throw new Error('Targets require ws:// or wss:// and the /ws path without credentials or query parameters');
    return target.toString();
  });
  if (new Set(targets).size !== targets.length) throw new Error('Gateway target URLs must be distinct');
  if (o.peerUrls.length && [o.restartContainer, o.redisContainer].some(Boolean)) throw new Error('Named restart container operations support one target');
  if (o.peerContainers.length && (!o.sampleContainer || o.peerContainers.length !== o.peerUrls.length)) throw new Error('Peer container sampling requires a primary container and one exact name per peer URL');
  if (o.peerUrls.length && o.sampleContainer && o.peerContainers.length !== o.peerUrls.length) throw new Error('Peer container sampling requires one exact name per peer URL');
  if (new Set([o.sampleContainer, ...o.peerContainers].filter(Boolean)).size !== [o.sampleContainer, ...o.peerContainers].filter(Boolean).length) throw new Error('Sampled gateway containers must be distinct');
  if (o.peerContainers.length && !o.driverContainer) for (const url of o.peerUrls) assertLocalUrl(url);
  if (o.scenario === 'restart') {
    if (!o.restartContainer || !o.redisContainer) throw new Error('restart requires --restart-container and --redis-container');
    if (o.restartContainer === o.redisContainer) throw new Error('Gateway and Redis container names must differ');
    if (!Number.isFinite(o.restartAfterSeconds) || o.restartAfterSeconds < 1 || o.restartAfterSeconds + o.recoveryTimeoutSeconds >= o.soakSeconds) throw new Error('Restart and recovery budget must fit inside --soak-seconds');
    o.sampleContainer ??= o.restartContainer;
    if (o.sampleContainer !== o.restartContainer) throw new Error('Restart stats must sample the named gateway');
  } else if (o.restartContainer || o.redisContainer) throw new Error('Restart container flags require --scenario restart');
  if (o.driverContainer) {
    if (!o.sampleContainer) throw new Error('--driver-container requires a named gateway via --sample-container or --restart-container');
    if ([o.sampleContainer, o.redisContainer, ...o.peerContainers].includes(o.driverContainer)) throw new Error('Driver, gateway and Redis container names must differ');
    if (o.serverPid) throw new Error('Docker drivers must use named gateway container stats, not host process stats');
  } else if (o.sampleContainer) assertLocalUrl(o.url);
  if (!o.healthUrl) {
    const u = new URL(o.url);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/api/health';
    o.healthUrl = u.toString();
  }
  return o;
}

export function assertContainerName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error('Use one exact Docker container name; options, shell text and selectors are refused');
}

function assertLocalUrl(url) {
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Container operations require a loopback gateway URL');
}

export async function dockerCommand(args) {
  const { stdout } = await execFileAsync('docker', args, { timeout: 20_000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export function assertRedisGatewayHealth(data) {
  if (data?.service !== 'orgiq-middleware' || data?.realtime?.gateway !== 'on' || data?.realtime?.store !== 'redis' || data?.realtime?.ready === false) throw new Error('Restart requires the OrgIQ gateway with a confirmed healthy Redis call store');
}

function driverRuntime() {
  let containerHostname = null;
  try { containerHostname = readFileSync('/etc/hostname', 'utf8').trim(); } catch {}
  return { platform: process.platform, hostname: process.env.HOSTNAME, containerHostname };
}

async function inspectContainer(name, command) {
  assertContainerName(name);
  const containers = JSON.parse(await command(['inspect', '--type', 'container', name]));
  const c = containers[0];
  if (containers.length !== 1 || c?.Name !== `/${name}` || c?.State?.Running !== true) throw new Error(`${name} must be one running container addressed by its exact name`);
  return c;
}

export async function assertGatewayTarget(o, command = dockerCommand, runtime = driverRuntime()) {
  const ws = new URL(o.url), health = new URL(o.healthUrl);
  if (!['ws:', 'wss:'].includes(ws.protocol) || health.protocol !== (ws.protocol === 'wss:' ? 'https:' : 'http:')
    || ws.hostname !== health.hostname || ws.port !== health.port || ws.username || ws.password || health.username || health.password
    || ws.pathname !== '/ws' || health.pathname !== '/api/health') throw new Error('Health and WebSocket URLs must address the same gateway host and port');
  const gateway = await inspectContainer(o.restartContainer ?? o.sampleContainer, command);
  if (!o.driverContainer) {
    assertLocalUrl(o.url);
    assertLocalUrl(o.healthUrl);
    const bindings = Object.values(gateway.NetworkSettings?.Ports ?? {}).flatMap((x) => x ?? []);
    if (!ws.port || !bindings.some((b) => b.HostPort === ws.port && ['127.0.0.1', '::1'].includes(b.HostIp))) throw new Error('The named gateway must publish the target port on loopback');
    return { gateway, networkIds: [] };
  }
  const driver = await inspectContainer(o.driverContainer, command);
  const id = driver.Id;
  const expectedHostname = driver.Config?.Hostname;
  if (runtime.platform !== 'linux' || !/^[a-f0-9]{64}$/.test(id ?? '') || expectedHostname !== id.slice(0, 12)
    || runtime.hostname !== expectedHostname || runtime.containerHostname !== expectedHostname) throw new Error('--driver-container must identify this running Docker driver with its default container hostname');
  const driverNetworkIds = new Set(Object.values(driver.NetworkSettings?.Networks ?? {}).map((n) => n.NetworkID).filter(Boolean));
  const networkIds = Object.values(gateway.NetworkSettings?.Networks ?? {})
    .filter((n) => driverNetworkIds.has(n.NetworkID)
      && [gateway.Name.slice(1), ...(n.Aliases ?? []), ...(n.DNSNames ?? [])].includes(ws.hostname))
    .map((n) => n.NetworkID);
  if (!networkIds.length) throw new Error('Gateway DNS name must be an exact gateway alias on the driver shared Docker network');
  const exposedPorts = new Set([...Object.keys(gateway.Config?.ExposedPorts ?? {}), ...Object.keys(gateway.NetworkSettings?.Ports ?? {})]);
  if (!ws.port || !exposedPorts.has(`${ws.port}/tcp`)) throw new Error('Docker gateway URL must use an exposed internal TCP port');
  return { gateway, networkIds };
}

export async function assertRestartTarget(o, command = dockerCommand, runtime = driverRuntime()) {
  const { networkIds } = await assertGatewayTarget(o, command, runtime);
  const redis = await inspectContainer(o.redisContainer, command);
  if (o.driverContainer && !Object.values(redis.NetworkSettings?.Networks ?? {}).some((n) => networkIds.includes(n.NetworkID))) throw new Error('Named Redis must share the driver and gateway Docker network');
  if (await command(['exec', o.redisContainer, 'redis-cli', 'PING']) !== 'PONG') throw new Error('Named Redis did not answer PONG');
  const health = await fetch(o.healthUrl, { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error('Gateway health failed before restart');
  assertRedisGatewayHealth(await health.json());
}

// ── small helpers ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const iso = () => new Date().toISOString();

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
function stats(arr) {
  if (!arr.length) return { n: 0, p50: null, p95: null, p99: null, max: null };
  return { n: arr.length, p50: r1(pct(arr, 50)), p95: r1(pct(arr, 95)), p99: r1(pct(arr, 99)), max: r1(Math.max(...arr)) };
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const fmt = (x) => (x == null ? '—' : `${x}`);
const pad4 = (n) => String(n).padStart(4, '0');

/** Exactly dmLobbyName(ids, { prefix }) from client/video/conversationLobby.js. */
function dmLobbyName(userIds, prefix) {
  const ids = Array.from(new Set(userIds.filter((u) => typeof u === 'string' && u.length > 0))).sort();
  return `${prefix}dm:${ids.join(':')}`;
}
/** Exactly mintCallId from useConversationCall.js. */
const mintCallId = () => `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ── tokens ──────────────────────────────────────────────────────────────────

/** A manifest supplies claims only. The gateway still checks the current
 * directory and policy for every action and recipient; it grants no rights. */
export function readIdentityManifest(value, minimum, org = 'social') {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100_000) throw new Error('Identity manifest must contain enough distinct directory users for the run');
  const seen = new Set();
  return value.map(row => {
    if (!row || typeof row !== 'object' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.userId ?? '')
      || seen.has(row.userId) || typeof row.displayName !== 'string' || !row.displayName.trim() || row.displayName.length > 256
      || !['participant', 'moderator', 'community-admin', 'admin'].includes(row.role)
      || !Number.isSafeInteger(row.epoch) || row.epoch < 0
      || !Array.isArray(row.tenants) || !row.tenants.includes(org)
      || row.tenants.length > 32 || new Set(row.tenants).size !== row.tenants.length
      || !row.tenants.every(tenant => typeof tenant === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(tenant))) {
      throw new Error('Identity manifest contains an invalid, duplicated or incomplete directory identity');
    }
    seen.add(row.userId);
    return { userId: row.userId, displayName: row.displayName, role: row.role, epoch: row.epoch, tenants: [...row.tenants] };
  });
}

/** The claims realtimeClaims() builds and verifyRealtimeToken() checks. */
export async function mintToken(secret, userId, org, ttlSeconds = 600, nowS = Math.floor(Date.now() / 1000), identity = null) {
  const displayName = identity?.displayName ?? `Load ${userId}`;
  if (identity && identity.userId !== userId) throw new Error('Token identity must match its subject');
  return new SignJWT({
    sub: userId,
    displayName,
    given_name: 'Load',
    family_name: userId,
    org,
    tenants: identity?.tenants ?? [org],
    role: identity?.role ?? 'participant',
    epoch: identity?.epoch ?? 0,
    tokenKind: 'orgiq-hs256',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuedAt(nowS)
    .setExpirationTime(nowS + ttlSeconds)
    .setIssuer('orgiq-middleware')
    .setAudience('realtime')
    .sign(new TextEncoder().encode(secret));
}

// ── server-side sampling ────────────────────────────────────────────────────

function discoverServerPid(wsUrl) {
  const u = new URL(wsUrl);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) return null;
  const port = u.port || (u.protocol === 'wss:' ? '443' : '80');
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim();
    const pid = Number(out.split('\n')[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function cpuSeconds(t) {
  // ps `time` = [[dd-]hh:]mm:ss[.cc]
  let days = 0;
  let rest = t.trim();
  if (rest.includes('-')) { const [d, r] = rest.split('-'); days = Number(d); rest = r; }
  const parts = rest.split(':').map(Number);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return days * 86400 + s;
}

class ServerSampler {
  constructor(pid, healthUrl, container = null, command = dockerCommand) {
    this.pid = pid; this.healthUrl = healthUrl;
    this.container = container; this.command = command;
    this.plannedOutage = false; this.plannedHealthErrors = 0; this.sampleErrors = 0;
    this.rss = []; this.cpu = []; this.health = []; this.healthErrors = 0;
    this.timers = []; this.last = null; this.slow = []; this.t0 = now(); this.phase = null;
  }
  start() {
    if (this.container) {
      this.timers.push(setInterval(() => void this.sampleContainer(), 5000));
      void this.sampleContainer();
    } else if (this.pid) {
      this.timers.push(setInterval(() => this.samplePs(), 1000));
      this.samplePs();
    }
    this.timers.push(setInterval(() => void this.sampleHealth(), 500));
  }
  async sampleContainer() {
    if (this.samplingContainer) return;
    this.samplingContainer = true;
    try {
      const row = JSON.parse(await this.command(['stats', '--no-stream', '--format', '{{json .}}', this.container]));
      const mem = /^([\d.]+)\s*(B|kB|KiB|MB|MiB|GB|GiB)\b/.exec(row.MemUsage ?? '');
      const scale = { B: 1 / 1048576, kB: 1000 / 1048576, KiB: 1 / 1024, MB: 1000000 / 1048576, MiB: 1, GB: 1000000000 / 1048576, GiB: 1024 };
      if (!mem || !Number.isFinite(Number.parseFloat(row.CPUPerc))) throw new Error('Invalid Docker stats');
      this.rss.push(Number(mem[1]) * scale[mem[2]]);
      this.cpu.push(Number.parseFloat(row.CPUPerc));
    } catch { if (!this.plannedOutage) this.sampleErrors++; }
    finally { this.samplingContainer = false; }
  }
  samplePs() {
    try {
      const out = execFileSync('ps', ['-o', 'rss=,time=', '-p', String(this.pid)], { encoding: 'utf8' }).trim();
      const [rssKb, time] = out.split(/\s+/);
      const t = now();
      const c = cpuSeconds(time);
      this.rss.push(Number(rssKb) / 1024);
      if (this.last) {
        const dt = (t - this.last.t) / 1000;
        if (dt > 0.2) this.cpu.push(((c - this.last.c) / dt) * 100);
      }
      this.last = { t, c };
    } catch { /* process gone */ }
  }
  async sampleHealth() {
    const t0 = now();
    const planned = this.plannedOutage;
    try {
      const res = await fetch(this.healthUrl, { signal: AbortSignal.timeout(5000) });
      await res.arrayBuffer();
      const ms = now() - t0;
      if (!res.ok) { if (planned) this.plannedHealthErrors++; else this.healthErrors++; }
      else if (!planned) this.health.push(ms);
      // Slow samples, stamped against the run's phase markers, show what stalled the loop.
      if (ms >= 50 && this.slow.length < 50) this.slow.push({ ms: r1(ms), atS: r1((t0 - this.t0) / 1000), phase: this.phase?.() ?? null });
    } catch { if (planned) this.plannedHealthErrors++; else this.healthErrors++; }
  }
  stop() { for (const t of this.timers) clearInterval(t); }
  summary() {
    return {
      pid: this.pid,
      container: this.container, memorySource: this.container ? 'docker-working-set' : 'process-rss', sampleErrors: this.sampleErrors,
      rssMb: { peak: r1(this.rss.length ? Math.max(...this.rss) : null), last: r1(this.rss.at(-1) ?? null) },
      cpuPct: { peak: r1(this.cpu.length ? Math.max(...this.cpu) : null), mean: r1(this.cpu.length ? this.cpu.reduce((a, b) => a + b, 0) / this.cpu.length : null), p95: r1(pct(this.cpu, 95)) },
      healthMs: { ...stats(this.health), errors: this.healthErrors, plannedOutageErrors: this.plannedHealthErrors }, slowHealth: this.slow,
    };
  }
}

// ── one run (scenario × group size) ─────────────────────────────────────────

export class Run {
  constructor(opts, scenario, groupSize, command = dockerCommand) {
    this.o = opts;
    this.scenario = scenario;
    this.groupSize = groupSize;
    this.docker = command;
    this.tag = randomBytes(2).toString('hex'); // fresh user namespace per run
    const doubles = scenario === 'double-accept' ? Math.min(10, opts.calls) : 0;
    this.identities = opts.identityManifest
      ? readIdentityManifest(JSON.parse(readFileSync(opts.identityManifest, 'utf8')), opts.sockets - doubles, opts.org) : null;
    this.identityByUser = new Map(this.identities?.map(identity => [identity.userId, identity]) ?? []);
    this.identityEvidence = this.identities ? {
      mode: 'directory-manifest', users: this.identities.length,
      sha256: createHash('sha256').update(JSON.stringify(this.identities)).digest('hex'),
    } : { mode: 'synthetic-claims' };
    this.prefix = `${opts.org}:`;
    this.clients = [];          // every Client ever opened
    this.currentClients = new Map();
    this.calls = [];            // call records
    this.callById = new Map();  // callId → call
    this.chatSent = new Map();  // nonce → { t, channel, sender }
    this.chatSentUsers = new Set();
    this.chatDeliveredUsers = new Set();
    this.lat = { invite: [], accept: [], chat: [], connect: [] };
    this.counts = {
      connectOk: 0, connectFail: 0, connectFailReasons: {},
      crossCall: 0, crossChat: 0, crossPresence: 0,
      unexpectedEnded: 0, answeredElsewhere: 0,
      denied: 0, otherErrors: 0, errorMessages: {},
      framesIn: 0, framesOut: 0, byKind: {},
      notifications: 0, missedCallNotifications: 0,
      reconnects: 0,
      unexpectedDisconnects: 0,
    };
    this.samples = { crossCall: [], unexpectedEnded: [], denied: [], errors: [] };
    this.churn = null;
    this.closing = false;
    this.recoveries = [];
    this.recovery = null;
  }

  user(i) {
    if (!this.identities) return `lt${this.tag}-${pad4(i)}`;
    const identity = this.identities[i - 1];
    if (!identity) throw new Error('Identity manifest has no directory user for this socket');
    return identity.userId;
  }

  // ── sockets ──

  async open(userId, role, timeoutMs = 10_000) {
    const c = new Client(this, userId, role);
    const targets = [this.o.url, ...(this.o.peerUrls ?? [])];
    c.targetUrl = targets[this.clients.length % targets.length];
    this.clients.push(c);
    await c.connect(timeoutMs);
    if (c.ok) this.currentClients.set(userId, c);
    return c;
  }

  // ── frame accounting shared by every socket ──

  onFrame(c, msg) {
    const k = `${msg.type ?? '?'}.${msg.action ?? msg.code ?? ''}`;
    this.counts.framesIn++;
    this.counts.byKind[k] = (this.counts.byKind[k] ?? 0) + 1;
    if (this.closing) return;
    if (msg.type === 'error') {
      const code = msg.code ?? msg.error?.code ?? '';
      if (code === 'AUTHZ_CHANNEL_DENIED') {
        this.counts.denied++;
        if (this.samples.denied.length < 10) this.samples.denied.push({ user: c.userId, channel: msg.channel, kind: msg.kind });
      } else {
        this.counts.otherErrors++;
        const m = `${msg.service ?? ''}:${msg.message ?? code}`;
        this.counts.errorMessages[m] = (this.counts.errorMessages[m] ?? 0) + 1;
      }
      return;
    }
    if (typeof msg.type === 'string' && msg.type.startsWith('notification')) {
      // NotificationService: { type:'notification:new', payload: record }.
      if (msg.type === 'notification:new') {
        this.counts.notifications++;
        if (msg.payload?.type === 'call-missed') this.counts.missedCallNotifications++;
      }
      return;
    }
    if (msg.type === 'chat') return this.onChat(c, msg);
    if (msg.type === 'presence') return this.onPresence(c, msg);
    if (msg.type === 'call') return this.onCall(c, msg);
  }

  onChat(c, msg) {
    if (msg.action === 'joined' && typeof msg.channel === 'string' && c.chatChannels.has(msg.channel)) {
      c.joinedChats.add(msg.channel); return;
    }
    if (msg.action !== 'message') return;
    const ch = msg.channel ?? msg.message?.channel;
    if (!c.chatChannels.has(ch)) {
      this.counts.crossChat++;
      return;
    }
    const text = msg.message?.message;
    if (typeof text !== 'string' || !text.startsWith('lt|')) return;
    const sent = this.chatSent.get(text);
    if (!sent || sent.sender === c.userId) return; // own echo
    this.lat.chat.push(now() - sent.t);
    this.chatDeliveredUsers.add(sent.sender);
    if (this.recovery && sent.recoveryId === this.recovery.id && this.recovery.fresh.get(c.userId) === c) this.recovery.chatDelivered.add(sent.sender);
  }

  onPresence(c, msg) {
    if (this.recovery && this.recovery.fresh.get(c.userId) === c && msg.action === 'set' && msg.presence?.clientId === c.clientId) this.recovery.presenceSet.add(c.userId);
    if (msg.action !== 'update') return;
    const chans = Array.isArray(msg.presence?.channels) ? msg.presence.channels : [];
    if (chans.length && !chans.some((ch) => c.presenceChannels.has(ch))) this.counts.crossPresence++;
    if (this.recovery && this.recovery.fresh.get(c.userId) === c && this.recovery.fresh.get(msg.presence?.userId)?.clientId === msg.presence?.clientId && msg.presence?.status === 'online') this.recovery.presenceDelivered.add(msg.presence.userId);
  }

  /** The collision detector: a call frame for a call/lobby this socket is not party to. */
  isForeign(c, d) {
    const lobby = typeof d.lobbyName === 'string' && d.lobbyName ? d.lobbyName : null;
    if (lobby && !c.lobbies.has(lobby)) return `lobby ${lobby}`;
    const callId = typeof d.callId === 'string' && d.callId ? d.callId : null;
    if (callId) {
      const call = this.callById.get(callId);
      if (!call) return `unknown callId ${callId}`;
      if (!c.lobbies.has(call.lobby)) return `callId ${callId} of ${call.lobby}`;
    }
    return null;
  }

  onCall(c, msg) {
    const d = msg.data && typeof msg.data === 'object' ? msg.data : {};
    const foreign = this.isForeign(c, d);
    if (foreign) {
      this.counts.crossCall++;
      if (this.samples.crossCall.length < 10) this.samples.crossCall.push({ to: c.userId, action: msg.action, why: foreign });
      return;
    }
    const call = typeof d.callId === 'string' ? this.callById.get(d.callId) : null;
    switch (msg.action) {
      case 'invite': {
        if (!call) return;
        const key = `${d.callId}|${c.userId}`;
        const sentAt = call.inviteSentAt.get(d.callId);
        if (sentAt != null && !call.inviteSeen.has(key)) {
          call.inviteSeen.add(key);
          this.lat.invite.push(now() - sentAt);
        }
        call.onInvite?.(c, d);
        return;
      }
      case 'accepted': {
        if (!call) return;
        const uid = d.userId ?? d.callerId;
        if (uid === c.userId) return; // sibling fan-out of my own user's accept
        const sentAt = call.acceptSentAt.get(`${d.callId}|${uid}`);
        if (sentAt != null && c.userId === call.callerOf(d.callId)) {
          const key = `${d.callId}|${uid}`;
          if (!call.acceptSeen.has(key)) {
            call.acceptSeen.add(key);
            this.lat.accept.push(now() - sentAt);
          } else {
            call.duplicateAccepted++;
          }
          call.onAccepted?.(uid, d.callId);
        }
        return;
      }
      case 'ended': {
        if (d.reason === 'answered-elsewhere') {
          this.counts.answeredElsewhere++;
          if (call) call.answeredElsewhere.push(c);
          return;
        }
        if (!call) return;
        // Our own hang-up echo carries no reason; the scripted hang-up of
        // this call has begun → expected.
        if (call.hangupStarted || call.retiredCallIds.has(d.callId)) return;
        this.counts.unexpectedEnded++;
        const ev = { to: c.userId, callId: d.callId, lobby: call.lobby, reason: d.reason ?? null, at: iso() };
        if (this.churn?.at) ev.secondsAfterChurn = r1((now() - this.churn.at) / 1000);
        call.serverEnded = call.serverEnded ?? ev;
        if (this.samples.unexpectedEnded.length < 50) this.samples.unexpectedEnded.push(ev);
        return;
      }
      case 'user-status': {
        if (call && this.churn && d.reason === 'peer-disconnected') {
          this.churn.userStatusLeft.push({ to: c.userId, callId: d.callId, rejoinGraceMs: d.rejoinGraceMs ?? null, secondsAfterChurn: r1((now() - this.churn.at) / 1000) });
        }
        return;
      }
      case 'active-call': {
        if (call && this.recovery && this.recovery.fresh.get(c.userId) === c && d.callId === call.callId && d.active === true && call.members.every((uid) => d.participantUserIds?.includes(uid))) this.recovery.callStatus.add(c.userId);
        if (this.churn && c.reconnected) {
          this.churn.activeCallReplies.push({ user: c.userId, active: d.active === true, callId: d.callId ?? null, participantUserIds: d.participantUserIds ?? [], includesSelf: Array.isArray(d.participantUserIds) && d.participantUserIds.includes(c.userId) });
        }
        return;
      }
      case 'participant-state': {
        if (call && this.recovery && this.recovery.fresh.get(c.userId) === c && this.recovery.fresh.has(d.userId) && d.userId !== c.userId && call.members.includes(d.userId)) this.recovery.participantStates.add(`${d.callId}|${d.userId}|${c.userId}`);
        return;
      }
      default:
    }
  }

  // ── background: chat + presence on DM channels ──

  async startBackground(chatClients) {
    this.backgroundUsers = chatClients.map((c) => c.userId);
    // Pair the chat sockets into DM channels (`social:ch:` needs membership rows; DMs do not).
    for (let i = 0; i + 1 < chatClients.length; i += 2) {
      const a = chatClients[i], b = chatClients[i + 1];
      const ch = dmLobbyName([a.userId, b.userId], this.prefix);
      for (const c of [a, b]) c.joinChat(ch);
    }
    if (chatClients.length % 2 === 1) {
      const c = chatClients.at(-1);
      c.joinPresenceOnly(dmLobbyName([c.userId, `${c.userId}x`], this.prefix));
    }
    const every = this.o.chatEverySec * 1000;
    this.bgTimers = [];
    // Every paired sender needs observed peer delivery even in a short smoke.
    // Ordinary background sends follow the planned cadence. Preserve the
    // synchronized initial send as an explicit burst stress profile.
    const paired = chatClients.filter(client => client.chatChannel);
    const admissionStarted = now(), admissionDeadline = admissionStarted + 10000;
    while (now() < admissionDeadline && paired.some(client => !client.joinedChats.has(client.chatChannel))) await sleep(10);
    this.chatAdmission = { expected: paired.length, joined: paired.filter(client => client.joinedChats.has(client.chatChannel)).length, waitMs: r1(now() - admissionStarted) };
    if (this.o.chatStartup === 'burst') for (const client of paired) client.sendChat();
    const startupWindow = Math.min(every, this.o.holdSeconds * 500);
    for (const [index, c] of paired.entries()) {
      const first = this.o.chatStartup === 'burst' ? Math.random() * every : startupWindow * (index + 1) / (paired.length + 1);
      const t = setTimeout(() => {
        this.currentClients.get(c.userId)?.sendChat();
        const iv = setInterval(() => this.currentClients.get(c.userId)?.sendChat(), every);
        this.bgTimers.push(iv);
      }, first);
      this.bgTimers.push(t);
    }
    // PresenceService's `heartbeat`, every 30 s (the plan's background load).
    this.bgTimers.push(setInterval(() => {
      for (const uid of this.backgroundUsers) this.currentClients.get(uid)?.send({ service: 'presence', action: 'heartbeat' });
    }, 30_000));
  }
  stopBackground() { for (const t of this.bgTimers ?? []) { clearTimeout(t); clearInterval(t); } }

  // ── the run ──

  async execute() {
    const o = this.o;
    if (this.scenario === 'restart') await assertRestartTarget(o, this.docker);
    else if (o.sampleContainer) await assertGatewayTarget(o, this.docker);
    for (const [index, name] of (o.peerContainers ?? []).entries()) {
      const health = new URL(o.peerUrls[index]); health.protocol = health.protocol === 'wss:' ? 'https:' : 'http:'; health.pathname = '/api/health';
      await assertGatewayTarget({ ...o, url: o.peerUrls[index], healthUrl: health.toString(), sampleContainer: name, restartContainer: null }, this.docker);
    }
    const g = this.groupSize;
    const callSockets = o.calls * g;
    const doubles = this.scenario === 'double-accept' ? Math.min(10, o.calls) : 0;
    if (callSockets + doubles > o.sockets) throw new Error(`--sockets ${o.sockets} < ${callSockets + doubles} needed for ${o.calls} calls of ${g}`);
    const chatCount = o.sockets - callSockets - doubles;

    console.log(`\n=== ${this.scenario} · group ${g} · ${o.calls} calls · ${o.sockets} sockets (${callSockets} in calls, ${doubles} second tabs, ${chatCount} chat/presence) · run tag ${this.tag}`);

    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const sampler = new ServerSampler(o.serverPid, o.healthUrl, o.sampleContainer, this.docker);
    this.phase = 'ramp';
    sampler.phase = () => this.phase;
    sampler.start();
    this.sampler = sampler;
    this.peerSamplers = (o.peerUrls ?? []).map((url, index) => {
      const health = new URL(url);
      health.protocol = health.protocol === 'wss:' ? 'https:' : 'http:';
      health.pathname = '/api/health';
      const container = o.peerContainers?.[index] ?? null;
      const peer = new ServerSampler(container ? null : discoverServerPid(url), health.toString(), container, this.docker);
      peer.phase = () => this.phase;
      peer.start();
      return { url, sampler: peer };
    });
    this.loop = loop;
    const t0 = now();

    // Build calls.
    let userIx = 1;
    for (let k = 0; k < o.calls; k++) {
      const members = Array.from({ length: g }, () => this.user(userIx++));
      this.calls.push(new Call(this, k, members));
    }
    const chatUsers = Array.from({ length: chatCount }, () => this.user(userIx++));

    // Ramp: open sockets at rampPerSec, call sockets first.
    const plan = [];
    for (const call of this.calls) for (const u of call.members) plan.push({ u, role: 'call', call });
    for (let k = 0; k < doubles; k++) plan.push({ u: this.calls[k].members[1], role: 'call', call: this.calls[k] });
    for (const u of chatUsers) plan.push({ u, role: 'chat' });
    const gap = 1000 / o.rampPerSec;
    const opened = [];
    const rampStart = now();
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      const wait = rampStart + i * gap - now();
      if (wait > 0) await sleep(wait);
      opened.push(this.open(p.u, p.role).then((c) => {
        if (p.call) p.call.attach(c);
        return c;
      }));
    }
    const clients = await Promise.all(opened);
    this.initialClients = clients;
    const rampSeconds = r1((now() - rampStart) / 1000);
    const chatClients = clients.filter((c) => c.role === 'chat' && c.ok);
    console.log(`  ramp: ${this.counts.connectOk}/${plan.length} connected in ${rampSeconds}s`);

    // Mount: every call socket asks `status` for its lobby (useConversationCall discovery).
    for (const call of this.calls) for (const c of call.sockets) c.send({ service: 'call', action: 'status', lobbyName: call.lobby });
    await this.startBackground(chatClients);
    await sleep(2000);

    // Start calls per scenario.
    this.phase = 'calls-starting';
    const sc = this.scenario;
    if (sc === 'ring-storm') {
      // 100 invites within 1 s.
      const step = 1000 / o.calls;
      for (const call of this.calls) { call.start(); await sleep(step); }
    } else if (sc === 'glare') {
      const glare = Math.min(20, o.calls);
      // 20 groups whose first two members invite each other within 10 ms.
      for (let k = 0; k < glare; k++) this.calls[k].startGlare();
      const rest = this.calls.slice(glare);
      const step = (10_000 / Math.max(1, rest.length));
      for (const call of rest) { call.start(); await sleep(step); }
    } else {
      // steady, double-accept, churn: 100 calls spread over spreadSeconds.
      const step = (o.spreadSeconds * 1000) / o.calls;
      for (const call of this.calls) { call.start(); await sleep(step); }
    }

    // Wait for establishment (bounded).
    const estDeadline = now() + 20_000;
    while (now() < estDeadline && this.calls.some((c) => !c.establishedAt && !c.failed)) await sleep(250);
    for (const c of this.calls) if (!c.establishedAt) c.failed = c.failed ?? 'not established within 20 s of the last invite';
    const lastEst = Math.max(...this.calls.map((c) => c.establishedAt ?? 0));

    // Churn: 10% of in-call sockets dropped 10 s after the last call is up, back after 2 s.
    let minHangupAt = 0;
    this.phase = 'hold';
    if (sc === 'churn') {
      await sleep(Math.max(0, lastEst + 10_000 - now()));
      await this.doChurn();
      minHangupAt = this.churn.at + 45_000; // past the server's 30 s rejoin grace
    }

    // Soaks hold every call together; periodic authenticated reconnects make
    // long runs exercise fresh token verification instead of expired sockets.
    if (sc === 'soak' || sc === 'restart') await this.holdSoak(sampler);

    // Hold, then the scripted hang-up of every call.
    if (this.churn) setTimeout(() => { this.phase = 'grace-expiry'; }, Math.max(0, this.churn.at + 29_000 - now()));
    const hangups = this.calls.map(async (call) => {
      const due = sc === 'soak' || sc === 'restart' ? now() : Math.max((call.establishedAt ?? now()) + o.holdSeconds * 1000, minHangupAt);
      await sleep(Math.max(0, due - now()));
      this.phase = 'hang-up';
      await call.hangUp();
    });
    await Promise.all(hangups);
    await sleep(3000);

    this.closing = true;
    this.stopBackground();
    for (const call of this.calls) call.stop();
    for (const c of this.clients) c.close();
    sampler.stop();
    for (const peer of this.peerSamplers) peer.sampler.stop();
    loop.disable();
    await sleep(1500);

    return this.report({ rampSeconds, sampler: sampler.summary(), peerServers: this.peerSamplers.map(peer => ({ url: peer.url, ...peer.sampler.summary() })), clientLoop: { p50: r1(loop.percentile(50) / 1e6), p99: r1(loop.percentile(99) / 1e6), max: r1(loop.max / 1e6) }, durationS: r1((now() - t0) / 1000) });
  }

  cleanup() {
    this.closing = true;
    this.stopBackground();
    for (const call of this.calls) call.stop();
    for (const c of this.clients) c.drop();
    this.sampler?.stop();
    for (const peer of this.peerSamplers ?? []) peer.sampler.stop();
    this.loop?.disable();
  }

  async holdSoak(sampler) {
    const started = now();
    const end = started + this.o.soakSeconds * 1000;
    const restartAt = started + this.o.restartAfterSeconds * 1000;
    let restarted = false;
    this.soak = { requestedSeconds: this.o.soakSeconds, tokenTtlSeconds: this.o.tokenTtlSeconds, startedAt: iso(), expiredBeforeReconnect: 0 };
    while (now() < end) {
      if (this.scenario === 'restart' && !restarted && now() >= restartAt) {
        restarted = true;
        await this.doRecovery('gateway-restart', sampler);
      } else {
        const refreshDue = [...this.currentClients.values()].some((c) => c.ok && !c.dropped && Date.now() >= c.tokenIssuedAt + this.o.tokenTtlSeconds * 750);
        if (refreshDue) await this.doRecovery('token-renewal', sampler);
      }
      if (this.recoveries.at(-1)?.error) break;
      this.phase = 'soak';
      await sleep(Math.min(250, Math.max(0, end - now())));
    }
    this.soak.elapsedSeconds = r1((now() - started) / 1000);
    this.soak.completed = now() >= end;
  }

  async doRecovery(kind, sampler) {
    const rec = {
      id: randomBytes(6).toString('hex'), kind, started: now(), startedAt: iso(),
      expectedSockets: this.o.sockets, expectedCallStatus: this.o.calls * this.groupSize,
      expectedParticipantStates: this.o.calls * this.groupSize * (this.groupSize - 1),
      expectedChat: this.initialClients.filter((c) => c.chatChannel).length,
      expectedPresence: this.backgroundUsers.length,
      fresh: new Map(), callStatus: new Set(), participantStates: new Set(),
      chatDelivered: new Set(), presenceSet: new Set(), presenceDelivered: new Set(),
      socketLatency: [], error: null,
    };
    this.recovery = rec;
    const deadline = now() + this.o.recoveryTimeoutSeconds * 1000;
    this.phase = kind;
    const originals = this.initialClients.map((c) => this.currentClients.get(c.userId) ?? c);
    const callByUser = new Map(this.calls.flatMap((call) => call.members.map((uid, i) => [uid, { call, wave: i }])));
    try {
      if (kind === 'gateway-restart') {
        for (const c of originals) c.plannedDisconnect = true;
        sampler.plannedOutage = true;
        const outageStarted = now();
        console.log(`  restart: exact container ${this.o.restartContainer}; Redis ${this.o.redisContainer}`);
        await this.docker(['restart', '--time', '1', this.o.restartContainer]);
        let ready = false;
        while (now() < deadline) {
          try {
            const res = await fetch(this.o.healthUrl, { signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - now()))) });
            if (res.ok) { assertRedisGatewayHealth(await res.json()); ready = true; break; }
          } catch { /* startup is the planned outage */ }
          await sleep(250);
        }
        if (!ready) throw new Error('Gateway did not return with its Redis call store inside the recovery budget');
        if (await this.docker(['exec', this.o.redisContainer, 'redis-cli', 'PING']) !== 'PONG') throw new Error('Redis failed its post-restart PING');
        rec.outageSeconds = r1((now() - outageStarted) / 1000);
        sampler.plannedOutage = false;
      }
      // Token renewal replaces one member per call (and one half of each DM)
      // at a time. Restart reconnects every user to the persisted call without
      // inventing an invite or changing the original call ID.
      const waves = kind === 'gateway-restart' ? [originals] : Array.from({ length: this.groupSize }, (_, wave) => originals.filter((c) => {
        const entry = callByUser.get(c.userId);
        return entry ? entry.wave === wave : this.backgroundUsers.indexOf(c.userId) % 2 === wave;
      }));
      for (const wave of waves) {
        const opened = [];
        const rampAt = now();
        for (let i = 0; i < wave.length; i++) {
          if (now() >= deadline) throw new Error('Recovery socket ramp exceeded its budget');
          await sleep(Math.max(0, rampAt + i * 1000 / this.o.rampPerSec - now()));
          const old = wave[i];
          if (Date.now() >= old.tokenExpiresAt) this.soak.expiredBeforeReconnect++;
          old.drop();
          opened.push(this.open(old.userId, old.role, Math.min(10_000, Math.max(1, deadline - now()))).then((fresh) => {
            if (!fresh.ok) return;
            rec.fresh.set(fresh.userId, fresh);
            rec.socketLatency.push(now() - rec.started);
            this.counts.reconnects++;
            const entry = callByUser.get(fresh.userId);
            if (entry) {
              entry.call.replace(old, fresh);
              // The public hook's actual reconnect order is intentional.
              fresh.send({ service: 'call', action: 'status', lobbyName: entry.call.lobby });
              entry.call.announce(fresh);
            } else {
              if (old.chatChannel) fresh.joinChat(old.chatChannel);
              else for (const ch of old.presenceChannels) fresh.joinPresenceOnly(ch);
            }
          }));
        }
        await Promise.all(opened);
        if (kind === 'token-renewal') {
          const callUsers = wave.filter((c) => callByUser.has(c.userId)).map((c) => c.userId);
          while (now() < deadline && callUsers.some((uid) => !rec.callStatus.has(uid))) {
            for (const uid of callUsers) {
              const fresh = rec.fresh.get(uid);
              const entry = callByUser.get(uid);
              if (fresh) { entry.call.announce(fresh); fresh.send({ service: 'call', action: 'status', lobbyName: entry.call.lobby }); }
            }
            await sleep(250);
          }
          if (callUsers.some((uid) => !rec.callStatus.has(uid))) throw new Error('Renewed call members were not registered before the next renewal wave');
        }
      }
      while (now() < deadline) {
        for (const call of this.calls) for (const c of call.sockets) {
          if (rec.fresh.get(c.userId) !== c) continue;
          call.announce(c);
          c.send({ service: 'call', action: 'status', lobbyName: call.lobby });
        }
        for (const uid of this.backgroundUsers) {
          const c = rec.fresh.get(uid);
          if (!c) continue;
          c.publishPresence();
          if (c.chatChannel && !rec.chatDelivered.has(uid)) c.sendChat(rec.id);
        }
        if (recoveryComplete(rec)) break;
        await sleep(1000);
      }
    } catch (err) { rec.error = err.message; }
    finally {
      sampler.plannedOutage = false;
      rec.durationSeconds = r1((now() - rec.started) / 1000);
      const summary = {
        kind, startedAt: rec.startedAt, durationSeconds: rec.durationSeconds, outageSeconds: rec.outageSeconds ?? 0,
        sockets: { expected: rec.expectedSockets, recovered: rec.fresh.size, ms: stats(rec.socketLatency) },
        callStatus: { expected: rec.expectedCallStatus, recovered: rec.callStatus.size },
        participantStates: { expected: rec.expectedParticipantStates, recovered: rec.participantStates.size },
        chat: { expected: rec.expectedChat, recovered: rec.chatDelivered.size },
        presence: { expected: rec.expectedPresence, republished: rec.presenceSet.size, expectedPeerDeliveries: rec.expectedChat, peerDeliveries: rec.presenceDelivered.size },
        complete: recoveryComplete(rec), error: rec.error,
      };
      this.recoveries.push(summary);
      this.recovery = null;
      console.log(`  ${kind}: sockets ${summary.sockets.recovered}/${summary.sockets.expected}, call status ${summary.callStatus.recovered}/${summary.callStatus.expected}, participant routes ${summary.participantStates.recovered}/${summary.participantStates.expected}, chat ${summary.chat.recovered}/${summary.chat.expected}, presence ${summary.presence.republished}/${summary.presence.expected}, ${summary.durationSeconds}s${rec.error ? `; ${rec.error}` : ''}`);
    }
  }

  async doChurn() {
    const g = this.groupSize;
    const inCall = this.calls.filter((c) => c.establishedAt && !c.failed);
    const target = Math.round(inCall.reduce((n, c) => n + c.sockets.length, 0) * 0.1);
    // Deterministic: one member per call, alternating caller and a callee.
    const victims = [];
    for (let k = 0; k < inCall.length && victims.length < target; k++) {
      const call = inCall[k];
      const m = k % 2 === 0 ? call.members[0] : call.members[1 + (k % (g - 1))];
      const s = call.socketOf(m);
      if (s) victims.push({ call, socket: s });
    }
    this.churn = { at: now(), killed: victims.length, of: inCall.reduce((n, c) => n + c.sockets.length, 0), userStatusLeft: [], activeCallReplies: [], reconnectOk: 0, callsTouched: new Set(victims.map((v) => v.call.k)).size };
    console.log(`  churn: dropping ${victims.length} in-call sockets (1 per call), reconnecting after 2 s`);
    this.phase = 'churn-drop';
    for (const v of victims) v.socket.drop();
    await sleep(2000);
    this.phase = 'churn-reconnect';
    await Promise.all(victims.map(async ({ call, socket }) => {
      const fresh = await this.open(socket.userId, 'call');
      if (!fresh.ok) return;
      this.counts.reconnects++;
      this.churn.reconnectOk++;
      fresh.reconnected = true;
      call.replace(socket, fresh);
      // useConversationCall's reconnect path: `status` (discovery) then announceSelf.
      fresh.send({ service: 'call', action: 'status', lobbyName: call.lobby });
      call.announce(fresh);
    }));
  }

  report(extra) {
    const o = this.o;
    const established = this.calls.filter((c) => c.establishedAt && !c.failed).length;
    const failedCalls = this.calls.filter((c) => c.failed).map((c) => ({ lobby: c.lobby, why: c.failed }));
    const dbl = this.scenario === 'double-accept' ? this.calls.slice(0, Math.min(10, o.calls)) : [];
    const doubleAccept = this.scenario === 'double-accept' ? {
      users: dbl.length,
      exactlyOneWinner: dbl.filter((c) => c.answeredElsewhere.length === 1 && c.duplicateAccepted === 0).length,
      answeredElsewhere: this.counts.answeredElsewhere,
      duplicateAcceptedAtCaller: dbl.reduce((n, c) => n + c.duplicateAccepted, 0),
    } : null;
    const glare = this.scenario === 'glare' ? {
      groups: this.calls.filter((c) => c.glare).length,
      bothSidesRang: this.calls.filter((c) => c.glare && c.glareBothRang()).length,
      resolvedToOneCall: this.calls.filter((c) => c.glare && c.establishedAt && !c.failed).length,
    } : null;
    const r = {
      scenario: this.scenario,
      identities: this.identityEvidence,
      groupSize: this.groupSize,
      calls: o.calls,
      sockets: o.sockets,
      holdSeconds: o.holdSeconds,
      soak: this.soak ?? null,
      recoveries: this.recoveries,
      unexpectedDisconnects: this.counts.unexpectedDisconnects,
      runTag: this.tag,
      durationS: extra.durationS,
      rampSeconds: extra.rampSeconds,
      connect: { ok: this.counts.connectOk, fail: this.counts.connectFail, failReasons: this.counts.connectFailReasons, ms: stats(this.lat.connect) },
      established,
      failedCalls: failedCalls.slice(0, 10),
      latencyMs: { inviteToIncoming: stats(this.lat.invite), acceptToAccepted: stats(this.lat.accept), chatDelivery: stats(this.lat.chat) },
      chat: { sent: this.chatSent.size, delivered: this.lat.chat.length, expectedSenders: this.initialClients.filter((c) => c.chatChannel).length, sendingUsers: this.chatSentUsers.size, deliveredUsers: this.chatDeliveredUsers.size },
      chatAdmission: this.chatAdmission ?? null,
      crossDeliveries: { call: this.counts.crossCall, chat: this.counts.crossChat, presence: this.counts.crossPresence, samples: this.samples.crossCall },
      unexpectedEnded: { count: this.counts.unexpectedEnded, callsEnded: this.calls.filter((c) => c.serverEnded).length, samples: this.samples.unexpectedEnded },
      answeredElsewhere: this.counts.answeredElsewhere,
      denied: { count: this.counts.denied, samples: this.samples.denied },
      otherErrors: { count: this.counts.otherErrors, byMessage: this.counts.errorMessages },
      notifications: { total: this.counts.notifications, missedCall: this.counts.missedCallNotifications },
      doubleAccept,
      glare,
      churn: this.churn ? {
        killed: this.churn.killed, of: this.churn.of, reconnected: this.churn.reconnectOk, callsTouched: this.churn.callsTouched,
        peersToldLeft: this.churn.userStatusLeft.length,
        rejoinGraceMs: this.churn.userStatusLeft[0]?.rejoinGraceMs ?? null,
        endedAfterChurnSeconds: stats(this.samples.unexpectedEnded.filter((e) => e.secondsAfterChurn != null).map((e) => e.secondsAfterChurn)),
        endedReasons: countBy(this.samples.unexpectedEnded.map((e) => e.reason)),
        activeCallReplies: {
          total: this.churn.activeCallReplies.length,
          activeTrue: this.churn.activeCallReplies.filter((a) => a.active).length,
          listingSelf: this.churn.activeCallReplies.filter((a) => a.includesSelf).length,
          sample: this.churn.activeCallReplies.slice(0, 2),
        },
      } : null,
      frames: { in: this.counts.framesIn, out: this.counts.framesOut, byKind: this.counts.byKind },
      server: extra.sampler,
      peerServers: extra.peerServers ?? [],
      targets: [o.url, ...(o.peerUrls ?? [])].map(url => ({ url, socketsOpened: this.clients.filter(client => client.targetUrl === url).length })),
      clientEventLoopMs: extra.clientLoop,
    };
    r.verdict = verdict(r);
    return r;
  }
}

export function recoveryComplete(rec) {
  return !rec.error && rec.fresh.size === rec.expectedSockets && rec.callStatus.size === rec.expectedCallStatus
    && rec.participantStates.size === rec.expectedParticipantStates && rec.chatDelivered.size === rec.expectedChat
    && rec.presenceSet.size === rec.expectedPresence && rec.presenceDelivered.size === rec.expectedChat;
}

function countBy(arr) { const o = {}; for (const x of arr) o[x ?? 'none'] = (o[x ?? 'none'] ?? 0) + 1; return o; }

// ── a socket ────────────────────────────────────────────────────────────────

export class Client {
  constructor(run, userId, role) {
    this.run = run; this.userId = userId; this.role = role;
    this.lobbies = new Set(); this.chatChannels = new Set(); this.presenceChannels = new Set();
    this.joinedChats = new Set();
    this.ok = false; this.dropped = false; this.reconnected = false;
    this.chatChannel = null;
  }
  async connect(timeoutMs = 10_000) {
    const run = this.run;
    const issuedAt = Math.floor(Date.now() / 1000);
    this.tokenIssuedAt = issuedAt * 1000;
    this.tokenExpiresAt = (issuedAt + run.o.tokenTtlSeconds) * 1000;
    const token = await mintToken(run.o.secret, this.userId, run.o.org, run.o.tokenTtlSeconds, issuedAt, run.identityByUser.get(this.userId));
    const t0 = now();
    return new Promise((resolveP) => {
      let settled = false;
      const done = (ok, why) => {
        if (settled) return;
        settled = true;
        this.ok = ok;
        if (ok) { run.counts.connectOk++; run.lat.connect.push(now() - t0); }
        else { run.counts.connectFail++; run.counts.connectFailReasons[why] = (run.counts.connectFailReasons[why] ?? 0) + 1; }
        resolveP(this);
      };
      const ws = new WebSocket(this.targetUrl ?? run.o.url, ['bearer-token-v1', token], {
        perMessageDeflate: false,
        handshakeTimeout: timeoutMs,
        ...(run.o.origin ? { origin: run.o.origin } : {}),
      });
      this.ws = ws;
      const timer = setTimeout(() => { done(false, 'session frame timeout'); try { ws.terminate(); } catch { /* */ } }, timeoutMs);
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'session' && msg.status === 'connected') { clearTimeout(timer); this.clientId = msg.clientId; done(true); return; }
        run.onFrame(this, msg);
      });
      ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); done(false, `HTTP ${res.statusCode}`); });
      ws.on('error', (err) => { clearTimeout(timer); done(false, err.code || err.message); });
      ws.on('close', () => {
        clearTimeout(timer);
        if (this.ok && !this.dropped && !this.plannedDisconnect && !run.closing) run.counts.unexpectedDisconnects++;
        done(false, 'closed before session');
        this.ok = false;
      });
    });
  }
  send(frame) {
    if (!this.ok || this.dropped || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    this.run.counts.framesOut++;
    return true;
  }
  joinChat(ch) {
    this.chatChannel = ch;
    this.chatChannels.add(ch);
    this.presenceChannels.add(ch);
    this.joinedChats.delete(ch);
    this.send({ service: 'chat', action: 'join', channel: ch });
    this.send({ service: 'presence', action: 'subscribe', channel: ch });
    this.publishPresence();
  }
  joinPresenceOnly(ch) {
    this.presenceChannels.add(ch);
    this.send({ service: 'presence', action: 'subscribe', channel: ch });
    this.publishPresence();
  }
  publishPresence() { this.send({ service: 'presence', action: 'set', status: 'online', metadata: {}, channels: [...this.presenceChannels] }); }
  sendChat(recoveryId = null) {
    if (!this.chatChannel || this.run.closing) return;
    const nonce = `lt|${this.userId}|${randomBytes(6).toString('hex')}`;
    if (this.send({ service: 'chat', action: 'send', channel: this.chatChannel, message: nonce })) {
      this.run.chatSent.set(nonce, { t: now(), channel: this.chatChannel, sender: this.userId, recoveryId });
      this.run.chatSentUsers.add(this.userId);
    }
  }
  /** A network drop: no close handshake, as a Wi-Fi blip looks to the server. */
  drop() { this.dropped = true; try { this.ws.terminate(); } catch { /* */ } }
  close() { try { this.ws.close(); } catch { /* */ } }
}

// ── a call (one lobby, its members) ─────────────────────────────────────────

class Call {
  constructor(run, k, members) {
    this.run = run; this.k = k; this.members = members;
    this.lobby = dmLobbyName(members, run.prefix);
    this.sockets = [];
    this.inviteSentAt = new Map();   // callId → t
    this.acceptSentAt = new Map();   // `${callId}|${uid}` → t
    this.inviteSeen = new Set();
    this.acceptSeen = new Set();
    this.accepted = new Set();       // uids accepted into the live call
    this.answeredElsewhere = [];
    this.duplicateAccepted = 0;
    this.callerByCallId = new Map();
    this.retiredCallIds = new Set(); // glare losers: ended by our own scripted cancel
    this.callId = null;              // the live call
    this.timers = [];
    this.hangupStarted = false;
  }
  attach(c) { if (c.ok) { c.lobbies.add(this.lobby); this.sockets.push(c); } }
  replace(old, fresh) {
    this.sockets = this.sockets.filter((s) => s !== old);
    fresh.lobbies.add(this.lobby);
    this.sockets.push(fresh);
  }
  socketsOf(uid) { return this.sockets.filter((s) => s.userId === uid && !s.dropped); }
  socketOf(uid) { return this.socketsOf(uid)[0] ?? null; }
  callerOf(callId) { return this.callerByCallId.get(callId); }
  others(uid) { return this.members.filter((m) => m !== uid); }

  /** useConversationCall.start(): invite every other member. */
  invite(callerUid) {
    const c = this.socketOf(callerUid);
    if (!c) { this.failed = `caller ${callerUid} not connected`; return null; }
    const callId = mintCallId();
    this.run.callById.set(callId, this);
    this.callerByCallId.set(callId, callerUid);
    this.inviteSentAt.set(callId, now());
    c.send({
      service: 'call',
      action: 'invite',
      callId,
      lobbyName: this.lobby,
      callerId: callerUid,
      callerName: `Load ${callerUid}`,
      targetUserIds: this.others(callerUid),
      channel: this.lobby,
    });
    return callId;
  }

  start() {
    this.callId = this.invite(this.members[0]);
    this.onInvite = (c, d) => {
      if (d.callId !== this.callId) return;
      this.acceptLater(c, d);
    };
    this.onAccepted = (uid, callId) => this.markAccepted(uid, callId);
  }

  /** The first two members ring each other within 10 ms; the lower id gives way. */
  startGlare() {
    this.glare = true;
    const [a, b] = this.members.slice(0, 2);
    const idA = this.invite(a);
    const jitter = Math.random() * 10;
    this.glareIds = { [a]: idA, [b]: null };
    this.glareRang = new Set();
    setTimeout(() => {
      this.glareIds[b] = this.invite(b);
      // The higher id keeps its call; the lower id answers it.
      const [lo, hi] = [a, b].sort();
      this.callId = this.glareIds[hi];
      this.loserCallId = this.glareIds[lo];
    }, jitter);
    this.onInvite = (c, d) => {
      if (!this.callId) { setTimeout(() => this.onInvite(c, d), 15); return; }
      const [lo, hi] = [a, b].sort();
      if (c.userId === lo && d.callId === this.loserCallId) return;
      if (c.userId === hi && d.callId === this.loserCallId) { this.glareRang.add(hi); return; } // rings, then gets cancelled
      if (c.userId === lo && d.callId === this.callId) {
        this.glareRang.add(lo);
        // useConversationCall.accept(): an active call is hung up first ('switched').
        const own = this.loserCallId;
        this.retiredCallIds.add(own);
        const others = this.others(lo);
        c.send({ service: 'call', action: 'cancelled', callId: own, callerId: lo, lobbyName: this.lobby, targetUserIds: others });
        c.send({ service: 'call', action: 'user-status', callId: own, callerId: lo, userId: lo, lobbyName: this.lobby, status: 'left', reason: 'hung-up', targetUserIds: others });
        c.send({ service: 'call', action: 'ended', callId: own, callerId: lo, lobbyName: this.lobby, targetUserIds: [lo] });
        this.acceptLater(c, d, 0);
        return;
      }
      if (d.callId === this.callId) this.acceptLater(c, d);
    };
    this.onAccepted = (uid, callId) => this.markAccepted(uid, callId);
  }
  glareBothRang() { return this.glareRang?.size === 2; }

  /** useConversationCall.accept(): `accepted` to the caller, then announceSelf once media is up. */
  acceptLater(c, d, delay = 100 + Math.random() * 400) {
    const t = setTimeout(() => {
      const twins = this.run.scenario === 'double-accept' ? this.socketsOf(c.userId) : [c];
      // Double accept: every tab of this user that rang accepts at once.
      if (twins.length > 1 && twins[0] !== c) return; // the first tab drives both
      for (const s of twins) {
        if (s !== c && !s.ok) continue;
        this.acceptSentAt.set(`${d.callId}|${s.userId}`, now());
        s.send({
          service: 'call',
          action: 'accepted',
          callId: d.callId,
          callerId: s.userId,
          userId: s.userId,
          displayName: `Load ${s.userId}`,
          targetUserIds: [d.callerId],
          lobbyName: d.lobbyName || this.lobby,
        });
      }
      this.accepted.add(c.userId);
      setTimeout(() => this.announce(c), 50);
    }, delay);
    this.timers.push(t);
  }

  markAccepted(uid) {
    this.accepted.add(uid);
    const caller = this.callerOf(this.callId);
    if (caller) this.accepted.add(caller);
    const callerSock = this.socketOf(caller);
    if (callerSock) this.announce(callerSock);
    if (!this.establishedAt && this.others(caller).every((m) => this.acceptSeen.has(`${this.callId}|${m}`))) {
      this.establishedAt = now();
      // participant-state every 20 s while the call holds.
      const iv = setInterval(() => { for (const s of this.sockets) if (!s.dropped) this.announce(s); }, this.run.o.stateEverySec * 1000);
      this.timers.push(iv);
    }
  }

  /** useConversationCall.announceSelf(). */
  announce(c) {
    if (!this.callId || this.hangupStarted || c.dropped) return;
    c.send({
      service: 'call',
      action: 'participant-state',
      callId: this.callId,
      lobbyName: this.lobby,
      callerId: c.userId,
      userId: c.userId,
      displayName: `Load ${c.userId}`,
      participantId: `pid-${c.userId}`,
      audioOn: true,
      cameraOn: true,
      screenSharing: false,
      status: 'in-call',
      targetUserIds: this.others(c.userId),
    });
  }

  /** useConversationCall.hangUp('left') from every member, caller first. */
  async hangUp() {
    if (!this.callId) return;
    this.hangupStarted = true;
    const order = [this.callerOf(this.callId), ...this.others(this.callerOf(this.callId))];
    for (const uid of order) {
      for (const s of this.socketsOf(uid)) {
        const peers = this.others(uid);
        s.send({ service: 'call', action: 'user-status', callId: this.callId, callerId: uid, userId: uid, lobbyName: this.lobby, status: 'left', reason: 'hung-up', targetUserIds: peers });
        s.send({ service: 'call', action: 'ended', callId: this.callId, callerId: uid, lobbyName: this.lobby, targetUserIds: [uid] });
      }
      await sleep(50);
    }
  }
  stop() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } }
}

// ── thresholds (the plan's pass/fail list) ──────────────────────────────────

export function verdict(r) {
  const v = [];
  const add = (name, ok, measured, limit) => v.push({ name, ok, measured, limit });
  const total = r.connect.ok + r.connect.fail;
  add('sockets connect', r.connect.fail === 0, `${r.connect.ok}/${total}`, '100%');
  add('calls established', r.established === r.calls, `${r.established}/${r.calls}`, 'all');
  const inv = r.latencyMs.inviteToIncoming;
  add('invite→incoming p95', inv.p95 != null && inv.p95 < 250, inv.p95, '< 250 ms');
  add('invite→incoming p99', inv.p99 != null && inv.p99 < 1000, inv.p99, '< 1000 ms');
  const acc = r.latencyMs.acceptToAccepted;
  add('accept→accepted p95', acc.p95 != null && acc.p95 < 250, acc.p95, '< 250 ms');
  const chat = r.latencyMs.chatDelivery;
  add('chat delivery p95', chat.n === 0 ? r.chat.expectedSenders === 0 : chat.p95 < 300, chat.p95, '< 300 ms, with paired-sender evidence');
  add('background chat coverage', r.chat.deliveredUsers === r.chat.expectedSenders, `${r.chat.deliveredUsers}/${r.chat.expectedSenders}`, 'all paired senders reach their peer');
  if (r.chatAdmission) add('background chat admission', r.chatAdmission.joined === r.chatAdmission.expected, `${r.chatAdmission.joined}/${r.chatAdmission.expected}; ${r.chatAdmission.waitMs}ms`, 'all server join acknowledgements within 10 seconds');
  const cross = r.crossDeliveries.call + r.crossDeliveries.chat + r.crossDeliveries.presence;
  add('cross-call/channel deliveries', cross === 0, cross, '0');
  if (r.scenario === 'double-accept') {
    add('double accept: exactly one winner', r.doubleAccept.exactlyOneWinner === r.doubleAccept.users, `${r.doubleAccept.exactlyOneWinner}/${r.doubleAccept.users}`, 'all');
  } else {
    add('answered-elsewhere outside scenario 4', r.answeredElsewhere === 0, r.answeredElsewhere, '0');
  }
  add('ended before scripted hang-up', r.unexpectedEnded.count === 0, r.unexpectedEnded.count, '0');
  add('unplanned socket disconnects', (r.unexpectedDisconnects ?? 0) === 0, r.unexpectedDisconnects ?? 0, '0');
  add('AUTHZ_CHANNEL_DENIED', r.denied.count === 0, r.denied.count, '0');
  const h = r.server.healthMs;
  add('event-loop proxy (/api/health p99)', h.p99 != null && h.p99 < 50, h.p99, '< 50 ms');
  add('health errors outside planned outage', h.errors === 0, h.errors, '0');
  if (r.server.pid || r.server.container) add('server memory peak', r.server.rssMb.peak != null && r.server.rssMb.peak < 700, r.server.rssMb.peak, '< 700 MiB');
  if (r.server.container) add('container samples', r.server.sampleErrors === 0 && r.server.rssMb.peak != null, r.server.sampleErrors, 'no errors, at least one sample');
  for (const [index, peer] of (r.peerServers ?? []).entries()) {
    add(`peer ${index + 1}: health p99`, peer.healthMs.p99 != null && peer.healthMs.p99 < 50, peer.healthMs.p99, '< 50 ms');
    add(`peer ${index + 1}: health errors`, peer.healthMs.errors === 0, peer.healthMs.errors, '0');
    if (peer.pid || peer.container) add(`peer ${index + 1}: memory peak`, peer.rssMb.peak != null && peer.rssMb.peak < 700, peer.rssMb.peak, '< 700 MiB');
    if (peer.container) add(`peer ${index + 1}: container samples`, peer.sampleErrors === 0 && peer.rssMb.peak != null, peer.sampleErrors, 'no errors, at least one sample');
  }
  if (r.soak) {
    add('bounded soak completed', r.soak.completed === true, r.soak.elapsedSeconds, `>= ${r.soak.requestedSeconds}s`);
    add('expired sockets at reauthentication', r.soak.expiredBeforeReconnect === 0, r.soak.expiredBeforeReconnect, '0');
    add('soak protocol errors', r.otherErrors.count === 0, r.otherErrors.count, '0');
    for (const [i, recovery] of (r.recoveries ?? []).entries()) add(`${recovery.kind} ${i + 1}: complete recovery`, recovery.complete === true, `${recovery.sockets.recovered}/${recovery.sockets.expected} sockets; ${recovery.callStatus.recovered}/${recovery.callStatus.expected} call statuses; ${recovery.durationSeconds}s`, '100% authenticated sockets, original call membership, peer state, chat and presence');
    if (r.scenario === 'restart') add('one planned gateway restart', r.recoveries.filter((x) => x.kind === 'gateway-restart').length === 1, r.recoveries.filter((x) => x.kind === 'gateway-restart').length, '1');
  }
  return v;
}

function printSummary(r) {
  const l = r.latencyMs;
  console.log(`  connect ${r.connect.ok}/${r.connect.ok + r.connect.fail} (p95 ${fmt(r.connect.ms.p95)} ms) · established ${r.established}/${r.calls} · ${r.durationS}s`);
  console.log(`  invite→incoming  p50 ${fmt(l.inviteToIncoming.p50)}  p95 ${fmt(l.inviteToIncoming.p95)}  p99 ${fmt(l.inviteToIncoming.p99)}  max ${fmt(l.inviteToIncoming.max)} ms (n=${l.inviteToIncoming.n})`);
  console.log(`  accept→accepted  p50 ${fmt(l.acceptToAccepted.p50)}  p95 ${fmt(l.acceptToAccepted.p95)}  p99 ${fmt(l.acceptToAccepted.p99)}  max ${fmt(l.acceptToAccepted.max)} ms (n=${l.acceptToAccepted.n})`);
  console.log(`  chat delivery    p50 ${fmt(l.chatDelivery.p50)}  p95 ${fmt(l.chatDelivery.p95)}  p99 ${fmt(l.chatDelivery.p99)}  max ${fmt(l.chatDelivery.max)} ms (n=${l.chatDelivery.n} of ${r.chat.sent} sent)`);
  console.log(`  cross: call ${r.crossDeliveries.call} chat ${r.crossDeliveries.chat} presence ${r.crossDeliveries.presence} · unexpected ended ${r.unexpectedEnded.count} · answered-elsewhere ${r.answeredElsewhere} · denied ${r.denied.count} · other errors ${r.otherErrors.count}`);
  if (r.otherErrors.count) console.log(`    errors: ${JSON.stringify(r.otherErrors.byMessage)}`);
  if (r.glare) console.log(`  glare: ${r.glare.bothSidesRang}/${r.glare.groups} both sides rang; ${r.glare.resolvedToOneCall} resolved to one call; missed-call notices ${r.notifications.missedCall}`);
  if (r.doubleAccept) console.log(`  double accept: ${r.doubleAccept.exactlyOneWinner}/${r.doubleAccept.users} exactly one winner; duplicate accepted at caller ${r.doubleAccept.duplicateAcceptedAtCaller}`);
  if (r.churn) {
    const c = r.churn;
    console.log(`  churn: ${c.killed}/${c.of} dropped, ${c.reconnected} back; peers told 'left' ${c.peersToldLeft} (rejoinGraceMs ${fmt(c.rejoinGraceMs)}); calls ended by server ${r.unexpectedEnded.callsEnded} at ${fmt(c.endedAfterChurnSeconds.p50)} s after the drop (${JSON.stringify(c.endedReasons)}); status replies listing the reconnected user ${c.activeCallReplies.listingSelf}/${c.activeCallReplies.total}`);
  }
  if (r.soak) console.log(`  soak ${r.soak.elapsedSeconds}/${r.soak.requestedSeconds}s · token TTL ${r.soak.tokenTtlSeconds}s · ${r.recoveries.length} authenticated recovery cycles · expired sockets ${r.soak.expiredBeforeReconnect}`);
  const s = r.server;
  if (s.slowHealth?.length) console.log(`  slow /api/health samples (>=50 ms): ${s.slowHealth.map((x) => `${x.ms}ms@${x.atS}s/${x.phase}`).join(', ')}`);
  console.log(`  server ${s.container ?? s.pid ?? '—'}: ${s.memorySource} peak ${fmt(s.rssMb.peak)} MiB · CPU peak ${fmt(s.cpuPct.peak)}% mean ${fmt(s.cpuPct.mean)}% · /api/health p50 ${fmt(s.healthMs.p50)} p99 ${fmt(s.healthMs.p99)} max ${fmt(s.healthMs.max)} ms (${s.healthMs.errors} errors; ${s.healthMs.plannedOutageErrors} planned-outage errors) · client loop p99 ${fmt(r.clientEventLoopMs.p99)} ms`);
  for (const x of r.verdict) console.log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.name}: ${fmt(x.measured)} (${x.limit})`);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const o = parseArgs(process.argv);
  if (!o.serverPid && !o.sampleContainer) o.serverPid = discoverServerPid(o.url);
  const scenarios = o.scenario === 'all' ? STANDARD_SCENARIOS : [o.scenario];
  console.log(`target ${o.url} · health ${o.healthUrl} · server pid ${o.serverPid ?? 'unknown (pass --server-pid)'} · hold ${o.holdSeconds}s`);
  const results = [];
  for (const g of o.groupSizes) {
    for (const sc of scenarios) {
      const run = new Run(o, sc, g);
      let r;
      try { r = await run.execute(); } finally { run.cleanup(); }
      printSummary(r);
      results.push(r);
      if (o.json) writeFileSync(o.json, JSON.stringify({ at: iso(), options: { ...o, secret: o.secret === 'orgiq-dev-realtime' ? 'dev-fallback' : 'custom' }, results }, null, 2));
      await sleep(3000);
    }
  }
  const failed = results.filter((r) => r.verdict.some((x) => !x.ok));
  console.log(`\n${results.length - failed.length}/${results.length} runs passed every threshold`);
  for (const r of results) {
    const f = r.verdict.filter((x) => !x.ok).map((x) => x.name);
    console.log(`  ${f.length ? 'FAIL' : 'PASS'}  ${r.scenario} × ${r.groupSize}${f.length ? ` — ${f.join('; ')}` : ''}`);
  }
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((err) => { console.error(err); process.exit(2); });
