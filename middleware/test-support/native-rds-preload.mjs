// Full-process acceptance only: replace the RDS SDK transport while executing
// the provider's actual SQL against the dedicated local PostgreSQL database.
// No installed SDK files are changed. This is not Aurora/IAM acceptance.
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { writeFileSync, existsSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import http from 'node:http';

const locator = process.env.ORGIQ_NATIVE_RDS_URL;
if (!locator) throw new Error('Native RDS acceptance requires ORGIQ_NATIVE_RDS_URL');
const url = new URL(locator);
const containerFixture = process.env.ORGIQ_NATIVE_RDS_CONTAINER_FIXTURE === '1'
  && url.hostname === 'host.docker.internal' && url.port === '15483' && url.pathname === '/orgiq' && url.username === 'orgiq';
if (process.env.NODE_ENV === 'production' || !['postgres:', 'postgresql:'].includes(url.protocol)
  || (!containerFixture && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname))) {
  throw new Error('Native RDS acceptance requires non-production loopback PostgreSQL or the explicit Docker host fixture');
}
const pool = new Pool({ connectionString: locator, max: 4, connectionTimeoutMillis: 2000, statement_timeout: 5000 });
// An idle fixture socket can disappear when the host's port bridge resets.
// pg removes that client; later lookups reconnect and never fall back to seeds.
pool.on('error', error => console.warn('[native-rds-acceptance] idle connection lost', error.name));
const transactions = new Map();
// Optional local diagnostics record counts and timings only, never SQL,
// subjects, parameters, credentials, messages or provider response contents.
const metricsPath = process.env.ORGIQ_NATIVE_STORE_METRICS_FILE;
if (metricsPath && !/^\/tmp\/orgiq-bff-cluster-[ab]-native-metrics\.json$/.test(metricsPath)) throw new Error('Use the dedicated native metrics path');
const metrics = { startedAt: new Date().toISOString(), pid: process.pid, poolMax: 4, poolWaitingPeak: 0,
  dynamoHttp: { socketLimit: null, activePeak: 0, queuedPeak: 0 }, operations: {}, dynamoTables: {} };
const fixtureTables = new Map(['chat-members', 'chat-messages', 'chat-conversations', 'chat-reads', 'chat-pins']
  .map(name => ['orgiq-bff-cluster-' + name, name]));
const loop = metricsPath ? monitorEventLoopDelay({ resolution: 10 }) : null;
loop?.enable();
const cpuStarted = process.cpuUsage(), clockStarted = performance.now();
function beginMetric(kind, collection = metrics.operations) {
  if (!metricsPath) return () => {};
  const row = collection[kind] ??= { count: 0, errors: 0, inFlight: 0, inFlightPeak: 0, totalMs: 0, maxMs: 0, buckets: {} };
  row.inFlight++; row.inFlightPeak = Math.max(row.inFlightPeak, row.inFlight);
  const started = performance.now();
  return failed => {
    const duration = performance.now() - started;
    row.inFlight--; row.count++; row.errors += failed ? 1 : 0;
    row.totalMs += duration; row.maxMs = Math.max(row.maxMs, duration);
    const bucket = Math.max(1, 2 ** Math.ceil(Math.log2(duration)));
    row.buckets[bucket] = (row.buckets[bucket] ?? 0) + 1;
  };
}
// Per-stage send-path timings (diagnostics only, with the metrics file): the
// innermost library stage a Dynamo call or HTTP socket wait happens in is its
// label. Fixed stage names only; no channel, subject or message is recorded.
const stageOf = new AsyncLocalStorage();
metrics.stages = {}; metrics.stageDynamo = {}; metrics.dynamoHttpByStage = {};
function timedStage(label, fn) {
  const finish = beginMetric(label, metrics.stages);
  let result;
  try { result = stageOf.run({ stage: label }, fn); } catch (error) { finish(true); throw error; }
  if (result && typeof result.then === 'function') return result.then(value => { finish(false); return value; }, error => { finish(true); throw error; });
  finish(false); return result;
}
function wrapMethod(proto, name, label) {
  const original = proto?.[name];
  if (typeof original !== 'function') { console.warn('[native-stage-metrics] missing', name); return; }
  proto[name] = function(...args) { return timedStage(typeof label === 'function' ? label(args) : label, () => original.apply(this, args)); };
}
function instrumentSendStages() {
  const require = createRequire(import.meta.url);
  const root = join(dirname(require.resolve('@connorhoehn/realtime-modules/server')), '..');
  const { ChatService } = require(join(root, 'chat/ChatService.js'));
  const access = require(join(root, 'server-ws/channelAccess.js'));
  const { LocalRealtimeRouter } = require(join(root, 'server/router.js'));
  const { RedisRealtimeRouter } = require(join(root, 'server/RedisRealtimeRouter.js'));
  wrapMethod(ChatService.prototype, 'handleSendMessage', 'chat.send.total');
  wrapMethod(ChatService.prototype, 'handleJoinChannel', 'chat.join.total');
  wrapMethod(ChatService.prototype, '_checkMembership', 'chat.send.membership');
  wrapMethod(ChatService.prototype, '_persistMessage', 'chat.send.persist');
  wrapMethod(ChatService.prototype, 'broadcastMessage', 'chat.send.broadcast');
  const permits = access.routerPermits;
  access.routerPermits = (...args) => timedStage('chat.send.routerPermits.' + (args[1] === 'publish' ? 'publish' : 'other'), () => permits(...args));
  wrapMethod(LocalRealtimeRouter.prototype, 'allows', args => 'router.authorize.' + (['publish', 'subscribe'].includes(args[0]) ? args[0] : 'other'));
  wrapMethod(LocalRealtimeRouter.prototype, 'fanOut', 'router.localFanOut');
  wrapMethod(LocalRealtimeRouter.prototype, 'sendFiltered', 'router.deliverFiltered');
  wrapMethod(RedisRealtimeRouter.prototype, 'checkChannel', args => 'redisRouter.checkChannel.' + (args[0] === 'publish' ? 'publish' : 'other'));
  wrapMethod(RedisRealtimeRouter.prototype, 'publish', 'redisRouter.peerPublish');
  wrapMethod(RedisRealtimeRouter.prototype, 'receive', 'redisRouter.peerReceive');
  // Plugins are fire-and-forget from the router; wrap each instance's hooks once.
  const scoped = LocalRealtimeRouter.prototype.sendToChannelScoped;
  const wrapped = new WeakSet();
  LocalRealtimeRouter.prototype.sendToChannelScoped = function(...args) {
    if (Array.isArray(this.plugins) && !wrapped.has(this.plugins)) {
      this.plugins = this.plugins.map((plugin, index) => plugin.onMessage ? { ...plugin, onMessage: input => timedStage('plugin.' + (/^[a-z0-9-]{1,40}$/i.test(plugin.name ?? '') ? plugin.name : 'index' + index), () => plugin.onMessage(input)) } : plugin);
      wrapped.add(this.plugins);
    }
    return scoped.apply(this, args);
  };
  // Pool wait (request → socket) versus DynamoDB Local service (socket → response headers).
  const request = http.request;
  http.request = function(...args) {
    const options = typeof args[0] === 'object' && !(args[0] instanceof URL) ? args[0] : null;
    const req = request.apply(this, args);
    if (options && String(options.port) === (process.env.ORGIQ_NATIVE_DYNAMO_PORT ?? '18063')) {
      const stage = stageOf.getStore()?.stage ?? 'none', started = performance.now();
      const row = metrics.dynamoHttpByStage[stage] ??= { count: 0, waitMs: 0, waitMaxMs: 0, serviceMs: 0, serviceMaxMs: 0 };
      let assigned = null;
      req.once('socket', () => { assigned = performance.now(); const wait = assigned - started; row.waitMs += wait; row.waitMaxMs = Math.max(row.waitMaxMs, wait); });
      req.once('response', () => { if (assigned === null) return; const service = performance.now() - assigned; row.count++; row.serviceMs += service; row.serviceMaxMs = Math.max(row.serviceMaxMs, service); });
    }
    return req;
  };
}
// Frame-pipeline diagnostics (ORGIQ_NATIVE_METRICS_MODE=frames, with the
// metrics file): socket 'message' receipt -> per-connection queue -> service
// handler -> chat send gates -> persist/broadcast -> recipient socket write,
// plus every outgoing error frame classified by fixed labels. Timings and
// counts only: channel names, subjects, message ids and bodies stay in memory
// for correlation and are never written. SIGUSR2 resets every histogram so a
// run excludes fixture preparation.
const metricsMode = process.env.ORGIQ_NATIVE_METRICS_MODE === 'frames' ? 'frames' : 'full';
const hists = {}; const counters = {};
function hist(key, ms) {
  const row = hists[key] ??= { count: 0, totalMs: 0, maxMs: 0, buckets: {} };
  const v = Math.max(0, ms); row.count++; row.totalMs += v; row.maxMs = Math.max(row.maxMs, v);
  const b = Math.floor(8 * Math.log2(1 + v)); row.buckets[b] = (row.buckets[b] ?? 0) + 1;
}
function count(key, n = 1) { counters[key] = (counters[key] ?? 0) + n; }
function family(channel) {
  if (typeof channel !== 'string') return 'none';
  let base = channel.replace(/^(presence|reactions|cursor|chat|typing|activity|pins):/, '');
  const parts = base.split(':');
  const f = parts.slice(0, 2).join(':');
  return /^[a-z0-9-]{1,24}(:[a-z0-9-]{1,24})?$/.test(f) ? f : 'other';
}
const frameOf = new AsyncLocalStorage();
function instrumentFrames() {
  const require = createRequire(import.meta.url);
  const root = join(dirname(require.resolve('@connorhoehn/realtime-modules/server')), '..');
  const WebSocket = require(require.resolve('ws', { paths: [root] }));
  const states = new WeakMap(); const byClient = new Map();
  const stateOf = ws => { let st = states.get(ws); if (!st) { st = { fifo: [], log: [], joined: new Set(), clientId: null, connectedAt: performance.now(), current: null }; states.set(ws, st); } return st; };
  const emit = WebSocket.prototype.emit;
  WebSocket.prototype.emit = function(event, ...args) {
    if (event === 'message') {
      let key = 'invalid';
      try { const m = JSON.parse(String(args[0])); key = (typeof m.service === 'string' ? m.service : '?') + '.' + (typeof m.action === 'string' ? m.action : '?'); } catch {}
      const st = stateOf(this); st.fifo.push({ t: performance.now(), key });
      if (st.fifo.length > 512) st.fifo.splice(0, st.fifo.length - 512);
      count('recv.' + (/^[a-z-]{1,20}\.[a-z-]{1,30}$/i.test(key) ? key : 'other'));
    } else if (event === 'close') {
      const st = states.get(this); if (st?.clientId) byClient.delete(st.clientId);
    }
    return emit.call(this, event, ...args);
  };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data, ...rest) {
    if (typeof data === 'string') {
      const st = stateOf(this);
      hist('socket.bufferedBytesAtSend', this.bufferedAmount / 1024);
      if (data.startsWith('{"type":"session"')) {
        try { const m = JSON.parse(data); if (typeof m.clientId === 'string') { st.clientId = m.clientId; st.connectedAt = performance.now(); byClient.set(m.clientId, st); } } catch {}
      } else if (data.startsWith('{"type":"chat"')) {
        try {
          const m = JSON.parse(data);
          if (m.action === 'joined' && typeof m.channel === 'string') st.joined.add(m.channel);
          if (m.action === 'message' && m.message?.timestamp) {
            const local = byClient.has(m.message.clientId);
            hist('deliver.createdToRecipientWrite.' + (local ? 'local' : 'peer'), Date.now() - Date.parse(m.message.timestamp));
          }
        } catch {}
      } else if (data.startsWith('{"type":"error"')) {
        try {
          const m = JSON.parse(data), ctx = frameOf.getStore();
          const channel = m.channel ?? m.error?.channel;
          const msg = String(m.message ?? m.error?.message ?? '').replace(/(subscribe to|publish to) .*/, '$1 <channel>').slice(0, 80);
          const origin = !ctx ? 'async' : ctx.clientId === st.clientId ? 'own:' + ctx.key : 'other:' + ctx.key;
          const age = performance.now() - st.connectedAt;
          const label = [m.code ?? m.error?.code ?? 'none', m.service ?? m.error?.service ?? '-', m.kind ?? '-', family(channel), msg,
            'during=' + origin, 'joined=' + (typeof channel === 'string' ? st.joined.has(channel) || st.joined.has(channel.replace(/^presence:/, '')) : 'n/a'),
            'socketAge=' + (age < 1000 ? '<1s' : age < 5000 ? '1-5s' : age < 30000 ? '5-30s' : '>30s')].join('|');
          count('errorFrame.' + label);
          if (ctx) hist('errorFrame.afterHandlerStart.' + (m.code ?? 'none'), performance.now() - ctx.t0);
        } catch {}
      }
    }
    return send.call(this, data, ...rest);
  };
  const handlerModule = require(join(root, 'server-ws/createWsHandler.js'));
  const create = handlerModule.createWsHandler;
  handlerModule.createWsHandler = function(opts) {
    for (const [name, svc] of Object.entries(opts.services ?? {})) {
      if (!svc || typeof svc.handleAction !== 'function') continue;
      const original = svc.handleAction;
      svc.handleAction = function(clientId, action, data) {
        const key = name + '.' + action, t0 = performance.now(), st = byClient.get(clientId);
        if (st) {
          const at = st.fifo.findIndex(entry => entry.key === key);
          if (at < 0) count('frames.unmatched');
          else {
            const head = st.fifo[at]; if (at > 0) count('frames.skipped', at); st.fifo.splice(0, at + 1);
            const wait = t0 - head.t; hist('queue.' + key, wait);
            if (key === 'chat.send') {
              hist('send.queueWait', wait);
              for (const done of st.log) {
                const overlap = Math.min(done.end ?? t0, t0) - Math.max(done.start, head.t);
                if (overlap > 0) hist('send.blockedBy.' + done.key, overlap);
              }
            }
          }
          st.current = { key, start: t0, end: null };
          st.log.push(st.current); if (st.log.length > 16) st.log.shift();
        }
        const finish = () => { const end = performance.now(); hist('handler.' + key, end - t0); if (st?.current?.start === t0) st.current.end = end; };
        return frameOf.run({ key, t0, clientId }, () => {
          let result;
          try { result = original.call(this, clientId, action, data); } catch (error) { finish(); throw error; }
          return Promise.resolve(result).finally(finish);
        });
      };
    }
    return create.call(this, opts);
  };
  const { ChatService } = require(join(root, 'chat/ChatService.js'));
  const access = require(join(root, 'server-ws/channelAccess.js'));
  const { LocalRealtimeRouter } = require(join(root, 'server/router.js'));
  const { RedisRealtimeRouter } = require(join(root, 'server/RedisRealtimeRouter.js'));
  const timeIn = (proto, method, label) => {
    const original = proto[method];
    proto[method] = function(...args) {
      const ctx = frameOf.getStore(), t = performance.now();
      const result = original.apply(this, args);
      const name = typeof label === 'function' ? label(args, ctx) : label;
      if (!name) return result;
      if (result && typeof result.then === 'function') return result.then(v => { hist(name, performance.now() - t); return v; }, e => { hist(name + '.threw', performance.now() - t); throw e; });
      hist(name, performance.now() - t); return result;
    };
  };
  const inSend = ctx => ctx?.key === 'chat.send';
  const PresenceService = require(join(root, 'presence/PresenceService.js'));
  const inSet = ctx => ctx?.key === 'presence.set';
  timeIn(PresenceService.prototype, 'permittedSetChannels', (_a, ctx) => inSet(ctx) ? 'presenceSet.permitted' : null);
  timeIn(PresenceService.prototype, 'broadcastPresenceUpdate', (_a, ctx) => inSet(ctx) ? 'presenceSet.broadcast' : null);
  const setPresence = PresenceService.prototype.handleSetPresence;
  PresenceService.prototype.handleSetPresence = function(...args) {
    if (this.store && !this.store.__timed) {
      const put = this.store.put.bind(this.store);
      this.store.put = (...a) => { const ctx = frameOf.getStore(), t = performance.now(); return put(...a).then(v => { if (inSet(ctx)) hist('presenceSet.storePut', performance.now() - t); return v; }); };
      this.store.__timed = true;
    }
    return setPresence.apply(this, args);
  };
  timeIn(PresenceService.prototype, 'updateChannelPresence', (_a, ctx) => inSet(ctx) ? 'presenceSet.updateChannels' : null);
  timeIn(ChatService.prototype, '_checkMembership', (_a, ctx) => inSend(ctx) ? 'send.gate.membership' : null);
  timeIn(ChatService.prototype, '_persistMessage', (_a, ctx) => inSend(ctx) ? 'send.persist' : null);
  timeIn(ChatService.prototype, 'broadcastMessage', (_a, ctx) => inSend(ctx) ? 'send.broadcast' : null);
  const generate = ChatService.prototype.generateMessageId;
  ChatService.prototype.generateMessageId = function(...args) { const ctx = frameOf.getStore(); if (inSend(ctx)) hist('send.handlerStartToCreated', performance.now() - ctx.t0); return generate.apply(this, args); };
  const permits = access.routerPermits;
  access.routerPermits = (...args) => {
    const ctx = frameOf.getStore(), t = performance.now();
    return permits(...args).then(v => { if (inSend(ctx)) hist('send.gate.routerPermits.' + args[1], performance.now() - t); return v; });
  };
  const allows = LocalRealtimeRouter.prototype.allows;
  LocalRealtimeRouter.prototype.allows = function(kind, clientId, channel, scope) {
    const t = performance.now(), decision = allows.call(this, kind, clientId, channel, scope);
    const record = allowed => { hist('authorize.' + kind + '.' + family(channel) + '.' + (allowed ? 'allow' : 'deny'), performance.now() - t); return allowed; };
    return typeof decision === 'boolean' ? record(decision) : decision.then(record);
  };
  timeIn(RedisRealtimeRouter.prototype, 'receive', 'peer.receive');
  timeIn(RedisRealtimeRouter.prototype, 'publish', 'peer.publish');
  timeIn(RedisRealtimeRouter.prototype, 'checkChannel', (args, ctx) => inSend(ctx) && args[0] === 'publish' ? 'send.broadcast.redisCheckPublish' : null);
  timeIn(LocalRealtimeRouter.prototype, 'sendToChannel', (_a, ctx) => inSend(ctx) ? 'send.broadcast.localFanOut' : null);
  // Chat message transit by wall clock (one kernel clock for every container):
  // created -> peer publish (sender node) and created -> peer receive entry.
  const chatCreated = frame => frame?.type === 'chat' && frame.action === 'message' && typeof frame.message?.timestamp === 'string' ? Date.parse(frame.message.timestamp) : null;
  const publishPeer = RedisRealtimeRouter.prototype.publish;
  RedisRealtimeRouter.prototype.publish = function(topic, frame) {
    if (frame?.kind === 'channel') { const created = chatCreated(frame.message); if (created) hist('send.createdToPeerPublish', Date.now() - created); }
    return publishPeer.call(this, topic, frame);
  };
  const receivePeer = RedisRealtimeRouter.prototype.receive;
  RedisRealtimeRouter.prototype.receive = function(payload) {
    if (typeof payload === 'string' && payload.includes('"kind":"channel"') && payload.includes('"action":"message"')) {
      try { const created = chatCreated(JSON.parse(payload).message); if (created) hist('peer.createdToReceive', Date.now() - created); } catch {}
    }
    return receivePeer.call(this, payload);
  };
  // Host membership fences (compiled image only): committed writes, peer
  // hints and authority proofs that observed a change, by channel family.
  const hostChat = '/app/dist/lib/social-chat.js';
  if (existsSync(hostChat)) {
    import(hostChat).then(({ MirroredMembershipStore }) => {
      const proto = MirroredMembershipStore?.prototype; if (!proto) return;
      const put = proto.putMember; proto.putMember = function(member) { count('membership.putMember.' + family(member?.channel)); return put.call(this, member); };
      const inv = proto.invalidate; proto.invalidate = function(channel) { count('membership.peerInvalidate.' + family(channel)); return inv.call(this, channel); };
      const observe = proto.observeChanges; proto.observeChanges = function(channel) {
        const o = observe.call(this, channel); let seen = false;
        return { ...o, changed: () => { const v = o.changed(); if (v && !seen) { seen = true; count('membership.fenceObserved.' + family(channel)); } return v; } };
      };
    }, error => console.warn('[native-frame-metrics] host membership hooks unavailable', error.name));
  }
}
// Origin attribution (ORGIQ_NATIVE_ORIGIN_METRICS=1, full mode only): which
// socket action or peer frame kind a Dynamo request started under, and the
// channel FAMILY (two fixed segments, e.g. social:dm) it names. Counts only.
const originMetrics = metricsPath && process.env.ORGIQ_NATIVE_ORIGIN_METRICS === '1';
const originOf = new AsyncLocalStorage();
metrics.originDynamo = {}; metrics.actions = {};
function dynamoFamily(input) {
  const values = Object.values(input?.ExpressionAttributeValues ?? {}).concat(Object.values(input?.Key ?? {}), Object.values(input?.Item ?? {}));
  for (const v of values) if (typeof v?.S === 'string' && v.S.includes(':')) return family(v.S);
  return 'none';
}
function instrumentOrigins() {
  const require = createRequire(import.meta.url);
  const root = join(dirname(require.resolve('@connorhoehn/realtime-modules/server')), '..');
  const handlerModule = require(join(root, 'server-ws/createWsHandler.js'));
  const create = handlerModule.createWsHandler;
  handlerModule.createWsHandler = function(opts) {
    for (const [name, svc] of Object.entries(opts.services ?? {})) {
      if (!svc || typeof svc.handleAction !== 'function') continue;
      const original = svc.handleAction;
      svc.handleAction = function(clientId, action, data) {
        const key = (name + '.' + action).replace(/[^a-z.-]/gi, '').slice(0, 40);
        metrics.actions[key] = (metrics.actions[key] ?? 0) + 1;
        return originOf.run({ o: 'ws:' + key }, () => original.call(this, clientId, action, data));
      };
    }
    return create.call(this, opts);
  };
  const { RedisRealtimeRouter } = require(join(root, 'server/RedisRealtimeRouter.js'));
  const receive = RedisRealtimeRouter.prototype.receive;
  RedisRealtimeRouter.prototype.receive = function(payload) {
    const kind = typeof payload === 'string' ? (/"kind":"([a-z-]{1,24})"/.exec(payload)?.[1] ?? 'other') : 'other';
    const action = kind === 'channel' ? (/"action":"([a-z-]{1,24})"/.exec(payload)?.[1] ?? '-') : '-';
    const key = 'peer:' + kind + '.' + action;
    metrics.actions[key] = (metrics.actions[key] ?? 0) + 1;
    return originOf.run({ o: key }, () => receive.call(this, payload));
  };
}
if (metricsPath) {
  const originalSend = DynamoDBClient.prototype.send;
  if (metricsMode === 'full') DynamoDBClient.prototype.send = async function(command, ...args) {
    if (command.input?.TableName?.startsWith('orgiq-bff-cluster-')) {
      const config = this.config.requestHandler.httpHandlerConfigs?.();
      const agent = config?.httpAgent;
      if (agent) {
        metrics.dynamoHttp.socketLimit = agent.maxSockets;
        metrics.dynamoHttp.activePeak = Math.max(metrics.dynamoHttp.activePeak, Object.values(agent.sockets).reduce((sum, sockets) => sum + sockets.length, 0));
        metrics.dynamoHttp.queuedPeak = Math.max(metrics.dynamoHttp.queuedPeak, Object.values(agent.requests).reduce((sum, requests) => sum + requests.length, 0));
      }
    }
    const finish = beginMetric('dynamo:' + command.constructor.name);
    // Labels are a fixed allowlist of synthetic fixture tables. No table
    // locator, item key, identity or provider response is recorded.
    const table = fixtureTables.get(command.input?.TableName);
    const finishTable = table ? beginMetric(table + ':' + command.constructor.name, metrics.dynamoTables) : () => {};
    const finishStage = table ? beginMetric((stageOf.getStore()?.stage ?? 'none') + '>' + table + ':' + command.constructor.name, metrics.stageDynamo) : () => {};
    const finishOrigin = table && originMetrics ? beginMetric((originOf.getStore()?.o ?? 'none') + '|' + (stageOf.getStore()?.stage ?? 'none') + '|' + dynamoFamily(command.input) + '>' + table + ':' + command.constructor.name, metrics.originDynamo) : () => {};
    try { const result = await originalSend.call(this, command, ...args); finish(false); finishTable(false); finishStage(false); finishOrigin(false); return result; }
    catch (error) { finish(true); finishTable(true); finishStage(true); finishOrigin(true); throw error; }
  };
  if (metricsMode === 'frames') {
    instrumentFrames();
    DynamoDBClient.prototype.send = async function(command, ...args) {
      try { return await originalSend.call(this, command, ...args); }
      catch (error) { count('dynamoError.' + String(error?.name ?? 'unknown').slice(0, 40) + '.' + command.constructor.name); throw error; }
    };
  } else { instrumentSendStages(); if (originMetrics) instrumentOrigins(); }
  process.on('SIGUSR2', () => { for (const k of Object.keys(hists)) delete hists[k]; for (const k of Object.keys(counters)) delete counters[k]; loop?.reset(); if (originMetrics) { metrics.originDynamo = {}; metrics.actions = {}; } metrics.resetAt = new Date().toISOString(); });
  const flush = () => writeFileSync(metricsPath, JSON.stringify({ ...metrics, mode: metricsMode, hists, counters,
    memory: process.memoryUsage(), heapLimit: getHeapStatistics().heap_size_limit,
    cpu: { ...process.cpuUsage(cpuStarted), elapsedMs: performance.now() - clockStarted },
    eventLoopMs: loop ? { p50: loop.percentile(50) / 1e6, p95: loop.percentile(95) / 1e6,
      p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 } : null,
    recordedAt: new Date().toISOString() }));
  const timer = setInterval(flush, 5000); timer.unref(); process.once('exit', flush);
}
function value(field) {
  if (!field || field.isNull) return null;
  for (const key of ['stringValue', 'longValue', 'doubleValue', 'booleanValue', 'blobValue']) {
    if (field[key] !== undefined) return field[key];
  }
  if (field.arrayValue) {
    for (const key of ['stringValues', 'longValues', 'doubleValues', 'booleanValues']) {
      if (field.arrayValue[key] !== undefined) return field.arrayValue[key];
    }
  }
  throw new Error('Unsupported native RDS parameter type');
}
function bind(sql, parameters = []) {
  const params = new Map(parameters.map(parameter => [parameter.name, value(parameter.value)]));
  const positions = new Map(), values = [];
  let result = '', i = 0, quote = null;
  while (i < sql.length) {
    const char = sql[i], next = sql[i + 1];
    if (quote) {
      result += char; i++;
      if (char === quote) {
        if (sql[i] === quote) { result += sql[i++]; } else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; result += char; i++; continue; }
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', i); const stop = end < 0 ? sql.length : end;
      result += sql.slice(i, stop); i = stop; continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2); if (end < 0) throw new Error('Unclosed SQL comment');
      result += sql.slice(i, end + 2); i = end + 2; continue;
    }
    if (char === ':' && next !== ':' && sql[i - 1] !== ':') {
      const name = /^([a-zA-Z_][a-zA-Z0-9_]*)/.exec(sql.slice(i + 1))?.[1];
      if (name) {
        if (!params.has(name)) throw new Error(`Unbound native RDS parameter ${name}`);
        if (!positions.has(name)) { values.push(params.get(name)); positions.set(name, values.length); }
        result += `$${positions.get(name)}`; i += name.length + 1; continue;
      }
    }
    result += char; i++;
  }
  return { text: result, values };
}
function cell(data, oid) {
  if (data === null || data === undefined) return { isNull: true };
  if (typeof data === 'boolean') return { booleanValue: data };
  if (typeof data === 'number') return Number.isSafeInteger(data) ? { longValue: data } : { doubleValue: data };
  if (data instanceof Date) return { stringValue: data.toISOString() };
  if (Buffer.isBuffer(data)) return { blobValue: data };
  if (typeof data === 'object') return { stringValue: JSON.stringify(data) };
  if ([20, 21, 23, 700, 701, 1700].includes(oid)) {
    const number = Number(data);
    if (Number.isFinite(number) && (oid !== 20 || Number.isSafeInteger(number))) {
      return Number.isSafeInteger(number) ? { longValue: number } : { doubleValue: number };
    }
  }
  return { stringValue: String(data) };
}
RDSDataClient.prototype.send = async function(command) {
  const input = command.input;
  const kind = command.constructor.name;
  if (kind === 'BeginTransactionCommand') {
    const client = await pool.connect(); await client.query('BEGIN');
    const id = randomUUID(); transactions.set(id, client); return { transactionId: id };
  }
  if (kind === 'CommitTransactionCommand' || kind === 'RollbackTransactionCommand') {
    const client = transactions.get(input.transactionId);
    if (!client) throw new Error('Unknown native RDS transaction');
    try { await client.query(kind === 'CommitTransactionCommand' ? 'COMMIT' : 'ROLLBACK'); }
    finally { transactions.delete(input.transactionId); client.release(); }
    return { transactionStatus: 'Transaction Complete' };
  }
  if (typeof input.sql !== 'string') throw new Error(`Unsupported native RDS command ${kind}`);
  const connection = input.transactionId ? transactions.get(input.transactionId) : pool;
  if (!connection) throw new Error('Unknown native RDS transaction');
  const finish = beginMetric(/\bapp_users\b/.test(input.sql) ? 'sql:identity' : /\buser_tenant_roles\b/.test(input.sql) ? 'sql:grants' : 'sql:other');
  let result;
  try {
    const operation = connection.query({ ...bind(input.sql, input.parameters), rowMode: 'array' });
    metrics.poolWaitingPeak = Math.max(metrics.poolWaitingPeak, pool.waitingCount);
    result = await operation; finish(false);
  } catch (error) { finish(true); if (metricsMode === 'frames') count('sqlError.' + String(error?.message ?? error?.name ?? 'unknown').replace(/[0-9]+/g, 'N').slice(0, 60)); throw error; }
  if (Array.isArray(result)) throw new Error('Native RDS statement must have one result');
  return { records: result.rows.map(row => row.map((data, index) => cell(data, result.fields[index].dataTypeID))),
    numberOfRecordsUpdated: result.rowCount ?? 0,
    columnMetadata: result.fields.map(field => ({ name: field.name, label: field.name })) };
};
console.log('[native-rds-acceptance] provider SQL transport connected to dedicated loopback PostgreSQL');
