// The DynamoDB-wire SearchIndex (docs/user-search-goal.md U3): one table, the
// operations DynamoDB, DynamoDB Local and the managed-nosql-store all speak —
// Query, BatchGetItem, BatchWriteItem and one GSI. No Scan, no SQL.
//
//   PK                          SK              item
//   D#<tenant>#<type>:<id>      D               the doc (JSON)        GSI1PK T#<tenant>#<type>, GSI1SK <type>:<id>
//   W#<tenant>#<token>          <type>:<id>     a posting (tokens.ts)
//   F#<tenant>#<name>=<value>   <type>:<id>     a facet value
//   N#<tenant>#<type>:<id>      E#<edge id>     an edge, filed under both of its ends (JSON)
//   M#<tenant>                  M               partition meta (JSON)
//   M#<tenant>                  TYPE#<type>     the types the partition holds (clear() walks them)
//
// A put reads the doc it replaces and deletes that doc's postings, facets and
// edges before writing the new ones; it is not transactional (S1: one writer
// per record, after its source commit). A store change stream can replace the
// write-through later without changing this layout.

import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand, DynamoDBClient, ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, BatchWriteCommand, DynamoDBDocumentClient, QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { docTokens, facetValue, termKeys } from './tokens.js';
import {
  DEFAULT_QUERY_LIMIT, docKey, visibleTo,
  type DocKey, type IndexMeta, type Neighbour, type SearchDoc, type SearchDocEdge, type SearchIndex, type SearchIndexPage, type SearchIndexQuery,
} from './types.js';

export interface KvIndexConfig { endpoint: string | null; table: string; region: string }

/** SEARCH_INDEX_DYNAMODB_ENDPOINT / SEARCH_INDEX_TABLE / AWS_REGION. */
export function kvIndexConfig(env: NodeJS.ProcessEnv = process.env): KvIndexConfig {
  return {
    endpoint: env['SEARCH_INDEX_DYNAMODB_ENDPOINT']?.trim() || null,
    table: env['SEARCH_INDEX_TABLE']?.trim() || 'orgiq-search-index',
    region: env['AWS_REGION']?.trim() || 'us-east-1',
  };
}

export function createKvIndexClient(cfg: KvIndexConfig): DynamoDBClient {
  // A loopback emulator accepts any key; never send the operator's real credentials to it.
  const local = !!cfg.endpoint && process.env['NODE_ENV'] !== 'production';
  return new DynamoDBClient({
    region: cfg.region,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 10_000, throwOnRequestTimeout: true },
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    ...(local ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
  });
}

/** Create the table and its GSI if absent (local setups and tests; infrastructure owns it in the cloud). */
export async function ensureKvIndexTable(client: DynamoDBClient, table: string): Promise<void> {
  try { await client.send(new DescribeTableCommand({ TableName: table })); return; } catch (e) { if (!(e instanceof ResourceNotFoundException)) throw e; }
  const S = 'S' as const;
  await client.send(new CreateTableCommand({
    TableName: table,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'PK', AttributeType: S }, { AttributeName: 'SK', AttributeType: S },
      { AttributeName: 'GSI1PK', AttributeType: S }, { AttributeName: 'GSI1SK', AttributeType: S },
    ],
    KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    GlobalSecondaryIndexes: [
      { IndexName: 'GSI1', KeySchema: [{ AttributeName: 'GSI1PK', KeyType: 'HASH' }, { AttributeName: 'GSI1SK', KeyType: 'RANGE' }], Projection: { ProjectionType: 'KEYS_ONLY' } },
    ],
  }));
}

export async function dropKvIndexTable(client: DynamoDBClient, table: string): Promise<void> {
  try { await client.send(new DeleteTableCommand({ TableName: table })); } catch (e) { if (!(e instanceof ResourceNotFoundException)) throw e; }
}

type Item = Record<string, unknown> & { PK: string; SK: string };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class KvSearchIndex implements SearchIndex {
  readonly kind = 'kv' as const;
  private readonly doc: DynamoDBDocumentClient;

  constructor(client: DynamoDBClient, private readonly table: string) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  // ── wire helpers ──────────────────────────────────────────────────────────
  private async queryAll(input: Omit<QueryCommandInput, 'TableName'>): Promise<Item[]> {
    const out: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(new QueryCommand({ TableName: this.table, ...input, ...(start ? { ExclusiveStartKey: start } : {}) }));
      out.push(...((res.Items ?? []) as Item[]));
      start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    return out;
  }

  private async batchGet(keys: Array<{ PK: string; SK: string }>): Promise<Item[]> {
    const out: Item[] = [];
    const unique = [...new Map(keys.map(k => [`${k.PK}\u0000${k.SK}`, k])).values()];
    for (let i = 0; i < unique.length; i += 100) {
      let request: Array<Record<string, unknown>> | undefined = unique.slice(i, i + 100);
      for (let attempt = 0; request?.length; attempt++) {
        const res = await this.doc.send(new BatchGetCommand({ RequestItems: { [this.table]: { Keys: request } } }));
        out.push(...((res.Responses?.[this.table] ?? []) as Item[]));
        request = res.UnprocessedKeys?.[this.table]?.Keys as Array<Record<string, unknown>> | undefined;
        if (request?.length) await sleep(Math.min(1000, 50 * 2 ** attempt));
      }
    }
    return out;
  }

  private async batchWrite(puts: Item[], deletes: Array<{ PK: string; SK: string }>): Promise<void> {
    // One request may not name the same key twice; a put wins over a delete of the same key.
    const putKeys = new Set(puts.map(p => `${p.PK}\u0000${p.SK}`));
    const ops = [
      ...[...new Map(deletes.map(d => [`${d.PK}\u0000${d.SK}`, d])).entries()].filter(([k]) => !putKeys.has(k)).map(([, d]) => ({ DeleteRequest: { Key: { PK: d.PK, SK: d.SK } } })),
      ...[...new Map(puts.map(p => [`${p.PK}\u0000${p.SK}`, p])).values()].map(p => ({ PutRequest: { Item: p } })),
    ];
    for (let i = 0; i < ops.length; i += 25) {
      let request: Array<Record<string, unknown>> | undefined = ops.slice(i, i + 25);
      for (let attempt = 0; request?.length; attempt++) {
        const res = await this.doc.send(new BatchWriteCommand({ RequestItems: { [this.table]: request as never } }));
        request = res.UnprocessedItems?.[this.table] as Array<Record<string, unknown>> | undefined;
        if (request?.length) await sleep(Math.min(1000, 50 * 2 ** attempt));
      }
    }
  }

  // ── item layout ───────────────────────────────────────────────────────────
  private docPk = (tenant: string, key: DocKey) => `D#${tenant}#${key}`;

  private itemsFor(doc: SearchDoc): Item[] {
    const t = doc.tenant, key = docKey(doc.type, doc.id);
    const items: Item[] = [
      { PK: this.docPk(t, key), SK: 'D', GSI1PK: `T#${t}#${doc.type}`, GSI1SK: key, data: JSON.stringify(doc) },
      { PK: `M#${t}`, SK: `TYPE#${doc.type}` },
    ];
    for (const tok of docTokens(doc.title, doc.text)) items.push({ PK: `W#${t}#${tok}`, SK: key });
    for (const [name, values] of Object.entries(doc.facets)) for (const v of values) items.push({ PK: `F#${t}#${name}=${facetValue(v)}`, SK: key });
    for (const e of doc.edges) for (const end of new Set([e.source, e.target])) items.push({ PK: `N#${t}#${end}`, SK: `E#${e.id}`, data: JSON.stringify(e) });
    return items;
  }

  // ── SearchIndex ───────────────────────────────────────────────────────────
  async put(doc: SearchDoc): Promise<void> { await this.putMany([doc]); }

  async putMany(docs: SearchDoc[]): Promise<void> {
    if (!docs.length) return;
    const byTenant = new Map<string, SearchDoc[]>();
    for (const d of docs) byTenant.set(d.tenant, [...(byTenant.get(d.tenant) ?? []), d]);
    for (const [tenant, group] of byTenant) {
      const previous = await this.get(tenant, group.map(d => docKey(d.type, d.id)));
      const stale = previous.flatMap(p => this.itemsFor(p).filter(i => !i.SK.startsWith('TYPE#')).map(i => ({ PK: i.PK, SK: i.SK })));
      await this.batchWrite(group.flatMap(d => this.itemsFor(d)), stale);
    }
  }

  async remove(tenant: string, key: DocKey): Promise<void> {
    const [old] = await this.get(tenant, [key]);
    if (!old) return;
    await this.batchWrite([], this.itemsFor(old).filter(i => !i.SK.startsWith('TYPE#')).map(i => ({ PK: i.PK, SK: i.SK })));
  }

  async get(tenant: string, keys: DocKey[]): Promise<SearchDoc[]> {
    if (!keys.length) return [];
    const items = await this.batchGet(keys.map(k => ({ PK: this.docPk(tenant, k), SK: 'D' })));
    const byKey = new Map(items.map(i => { const d = JSON.parse(String(i['data'])) as SearchDoc; return [docKey(d.type, d.id), d] as const; }));
    return keys.flatMap(k => { const d = byKey.get(k); return d ? [d] : []; });
  }

  private async keysOfType(tenant: string, type: string): Promise<DocKey[]> {
    const rows = await this.queryAll({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': `T#${tenant}#${type}` } });
    return rows.map(r => String(r['GSI1SK']));
  }

  private async typesOf(tenant: string): Promise<string[]> {
    const rows = await this.queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :t)', ExpressionAttributeValues: { ':pk': `M#${tenant}`, ':t': 'TYPE#' } });
    return rows.map(r => r.SK.slice('TYPE#'.length));
  }

  private async keysUnder(pk: string): Promise<DocKey[]> {
    return (await this.queryAll({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': pk } })).map(r => r.SK);
  }

  async query(q: SearchIndexQuery): Promise<SearchIndexPage> {
    const t = q.tenant;
    let keys: Set<DocKey>;
    if (q.terms.length) {
      const lookups = [...new Set(q.terms.flatMap(termKeys))];
      keys = new Set((await Promise.all(lookups.map(k => this.keysUnder(`W#${t}#${k}`)))).flat());
    } else {
      const types = q.types?.length ? q.types : await this.typesOf(t);
      keys = new Set((await Promise.all(types.map(type => this.keysOfType(t, type)))).flat());
    }
    for (const [name, values] of Object.entries(q.facets ?? {})) {
      const allowed = new Set((await Promise.all(values.map(v => this.keysUnder(`F#${t}#${name}=${facetValue(v)}`)))).flat());
      keys = new Set([...keys].filter(k => allowed.has(k)));
    }
    if (q.types?.length) keys = new Set([...keys].filter(k => q.types!.includes(k.slice(0, k.indexOf(':')))));
    const docs = (await this.get(t, [...keys].sort())).filter(d => visibleTo(d, q.allowedAcls));
    const start = q.cursor ? Number(q.cursor) || 0 : 0;
    const limit = q.limit ?? DEFAULT_QUERY_LIMIT;
    return { docs: docs.slice(start, start + limit), cursor: start + limit < docs.length ? String(start + limit) : null };
  }

  async neighbours(tenant: string, keys: DocKey[], labels?: string[]): Promise<Neighbour[]> {
    const from = [...new Set(keys)];
    const edgesBy = await Promise.all(from.map(async k => ({
      from: k,
      edges: (await this.queryAll({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `N#${tenant}#${k}` } }))
        .map(i => JSON.parse(String(i['data'])) as SearchDocEdge)
        .filter(e => !labels || labels.includes(e.label))
        .sort((a, b) => a.id.localeCompare(b.id)),
    })));
    const others = [...new Set(edgesBy.flatMap(({ from: f, edges }) => edges.map(e => (e.source === f ? e.target : e.source))))];
    const docs = new Map((await this.get(tenant, others)).map(d => [docKey(d.type, d.id), d]));
    return edgesBy.flatMap(({ from: f, edges }) => edges.flatMap(edge => {
      const doc = docs.get(edge.source === f ? edge.target : edge.source);
      return doc ? [{ from: f, edge, doc }] : [];
    }));
  }

  async getMeta(tenant: string): Promise<IndexMeta | null> {
    const [item] = await this.batchGet([{ PK: `M#${tenant}`, SK: 'M' }]);
    return item ? JSON.parse(String(item['data'])) as IndexMeta : null;
  }

  async setMeta(tenant: string, meta: IndexMeta): Promise<void> {
    await this.batchWrite([{ PK: `M#${tenant}`, SK: 'M', data: JSON.stringify(meta) }], []);
  }

  async clear(tenant: string): Promise<void> {
    const types = await this.typesOf(tenant);
    const keys = (await Promise.all(types.map(type => this.keysOfType(tenant, type)))).flat();
    const docs = await this.get(tenant, keys);
    await this.batchWrite([], [
      ...docs.flatMap(d => this.itemsFor(d).map(i => ({ PK: i.PK, SK: i.SK }))),
      { PK: `M#${tenant}`, SK: 'M' },
      ...types.map(type => ({ PK: `M#${tenant}`, SK: `TYPE#${type}` })),
    ]);
  }
}
