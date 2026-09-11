// EMF emitter — writes Embedded Metric Format (EMF) JSON to CloudWatch Logs.
//
// CloudWatch automatically extracts EMF-formatted log events into metrics under
// the namespace + dimensions declared in the `_aws` envelope. This is cheaper
// than PutMetricData and supports high-cardinality dimensions.
//
// One log group, one stream per process. Stream creation is idempotent via the
// ResourceAlreadyExistsException catch. PutLogEvents failures are logged but
// never thrown — metric emission must not break the agent invocation path.

import {
  CloudWatchLogsClient,
  PutLogEventsCommand,
  CreateLogStreamCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { config } from '../config.js';
import { clock } from '../mock/core/clock.js';
import { mockEmitCanaryScore } from '../mock/canary-scores.js';

const LOG_GROUP = '/orgiq/canary/scores';
const STREAM = `host-${process.pid}-${Date.now()}`;

const client = new CloudWatchLogsClient({});

let streamReady: Promise<void> | null = null;

async function ensureStream(): Promise<void> {
  // Offline there is no log group to open a stream in. Returning early rather
  // than letting CreateLogStream throw is not cosmetic: `emitCanaryScore`
  // awaits this before every put, and the throw was the reason a judged ask
  // emitted nothing at all in dev:mock — see mock/canary-scores.ts.
  if (config.mock.cloudwatch) return;
  if (streamReady) return streamReady;
  streamReady = (async () => {
    try {
      await client.send(
        new CreateLogStreamCommand({
          logGroupName: LOG_GROUP,
          logStreamName: STREAM,
        }),
      );
    } catch (err) {
      const e = err as { name?: string };
      if (e?.name === 'ResourceAlreadyExistsException') return;
      // Don't reject — we still want to try PutLogEvents in case the stream
      // already exists but CreateLogStream returned a different error.
      console.warn('[emf-emitter] CreateLogStream failed', e?.name);
    }
  })();
  return streamReady;
}

export interface CanaryScoreRecord {
  canary_name: string;
  version_label: 'A' | 'B';
  prompt_arn: string;
  request_id: string;
  composite_score: number;
  latency_ms: number;
  error: 0 | 1;
  /**
   * The rubric dimensions the judge actually scored.
   *
   * Optional because a judge may ABSTAIN: the offline reader
   * (`mock/answer-check.ts`) cannot hear register, so it omits `tone` for
   * anything that is not a refusal rather than awarding it marks. An absent
   * key and a zero are different claims — "not measured" versus "measured and
   * bad" — and only the first is true, so the key is left out. CloudWatch
   * extracts `composite_score`, `latency_ms` and `error` as metrics; these
   * four are log properties, so an omitted one costs the metric nothing.
   */
  helpfulness?: number;
  factuality?: number;
  tone?: number;
  conciseness?: number;
  /**
   * Who scored it — set only when it was not the configured Bedrock model, so
   * a record read back out of the log group can never be mistaken for one a
   * model produced.
   */
  judged_by?: string;
}

export async function emitCanaryScore(rec: CanaryScoreRecord): Promise<void> {
  await ensureStream();
  if (config.mock.cloudwatch) {
    // The record still happens — it lands in the fixture that stands in for
    // the log group, so `GET /api/__mock/state` counts it and
    // `POST /api/__mock/reset` takes it back. What changes offline is where
    // the record lives, not whether it was written.
    mockEmitCanaryScore({ ...rec, emittedAt: clock.nowIso() });
    return;
  }
  const message = JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'OrgIQ/Canary',
          Dimensions: [['canary_name', 'version_label']],
          Metrics: [
            { Name: 'composite_score', Unit: 'None' },
            { Name: 'latency_ms', Unit: 'Milliseconds' },
            { Name: 'error', Unit: 'Count' },
          ],
        },
      ],
    },
    ...rec,
  });

  await client
    .send(
      new PutLogEventsCommand({
        logGroupName: LOG_GROUP,
        logStreamName: STREAM,
        logEvents: [{ timestamp: Date.now(), message }],
      }),
    )
    .catch((err: unknown) => {
      const e = err as { name?: string };
      console.warn('[emf-emitter] PutLogEvents failed', e?.name);
    });
}
