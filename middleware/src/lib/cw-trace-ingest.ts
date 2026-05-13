// CloudWatch Logs ingestion of agent trace bundles.
//
// AgentCore Runtime writes each agent's stdout to a per-agent log group:
//   /aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT
// Our instrumentation (agents/_shared/instrumentation.py::post_trace) emits
// one JSON line per invocation prefixed with `ORGIQ_TRACE:`. We poll all
// matching log groups every POLL_INTERVAL_MS, extract the lines, parse the
// JSON, and feed each bundle through the existing trace-sink processTrace()
// function — the same code path as the synchronous HTTP /trace endpoint.
//
// Why poll instead of subscription filters: AgentCore Runtime owns the log
// group lifecycle. We don't want to mutate the runtime's CW Logs config from
// the middleware, and subscription filters require an IAM trust handshake we
// can't manage from a developer machine. CW Logs Insights queries are read
// only and cost ~$0.005 per GB scanned — cheap at our trace volume.
//
// Idempotency: processTrace() persists rows with
//   INSERT INTO observability.invocation_traces ... ON CONFLICT DO NOTHING
// keyed on invocation_id, so a poll window that overlaps a prior window (or
// re-ingests a line the HTTP path already delivered) is safe.
//
// IAM: requires logs:DescribeLogGroups, logs:StartQuery, logs:GetQueryResults
// on /aws/bedrock-agentcore/runtimes/*. For local dev the operator's AWS
// profile is used. For production middleware deployment, ensure the
// middleware execution role has those permissions attached.

import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
  type GetQueryResultsCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs';
import { config } from '../config.js';
import { processTrace, type TraceInput } from './trace-sink.js';

// Log groups created by AgentCore Runtime follow:
//   /aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT
// where <runtime-id> is the underscored agent name (e.g. `orgiq_supervisor`).
const LOG_GROUP_PREFIX = '/aws/bedrock-agentcore/runtimes/';

// We only ingest from OrgIQ-owned runtimes, identified by the orgiq_ prefix.
// Any other runtime in the account is ignored even if it shares the log
// group prefix — keeps the query scope tight + the IAM blast radius small.
const AGENT_RUNTIME_PREFIX = 'orgiq_';

// CW Logs Insights per-query line cap. Set higher than we ever expect to
// emit in 30s so we don't silently drop traces under burst. The query is
// `limit 5000` server-side; this constant matches the SQL.
const QUERY_LIMIT = 5000;

// Discovery cache: log groups don't change frequently, but a freshly
// deployed runtime can appear mid-session. Refresh every 5 minutes.
const LOG_GROUP_CACHE_TTL_MS = 5 * 60_000;

// Poll cadence + initial-lookback. We start the cursor 5 minutes behind
// boot so a middleware restart picks up traces that landed during the
// restart gap. Subsequent polls advance the cursor to the previous endTime.
const POLL_INTERVAL_MS = 30_000;
const INITIAL_LOOKBACK_S = 300;

// Hard cap on the Insights polling loop. CW Logs Insights is async — we
// poll the query state up to (MAX_QUERY_POLL_ATTEMPTS * QUERY_POLL_DELAY_MS)
// before giving up. 30s budget keeps us inside the 30s poll cadence.
const QUERY_POLL_DELAY_MS = 1_000;
const MAX_QUERY_POLL_ATTEMPTS = 30;

const ORGIQ_TRACE_PREFIX = 'ORGIQ_TRACE:';

let _lastPollTs = Math.floor(Date.now() / 1000) - INITIAL_LOOKBACK_S;
let _client: CloudWatchLogsClient | null = null;
let _logGroupCache: { groups: string[]; fetchedAt: number } | null = null;

function client(): CloudWatchLogsClient {
  if (!_client) {
    // Match the construction style of middleware/src/providers/cloudwatch.ts —
    // region from config, default credential provider chain.
    _client = new CloudWatchLogsClient({ region: config.region });
  }
  return _client;
}

/**
 * Page through DescribeLogGroups (logs:DescribeLogGroups) and return every
 * log group whose name starts with our prefix AND whose runtime id starts
 * with `orgiq_`. The latter check guards against pulling in random runtimes
 * deployed to the same account.
 *
 * The result is cached for LOG_GROUP_CACHE_TTL_MS to keep the per-poll
 * overhead at 1 API call typical and 0 calls within the cache window.
 */
async function discoverLogGroups(): Promise<string[]> {
  const now = Date.now();
  if (_logGroupCache && now - _logGroupCache.fetchedAt < LOG_GROUP_CACHE_TTL_MS) {
    return _logGroupCache.groups;
  }

  const collected: string[] = [];
  let nextToken: string | undefined;
  try {
    do {
      const resp = await client().send(
        new DescribeLogGroupsCommand({
          logGroupNamePrefix: LOG_GROUP_PREFIX,
          nextToken,
        }),
      );
      for (const lg of resp.logGroups ?? []) {
        if (!lg.logGroupName) continue;
        // Trim the prefix to get the suffix (`<runtime-id>-DEFAULT`).
        const suffix = lg.logGroupName.slice(LOG_GROUP_PREFIX.length);
        if (suffix.startsWith(AGENT_RUNTIME_PREFIX)) {
          collected.push(lg.logGroupName);
        }
      }
      nextToken = resp.nextToken;
    } while (nextToken);
  } catch (err) {
    console.warn('[cw-ingest] discoverLogGroups failed:',
      (err as Error).message);
    // Keep last good cache if we have one; otherwise return [].
    if (_logGroupCache) return _logGroupCache.groups;
    return [];
  }

  _logGroupCache = { groups: collected, fetchedAt: now };
  return collected;
}

/**
 * Run one ingestion pass.
 *
 * Returns counts so callers (the boot logger + tests) can observe how many
 * bundles flowed through this poll. Both counters are best-effort: a
 * 0/0 return doesn't necessarily mean "no agents are running" — it might
 * mean "no agents emitted ORGIQ_TRACE in this window" or "Insights returned
 * an empty result set". The middleware log line distinguishes them.
 */
export async function pollOnce(): Promise<{ ingested: number; errors: number }> {
  const startTs = _lastPollTs;
  const endTs = Math.floor(Date.now() / 1000);
  // Defensive: if endTs <= startTs we'd have a zero-width query that some
  // SDKs reject. Bail and let the next tick widen the window.
  if (endTs <= startTs) {
    return { ingested: 0, errors: 0 };
  }

  const logGroups = await discoverLogGroups();
  if (logGroups.length === 0) {
    // Advance the cursor so we don't replay a wider window once log groups
    // appear; the worst-case is the first 30s of new runtime output goes
    // unscanned, which is acceptable.
    _lastPollTs = endTs;
    return { ingested: 0, errors: 0 };
  }

  // CW Logs Insights query string. We filter server-side to keep the result
  // set tiny + cheap, and sort by @timestamp so the JSON parse loop processes
  // bundles in roughly chronological order.
  const queryString = `
    fields @timestamp, @message
    | filter @message like /^ORGIQ_TRACE:/
    | sort @timestamp asc
    | limit ${QUERY_LIMIT}
  `;

  let queryId: string | undefined;
  try {
    const start = await client().send(
      new StartQueryCommand({
        logGroupNames: logGroups,
        startTime: startTs,
        endTime: endTs,
        queryString,
      }),
    );
    queryId = start.queryId;
  } catch (err) {
    console.warn('[cw-ingest] StartQuery failed:', (err as Error).message);
    return { ingested: 0, errors: 1 };
  }
  if (!queryId) return { ingested: 0, errors: 0 };

  // Poll for query completion. Insights queries are async; small windows
  // typically resolve in a few seconds.
  let result: GetQueryResultsCommandOutput | undefined;
  for (let i = 0; i < MAX_QUERY_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, QUERY_POLL_DELAY_MS));
    try {
      result = await client().send(new GetQueryResultsCommand({ queryId }));
    } catch (err) {
      console.warn('[cw-ingest] GetQueryResults failed:',
        (err as Error).message);
      return { ingested: 0, errors: 1 };
    }
    const status = result.status;
    if (status === 'Complete') break;
    if (status === 'Failed' || status === 'Cancelled' || status === 'Timeout') {
      console.warn(`[cw-ingest] query ${queryId} terminated with status ${status}`);
      return { ingested: 0, errors: 1 };
    }
  }
  if (!result || result.status !== 'Complete') {
    // Timed out; leave the cursor where it was so the next poll re-tries
    // the same window. Insights deduplicates by line, so retries are safe.
    return { ingested: 0, errors: 0 };
  }

  let ingested = 0;
  let errors = 0;
  const rows = result.results ?? [];
  for (const row of rows) {
    // Each row is an array of {field, value} pairs; @message holds the line.
    const msgField = row.find((f) => f.field === '@message');
    const raw = msgField?.value;
    if (typeof raw !== 'string') continue;
    const line = raw.trim();
    if (!line.startsWith(ORGIQ_TRACE_PREFIX)) continue;
    const json = line.slice(ORGIQ_TRACE_PREFIX.length).trim();
    if (!json) continue;
    let bundle: TraceInput;
    try {
      bundle = JSON.parse(json) as TraceInput;
    } catch (err) {
      errors++;
      console.warn('[cw-ingest] JSON parse failed:',
        (err as Error).message);
      continue;
    }
    try {
      // processTrace is ON CONFLICT DO NOTHING on invocation_id — re-ingesting
      // a bundle the HTTP path already persisted is a no-op at the DB layer.
      await processTrace(bundle);
      ingested++;
    } catch (err) {
      errors++;
      console.warn('[cw-ingest] processTrace failed:',
        (err as Error).message);
    }
  }

  // Advance the cursor only after a successful query (regardless of whether
  // we ingested anything). On query failure we leave it alone so the next
  // poll re-attempts the same window.
  _lastPollTs = endTs;
  return { ingested, errors };
}

let _intervalHandle: NodeJS.Timeout | null = null;

/**
 * Start the background trace poller. Idempotent — calling twice is a no-op.
 *
 * Honours OBS_TRACE_POLLER_DISABLED=1 as a kill switch (useful in unit tests
 * or when middleware is run with a stub AWS account for offline dev).
 */
export function startTracePoller(): void {
  if (_intervalHandle) return;
  if (process.env['OBS_TRACE_POLLER_DISABLED'] === '1') {
    console.log('[cw-ingest] OBS_TRACE_POLLER_DISABLED=1 — skipping start');
    return;
  }
  if (!config.region) {
    console.warn('[cw-ingest] no AWS_REGION configured; skipping start');
    return;
  }

  console.log(
    `[cw-ingest] starting trace poller, interval ${POLL_INTERVAL_MS / 1000}s`,
  );

  // Kick off an immediate poll so a freshly-booted middleware doesn't wait
  // 30s before pulling its first batch.
  void pollOnce()
    .then((r) => {
      console.log(
        `[cw-ingest] initial poll: ingested ${r.ingested} bundle(s), errors ${r.errors}`,
      );
    })
    .catch((err) =>
      console.warn('[cw-ingest] initial poll failed:', (err as Error).message),
    );

  _intervalHandle = setInterval(() => {
    pollOnce()
      .then((r) => {
        // Suppress the every-30s noise unless something happened.
        if (r.ingested > 0 || r.errors > 0) {
          console.log(
            `[cw-ingest] poll: ingested ${r.ingested}, errors ${r.errors}`,
          );
        }
      })
      .catch((err) =>
        console.warn('[cw-ingest] poll failed:', (err as Error).message),
      );
  }, POLL_INTERVAL_MS);
}

/** Stop the background poller. Safe to call when not running. */
export function stopTracePoller(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

// Test hook — reset the cursor + caches so unit tests can run multiple polls
// without stale state. Not used in normal operation.
export function _resetCursorForTest(): void {
  _lastPollTs = Math.floor(Date.now() / 1000) - INITIAL_LOOKBACK_S;
  _logGroupCache = null;
}
