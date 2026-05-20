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

const LOG_GROUP = '/orgiq/canary/scores';
const STREAM = `host-${process.pid}-${Date.now()}`;

const client = new CloudWatchLogsClient({});

let streamReady: Promise<void> | null = null;

async function ensureStream(): Promise<void> {
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
  helpfulness: number;
  factuality: number;
  tone: number;
  conciseness: number;
}

export async function emitCanaryScore(rec: CanaryScoreRecord): Promise<void> {
  await ensureStream();
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
