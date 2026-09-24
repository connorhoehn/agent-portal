/**
 * The process-wide compute registry and its wiring to the devbox fleet.
 *
 * Store choice: DynamoDB. The deployed middleware already holds read/write on
 * the foundation stack's `orgiq-sessions` table (sessionId S + timestamp N,
 * TTL attribute `ttl` — infra/lib/foundation-stack.ts,
 * middleware-service-stack.ts), and the AWS SDK is already a dependency;
 * nothing in the middleware talks to Redis. Locally the stack's shared
 * DynamoDB Local (:18000) stands in for it.
 *
 * Environment:
 *   COMPUTE_REGISTRY_STORE        'dynamodb' | 'memory' (default: dynamodb,
 *                                 falling back to memory if unreachable)
 *   COMPUTE_REGISTRY_TABLE        table (default SESSIONS_TABLE / orgiq-sessions;
 *                                 under DEV_OFFLINE, agentcore-compute-registry)
 *   COMPUTE_REGISTRY_DDB_ENDPOINT endpoint override (DEV_OFFLINE default
 *                                 http://localhost:18000)
 *   COMPUTE_REGISTRY_TTL_MS       registration TTL (default 15 min); the
 *                                 heartbeat runs every third of it
 *
 * Only under DEV_OFFLINE does it create its table — against AWS the table is
 * the stack's, and a missing one means memory mode with a warning.
 */
import { CreateTableCommand, DescribeTableCommand, DescribeTimeToLiveCommand, DynamoDBClient, UpdateTimeToLiveCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { addFleetMirror, hydrateBoxes, listBoxes, type FleetBox } from '../lib/devbox-fleet.js';
import { createComputeRegistry, DEFAULT_REGISTRATION_TTL_MS, type ComputeRegistry } from './compute-registry.js';
import {
  createDynamoRegistryStore,
  createMemoryRegistryStore,
  createSwitchableStore,
  type ComputeRegistryStore,
} from './compute-registry-store.js';

const switchable = createSwitchableStore(createMemoryRegistryStore());

export const computeRegistry = createComputeRegistry({
  store: switchable,
  registrationTtlMs: Number(process.env['COMPUTE_REGISTRY_TTL_MS'] ?? DEFAULT_REGISTRATION_TTL_MS),
});

function warn(message: string, err?: unknown): void {
  console.warn(`[compute-registry] ${message}${err ? `: ${(err as Error)?.message ?? err}` : ''}`);
}

async function connectDynamo(): Promise<{ store: ComputeRegistryStore; table: string; endpoint: string } | null> {
  const offline = process.env['DEV_OFFLINE'] === 'true';
  const endpoint = process.env['COMPUTE_REGISTRY_DDB_ENDPOINT']?.trim() || (offline ? 'http://localhost:18000' : '');
  const table = process.env['COMPUTE_REGISTRY_TABLE']?.trim()
    || (offline ? 'agentcore-compute-registry' : (process.env['SESSIONS_TABLE']?.trim() || 'orgiq-sessions'));
  const raw = new DynamoDBClient({
    region: process.env['AWS_REGION'] || 'us-east-1',
    maxAttempts: 2,
    ...(endpoint ? { endpoint } : {}),
    // DynamoDB Local accepts any credentials; offline there are none to find.
    ...(offline && !process.env['AWS_ACCESS_KEY_ID']
      ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
  });
  const probe = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try { return await fn(controller.signal); } finally { clearTimeout(timer); }
  };
  try {
    await probe((abortSignal) => raw.send(new DescribeTableCommand({ TableName: table }), { abortSignal }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ResourceNotFoundException' || !offline) {
      warn(`DynamoDB table ${table}${endpoint ? ` at ${endpoint}` : ''} unavailable — registry stays in memory`, err);
      return null;
    }
    try {
      await probe((abortSignal) => raw.send(new CreateTableCommand({
        TableName: table,
        AttributeDefinitions: [
          { AttributeName: 'sessionId', AttributeType: 'S' },
          { AttributeName: 'timestamp', AttributeType: 'N' },
        ],
        KeySchema: [
          { AttributeName: 'sessionId', KeyType: 'HASH' },
          { AttributeName: 'timestamp', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }), { abortSignal }));
    } catch (createErr) {
      if ((createErr as { name?: string }).name !== 'ResourceInUseException') {
        warn(`could not create ${table} — registry stays in memory`, createErr);
        return null;
      }
    }
  }
  if (offline) {
    // The table this creates had TTL off, so dead registrations (`ttl`, epoch
    // seconds) stayed forever — 76 of 81 rows expired on 2026-09-24
    // (realtime-examples NFR #226). With it on, the dev stack's local TTL
    // sweep reaps them as AWS would; orgiq-sessions already has TTL.
    try {
      const ttl = await probe((abortSignal) => raw.send(new DescribeTimeToLiveCommand({ TableName: table }), { abortSignal }));
      if (ttl.TimeToLiveDescription?.TimeToLiveStatus !== 'ENABLED') {
        await probe((abortSignal) => raw.send(new UpdateTimeToLiveCommand({
          TableName: table,
          TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' },
        }), { abortSignal }));
      }
    } catch (err) {
      warn(`could not enable TTL on ${table}`, err);
    }
  }
  return {
    store: createDynamoRegistryStore({ client: DynamoDBDocumentClient.from(raw), tableName: table }),
    table,
    endpoint: endpoint || 'aws',
  };
}

/**
 * Mirror this replica's fleet into the registry and keep its registrations
 * alive. Exported for tests: it takes the registry and fleet accessors it
 * works on, so two "replicas" can be simulated over one store.
 */
export function attachFleetMirror(registry: ComputeRegistry, fleet: {
  addFleetMirror: typeof addFleetMirror;
  listBoxes: () => FleetBox[];
}): { heartbeat(): Promise<void>; detach(): void } {
  const dirty = new Set<string>();
  const log = (err: unknown) => warn('fleet mirror write failed', err);
  const detach = fleet.addFleetMirror({
    upsert(box) { dirty.delete(box.id); void registry.putBox({ ...box }).catch(log); },
    remove(id) { dirty.delete(id); void registry.removeBox(id).catch(log); },
    // Hot path (every stream event): only note it; the heartbeat writes it.
    touch(box) { dirty.add(box.id); },
  });
  return {
    async heartbeat() {
      for (const box of fleet.listBoxes()) {
        try {
          // A box whose activity moved is rewritten in full; an unchanged one
          // only has its expiry extended, so a stale copy here can never
          // overwrite a newer write made by another replica.
          if (dirty.delete(box.id)) await registry.putBox({ ...box });
          else await registry.refreshBox(box.id);
          await registry.refreshShares({ source: 'cloud-compute', resourceId: `box:${box.id}` });
        } catch (err) { log(err); }
      }
    },
    detach,
  };
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Boot: point the registry at DynamoDB when reachable, adopt every live
 * registration another replica (or this one, before a restart) made, then
 * mirror and heartbeat. Never throws — the middleware must boot without it.
 */
export async function initComputeRegistry(): Promise<{ kind: string; restored: number }> {
  const mode = (process.env['COMPUTE_REGISTRY_STORE'] ?? 'dynamodb').trim();
  if (mode !== 'memory') {
    const connected = await connectDynamo().catch((err) => { warn('connect failed', err); return null; });
    if (connected) switchable.use(connected.store);
  }
  let restored = 0;
  try {
    // Hydrated boxes join this replica's fleet exactly as Aurora-hydrated ones
    // do (initFleetPersistence), so this replica heartbeats them from now on.
    restored = hydrateBoxes(await computeRegistry.listBoxes());
  } catch (err) { warn('hydrate failed', err); }
  const mirror = attachFleetMirror(computeRegistry, { addFleetMirror, listBoxes });
  // Publish what the fleet already holds (Aurora/mock hydration may have run first).
  await mirror.heartbeat();
  for (const box of listBoxes()) {
    if (!(await computeRegistry.getBox(box.id).catch(() => null))) await computeRegistry.putBox({ ...box }).catch(() => {});
  }
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => { void mirror.heartbeat(); }, Math.max(1_000, Math.floor(computeRegistry.registrationTtlMs / 3)));
  heartbeatTimer.unref?.();
  console.warn(`[compute-registry] ${switchable.kind} store — ${restored} box(es) restored, `
    + `registrations expire after ${Math.round(computeRegistry.registrationTtlMs / 1000)}s unless refreshed`);
  return { kind: switchable.kind, restored };
}
