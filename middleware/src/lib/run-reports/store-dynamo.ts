// DynamoRunReportStore: the durable RunReportStore, in the runbook store's own
// single table (lib/runbooks/store-dynamo.ts) under its own key prefix:
//
//   PK           SK       item (entity under `data`)
//   RPT#<ref>    META     RunReport   GSI1PK RPTWI#<workItemId>  GSI1SK <endedAt>#<ref>
//                                    GSI2PK RPTINI#<initiative> GSI2SK <endedAt>#<ref>
//
// The index prefixes never meet the runbook rows' (SCOPE#…, PROPSTATUS#…).
// Write-once is a ConditionExpression; a lost race reads the winner back.
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Page } from '../runbooks/store.js';
import type { DebriefState, RunDebrief, RunReport } from './types.js';
import {
  checkReport, filterReports, pageReports,
  type ListRunReportsQuery, type RunReportStore,
} from './store.js';

type Item = Record<string, unknown>;
const errName = (e: unknown): string => (e as { name?: string })?.name ?? '';
const reportKey = (ref: string) => ({ PK: `RPT#${ref}`, SK: 'META' });

function reportItem(r: RunReport): Item {
  const sk = `${r.endedAt}#${r.runRef}`;
  return {
    ...reportKey(r.runRef), data: r,
    ...(r.workItemId ? { GSI1PK: `RPTWI#${r.workItemId}`, GSI1SK: sk } : {}),
    ...(r.initiativeId ? { GSI2PK: `RPTINI#${r.initiativeId}`, GSI2SK: sk } : {}),
  };
}

export class DynamoRunReportStore implements RunReportStore {
  readonly kind = 'dynamo' as const;
  private readonly doc: DynamoDBDocumentClient;

  constructor(client: DynamoDBClient, private readonly table: string) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  private async get<T>(key: { PK: string; SK: string }): Promise<T | null> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }));
    return out.Item ? (out.Item['data'] as T) : null;
  }

  async putReport(r: RunReport): Promise<{ report: RunReport; created: boolean }> {
    checkReport(r);
    try {
      await this.doc.send(new PutCommand({ TableName: this.table, Item: reportItem(r), ConditionExpression: 'attribute_not_exists(PK)' }));
      return { report: structuredClone(r), created: true };
    } catch (e) {
      if (errName(e) !== 'ConditionalCheckFailedException') throw e;
      const won = await this.getReport(r.runRef);
      if (!won) throw e;
      return { report: won, created: false };
    }
  }

  getReport(runRef: string): Promise<RunReport | null> { return this.get<RunReport>(reportKey(runRef)); }

  async setDebrief(runRef: string, debrief: RunDebrief, expect: DebriefState | null): Promise<RunReport | null> {
    // A report stored before lane C has no `debrief` key at all; `null` covers both that and an explicit null.
    const cond = expect === null
      ? 'attribute_exists(PK) AND (attribute_not_exists(#d.#db) OR #d.#db = :null)'
      : 'attribute_exists(PK) AND #d.#db.#st = :expect';
    try {
      const out = await this.doc.send(new UpdateCommand({
        TableName: this.table, Key: reportKey(runRef),
        UpdateExpression: 'SET #d.#db = :v',
        ConditionExpression: cond,
        ExpressionAttributeNames: { '#d': 'data', '#db': 'debrief', ...(expect === null ? {} : { '#st': 'state' }) },
        ExpressionAttributeValues: { ':v': debrief, ...(expect === null ? { ':null': null } : { ':expect': expect }) },
        ReturnValues: 'ALL_NEW',
      }));
      return (out.Attributes?.['data'] as RunReport | undefined) ?? null;
    } catch (e) {
      if (errName(e) === 'ConditionalCheckFailedException') return null;
      throw e;
    }
  }

  async listReports(q?: ListRunReportsQuery): Promise<Page<RunReport>> {
    let items: Item[];
    if (q?.workItemId) items = await this.query('GSI1', 'GSI1PK', `RPTWI#${q.workItemId}`);
    else if (q?.initiativeId) items = await this.query('GSI2', 'GSI2PK', `RPTINI#${q.initiativeId}`);
    else items = await this.scanReports();
    const rows = filterReports(items.map((i) => i['data'] as RunReport), q);
    return pageReports(rows, q);
  }

  private async query(index: string, attr: string, pk: string): Promise<Item[]> {
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(new QueryCommand({
        TableName: this.table, IndexName: index,
        KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': attr }, ExpressionAttributeValues: { ':pk': pk },
        ExclusiveStartKey: start,
      }));
      items.push(...((out.Items ?? []) as Item[]));
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  }

  private async scanReports(): Promise<Item[]> {
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(new ScanCommand({
        TableName: this.table, ConsistentRead: true,
        FilterExpression: 'SK = :m AND begins_with(PK, :p)', ExpressionAttributeValues: { ':m': 'META', ':p': 'RPT#' },
        ExclusiveStartKey: start,
      }));
      items.push(...((out.Items ?? []) as Item[]));
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  }
}
