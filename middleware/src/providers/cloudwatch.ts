// CloudWatch + X-Ray provider for observability summary + traces.
//
// Real implementation:
//   - getSummary(): aggregates Invocations / Errors / Latency / Tokens from CloudWatch
//     metrics (AWS/BedrockAgentCore + custom OrgIQ namespace) over last 24h. Returns
//     a zero-state summary when no metrics exist yet (pre-runtime-deployment).
//   - listTraces(limit, scope): GetTraceSummaries (filtered to the caller's
//     `user_id` / `tenant` annotations, lib/trace-owner.ts) → BatchGetTraces.
//   - getTrace(id): BatchGetTraces for a single trace ID.
//
// X-Ray → internal Trace mapping is SIMPLIFIED: we return traceId, agentId,
// startTime, totalDurationMs, status, tokensIn/Out from segment annotations
// when present, and spans:[] empty. The UI mainly needs trace count + summary
// fields today; full span tree mapping is a TODO once real traces flow in.
//
// Mock implementation mirrors the existing /api/observability route behavior.
import {
  XRayClient,
  GetTraceSummariesCommand,
  BatchGetTracesCommand,
  type TraceSummary,
  type Trace as XRayTrace,
} from '@aws-sdk/client-xray';
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  PutMetricDataCommand,
  Statistic,
  type GetMetricStatisticsCommandInput,
} from '@aws-sdk/client-cloudwatch';
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { config } from '../config.js';
import { realAgentCore } from './agentcore.js';
import type { AgentRuntimeSummary } from './types.js';
import { mockTraces } from '../mock/traces.js';
import { TRACE_OWNER_ANNOTATIONS, traceInScope, xrayScopeFilter } from '../lib/trace-owner.js';
import type { TraceScope } from '../lib/trace-scope.js';
import { mockAgents } from '../mock/agent-statuses.js';
import type {
  BedrockInvocationEntry,
  CloudWatchProvider,
  GuardrailMetricPoint,
  GuardrailMetricsSummary,
  ObservabilitySummary,
  Trace,
  TraceSpan,
} from './types.js';

// ── Mock provider ─────────────────────────────────────────────────────────────

export const mockCloudWatch: CloudWatchProvider = {
  // Every number here is a sum over `mockAgents`, and since the fixture floor
  // landed every per-agent number there is itself COUNTED from the invocation
  // rows the Invocations page lists (mock/invocations.ts). So Health, the
  // Architecture graph and that list are three sums over one set of rows — the
  // arrangement that makes "Health promises 25 errors, the list shows 6"
  // structurally impossible rather than merely fixed.
  async getSummary(): Promise<ObservabilitySummary> {
    const fleet = [...mockAgents];
    const totalInvocations = fleet.reduce((s, a) => s + a.invocationsLast24h, 0);
    const totalErrors = fleet.reduce((s, a) => s + a.errorsLast24h, 0);
    const totalTokens = fleet.reduce((s, a) => s + a.tokensLast24h, 0);
    // An empty fleet is a real state now (the `empty` scenario, and a real
    // account before its first deploy). Dividing by its length produced NaN;
    // zero-filling it instead was the other wrong answer, because an average
    // latency of 0ms is not a measurement of an empty fleet, it is a claim
    // that the fleet is infinitely fast. `null` is the honest third option,
    // and the tile already renders it as "—".
    const avgLatency =
      fleet.length > 0 ? Math.round(fleet.reduce((s, a) => s + a.latencyP50Ms, 0) / fleet.length) : null;
    const successRate =
      totalInvocations > 0
        ? (((totalInvocations - totalErrors) / totalInvocations) * 100).toFixed(1)
        : '0.0';
    return {
      totalInvocations24h: totalInvocations,
      totalErrors24h: totalErrors,
      totalTokens24h: totalTokens,
      avgLatencyMs: avgLatency,
      successRate,
      traceCount: mockTraces.length,
    };
  },

  async listTraces(limit: number, scope: TraceScope | null = null): Promise<Trace[]> {
    return mockTraces.filter((t) => traceInScope(scope, t)).slice(0, limit);
  },

  async getTrace(traceId: string): Promise<Trace | null> {
    return mockTraces.find((t) => t.traceId === traceId) ?? null;
  },

  async listBedrockInvocations(): Promise<BedrockInvocationEntry[]> {
    return [];
  },

  async getGuardrailMetrics(_guardrailId, hours): Promise<GuardrailMetricsSummary> {
    // Synthesize a flat-zero series so the UI still renders during offline dev.
    const now = Date.now();
    const series: GuardrailMetricPoint[] = Array.from({ length: hours }, (_, i) => ({
      timestamp: new Date(now - (hours - i - 1) * 60 * 60 * 1000).toISOString(),
      invocations: 0,
      interventions: 0,
    }));
    return {
      totalInvocations: 0,
      totalInterventions: 0,
      interventionRate: '0.0',
      series,
    };
  },
};

// ── Real provider ─────────────────────────────────────────────────────────────

const xray = new XRayClient({ region: config.region });
const cw = new CloudWatchClient({ region: config.region });
const cwLogs = new CloudWatchLogsClient({ region: config.region });

const BEDROCK_INVOCATION_LOG_GROUP = '/orgiq/bedrock-invocations';

// Pull agent name out of `arn:...:assumed-role/orgiq-<agent>-execution-role/...`.
function agentFromRoleArn(arn: string | undefined): string {
  if (!arn) return 'unknown';
  const m = arn.match(/assumed-role\/[^/]+/);
  if (!m) return 'unknown';
  const role = m[0].replace('assumed-role/', '');
  const name = role.replace(/^orgiq-/, '').replace(/-execution-role$/, '');
  return name || 'unknown';
}

function snippetText(text: string, max = 200): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

const ZERO_SUMMARY: ObservabilitySummary = {
  totalInvocations24h: 0,
  totalErrors24h: 0,
  totalTokens24h: 0,
  avgLatencyMs: null,
  successRate: '0.0',
  traceCount: 0,
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// AWS publishes AgentCore metrics under a HYPHENATED namespace. The
// unhyphenated spelling does not exist — a GetMetricStatistics against it
// returns an empty Datapoints array rather than an error, so this page
// reported a confident 0 invocations / 0.0% success rate while 116 real
// invocations sat in the account. agentcore.ts had the correct spelling all
// along, which is why /api/agents and this summary disagreed.
const NAMESPACE_AGENTCORE = 'AWS/Bedrock-AgentCore';

// Account-wide roll-up dimension. AgentCore emits every per-runtime metric
// with Resource/Operation dimensions, so an undimensioned query matches
// nothing; AggregateOperation is the only cross-runtime total published, and
// it comes in two flavours (direct invokes vs. the command API).
const AGGREGATE_OPERATIONS = ['InvokeAgentRuntime', 'InvokeAgentRuntimeCommand'];

/**
 * Sum a metric over the last 24h across one or more dimension sets.
 *
 * `dimensionSets` defaults to a single undimensioned query. Pass explicit
 * sets when the metric is only published with dimensions — CloudWatch treats
 * a dimension-less query as its own distinct series and silently returns no
 * datapoints rather than rolling up, which is exactly how this file came to
 * report a confident zero.
 */
async function sumMetric(
  namespace: string,
  metricName: string,
  dimensionSets: Array<Array<{ Name: string; Value: string }>> = [[]],
): Promise<number> {
  const end = new Date();
  const start = new Date(end.getTime() - ONE_DAY_MS);
  const totals = await Promise.all(
    dimensionSets.map(async (dims) => {
      const input: GetMetricStatisticsCommandInput = {
        Namespace: namespace,
        MetricName: metricName,
        ...(dims.length ? { Dimensions: dims } : {}),
        StartTime: start,
        EndTime: end,
        Period: 3600,
        Statistics: ['Sum'],
      };
      try {
        const out = await cw.send(new GetMetricStatisticsCommand(input));
        return (out.Datapoints ?? []).reduce((s, d) => s + (d.Sum ?? 0), 0);
      } catch {
        return 0;
      }
    }),
  );
  return totals.reduce((s, n) => s + n, 0);
}

/** The two aggregate dimension sets AgentCore publishes cross-runtime totals under. */
const AGGREGATE_DIMS = AGGREGATE_OPERATIONS.map((op) => [
  { Name: 'AggregateOperation', Value: op },
]);

// Infer span kind from a segment/subsegment name when annotations don't carry it.
function inferKind(name: string): TraceSpan['kind'] {
  const n = name.toLowerCase();
  if (n.includes('model') || n.includes('bedrock') || n.includes('llm')) return 'llm';
  if (n.includes('retrieve') || n.includes('kb') || n.includes('knowledge')) return 'retrieval';
  if (n.includes('tool')) return 'tool';
  return 'agent';
}

interface SegmentDoc { annotations?: Record<string, unknown>; subsegments?: SegmentDoc[] }

/**
 * The owner annotations (TRACE_OWNER_ANNOTATIONS) of a segment document, from
 * the segment itself or the first of its subsegments that names them.
 * Exported for the tests.
 */
export function ownerAnnotations(doc: SegmentDoc, depth = 0): { userId: string | null; tenant: string | null } {
  const ann = doc.annotations ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  let userId = str(ann[TRACE_OWNER_ANNOTATIONS.user]);
  let tenant = str(ann[TRACE_OWNER_ANNOTATIONS.tenant]);
  if ((userId && tenant) || depth >= 8) return { userId, tenant };
  for (const sub of doc.subsegments ?? []) {
    const inner = ownerAnnotations(sub, depth + 1);
    userId ??= inner.userId;
    tenant ??= inner.tenant;
    if (userId && tenant) break;
  }
  return { userId, tenant };
}

// Map an X-Ray trace document to our simplified Trace shape.
// TODO: implement full segment → span tree mapping once real traces arrive.
function mapXRayTrace(xt: XRayTrace): Trace | null {
  const traceId = xt.Id;
  if (!traceId) return null;

  // X-Ray Segments[].Document is a JSON string; parse the first one to extract
  // root segment fields (name, start_time, annotations, error flag).
  let agentName = 'unknown';
  let startTimeMs = 0;
  let status: Trace['status'] = 'ok';
  let tokensIn = 0;
  let tokensOut = 0;
  // The owner, from the first segment that names one (`user_id` / `tenant` annotations).
  let userId: string | null = null;
  let tenant: string | null = null;

  for (const seg of xt.Segments ?? []) {
    if (!seg.Document) continue;
    try {
      const doc = JSON.parse(seg.Document) as {
        name?: string;
        start_time?: number;
        error?: boolean;
        fault?: boolean;
        annotations?: Record<string, string | number>;
        subsegments?: SegmentDoc[];
      };
      if (agentName === 'unknown' && doc.name) agentName = doc.name;
      if (startTimeMs === 0 && doc.start_time) {
        startTimeMs = doc.start_time * 1000;
      }
      if (doc.error || doc.fault) status = 'error';
      const ann = doc.annotations ?? {};
      const ti = ann['tokens.in'];
      const to = ann['tokens.out'];
      if (typeof ti === 'number') tokensIn += ti;
      if (typeof to === 'number') tokensOut += to;
      // The agents tag every span (root and children alike); an OTel span
      // that X-Ray stores as a subsegment carries them one level down.
      const owner = ownerAnnotations(doc);
      if (userId === null && owner.userId) userId = owner.userId;
      if (tenant === null && owner.tenant) tenant = owner.tenant;
    } catch {
      // ignore malformed segment doc
    }
  }

  return {
    traceId,
    rootSpan: traceId,
    agentId: agentName,
    agentName,
    startTime: startTimeMs > 0 ? new Date(startTimeMs).toISOString() : new Date().toISOString(),
    totalDurationMs: Math.round((xt.Duration ?? 0) * 1000),
    spanCount: (xt.Segments ?? []).length,
    status,
    tokensIn,
    tokensOut,
    spans: [], // TODO: flatten segments + subsegments into TraceSpan[]
    userId,
    tenant,
  };
}

/**
 * Lower-bound count of X-Ray traces in the last 24h.
 *
 * GetTraceSummaries walks the time range page by page and routinely returns
 * an EMPTY first page with a NextToken — reading only page one reported zero
 * traces against an account holding tens of thousands, which in turn made the
 * health page claim span export was broken when it was fine. We page until we
 * have enough evidence to answer "are traces flowing?", then stop: the exact
 * total is not worth tens of API calls.
 */
const TRACE_PAGE_LIMIT = 10;
const TRACE_COUNT_ENOUGH = 25;

// ── Summary / traces TTL cache ────────────────────────────────────────────────
//
// /api/observability/summary polls getSummary on every dashboard tick, and each
// call bills a GetMetricData (listRuntimes) + two GetMetricStatistics (tokens) +
// a GetTraceSummaries against CloudWatch/X-Ray — all charged per request. The
// window is a fixed 24h, so ~15s of staleness is irrelevant. listTraces is polled
// the same way and is cached per-limit.
//
// Blind results are NOT pinned for the full TTL: getSummary returns the shared
// ZERO_SUMMARY sentinel both when the account is genuinely empty AND when a
// credential/CloudWatch outage swallows every inner call, and listTraces returns
// [] on error. Caching those would mask a later recovery, so we only cache a real
// (non-sentinel / non-empty) result.
const SUMMARY_TTL_MS = (() => {
  const n = Number.parseInt(process.env['OBS_SUMMARY_TTL_MS'] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 15_000;
})();

let summaryCache: { value: ObservabilitySummary; fetchedAt: number } | null = null;
/** Keyed by limit and scope: one caller's cached list is never another's answer. */
const tracesCache = new Map<string, { value: Trace[]; fetchedAt: number }>();

/** Test hook: drop the cached summary + traces so a fresh call re-hits the API. */
export function __resetObservabilityCache(): void {
  summaryCache = null;
  tracesCache.clear();
}

async function countTraces(): Promise<number> {
  const end = new Date();
  const start = new Date(end.getTime() - ONE_DAY_MS);
  let token: string | undefined;
  let seen = 0;
  try {
    for (let page = 0; page < TRACE_PAGE_LIMIT; page++) {
      const out: { TraceSummaries?: unknown[]; NextToken?: string } = await xray.send(
        new GetTraceSummariesCommand({
          StartTime: start,
          EndTime: end,
          ...(token ? { NextToken: token } : {}),
        }),
      );
      seen += (out.TraceSummaries ?? []).length;
      if (seen >= TRACE_COUNT_ENOUGH) break;
      token = out.NextToken;
      if (!token) break;
    }
  } catch {
    return seen;
  }
  return seen;
}

/**
 * Fleet health over the last 24h.
 *
 * Invocations, errors, and latency are summed over OrgIQ's own deployed
 * runtimes rather than the account-wide AggregateOperation roll-up. This
 * account hosts other teams' agents too, so the roll-up would attribute
 * their traffic to us; it also guarantees this endpoint and /api/agents
 * agree, which they did not when each computed its own totals.
 *
 * Tokens remain account-wide — Bedrock publishes InputTokenCount without a
 * per-runtime dimension, so there is nothing to scope it by.
 *
 * Returns the shared ZERO_SUMMARY sentinel (by reference) for both the
 * genuinely-empty and the everything-failed cases, so the caching wrapper can
 * tell a real result from a blind one.
 */
async function computeSummary(): Promise<ObservabilitySummary> {
    try {
      const [runtimes, tokens, traceCount] = await Promise.all([
        realAgentCore.listRuntimes().catch(() => [] as AgentRuntimeSummary[]),
        (async () =>
          (await sumMetric('AWS/Bedrock', 'InputTokenCount')) +
          (await sumMetric('AWS/Bedrock', 'OutputTokenCount')))(),
        countTraces(),
      ]);

      const invocations = runtimes.reduce((n: number, r: AgentRuntimeSummary) => n + (r.invocationsLast24h ?? 0), 0);
      const errors = runtimes.reduce((n: number, r: AgentRuntimeSummary) => n + (r.errorsLast24h ?? 0), 0);

      // Weight each runtime's latency by how much traffic it actually took —
      // a plain mean lets an idle agent's cold-start dominate a busy one.
      const weighted = runtimes.reduce(
        (n: number, r: AgentRuntimeSummary) => n + (r.latencyP50Ms ?? 0) * (r.invocationsLast24h ?? 0),
        0,
      );
      const latencyAvg = invocations > 0 ? Math.round(weighted / invocations) : null;

      if (invocations === 0 && errors === 0 && tokens === 0 && traceCount === 0) {
        return ZERO_SUMMARY;
      }

      const successRate =
        invocations > 0
          ? (((invocations - errors) / invocations) * 100).toFixed(1)
          : '0.0';
      return {
        totalInvocations24h: Math.round(invocations),
        totalErrors24h: Math.round(errors),
        totalTokens24h: Math.round(tokens),
        avgLatencyMs: latencyAvg,
        successRate,
        traceCount,
      };
    } catch {
      return ZERO_SUMMARY;
    }
}

async function computeListTraces(limit: number, scope: TraceScope | null): Promise<Trace[]> {
    // The caller's traces only (the route filters again): a scope the filter language cannot quote reads nothing.
    const filter = xrayScopeFilter(scope);
    if (filter === null) return [];
    try {
      const end = new Date();
      const start = new Date(end.getTime() - ONE_DAY_MS);
      const summaries = await xray.send(
        new GetTraceSummariesCommand({ StartTime: start, EndTime: end, ...(filter ? { FilterExpression: filter } : {}) }),
      );
      const ids = ((summaries.TraceSummaries ?? []) as TraceSummary[])
        .map((s) => s.Id)
        .filter((id): id is string => Boolean(id))
        .slice(0, limit);
      if (ids.length === 0) return [];

      // BatchGetTraces accepts up to 5 trace IDs per call.
      const batches: string[][] = [];
      for (let i = 0; i < ids.length; i += 5) batches.push(ids.slice(i, i + 5));
      const results: Trace[] = [];
      for (const batch of batches) {
        const out = await xray.send(new BatchGetTracesCommand({ TraceIds: batch }));
        for (const xt of out.Traces ?? []) {
          const t = mapXRayTrace(xt);
          if (t) results.push(t);
        }
      }
      return results;
    } catch {
      return [];
    }
}

export const realCloudWatch: CloudWatchProvider = {
  async getSummary(): Promise<ObservabilitySummary> {
    const now = Date.now();
    if (summaryCache && now - summaryCache.fetchedAt < SUMMARY_TTL_MS) {
      return summaryCache.value;
    }
    const value = await computeSummary();
    // ZERO_SUMMARY (by reference) means empty-or-blind — don't pin it, so a
    // credential/CloudWatch recovery isn't masked by a stale zero.
    if (value !== ZERO_SUMMARY) {
      summaryCache = { value, fetchedAt: now };
    }
    return value;
  },

  async listTraces(limit: number, scope: TraceScope | null = null): Promise<Trace[]> {
    const now = Date.now();
    const key = `${limit}|${scope ? `${scope.tenant}|${scope.userId ?? '*'}` : 'all'}`;
    const hit = tracesCache.get(key);
    if (hit && now - hit.fetchedAt < SUMMARY_TTL_MS) return hit.value;
    const value = await computeListTraces(limit, scope);
    // An empty list is also what an X-Ray outage returns — cache only a real hit.
    if (value.length > 0) tracesCache.set(key, { value, fetchedAt: now });
    return value;
  },

  async getTrace(traceId: string): Promise<Trace | null> {
    try {
      const out = await xray.send(new BatchGetTracesCommand({ TraceIds: [traceId] }));
      const xt = (out.Traces ?? [])[0];
      if (!xt) return null;
      return mapXRayTrace(xt);
    } catch {
      return null;
    }
  },

  async listBedrockInvocations({ limit, sinceMs }): Promise<BedrockInvocationEntry[]> {
    const startTime = Date.now() - (sinceMs ?? 60 * 60 * 1000); // default last 1h
    try {
      const resp = await cwLogs.send(
        new FilterLogEventsCommand({
          logGroupName: BEDROCK_INVOCATION_LOG_GROUP,
          startTime,
          limit: Math.max(limit, 100), // overshoot — many events aren't JSON (validation messages)
        }),
      );
      const events = resp.events ?? [];
      const out: BedrockInvocationEntry[] = [];
      for (const e of events) {
        const text = e.message ?? '';
        if (!text.startsWith('{')) continue;
        let msg: any;
        try {
          msg = JSON.parse(text);
        } catch {
          continue;
        }
        const inputBody = msg.input?.inputBodyJson ?? {};
        const outputBody = msg.output?.outputBodyJson ?? {};

        // Last user message → prompt; assistant text → response
        const messages = inputBody.messages ?? [];
        const lastUser = [...messages].reverse().find((m: any) => m.role === 'user');
        const prompt = lastUser?.content?.[0]?.text ?? '';
        const responseBlocks = outputBody?.output?.message?.content ?? [];
        const response = responseBlocks
          .map((c: any) => c?.text ?? '')
          .join('')
          .trim();

        // Detect interventions from guardrail trace
        const interventions: BedrockInvocationEntry['interventions'] = [];
        const trace = outputBody?.trace?.guardrail;
        if (trace && typeof trace === 'object') {
          const collectFromAssessments = (assessments: any, source: 'INPUT' | 'OUTPUT') => {
            if (!assessments) return;
            const lists = Array.isArray(assessments) ? assessments : [assessments];
            for (const a of lists) {
              for (const t of a?.topicPolicy?.topics ?? []) {
                if (t.action === 'BLOCKED' || t.detected) {
                  interventions.push({ source, policyType: 'TopicPolicy', detail: t.name ?? 'unknown' });
                }
              }
              for (const f of a?.contentPolicy?.filters ?? []) {
                if (f.action === 'BLOCKED' || f.detected) {
                  interventions.push({ source, policyType: 'ContentPolicy', detail: f.type ?? 'unknown' });
                }
              }
              for (const f of a?.sensitiveInformationPolicy?.piiEntities ?? []) {
                if (f.action === 'BLOCKED' || f.action === 'ANONYMIZED') {
                  interventions.push({ source, policyType: 'PII', detail: f.type ?? 'unknown' });
                }
              }
              for (const w of a?.wordPolicy?.customWords ?? []) {
                if (w.action === 'BLOCKED' || w.detected) {
                  interventions.push({ source, policyType: 'WordPolicy', detail: w.match ?? 'unknown' });
                }
              }
            }
          };
          for (const [, ass] of Object.entries(trace.inputAssessment ?? {})) {
            collectFromAssessments(ass, 'INPUT');
          }
          for (const [, ass] of Object.entries(trace.outputAssessments ?? {})) {
            collectFromAssessments(ass, 'OUTPUT');
          }
        }

        out.push({
          requestId: msg.requestId ?? '',
          timestamp: msg.timestamp ?? new Date(e.timestamp ?? Date.now()).toISOString(),
          agent: agentFromRoleArn(msg.identity?.arn),
          modelId: msg.modelId ?? '',
          operation: msg.operation ?? '',
          promptSnippet: snippetText(prompt),
          responseSnippet: snippetText(response),
          inputTokens: Number(msg.input?.inputTokenCount ?? 0),
          outputTokens: Number(msg.output?.outputTokenCount ?? 0),
          durationGuess: 0,
          intervened: interventions.length > 0,
          interventions,
        });
        if (out.length >= limit) break;
      }
      // Newest first
      return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    } catch (err) {
      console.warn('[cloudwatch] listBedrockInvocations failed:', (err as Error).message);
      return [];
    }
  },

  async getGuardrailMetrics(guardrailId, hours): Promise<GuardrailMetricsSummary> {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);

    // AWS/Bedrock/Guardrails — per-guardrail metrics keyed on (GuardrailArn,
    // GuardrailVersion). We sum across DRAFT and "1" since agents may have
    // been pointed at either over the lookback window.
    const guardrailArn = `arn:aws:bedrock:${config.region}:${config.accountId}:guardrail/${guardrailId}`;
    const versions = ['DRAFT', '1'];

    const fetchSeries = async (metric: string, version: string): Promise<Map<string, number>> => {
      try {
        const out = await cw.send(
          new GetMetricStatisticsCommand({
            Namespace: 'AWS/Bedrock/Guardrails',
            MetricName: metric,
            Dimensions: [
              { Name: 'GuardrailArn', Value: guardrailArn },
              { Name: 'GuardrailVersion', Value: version },
            ],
            StartTime: start,
            EndTime: end,
            Period: 3600,
            Statistics: [Statistic.Sum],
          }),
        );
        const m = new Map<string, number>();
        for (const d of out.Datapoints ?? []) {
          if (!d.Timestamp) continue;
          m.set(d.Timestamp.toISOString(), d.Sum ?? 0);
        }
        return m;
      } catch {
        return new Map();
      }
    };

    // Sum the same metric across versions into one map per metric.
    const mergeMaps = (maps: Map<string, number>[]): Map<string, number> => {
      const merged = new Map<string, number>();
      for (const m of maps) {
        for (const [k, v] of m.entries()) {
          merged.set(k, (merged.get(k) ?? 0) + v);
        }
      }
      return merged;
    };

    const invMaps = await Promise.all(versions.map((v) => fetchSeries('Invocations', v)));
    const intvMaps = await Promise.all(versions.map((v) => fetchSeries('InvocationsIntervened', v)));
    const invByExactTs = mergeMaps(invMaps);
    const intvByExactTs = mergeMaps(intvMaps);

    // CloudWatch's response timestamps don't always land on the hour boundary
    // (e.g. 19:21 when we asked for Period=3600), so we can't reverse-lookup by
    // expected key. Re-bucket by rounding each datapoint down to its hour.
    const reBucket = (m: Map<string, number>): Map<string, number> => {
      const out = new Map<string, number>();
      for (const [k, v] of m.entries()) {
        const t = new Date(k).getTime();
        const bucketKey = new Date(Math.floor(t / 3_600_000) * 3_600_000).toISOString();
        out.set(bucketKey, (out.get(bucketKey) ?? 0) + v);
      }
      return out;
    };
    const inv = reBucket(invByExactTs);
    const intv = reBucket(intvByExactTs);

    // Build a continuous hour-bucket series so the chart isn't full of gaps.
    const series: GuardrailMetricPoint[] = [];
    for (let i = 0; i < hours; i++) {
      const ts = new Date(start.getTime() + i * 60 * 60 * 1000);
      // CloudWatch returns timestamps aligned to the period boundary; we
      // match on the bucket's ISO string.
      const key = new Date(Math.floor(ts.getTime() / (3600 * 1000)) * 3600 * 1000).toISOString();
      series.push({
        timestamp: ts.toISOString(),
        invocations: Math.round(inv.get(key) ?? 0),
        interventions: Math.round(intv.get(key) ?? 0),
      });
    }

    const totalInvocations = series.reduce((s, p) => s + p.invocations, 0);
    const totalInterventions = series.reduce((s, p) => s + p.interventions, 0);
    const rate = totalInvocations > 0
      ? ((totalInterventions / totalInvocations) * 100).toFixed(1)
      : '0.0';

    return {
      totalInvocations,
      totalInterventions,
      interventionRate: rate,
      series,
    };
  },
};

// ── OrgIQ/Observability metric publishers ─────────────────────────────────────
//
// The trace-sink (middleware/src/lib/trace-sink.ts) calls these after embedding
// + judging a sampled invocation. Each publishes a single datapoint into the
// `OrgIQ/Observability` namespace; alarms in the AgentCoreTelemetry stack read
// from the same namespace.
//
// All calls are fire-and-forget: failures log and swallow so an outage of
// CloudWatch never blocks the agent invocation path.

const OBS_NAMESPACE = 'OrgIQ/Observability';

async function putMetric(
  metricName: string,
  value: number,
  dimensions: Array<{ Name: string; Value: string }>,
  unit: 'None' | 'Count' | 'Percent' = 'None',
): Promise<void> {
  if (!Number.isFinite(value)) return;
  try {
    await cw.send(
      new PutMetricDataCommand({
        Namespace: OBS_NAMESPACE,
        MetricData: [
          {
            MetricName: metricName,
            Value: value,
            Unit: unit,
            Dimensions: dimensions,
            Timestamp: new Date(),
          },
        ],
      }),
    );
  } catch (err) {
    console.warn(`[cloudwatch] putMetric ${metricName} failed:`,
      (err as Error).message);
  }
}

/** Publish embedding-drift cosine distance (0..2). Dim: AgentId, TemplateId. */
export async function putDriftMetric(
  agentId: string,
  templateId: string,
  value: number,
): Promise<void> {
  await putMetric(
    'EmbeddingDriftP95',
    value,
    [
      { Name: 'AgentId', Value: agentId || 'unknown' },
      { Name: 'TemplateId', Value: templateId || 'default' },
    ],
    'None',
  );
}

/** Publish a single judge score (0..1). Dim: AgentId. */
export async function putQualityMetric(
  agentId: string,
  score: number,
): Promise<void> {
  await putMetric(
    'JudgeScore',
    score,
    [{ Name: 'AgentId', Value: agentId || 'unknown' }],
    'None',
  );
}

/** Publish per-invocation schema conformance as 0|1 (averaged in alarms). */
export async function putSchemaMetric(
  agentId: string,
  conformance: number,
): Promise<void> {
  await putMetric(
    'SchemaConformance',
    conformance,
    [{ Name: 'AgentId', Value: agentId || 'unknown' }],
    'None',
  );
}
