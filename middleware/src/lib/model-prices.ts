// Claude prices from config, not code (DE-32).
//
// `pricing.ts` holds the Nova/Titan rates the agents use. The devbox's Bedrock
// Claude inference profiles are priced from a table the OPERATOR owns:
//
//   SSM /orgiq/pricing/model_prices — a JSON map of model id → price, each
//   entry carrying `source` and `effectiveFrom`, created by hand or by a
//   script and never by CDK (so a redeploy cannot overwrite the rates).
//
// Read-through with a 5-minute TTL (the `lib/judge-config.ts` pattern):
//
//   MOCK_AGENTCORE                → the fixture `mock/model-prices.ts`, read
//                                   live on every call so a scenario change is
//                                   visible at once; never SSM, never defaults
//   online, parameter readable    → checked-in defaults, overlaid per id by
//                                   the parameter's rows
//   online, parameter missing     → the defaults alone
//   online, SSM error             → the last good snapshot (stale on error)
//
// The lookup is SYNCHRONOUS over the last snapshot, because the trace path
// and the fleet price in a hot loop; a refresh is kicked at boot and whenever
// a lookup finds the snapshot past its TTL. The table registers itself with
// `pricing.ts::registerPriceSource` at import, so `pricing.ts` callers that
// never import this module (the fleet) still see it once the server has.
//
// An entry without `source` or `effectiveFrom`, or with a non-numeric rate,
// is refused and logged, not loaded: a rate nobody can trace back to a page
// or a bill is the "invented number that looks authoritative" the old
// pricing.ts refused to ship.

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  estimateUsageCost as estimateWithRegisteredSources,
  priceFor as priceForRegistered,
  registerPriceSource,
  type BedrockPrice,
  type TokenUsage,
} from './pricing.js';
import { DEFAULT_MODEL_PRICES, type ModelPriceEntry } from './model-prices-defaults.js';
import { modelPriceRows } from '../mock/model-prices.js';

export type { ModelPriceEntry } from './model-prices-defaults.js';

export const MODEL_PRICES_TTL_MS = 5 * 60_000;
const DEFAULT_PARAM = '/orgiq/pricing/model_prices';

/**
 * Offline = MOCK_AGENTCORE, read from the environment rather than through
 * `config.ts`: the same literal as `config.ts::flag` and
 * `routes/devbox.ts::mockAgentCore`, kept here so the devbox routes and the
 * runner — which import no config today — can import this module without
 * pulling `import.meta` into their test compilation.
 */
function offline(): boolean {
  return process.env['MOCK_AGENTCORE'] === 'true';
}

export function modelPricesParamName(): string {
  return process.env['MODEL_PRICES_PARAM']?.trim() || DEFAULT_PARAM;
}

/** `MODEL_PRICES_DEFAULTS=off` ships an empty table until the operator fills SSM. */
export function defaultsEnabled(): boolean {
  const raw = (process.env['MODEL_PRICES_DEFAULTS'] ?? '').trim().toLowerCase();
  return !(raw === 'off' || raw === 'false' || raw === '0');
}

export interface ModelPricesSnapshot {
  prices: Record<string, ModelPriceEntry>;
  /** Where the rows came from. */
  origin: 'defaults' | 'ssm+defaults' | 'ssm' | 'empty';
  /** SSM parameter version, '' when the parameter was not read. */
  version: string;
  fetchedAt: number;
  /** Entries the parameter carried that were refused, by id and reason. */
  rejected: Array<{ id: string; reason: string }>;
}

function isRate(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Validate one parameter document. Returns the accepted rows and the refused
 * ones; never throws on a bad row, because one typo must not blank the table.
 * A non-object document is refused whole.
 */
export function validateModelPrices(doc: unknown): {
  accepted: Record<string, ModelPriceEntry>;
  rejected: Array<{ id: string; reason: string }>;
} {
  const accepted: Record<string, ModelPriceEntry> = {};
  const rejected: Array<{ id: string; reason: string }> = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    rejected.push({ id: '*', reason: 'document must be a JSON object keyed by model id' });
    return { accepted, rejected };
  }
  for (const [rawId, raw] of Object.entries(doc as Record<string, unknown>)) {
    const id = rawId.trim();
    const e = raw as Partial<ModelPriceEntry> | null;
    const refuse = (reason: string): void => { rejected.push({ id, reason }); };
    if (!id) { refuse('empty model id'); continue; }
    if (!e || typeof e !== 'object') { refuse('entry must be an object'); continue; }
    if (typeof e.source !== 'string' || !e.source.trim()) { refuse('missing source'); continue; }
    if (typeof e.effectiveFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(e.effectiveFrom)) {
      refuse('missing or malformed effectiveFrom (ISO date)');
      continue;
    }
    if (!isRate(e.input) || !isRate(e.output)) { refuse('input and output must be non-negative numbers'); continue; }
    if (e.cacheWrite !== undefined && !isRate(e.cacheWrite)) { refuse('cacheWrite must be a non-negative number'); continue; }
    if (e.cacheRead !== undefined && !isRate(e.cacheRead)) { refuse('cacheRead must be a non-negative number'); continue; }
    accepted[id] = {
      input: e.input, output: e.output,
      ...(e.cacheWrite !== undefined ? { cacheWrite: e.cacheWrite } : {}),
      ...(e.cacheRead !== undefined ? { cacheRead: e.cacheRead } : {}),
      source: e.source.trim(), effectiveFrom: e.effectiveFrom,
    };
  }
  return { accepted, rejected };
}

/** The parameter's rows over the defaults, per id. Pure. */
export function buildSnapshot(
  ssm: { value: string; version: string } | null,
  now: number,
  withDefaults = defaultsEnabled(),
): ModelPricesSnapshot {
  const base: Record<string, ModelPriceEntry> = withDefaults ? { ...DEFAULT_MODEL_PRICES } : {};
  if (!ssm) {
    return { prices: base, origin: withDefaults ? 'defaults' : 'empty', version: '', fetchedAt: now, rejected: [] };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(ssm.value); } catch { parsed = null; }
  const { accepted, rejected } = validateModelPrices(parsed ?? { '*': null });
  const prices = { ...base, ...accepted };
  const origin = withDefaults ? 'ssm+defaults' : Object.keys(prices).length ? 'ssm' : 'empty';
  return { prices, origin, version: ssm.version, fetchedAt: now, rejected };
}

// ─── The read-through ────────────────────────────────────────────────────────

/** What fetches the parameter. Swapped in tests; `null` = ParameterNotFound. */
export type ModelPricesTransport = (name: string) => Promise<{ value: string; version: string } | null>;

let client: SSMClient | null = null;
const ssmTransport: ModelPricesTransport = async (name) => {
  client ??= new SSMClient({});
  try {
    const res = await client.send(new GetParameterCommand({ Name: name }));
    const value = res.Parameter?.Value;
    return typeof value === 'string' ? { value, version: String(res.Parameter?.Version ?? '') } : null;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ParameterNotFound') return null;
    throw err;
  }
};
let transport: ModelPricesTransport = ssmTransport;

let snapshot: ModelPricesSnapshot | null = null;
let inflight: Promise<ModelPricesSnapshot> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function logRejected(s: ModelPricesSnapshot): void {
  for (const r of s.rejected) {
    console.warn(`[model-prices] refused ${modelPricesParamName()} entry ${JSON.stringify(r.id)}: ${r.reason}`);
  }
}

/**
 * Read the parameter now and replace the snapshot. Online only; offline the
 * fixture is the store and there is nothing to refresh. Serves the last good
 * snapshot on an SSM error, the defaults when there is no last good one.
 */
export async function refreshModelPrices(): Promise<ModelPricesSnapshot> {
  const now = Date.now();
  if (offline()) {
    snapshot = { prices: {}, origin: 'empty', version: '', fetchedAt: now, rejected: [] };
    return snapshot;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const next = buildSnapshot(await transport(modelPricesParamName()), now);
      logRejected(next);
      snapshot = next;
    } catch (err) {
      if (snapshot) {
        snapshot = { ...snapshot, fetchedAt: now }; // stale on error, retried next TTL
      } else {
        console.warn('[model-prices] SSM read failed, using defaults', (err as { name?: string })?.name ?? err);
        snapshot = buildSnapshot(null, now);
      }
    } finally {
      inflight = null;
    }
    return snapshot!;
  })();
  return inflight;
}

/** The last snapshot (defaults if nothing has been read yet), kicking a refresh when stale. */
export function modelPricesSnapshot(): ModelPricesSnapshot {
  if (offline()) {
    const prices: Record<string, ModelPriceEntry> = {};
    for (const row of modelPriceRows.rows()) {
      const { modelId, ...price } = row;
      prices[modelId] = price;
    }
    return { prices, origin: Object.keys(prices).length ? 'ssm' : 'empty', version: 'mock', fetchedAt: Date.now(), rejected: [] };
  }
  const now = Date.now();
  if (!snapshot) snapshot = buildSnapshot(null, now);
  if (now - snapshot.fetchedAt >= MODEL_PRICES_TTL_MS) void refreshModelPrices().catch(() => undefined);
  return snapshot;
}

/** The config table's own row for an EXACT id (no prefix rule); `pricing.ts` applies the id rule. */
export function priceForModel(modelId: string): ModelPriceEntry | undefined {
  return modelPricesSnapshot().prices[modelId];
}

registerPriceSource(priceForModel);

/** The price row for `modelId` after the one id rule, over Nova/Titan and this table. */
export function priceFor(modelId: string): BedrockPrice | null {
  return priceForRegistered(modelId);
}

/** Every bucket priced separately, or `null` (see `pricing.ts::estimateUsageCost`). */
export function estimateUsageCost(modelId: string, usage: TokenUsage): number | null {
  return estimateWithRegisteredSources(modelId, usage);
}

/**
 * Boot: read once now, then on every TTL. The interval is unref'd so it never
 * holds a test process open; offline it is not started at all.
 */
export function startModelPriceRefresh(): void {
  if (offline() || timer) return;
  void refreshModelPrices().catch(() => undefined);
  timer = setInterval(() => { void refreshModelPrices().catch(() => undefined); }, MODEL_PRICES_TTL_MS);
  timer.unref?.();
}

export function stopModelPriceRefresh(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test hooks. */
export function _setModelPricesTransportForTest(t: ModelPricesTransport | null): void {
  transport = t ?? ssmTransport;
}
export function _resetModelPricesForTest(): void {
  snapshot = null;
  inflight = null;
  stopModelPriceRefresh();
  registerPriceSource(priceForModel);
}
