// DynamoRunbookStore: the durable RunbookStore, on one DynamoDB-wire table
// (design §2.5). Point RUNBOOK_DYNAMODB_ENDPOINT at DynamoDB Local or the
// managed-nosql-store for the local durable setup; AWS DynamoDB is the cloud one.
//
//   PK              SK                 item (entity under `data`)
//   RB#<id>         META               Runbook   GSI1PK SCOPE#<kind>#<ref|->, GSI1SK <status>#<updated_at>
//   RB#<id>         V#<000000n>        RunbookVersion
//   RB#<id>         APP#<appId>        RunbookApplication (id-unique; ordered by `at` on read)
//   PROP#<id>       META               Proposal  GSI2PK PROPSTATUS#<status>, GSI2SK <created_at>
//   BRIEF#<runRef>  META               SessionBrief
//
// Every guard is a ConditionExpression; an accept or a version append is one
// TransactWriteItems, so of two concurrent writers exactly one succeeds. The
// pure rules (which write is legal, which error) are shared with the Rows store
// in store.ts. This file has no SQL dependency.
import {
  CreateTableCommand, DeleteTableCommand, DescribeTableCommand, DynamoDBClient, ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  Runbook, RunbookApplication, RunbookProposal, RunbookVersion, SessionBrief,
} from './types.js';
import {
  AlreadyExistsError, BriefExistsError, InvalidWriteError, NotFoundError, ProposalClosedError, VersionConflictError,
  byNewest, checkCreate, checkPutRunbook, clone, filterProposals, filterRunbooks, matchesText, paginate, planAccept,
  planDecision, planPutVersion, runbookSearchText,
  type AcceptProposalInput, type AcceptProposalResult, type DecideProposalInput, type ListBriefsQuery, type ListProposalsQuery,
  type ListRunbooksQuery, type Page, type RunbookStore,
} from './store.js';

export interface RunbookStoreConfig {
  store: 'dynamo' | 'memory';
  endpoint: string | null;
  table: string;
  region: string;
}

/** RUNBOOK_STORE=dynamo|memory wins; otherwise dynamo when RUNBOOK_DYNAMODB_ENDPOINT or RUNBOOK_TABLE is set (the social-chat rule). */
export function runbookStoreConfig(env: NodeJS.ProcessEnv = process.env): RunbookStoreConfig {
  const endpoint = env['RUNBOOK_DYNAMODB_ENDPOINT']?.trim() || null;
  const table = env['RUNBOOK_TABLE']?.trim() || '';
  const explicit = (env['RUNBOOK_STORE'] ?? '').trim().toLowerCase();
  const store: RunbookStoreConfig['store'] = explicit === 'dynamo' ? 'dynamo' : explicit === 'memory' ? 'memory' : endpoint || table ? 'dynamo' : 'memory';
  return { store, endpoint, table: table || 'orgiq-runbooks', region: env['AWS_REGION']?.trim() || 'us-east-1' };
}

export function createRunbookDynamoClient(cfg: RunbookStoreConfig): DynamoDBClient {
  // A loopback emulator accepts any key; never send the operator's real credentials to it.
  const local = !!cfg.endpoint && process.env['NODE_ENV'] !== 'production';
  return new DynamoDBClient({
    region: cfg.region,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true },
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    ...(local ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
  });
}

/** Create the table and its two indexes if absent (local setups and tests; CDK owns it in the cloud). */
export async function ensureRunbookTable(client: DynamoDBClient, table: string): Promise<void> {
  try { await client.send(new DescribeTableCommand({ TableName: table })); return; } catch (e) { if (!(e instanceof ResourceNotFoundException)) throw e; }
  const S = 'S' as const, HASH = 'HASH' as const, RANGE = 'RANGE' as const;
  await client.send(new CreateTableCommand({
    TableName: table,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'PK', AttributeType: S }, { AttributeName: 'SK', AttributeType: S },
      { AttributeName: 'GSI1PK', AttributeType: S }, { AttributeName: 'GSI1SK', AttributeType: S },
      { AttributeName: 'GSI2PK', AttributeType: S }, { AttributeName: 'GSI2SK', AttributeType: S },
    ],
    KeySchema: [{ AttributeName: 'PK', KeyType: HASH }, { AttributeName: 'SK', KeyType: RANGE }],
    GlobalSecondaryIndexes: [
      { IndexName: 'GSI1', KeySchema: [{ AttributeName: 'GSI1PK', KeyType: HASH }, { AttributeName: 'GSI1SK', KeyType: RANGE }], Projection: { ProjectionType: 'ALL' } },
      { IndexName: 'GSI2', KeySchema: [{ AttributeName: 'GSI2PK', KeyType: HASH }, { AttributeName: 'GSI2SK', KeyType: RANGE }], Projection: { ProjectionType: 'ALL' } },
    ],
  }));
}
export async function dropRunbookTable(client: DynamoDBClient, table: string): Promise<void> {
  try { await client.send(new DeleteTableCommand({ TableName: table })); } catch (e) { if (!(e instanceof ResourceNotFoundException)) throw e; }
}

const rbKey = (id: string) => ({ PK: `RB#${id}`, SK: 'META' });
const verKey = (id: string, n: number) => ({ PK: `RB#${id}`, SK: `V#${String(n).padStart(6, '0')}` });
const propKey = (id: string) => ({ PK: `PROP#${id}`, SK: 'META' });
const briefKey = (runRef: string) => ({ PK: `BRIEF#${runRef}`, SK: 'META' });

const runbookItem = (r: Runbook) => ({
  ...rbKey(r.id), GSI1PK: `SCOPE#${r.scope.kind}#${r.scope.ref ?? '-'}`, GSI1SK: `${r.status}#${r.updated_at}`, data: r,
});
const versionItem = (v: RunbookVersion) => ({ ...verKey(v.runbook_id, v.version), data: v });
const proposalItem = (p: RunbookProposal) => ({ ...propKey(p.id), GSI2PK: `PROPSTATUS#${p.status}`, GSI2SK: p.created_at, data: p });
const briefItem = (b: SessionBrief) => ({ ...briefKey(b.run_ref), data: b });

type Item = Record<string, unknown>;
const dataOf = <T>(item: Item | undefined): T | null => (item ? (item['data'] as T) : null);
const errName = (e: unknown): string => (e as { name?: string })?.name ?? '';

export class DynamoRunbookStore implements RunbookStore {
  readonly kind = 'dynamo' as const;
  private readonly doc: DynamoDBDocumentClient;

  constructor(client: DynamoDBClient, private readonly table: string) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  // ── low-level ──
  private async get<T>(key: { PK: string; SK: string }): Promise<T | null> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }));
    return dataOf<T>(out.Item);
  }
  private async queryAll(input: { index?: string; pk: string; pkAttr?: string; skAttr?: string; skPrefix?: string }): Promise<Item[]> {
    const pkAttr = input.pkAttr ?? 'PK', skAttr = input.skAttr ?? 'SK';
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(new QueryCommand({
        TableName: this.table, ...(input.index ? { IndexName: input.index } : {}),
        KeyConditionExpression: input.skPrefix ? '#pk = :pk AND begins_with(#sk, :sk)' : '#pk = :pk',
        ExpressionAttributeNames: input.skPrefix ? { '#pk': pkAttr, '#sk': skAttr } : { '#pk': pkAttr },
        ExpressionAttributeValues: input.skPrefix ? { ':pk': input.pk, ':sk': input.skPrefix } : { ':pk': input.pk },
        // Index reads are eventually consistent on real DynamoDB; table reads are strong.
        ...(input.index ? {} : { ConsistentRead: true }),
        ExclusiveStartKey: start,
      }));
      items.push(...((out.Items ?? []) as Item[]));
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  }
  private async scanMeta(pkPrefix: string): Promise<Item[]> {
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(new ScanCommand({
        TableName: this.table, ConsistentRead: true,
        FilterExpression: 'SK = :m AND begins_with(PK, :p)',
        ExpressionAttributeValues: { ':m': 'META', ':p': pkPrefix },
        ExclusiveStartKey: start,
      }));
      items.push(...((out.Items ?? []) as Item[]));
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  }

  // ── runbooks ──
  getRunbook(id: string): Promise<Runbook | null> { return this.get<Runbook>(rbKey(id)); }

  async listRunbooks(q?: ListRunbooksQuery): Promise<Page<Runbook>> {
    const items = q?.scope
      ? await this.queryAll({ index: 'GSI1', pk: `SCOPE#${q.scope.kind}#${q.scope.ref ?? '-'}`, pkAttr: 'GSI1PK' })
      : await this.scanMeta('RB#');
    let rows = filterRunbooks(items.map((i) => dataOf<Runbook>(i) as Runbook), q);
    if (q?.text?.trim()) {
      const keep: Runbook[] = [];
      for (const r of rows) {
        const v = await this.get<RunbookVersion>(verKey(r.id, r.current_version));
        if (matchesText(q.text, runbookSearchText(r, v?.doc ?? null))) keep.push(r);
      }
      rows = keep;
    }
    return paginate(rows.sort(byNewest((r) => r.updated_at, (r) => r.id)), q?.cursor, q?.limit);
  }

  async createRunbook(runbook: Runbook, v1: RunbookVersion): Promise<void> {
    checkCreate(runbook, v1);
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.table, Item: runbookItem(runbook), ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: this.table, Item: versionItem(v1), ConditionExpression: 'attribute_not_exists(PK)' } },
      ] }));
    } catch (e) {
      if (errName(e) === 'TransactionCanceledException') throw new AlreadyExistsError(`runbook ${runbook.id}`);
      throw e;
    }
  }

  async putRunbook(runbook: Runbook, expectedUpdatedAt: string): Promise<void> {
    checkPutRunbook(await this.getRunbook(runbook.id), runbook, expectedUpdatedAt);
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table, Item: runbookItem(runbook),
        ConditionExpression: '#d.updated_at = :u AND #d.current_version = :c',
        ExpressionAttributeNames: { '#d': 'data' },
        ExpressionAttributeValues: { ':u': expectedUpdatedAt, ':c': runbook.current_version },
      }));
    } catch (e) {
      if (errName(e) === 'ConditionalCheckFailedException') throw new VersionConflictError(`${runbook.id} changed since it was read`, expectedUpdatedAt, null);
      throw e;
    }
  }

  // ── versions ──
  getVersion(runbookId: string, version: number): Promise<RunbookVersion | null> { return this.get<RunbookVersion>(verKey(runbookId, version)); }
  async listVersions(runbookId: string): Promise<RunbookVersion[]> {
    const items = await this.queryAll({ pk: `RB#${runbookId}`, skPrefix: 'V#' });
    return items.map((i) => dataOf<RunbookVersion>(i) as RunbookVersion).sort((a, b) => a.version - b.version);
  }

  async putVersion(v: RunbookVersion, expectedCurrent: number, at: string): Promise<void> {
    const next = planPutVersion(await this.getRunbook(v.runbook_id), v, expectedCurrent, at);
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.table, Item: versionItem(v), ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: {
          TableName: this.table, Item: runbookItem(next), ConditionExpression: '#d.current_version = :c',
          ExpressionAttributeNames: { '#d': 'data' }, ExpressionAttributeValues: { ':c': expectedCurrent },
        } },
      ] }));
    } catch (e) {
      if (errName(e) === 'TransactionCanceledException') {
        const now = await this.getRunbook(v.runbook_id);
        throw new VersionConflictError(`${v.runbook_id} is at v${now?.current_version}, not v${expectedCurrent}`, expectedCurrent, now?.current_version ?? null);
      }
      throw e;
    }
  }

  // ── proposals ──
  getProposal(id: string): Promise<RunbookProposal | null> { return this.get<RunbookProposal>(propKey(id)); }

  async putProposal(p: RunbookProposal): Promise<void> {
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table, Item: proposalItem(p),
        ConditionExpression: 'attribute_not_exists(PK) OR #d.#s = :open',
        ExpressionAttributeNames: { '#d': 'data', '#s': 'status' }, ExpressionAttributeValues: { ':open': 'open' },
      }));
    } catch (e) {
      if (errName(e) === 'ConditionalCheckFailedException') throw new AlreadyExistsError(`decided proposal ${p.id}`);
      throw e;
    }
  }

  async listProposals(q?: ListProposalsQuery): Promise<Page<RunbookProposal>> {
    const items = q?.status?.length === 1
      ? await this.queryAll({ index: 'GSI2', pk: `PROPSTATUS#${q.status[0]}`, pkAttr: 'GSI2PK' })
      : await this.scanMeta('PROP#');
    const rows = filterProposals(items.map((i) => dataOf<RunbookProposal>(i) as RunbookProposal), q);
    return paginate(rows.sort(byNewest((p) => p.created_at, (p) => p.id)), q?.cursor, q?.limit);
  }

  async acceptProposal(input: AcceptProposalInput): Promise<AcceptProposalResult> {
    const proposal = await this.getProposal(input.proposal_id);
    const runbookId = proposal?.runbook_id ?? input.runbook?.id ?? null;
    const before = runbookId ? await this.getRunbook(runbookId) : null;
    const plan = planAccept(proposal, before, input);
    const names = { '#d': 'data', '#s': 'status' };
    const tx: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [
      // Once-only: the proposal must still be open.
      { Put: { TableName: this.table, Item: proposalItem(plan.proposal), ConditionExpression: '#d.#s = :open', ExpressionAttributeNames: names, ExpressionAttributeValues: { ':open': 'open' } } },
      before
        // Concurrent-edit guard: the runbook must still be at the version this was planned against.
        ? { Put: { TableName: this.table, Item: runbookItem(plan.runbook), ConditionExpression: '#d.current_version = :c', ExpressionAttributeNames: { '#d': 'data' }, ExpressionAttributeValues: { ':c': before.current_version } } }
        : { Put: { TableName: this.table, Item: runbookItem(plan.runbook), ConditionExpression: 'attribute_not_exists(PK)' } },
    ];
    if (plan.version) tx.push({ Put: { TableName: this.table, Item: versionItem(plan.version), ConditionExpression: 'attribute_not_exists(PK)' } });
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: tx }));
    } catch (e) {
      if (errName(e) !== 'TransactionCanceledException') throw e;
      // Something moved between the read and the write: say which.
      const now = await this.getProposal(input.proposal_id);
      if (now && now.status !== 'open') throw new ProposalClosedError(now.id, now.status);
      const rb = runbookId ? await this.getRunbook(runbookId) : null;
      throw new VersionConflictError(`${runbookId} moved to v${rb?.current_version} while accepting`, before?.current_version ?? null, rb?.current_version ?? null);
    }
    return clone(plan);
  }

  async decideProposal(input: DecideProposalInput): Promise<RunbookProposal> {
    const next = planDecision(await this.getProposal(input.proposal_id), input);
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table, Item: proposalItem(next), ConditionExpression: '#d.#s = :open',
        ExpressionAttributeNames: { '#d': 'data', '#s': 'status' }, ExpressionAttributeValues: { ':open': 'open' },
      }));
    } catch (e) {
      if (errName(e) === 'ConditionalCheckFailedException') {
        const now = await this.getProposal(input.proposal_id);
        throw new ProposalClosedError(input.proposal_id, now?.status ?? 'decided');
      }
      throw e;
    }
    return next;
  }

  // ── applications ──
  async appendApplication(a: RunbookApplication): Promise<void> {
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table, ConditionExpression: 'attribute_not_exists(PK)',
        Item: { PK: `RB#${a.runbook_id}`, SK: `APP#${a.id}`, data: a },
      }));
    } catch (e) {
      if (errName(e) === 'ConditionalCheckFailedException') throw new AlreadyExistsError(`application ${a.id}`);
      throw e;
    }
  }
  async listApplications(runbookId: string, version?: number): Promise<RunbookApplication[]> {
    const items = await this.queryAll({ pk: `RB#${runbookId}`, skPrefix: 'APP#' });
    return items.map((i) => dataOf<RunbookApplication>(i) as RunbookApplication)
      .filter((a) => version === undefined || a.version === version)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  // ── briefs ──
  async putBrief(b: SessionBrief): Promise<void> {
    if (!b.run_ref) throw new InvalidWriteError('a brief needs a run_ref');
    try {
      await this.doc.send(new PutCommand({ TableName: this.table, Item: briefItem(b), ConditionExpression: 'attribute_not_exists(PK)' }));
    } catch (e) {
      if (errName(e) !== 'ConditionalCheckFailedException') throw e;
      const existing = await this.getBrief(b.run_ref);
      if (existing?.sha256 === b.sha256) return;
      throw new BriefExistsError(b.run_ref);
    }
  }
  getBrief(runRef: string): Promise<SessionBrief | null> { return this.get<SessionBrief>(briefKey(runRef)); }
  async listBriefs(q?: ListBriefsQuery): Promise<Page<SessionBrief>> {
    const rows = (await this.scanMeta('BRIEF#')).map((i) => dataOf<SessionBrief>(i) as SessionBrief);
    return paginate(rows.sort(byNewest((b) => b.assembled_at, (b) => b.id)), q?.cursor, q?.limit);
  }
}

