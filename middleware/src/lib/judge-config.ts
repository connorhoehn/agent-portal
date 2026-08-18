// LLM-as-judge configuration — the server-side source of truth behind the
// /iq/evaluations page. Persisted in SSM (same pattern as weight-cache.ts)
// so the config survives middleware restarts and is shared across instances.
//
//   /orgiq/canary/judge_config — JSON JudgeConfig
//
// fireJudge() reads this on every invocation (20s read-through cache):
//   - enabled=false  → no judge calls at all
//   - minSampleRate  → % of eligible invocations actually judged
//   - modelId        → judge model (template is rendered locally so the model
//                      choice is honored even though the Bedrock prompt pins one)
//   - dimensions     → rubric weights folded into the composite score

import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';

const PARAM = '/orgiq/canary/judge_config';
const TTL_MS = 20_000;

const client = new SSMClient({});

export interface JudgeRubricDimension {
  key: string;
  label?: string;
  description?: string;
  weight: number; // 0–100
}

export interface JudgeConfig {
  enabled: boolean;
  modelId: string;
  promptId: string | null;
  promptVersion: string | null;
  dimensions: JudgeRubricDimension[];
  minSampleRate: number; // 0–100, % of invocations judged
  failThreshold: number; // 0–10
}

export const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
  // Enabled by default — the canary controller is blind without judge scores.
  enabled: true,
  modelId: 'amazon.nova-pro-v1:0',
  promptId: null,
  promptVersion: null,
  dimensions: [
    { key: 'helpfulness', weight: 30 },
    { key: 'factuality', weight: 30 },
    { key: 'tone', weight: 20 },
    { key: 'conciseness', weight: 20 },
  ],
  // Judge everything by default — sampling down is an operator cost decision.
  minSampleRate: 100,
  failThreshold: 5,
};

function sanitize(raw: unknown): JudgeConfig {
  const r = (raw ?? {}) as Partial<JudgeConfig>;
  const dims = Array.isArray(r.dimensions)
    ? r.dimensions
        .filter((d): d is JudgeRubricDimension =>
          d != null && typeof d === 'object' && typeof (d as JudgeRubricDimension).key === 'string')
        .map((d) => ({
          key: d.key,
          ...(typeof d.label === 'string' ? { label: d.label } : {}),
          ...(typeof d.description === 'string' ? { description: d.description } : {}),
          weight: clampInt(d.weight, 0, 100, 25),
        }))
    : DEFAULT_JUDGE_CONFIG.dimensions;

  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_JUDGE_CONFIG.enabled,
    modelId:
      typeof r.modelId === 'string' && r.modelId.trim()
        ? r.modelId.trim()
        : DEFAULT_JUDGE_CONFIG.modelId,
    promptId: typeof r.promptId === 'string' && r.promptId ? r.promptId : null,
    promptVersion:
      typeof r.promptVersion === 'string' && r.promptVersion ? r.promptVersion : null,
    dimensions: dims.length > 0 ? dims : DEFAULT_JUDGE_CONFIG.dimensions,
    minSampleRate: clampInt(r.minSampleRate, 0, 100, DEFAULT_JUDGE_CONFIG.minSampleRate),
    failThreshold: clampInt(r.failThreshold, 0, 10, DEFAULT_JUDGE_CONFIG.failThreshold),
  };
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

interface CacheEntry {
  value: JudgeConfig;
  fetchedAt: number;
}

let entry: CacheEntry | null = null;

export async function getJudgeConfig(): Promise<JudgeConfig> {
  const now = Date.now();
  if (entry && now - entry.fetchedAt < TTL_MS) return entry.value;

  try {
    const res = await client.send(new GetParameterCommand({ Name: PARAM }));
    const parsed = sanitize(JSON.parse(res.Parameter?.Value ?? '{}'));
    entry = { value: parsed, fetchedAt: now };
    return parsed;
  } catch (err) {
    const e = err as { name?: string };
    if (entry) return entry.value; // serve stale on transient SSM errors
    if (e?.name !== 'ParameterNotFound') {
      console.warn('[judge-config] SSM read failed, using defaults', e?.name);
    }
    entry = { value: DEFAULT_JUDGE_CONFIG, fetchedAt: now };
    return DEFAULT_JUDGE_CONFIG;
  }
}

export async function setJudgeConfig(raw: unknown): Promise<JudgeConfig> {
  const cfg = sanitize(raw);
  await client.send(
    new PutParameterCommand({
      Name: PARAM,
      Value: JSON.stringify(cfg),
      Type: 'String',
      Overwrite: true,
    }),
  );
  entry = { value: cfg, fetchedAt: Date.now() };
  return cfg;
}

/** Weighted composite over whatever rubric keys the config declares. */
export function weightedComposite(
  scores: Record<string, number>,
  dims: JudgeRubricDimension[],
): number {
  let sum = 0;
  let totalWeight = 0;
  for (const d of dims) {
    const s = scores[d.key];
    if (typeof s !== 'number' || !Number.isFinite(s)) continue;
    sum += s * d.weight;
    totalWeight += d.weight;
  }
  if (totalWeight === 0) {
    const vals = Object.values(scores).filter((v) => Number.isFinite(v));
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  return sum / totalWeight;
}

export function invalidateJudgeConfig(): void {
  entry = null;
}
