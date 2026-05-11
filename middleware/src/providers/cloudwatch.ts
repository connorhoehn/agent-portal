// CloudWatch + X-Ray provider for observability summary + traces.
//
// Real implementation:
//   - getSummary(): aggregates Invocations / Errors / Latency / Tokens from CloudWatch
//     metrics (AWS/BedrockAgentCore + custom OrgIQ namespace) over last 24h. Returns
//     a zero-state summary when no metrics exist yet (pre-runtime-deployment).
//   - listTraces(limit): GetTraceSummaries → BatchGetTraces against X-Ray.
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
  Statistic,
  type GetMetricStatisticsCommandInput,
} from '@aws-sdk/client-cloudwatch';
import { config } from '../config.js';
import { mockTraces } from '../mock/traces.js';
import { mockAgents } from '../mock/agent-statuses.js';
import type {
  CloudWatchProvider,
  GuardrailMetricPoint,
  GuardrailMetricsSummary,
  ObservabilitySummary,
  Trace,
  TraceSpan,
} from './types.js';

// ── Mock provider ─────────────────────────────────────────────────────────────

export const mockCloudWatch: CloudWatchProvider = {
  async getSummary(): Promise<ObservabilitySummary> {
    const totalInvocations = mockAgents.reduce((s, a) => s + a.invocationsLast24h, 0);
    const totalErrors = mockAgents.reduce((s, a) => s + a.errorsLast24h, 0);
    const totalTokens = mockAgents.reduce((s, a) => s + a.tokensLast24h, 0);
    const avgLatency = Math.round(
      mockAgents.reduce((s, a) => s + a.latencyP50Ms, 0) / mockAgents.length,
    );
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

  async listTraces(limit: number): Promise<Trace[]> {
    return mockTraces.slice(0, limit);
  },

  async getTrace(traceId: string): Promise<Trace | null> {
    return mockTraces.find((t) => t.traceId === traceId) ?? null;
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

const ZERO_SUMMARY: ObservabilitySummary = {
  totalInvocations24h: 0,
  totalErrors24h: 0,
  totalTokens24h: 0,
  avgLatencyMs: 0,
  successRate: '0.0',
  traceCount: 0,
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const NAMESPACE_AGENTCORE = 'AWS/BedrockAgentCore';

// Sum a metric across all dimensions in the last 24h. Returns 0 when no data.
async function sumMetric(
  namespace: string,
  metricName: string,
): Promise<number> {
  const end = new Date();
  const start = new Date(end.getTime() - ONE_DAY_MS);
  const input: GetMetricStatisticsCommandInput = {
    Namespace: namespace,
    MetricName: metricName,
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
}

async function avgMetric(
  namespace: string,
  metricName: string,
): Promise<number> {
  const end = new Date();
  const start = new Date(end.getTime() - ONE_DAY_MS);
  const input: GetMetricStatisticsCommandInput = {
    Namespace: namespace,
    MetricName: metricName,
    StartTime: start,
    EndTime: end,
    Period: 3600,
    Statistics: ['Average'],
  };
  try {
    const out = await cw.send(new GetMetricStatisticsCommand(input));
    const points = out.Datapoints ?? [];
    if (points.length === 0) return 0;
    const sum = points.reduce((s, d) => s + (d.Average ?? 0), 0);
    return Math.round(sum / points.length);
  } catch {
    return 0;
  }
}

// Infer span kind from a segment/subsegment name when annotations don't carry it.
function inferKind(name: string): TraceSpan['kind'] {
  const n = name.toLowerCase();
  if (n.includes('model') || n.includes('bedrock') || n.includes('llm')) return 'llm';
  if (n.includes('retrieve') || n.includes('kb') || n.includes('knowledge')) return 'retrieval';
  if (n.includes('tool')) return 'tool';
  return 'agent';
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

  for (const seg of xt.Segments ?? []) {
    if (!seg.Document) continue;
    try {
      const doc = JSON.parse(seg.Document) as {
        name?: string;
        start_time?: number;
        error?: boolean;
        fault?: boolean;
        annotations?: Record<string, string | number>;
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
  };
}

export const realCloudWatch: CloudWatchProvider = {
  async getSummary(): Promise<ObservabilitySummary> {
    try {
      // No agent runtimes deployed yet → all of these will be 0. That's fine.
      const [invocations, errors, latencyAvg, tokens, traceCount] = await Promise.all([
        sumMetric(NAMESPACE_AGENTCORE, 'Invocations'),
        sumMetric(NAMESPACE_AGENTCORE, 'Errors'),
        avgMetric(NAMESPACE_AGENTCORE, 'Latency'),
        sumMetric('OrgIQ/Agents', 'TokensTotal'),
        (async () => {
          try {
            const end = new Date();
            const start = new Date(end.getTime() - ONE_DAY_MS);
            const out = await xray.send(
              new GetTraceSummariesCommand({ StartTime: start, EndTime: end }),
            );
            return (out.TraceSummaries ?? []).length;
          } catch {
            return 0;
          }
        })(),
      ]);

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
  },

  async listTraces(limit: number): Promise<Trace[]> {
    try {
      const end = new Date();
      const start = new Date(end.getTime() - ONE_DAY_MS);
      const summaries = await xray.send(
        new GetTraceSummariesCommand({ StartTime: start, EndTime: end }),
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
