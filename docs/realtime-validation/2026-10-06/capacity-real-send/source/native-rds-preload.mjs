// Full-process acceptance only: replace the RDS SDK transport while executing
// the provider's actual SQL against the dedicated local PostgreSQL database.
// No installed SDK files are changed. This is not Aurora/IAM acceptance.
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { writeFileSync } from 'node:fs';
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
  const root = join(dirname(require.resolve('@connorhoehnslalom/realtime-modules/server')), '..');
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
if (metricsPath) {
  const originalSend = DynamoDBClient.prototype.send;
  DynamoDBClient.prototype.send = async function(command, ...args) {
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
    try { const result = await originalSend.call(this, command, ...args); finish(false); finishTable(false); finishStage(false); return result; }
    catch (error) { finish(true); finishTable(true); finishStage(true); throw error; }
  };
  instrumentSendStages();
  const flush = () => writeFileSync(metricsPath, JSON.stringify({ ...metrics,
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
  } catch (error) { finish(true); throw error; }
  if (Array.isArray(result)) throw new Error('Native RDS statement must have one result');
  return { records: result.rows.map(row => row.map((data, index) => cell(data, result.fields[index].dataTypeID))),
    numberOfRecordsUpdated: result.rowCount ?? 0,
    columnMetadata: result.fields.map(field => ({ name: field.name, label: field.name })) };
};
console.log('[native-rds-acceptance] provider SQL transport connected to dedicated loopback PostgreSQL');
