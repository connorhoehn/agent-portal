// Pure DynamoDB reader for per-run score snapshots written by the scoring agent.
// Table: orgiq-scores  (person_id PK, timestamp SK, normalized_score number)

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { HistoryResponse, HistorySample } from './types.js';

const TABLE_NAME = process.env['DYNAMODB_SCORES_TABLE'] ?? 'orgiq-scores';

const raw = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(raw);

export async function getPersonHistory(
  personId: string,
  days: number,
): Promise<HistoryResponse> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'person_id = :pid AND #ts > :since',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: { ':pid': personId, ':since': since },
    }),
  );

  const items = (result.Items ?? []) as Array<{
    person_id: string;
    timestamp: string;
    normalized_score: number;
  }>;

  // Downsample: keep latest sample per calendar day
  const byDay = new Map<string, HistorySample>();
  for (const item of items) {
    const day = item.timestamp.slice(0, 10);
    const existing = byDay.get(day);
    if (!existing || item.timestamp > existing.ts) {
      byDay.set(day, { ts: item.timestamp, score: item.normalized_score });
    }
  }
  const samples = Array.from(byDay.values()).sort((a, b) =>
    a.ts.localeCompare(b.ts),
  );

  // Delta vs 7 days ago: find sample closest to (now - 7d), within ±2 days
  let deltaVs7d: number | null = null;
  if (samples.length > 0) {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

    let closest: HistorySample | null = null;
    let closestDist = Infinity;
    for (const s of samples) {
      const dist = Math.abs(new Date(s.ts).getTime() - sevenDaysAgo);
      if (dist < closestDist) {
        closestDist = dist;
        closest = s;
      }
    }

    const currentScore = samples[samples.length - 1]!.score;
    if (closest && closestDist <= twoDaysMs) {
      deltaVs7d = currentScore - closest.score;
    }
  }

  return { personId, samples, deltaVs7d };
}
