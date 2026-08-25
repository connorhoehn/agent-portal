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
// keyed on invocation_id, so a poll window that overlaps a prior window
// re-ingests the same line harmlessly — the id in the bundle is the agent's
// own, and it is stable across polls.
//
// That guarantee covers THIS path only. It never covered the middleware's
// own `recordInvocation` write, despite an older comment here claiming it
// did: that path keys on the SSE runId the middleware minted, which is a
// different id for the same logical run, so the conflict never fired and
// every user-facing invocation landed twice. See invocations.ts —
// `shouldWriteMiddlewareTrace()` now makes the agent the sole writer
// whenever `isAgentTraceIngestionActive()` says a pipeline is carrying its
// bundles to Aurora.
//
// IAM: requires logs:DescribeLogGroups, logs:StartQuery, logs:GetQueryResults
// on /aws/bedrock-agentcore/runtimes/*. For local dev the operator's AWS
// profile is used. For production middleware deployment, ensure the
// middleware execution role has those permissions attached.

// ──────────────────────────────────────────────────────────────────────────
// MIGRATION NOTE (OI Phase 4):
//
// This poller reads legacy `ORGIQ_TRACE:<json>` lines from CW Logs. It's
// being phased out in favor of `OrgIQ-SpanProjector` Lambda which reads
// OpenInference-attributed OTel spans and projects them to the same Aurora
// tables.
//
// To retire this poller in production:
//   1. Deploy OrgIQ-SpanProjector (`cdk deploy OrgIQ-SpanProjector`).
//   2. Verify it's writing invocation_traces rows for live agent invocations.
//   3. Set OBS_USE_LEGACY_POLLER=false on the middleware service.
//   4. Once stable for ~1 week, delete this file + its startTracePoller import.
// ──────────────────────────────────────────────────────────────────────────

import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
  type GetQueryResultsCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  BedrockAgentCoreControlClient,
  ListAgentRuntimesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
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

// ── Ingestion authority ───────────────────────────────────────────────────
//
// Agents emit their own trace bundle (`ORGIQ_TRACE:` on stdout, plus the
// OpenInference spans the Span Projector reads) carrying the id THEY minted,
// their model, token counts, tool calls and parent link. When any pipeline is
// carrying those bundles into Aurora, the agent's row is the authoritative
// one and nothing else should write a second row for the same run.
//
// These two helpers name that decision so `invocations.ts` can consult it
// without duplicating knowledge of which env vars govern ingestion.

const LEGACY_POLLER_DISABLE_VALUES = new Set(['false', '0', 'no', 'off', 'disabled']);

/**
 * True when OBS_USE_LEGACY_POLLER asks for the legacy CW Logs poller (the
 * default). False hands the job to the OrgIQ-SpanProjector Lambda instead —
 * still an out-of-band ingestion path, just a different one.
 */
function legacyPollerRequested(): boolean {
  const flag = (process.env['OBS_USE_LEGACY_POLLER'] ?? 'true').trim().toLowerCase();
  return !LEGACY_POLLER_DISABLE_VALUES.has(flag);
}

/**
 * True when SOME out-of-band pipeline is expected to persist agent-emitted
 * trace bundles into observability.invocation_traces — either this poller or
 * the Span Projector Lambda that supersedes it.
 *
 * Deliberately not "is the interval handle set": the Span Projector runs in
 * Lambda, so a middleware that never starts the poller can still be in a
 * deployment where agents own their rows. The only configurations that mean
 * "nothing is ingesting" are the explicit kill switch and a missing region.
 */
export function isAgentTraceIngestionActive(): boolean {
  // Explicit kill switch — unit tests and offline/stub-account dev. Nothing
  // is reading agent stdout, so nothing will write the agent's row.
  if (process.env['OBS_TRACE_POLLER_DISABLED'] === '1') return false;
  // No region → no CW Logs client here, and no deployed projector to speak of.
  if (!config.region) return false;
  // Either this poller runs, or OBS_USE_LEGACY_POLLER=false handed the job to
  // the projector. Both end at the same table, keyed on the agent's own id.
  return true;
}

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

  // First: get the set of CURRENTLY DEPLOYED runtime IDs. AgentCore retains
  // log groups for old runtime versions even after the runtime is replaced,
  // so without this filter we end up trying to query 40+ stale groups —
  // which trips StartQuery's combined-list-length limit (~512 chars on
  // logGroupNames). Filter to active runtimes only.
  const activeRuntimeIds = new Set<string>();
  try {
    const ctrl = new BedrockAgentCoreControlClient({ region: config.region });
    const resp = await ctrl.send(new ListAgentRuntimesCommand({ maxResults: 50 }));
    for (const r of resp.agentRuntimes ?? []) {
      if (r.agentRuntimeId) activeRuntimeIds.add(r.agentRuntimeId);
    }
  } catch (err) {
    console.warn('[cw-ingest] list-agent-runtimes failed:',
      (err as Error).message);
    // Fall through — we'll filter on the orgiq_ prefix alone and hope the
    // group count stays under StartQuery's limits.
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
        if (!suffix.startsWith(AGENT_RUNTIME_PREFIX)) continue;
        // ORGIQ_TRACE lines come from agent stdout — AgentCore routes that to
        // the `-DEFAULT` log group, not the `-<endpoint>` ones.
        if (!suffix.endsWith('-DEFAULT')) continue;
        // If we resolved active runtimes, require the suffix to start with one
        // of them. Strips out stale-version log groups that AgentCore keeps
        // around indefinitely.
        if (activeRuntimeIds.size > 0) {
          const runtimeId = suffix.replace(/-DEFAULT$/, '');
          if (!activeRuntimeIds.has(runtimeId)) continue;
        }
        collected.push(lg.logGroupName);
      }
      nextToken = resp.nextToken;
    } while (nextToken);
  } catch (err) {
    console.warn('[cw-ingest] discoverLogGroups failed:',
      (err as Error).message);
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
// CW Logs has 30-60s ingestion delay before lines become queryable via
// Insights. If the poll window's endTs is `now`, the most recent agent
// emissions won't show up because they're still propagating. Lag the cursor
// by INGEST_LAG_S so queries hit the *eventually-consistent* portion of the
// stream. The price is a fixed extra ~minute of latency per trace; the
// alternative is missing every trace until the cursor laps it.
const INGEST_LAG_S = 60;

export async function pollOnce(): Promise<{ ingested: number; errors: number }> {
  const startTs = _lastPollTs;
  const endTs = Math.floor(Date.now() / 1000) - INGEST_LAG_S;
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
  // Match ORGIQ_TRACE: anywhere in the line — AgentCore Runtime sometimes
  // concatenates adjacent stdout writes into a single CW Logs @message, so
  // the prefix can appear after preceding text. The downstream parser
  // re-anchors on indexOf(prefix) and extracts the JSON object.
  const queryString = `
    fields @timestamp, @message
    | filter @message like /ORGIQ_TRACE:/
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
  let sampledOut = 0;
  let skipped = 0;
  let duplicates = 0;
  const rows = result.results ?? [];
  let matched = 0;
  for (const row of rows) {
    // Each row is an array of {field, value} pairs; @message holds the line.
    const msgField = row.find((f) => f.field === '@message');
    const raw = msgField?.value;
    if (typeof raw !== 'string') continue;
    // AgentCore Runtime concatenates adjacent stdout writes into one CW Logs
    // @message field, so the ORGIQ_TRACE: prefix can appear AFTER preceding
    // text (the agent's natural response). Find it anywhere in the line.
    const prefixIdx = raw.indexOf(ORGIQ_TRACE_PREFIX);
    if (prefixIdx < 0) continue;
    matched++;
    // Walk the substring after the prefix and extract the *matching* JSON
    // object using depth counting. We can't use lastIndexOf('}') — CW Logs
    // concatenates adjacent stdout writes, so the @message can contain output
    // AFTER the trace JSON whose stray `}` would cause us to slice past the
    // end of the bundle.
    const afterPrefix = raw.slice(prefixIdx + ORGIQ_TRACE_PREFIX.length);
    const firstBrace = afterPrefix.indexOf('{');
    if (firstBrace < 0) continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    let endBrace = -1;
    for (let i = firstBrace; i < afterPrefix.length; i++) {
      const ch = afterPrefix[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { endBrace = i; break; }
      }
    }
    if (endBrace < 0) continue;
    const json = afterPrefix.slice(firstBrace, endBrace + 1);
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
      // processTrace is ON CONFLICT DO NOTHING on invocation_id, and this
      // bundle carries the agent's own id — so re-polling an overlapping
      // window is a no-op at the DB layer. (It does NOT dedupe against the
      // middleware's `recordInvocation` write, which keys on a different id;
      // that path is now gated off whenever this one is running.)
      // Count what actually landed: it returns sampled=false when the trace was
      // dropped by the sampling gate, and inserted=false for a duplicate. The
      // old code counted every call as "persisted", so a 10% sample rate read
      // as "persisted 2" while the table gained nothing — which made the
      // observability pages look broken with no way to tell why.
      const result = await processTrace(bundle);
      if (result.inserted) ingested++;
      else if (result.sampled === false) sampledOut++;
      else if (result.skipped) skipped++;
      else duplicates++;
    } catch (err) {
      errors++;
      console.warn('[cw-ingest] processTrace failed:',
        (err as Error).message);
    }
  }

  // Advance the cursor only after a successful query (regardless of whether
  // we ingested anything). On query failure we leave it alone so the next
  // poll re-attempts the same window.
  // Only log when something interesting happened — avoid spamming once-per-30s
  // when there's no agent activity. matched but not persisted is worth seeing.
  if (matched > 0 || errors > 0) {
    const detail = [
      `persisted ${ingested}`,
      sampledOut > 0 ? `sampled-out ${sampledOut}` : '',
      skipped > 0 ? `phantom-skipped ${skipped}` : '',
      duplicates > 0 ? `duplicate ${duplicates}` : '',
      `parse errors ${errors}`,
    ].filter(Boolean).join(', ');
    console.log(`[cw-ingest] matched ${matched} line(s); ${detail}`);
  }
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
  // Feature flag: when the OI Span Projector is verified in production, flip
  // OBS_USE_LEGACY_POLLER=false to retire this legacy ingestion path without
  // a redeploy. Default = true (poller runs as before).
  //
  // See: docs.ag-ui.com + OpenInference Phase 4 plan.
  if (!legacyPollerRequested()) {
    console.log('[cw-trace-ingest] OBS_USE_LEGACY_POLLER=false — legacy poller disabled. OI Span Projector should be producing rows instead.');
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
        // Suppress per-poll noise — only log when ingestion actually happened
        // or errors fired. The inner pollOnce already logs match/persist counts
        // when matched > 0.
        if (r.ingested > 0 || r.errors > 0) {
          console.log(`[cw-ingest] poll: ingested ${r.ingested}, errors ${r.errors}`);
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
