/**
 * Shared, expiring key/value store behind the compute registry.
 *
 * The compute registry (boxes, explicit shares, capability sessions,
 * revocation markers — see compute-registry.ts) used to live in process maps,
 * so with more than one middleware replica a request landing on the other one
 * saw none of it, and any restart dropped it. This is the seam that moves it
 * out of the process.
 *
 * Semantics every implementation must keep:
 * - Every record carries an absolute expiry. Reads (`get`, `list`) filter
 *   expired records themselves — never trust the backend to have deleted
 *   them (DynamoDB TTL deletion is lazy, up to days late; DynamoDB Local never
 *   deletes at all).
 * - `refresh` extends a record that is still live and reports whether it did.
 *   It never resurrects: a record another replica deleted, or one that has
 *   already expired, stays gone. That is what makes it a heartbeat rather than
 *   a write.
 * - Values are stored as JSON copies; callers never share object identity
 *   with the store.
 */
import { createHash } from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

export interface ComputeRegistryStore {
  readonly kind: 'memory' | 'dynamodb';
  put(partition: string, key: string, value: unknown, ttlMs: number): Promise<void>;
  /** Extend a live record's expiry. False when it is missing or already expired. */
  refresh(partition: string, key: string, ttlMs: number): Promise<boolean>;
  get<T>(partition: string, key: string): Promise<T | null>;
  list<T>(partition: string): Promise<T[]>;
  delete(partition: string, key: string): Promise<void>;
}

/**
 * In-process implementation: tests, and the no-store mode a laptop without
 * DynamoDB Local falls back to. Mutations happen synchronously inside the
 * call (before the returned promise settles), so a caller that fires a write
 * without awaiting it still sees it on its next read — the same guarantee
 * the plain Maps this replaced gave.
 */
export function createMemoryRegistryStore(options: { now?: () => number } = {}): ComputeRegistryStore {
  const now = options.now ?? Date.now;
  const partitions = new Map<string, Map<string, { json: string; expiresAtMs: number }>>();

  function live(partition: string, key: string) {
    const record = partitions.get(partition)?.get(key);
    if (!record) return null;
    if (record.expiresAtMs <= now()) {
      partitions.get(partition)?.delete(key);
      return null;
    }
    return record;
  }

  return {
    kind: 'memory',
    async put(partition, key, value, ttlMs) {
      const bucket = partitions.get(partition) ?? new Map();
      bucket.set(key, { json: JSON.stringify(value), expiresAtMs: now() + Math.max(1, ttlMs) });
      partitions.set(partition, bucket);
    },
    async refresh(partition, key, ttlMs) {
      const record = live(partition, key);
      if (!record) return false;
      record.expiresAtMs = now() + Math.max(1, ttlMs);
      return true;
    },
    async get<T>(partition: string, key: string) {
      const record = live(partition, key);
      return record ? JSON.parse(record.json) as T : null;
    },
    async list<T>(partition: string) {
      const out: T[] = [];
      for (const key of [...(partitions.get(partition)?.keys() ?? [])]) {
        const record = live(partition, key);
        if (record) out.push(JSON.parse(record.json) as T);
      }
      return out;
    },
    async delete(partition, key) {
      partitions.get(partition)?.delete(key);
    },
  };
}

/**
 * Stable numeric sort key for a string key (52 bits of sha256 — an exact
 * JS integer). The deployed table this targets (`orgiq-sessions`, foundation
 * stack) is keyed `sessionId` (S) + `timestamp` (N); the numeric sort key is
 * what lets one partition hold a whole list (every box, every viewer of a
 * resource) and be read back with a single Query. The original key is stored
 * alongside and checked on read, so a hash collision reads as a miss rather
 * than as someone else's record.
 */
export function registrySortKey(key: string): number {
  return parseInt(createHash('sha256').update(key).digest('hex').slice(0, 13), 16);
}

const PK_PREFIX = 'compute-registry#';

interface Row {
  sessionId: string;
  timestamp: number;
  registryKey: string;
  value: string;
  expiresAtMs: number;
  ttl: number;
}

/**
 * DynamoDB implementation. `ttl` (epoch seconds) is the table's TTL attribute
 * so the backend eventually sweeps dead rows; `expiresAtMs` is what reads and
 * the refresh condition actually check.
 */
export function createDynamoRegistryStore(options: {
  client: DynamoDBDocumentClient;
  tableName: string;
  now?: () => number;
}): ComputeRegistryStore {
  const { client, tableName } = options;
  const now = options.now ?? Date.now;
  const pk = (partition: string) => `${PK_PREFIX}${partition}`;

  function decode<T>(row: Record<string, unknown> | undefined, key?: string): T | null {
    if (!row) return null;
    const r = row as unknown as Row;
    if (key !== undefined && r.registryKey !== key) return null;
    if (!(Number(r.expiresAtMs) > now())) return null;
    try { return JSON.parse(String(r.value)) as T; } catch { return null; }
  }

  return {
    kind: 'dynamodb',
    async put(partition, key, value, ttlMs) {
      const expiresAtMs = now() + Math.max(1, ttlMs);
      const item: Row = {
        sessionId: pk(partition), timestamp: registrySortKey(key), registryKey: key,
        value: JSON.stringify(value), expiresAtMs, ttl: Math.ceil(expiresAtMs / 1000),
      };
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
    },
    async refresh(partition, key, ttlMs) {
      const at = now();
      const expiresAtMs = at + Math.max(1, ttlMs);
      try {
        await client.send(new UpdateCommand({
          TableName: tableName,
          Key: { sessionId: pk(partition), timestamp: registrySortKey(key) },
          UpdateExpression: 'SET expiresAtMs = :e, #ttl = :t',
          ConditionExpression: 'attribute_exists(sessionId) AND registryKey = :k AND expiresAtMs > :now',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':e': expiresAtMs, ':t': Math.ceil(expiresAtMs / 1000), ':k': key, ':now': at },
        }));
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
    async get<T>(partition: string, key: string) {
      const out = await client.send(new GetCommand({
        TableName: tableName,
        Key: { sessionId: pk(partition), timestamp: registrySortKey(key) },
        ConsistentRead: true,
      }));
      return decode<T>(out.Item, key);
    },
    async list<T>(partition: string) {
      const values: T[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const out = await client.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'sessionId = :pk',
          ExpressionAttributeValues: { ':pk': pk(partition) },
          ConsistentRead: true,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }));
        for (const row of out.Items ?? []) {
          const value = decode<T>(row);
          if (value !== null) values.push(value);
        }
        startKey = out.LastEvaluatedKey;
      } while (startKey);
      return values;
    },
    async delete(partition, key) {
      await client.send(new DeleteCommand({
        TableName: tableName,
        Key: { sessionId: pk(partition), timestamp: registrySortKey(key) },
      }));
    },
  };
}

/**
 * A store whose backend can be swapped once at boot. The registry is built at
 * import time (routes need it synchronously), but whether DynamoDB is
 * reachable is only known after an async probe — so the singleton starts on
 * memory and `initComputeRegistry()` points it at the shared store.
 */
export function createSwitchableStore(initial: ComputeRegistryStore): ComputeRegistryStore & {
  use(next: ComputeRegistryStore): void;
  current(): ComputeRegistryStore;
} {
  let target = initial;
  return {
    get kind() { return target.kind; },
    use(next) { target = next; },
    current() { return target; },
    put: (...args) => target.put(...args),
    refresh: (...args) => target.refresh(...args),
    get: <T>(partition: string, key: string) => target.get<T>(partition, key),
    list: <T>(partition: string) => target.list<T>(partition),
    delete: (...args) => target.delete(...args),
  };
}
