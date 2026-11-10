// Single-use nonces for signed service envelopes (lib/service-auth.ts), shared
// across middleware replicas when a table is configured.
//
// The in-process cache alone lets a captured signed request be accepted once
// per replica inside its window. With SERVICE_AUTH_REPLAY_TABLE set, a nonce
// the process has not seen is also claimed with a conditional put into that
// DynamoDB-compatible table (DynamoDB itself, or a local DynamoDB-compatible
// store through SERVICE_AUTH_REPLAY_DYNAMODB_ENDPOINT). A put that finds a live
// item means another replica already accepted the nonce: a replay.
//
// THE TABLE IS SHARED with the agents' invoke replay store
// (agents/_shared/replay_store.py, AGENT_INVOKE_REPLAY_TABLE). Both write the
// same item shape — string partition key `nonce_hash`, numeric TTL attribute
// `expires_at` — and they never collide: the agents' keys are a bare 64-char
// hex digest, the middleware's carry the `service-envelope#` prefix, and the
// IAM grants pin each writer to its side of that split (dynamodb:LeadingKeys).
//
// FAIL CLOSED. Once a table is configured, any store error other than "already
// there" (throttled, unreachable, missing table, no permission) — or a client
// that cannot be built — refuses the request. Nothing falls back to the process
// alone. Unset keeps today's behaviour: the in-process cache only.
//
//   SERVICE_AUTH_REPLAY_TABLE               the table name; unset = process only
//   SERVICE_AUTH_REPLAY_DYNAMODB_ENDPOINT   optional local endpoint
//   AWS_REGION                              the table's region

import { createHash } from 'node:crypto';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

export const REPLAY_TABLE_ENV = 'SERVICE_AUTH_REPLAY_TABLE';
export const REPLAY_ENDPOINT_ENV = 'SERVICE_AUTH_REPLAY_DYNAMODB_ENDPOINT';
/** Key prefix that separates the middleware's items from the agents' bare digests. */
export const REPLAY_KEY_PREFIX = 'service-envelope#';

/** The shared layer. Resolves true on first use, false on a replay; rejects when it cannot decide. */
export interface NonceStore {
  claim(key: string, nowMs: number, windowMs: number): Promise<boolean>;
}

export interface ReplayStoreConfig { table: string; endpoint: string | null; region: string }

/** The configured table, or null when none is (keep the in-process cache alone). */
export function replayStoreConfig(env: NodeJS.ProcessEnv = process.env): ReplayStoreConfig | null {
  const table = env[REPLAY_TABLE_ENV]?.trim();
  if (!table) return null;
  return {
    table,
    endpoint: env[REPLAY_ENDPOINT_ENV]?.trim() || null,
    region: env['AWS_REGION']?.trim() || 'us-east-1',
  };
}

export function createReplayDynamoClient(cfg: ReplayStoreConfig): DynamoDBClient {
  // A loopback emulator accepts any key; never send the operator's real credentials to it.
  const local = !!cfg.endpoint && process.env['NODE_ENV'] !== 'production';
  return new DynamoDBClient({
    region: cfg.region,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true },
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    ...(local ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
  });
}

/** The partition key a middleware nonce is stored under. */
export function replayKey(key: string): string {
  return REPLAY_KEY_PREFIX + createHash('sha256').update(key, 'utf8').digest('hex');
}

type PutOnly = Pick<DynamoDBClient, 'send'>;

/** One conditional put per accepted nonce. */
export class DynamoNonceStore implements NonceStore {
  constructor(private readonly table: string, private readonly client: PutOnly) {}

  async claim(key: string, nowMs: number, windowMs: number): Promise<boolean> {
    // Wall clock: every replica compares against the same expiry.
    const now = Math.floor(nowMs / 1000);
    const serviceId = key.split(':', 1)[0] ?? '';
    try {
      await this.client.send(new PutItemCommand({
        TableName: this.table,
        Item: {
          nonce_hash: { S: replayKey(key) },
          caller: { S: serviceId.slice(0, 256) },
          expires_at: { N: String(Math.floor((nowMs + windowMs) / 1000) + 1) },
        },
        // TTL deletion is lazy: an item past its expiry no longer counts.
        ConditionExpression: 'attribute_not_exists(nonce_hash) OR expires_at < :now',
        ExpressionAttributeValues: { ':now': { N: String(now) } },
      }));
      return true;
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }
}

/** A configured store whose client could not be built: every claim refuses. */
class UnavailableNonceStore implements NonceStore {
  constructor(private readonly why: string) {}
  claim(): Promise<boolean> { return Promise.reject(new Error(this.why)); }
}

let resolved: { signature: string; store: NonceStore | null } | null = null;
let override: { store: NonceStore | null } | null = null;

/**
 * The shared store this process uses, or null. Read from the environment on
 * first use and again whenever the table/endpoint variables change.
 */
export function sharedNonceStore(env: NodeJS.ProcessEnv = process.env): NonceStore | null {
  if (override) return override.store;
  const cfg = replayStoreConfig(env);
  const signature = cfg ? `${cfg.table}|${cfg.endpoint ?? ''}|${cfg.region}` : '';
  if (resolved && resolved.signature === signature) return resolved.store;
  let store: NonceStore | null = null;
  if (cfg) {
    try {
      store = new DynamoNonceStore(cfg.table, createReplayDynamoClient(cfg));
      console.info(`[service-auth] signed-envelope nonces shared through table ${cfg.table}`);
    } catch (e) {
      console.error(`[service-auth] replay table ${cfg.table} is configured but its client failed `
        + `(${(e as Error)?.name ?? 'Error'}); signed requests are refused`);
      store = new UnavailableNonceStore('the replay store client could not be built');
    }
  }
  resolved = { signature, store };
  return store;
}

/** Test hook — pin the shared store (null = none); `undefined` returns to the environment. */
export function setSharedNonceStore(store: NonceStore | null | undefined): void {
  override = store === undefined ? null : { store };
  resolved = null;
}
