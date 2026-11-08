// The voice session's ledger rows (docs/voice-navigator-spec.md §7,
// docs/voice-navigator-gaps.md G11), shared by the close route and the reaper.
//
// Two rows per session, both `source: 'voice_session'`:
//   <id>         the voice itself: seconds / 60 × the session's rate, the row
//                that settles the hold (its source_id is the hold's);
//   <id>:tokens  the delegated Responses model's tokens (trigger
//                `voice-delegation`), priced from the price table's row for
//                the delegation model (lib/model-prices-defaults.ts) or the
//                VOICE_DELEGATION_USD_PER_1M_INPUT / _OUTPUT override. It
//                never matches the hold, so it never settles one.
// Each is `reported` when its figure came from the provider over the sideband
// (G12: `session.closed` / `session.usage.updated` seconds, the nested
// `response.completed` token sums), `estimated` when it came from the dock
// (the sideband never connected, or the replica that held it died), or
// `unknown` (neither reported it: the reaper's case, or a close without the
// token block); a later close may still move an unknown row to a known one,
// never a known one to another figure (providers/spend-ledger.ts UPSERT_TAIL).

import type { VoiceSessionRow } from '../../providers/voice-sessions.js';
import type { CostBasis } from '../run-cost.js';
import type { BedrockPrice, TokenUsage } from '../pricing.js';
import type { ProviderUsage } from './openai.js';
import { DEFAULT_DELEGATION_MODEL, MAX_TOKENS_PER_RESPONSE, MIN_BILLED_SECONDS, voiceConfig, voiceCostUsd } from './config.js';

/** Where a known figure came from: the provider's sideband, or the dock. */
export type KnownBasis = 'reported' | 'estimated';

/** What the dock sums from every nested `response.completed.response.usage` of one session. */
export interface DelegatedUsage {
  /** `input_tokens`, which includes the cached ones (OpenAI's convention). */
  inputTokens: number;
  outputTokens: number;
  /** `input_tokens_details.cached_tokens`, a part of inputTokens. */
  cachedTokens: number;
  /** How many `response.completed` frames the sums cover. */
  responses: number;
}

const count = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/**
 * The close body's `delegated` block, bounded (G11): responses at the
 * session's tool calls plus one, each count at 50,000 tokens per response,
 * cached at the input. Null when the block is missing or malformed: an
 * unknown figure, never a guessed one.
 */
export function boundDelegatedUsage(raw: unknown, toolCalls: number): DelegatedUsage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const input = count(r['inputTokens']), output = count(r['outputTokens']);
  const cached = count(r['cachedTokens'] ?? 0), responses = count(r['responses']);
  if (input == null || output == null || cached == null || responses == null) return null;
  const allowed = Math.min(responses, Math.max(0, Math.floor(toolCalls)) + 1);
  const ceiling = allowed * MAX_TOKENS_PER_RESPONSE;
  const inputTokens = Math.min(input, ceiling);
  return {
    inputTokens, outputTokens: Math.min(output, ceiling), cachedTokens: Math.min(cached, inputTokens), responses: allowed,
  };
}

/**
 * USD for the delegated tokens at `model`'s price, to four places (the
 * ledger's NUMERIC(10,4)), or null when nothing prices it. The override
 * replaces the table's input / output rate per bucket.
 */
export async function delegationCostUsd(model: string, usage: DelegatedUsage): Promise<number | null> {
  const { priceFor } = await import('../model-prices.js');
  const { priceUsage } = await import('../pricing.js');
  const override = voiceConfig().delegationUsdPer1M;
  const table = priceFor(model);
  let price: BedrockPrice | null = table;
  if (override.input != null || override.output != null) {
    const input = override.input != null ? override.input / 1000 : table?.input;
    const output = override.output != null ? override.output / 1000 : table?.output;
    if (input == null || output == null) return null;
    price = { input, output, cacheRead: override.input != null ? input : table?.cacheRead ?? input };
  }
  if (!price) return null;
  const tokens: TokenUsage = {
    inputTokens: usage.inputTokens - usage.cachedTokens, outputTokens: usage.outputTokens,
    ...(usage.cachedTokens > 0 ? { cacheReadTokens: usage.cachedTokens } : {}),
  };
  const cost = priceUsage(price, tokens);
  return cost == null ? null : Math.round(cost * 10_000) / 10_000;
}

/**
 * The provider figures a row carries (G12), as the sideband would answer
 * them. Never `final`: a row only says what was written last, and the close
 * may land on a replica that never held the socket.
 */
export function providerUsageFromRow(row: Pick<VoiceSessionRow, 'provider_seconds' | 'provider_tokens_in' | 'provider_tokens_out' | 'provider_tokens_cached'>): ProviderUsage | null {
  const seconds = row.provider_seconds ?? null, inputTokens = row.provider_tokens_in ?? null;
  if (seconds == null && inputTokens == null) return null;
  return {
    seconds, inputTokens, outputTokens: inputTokens == null ? null : row.provider_tokens_out ?? 0,
    cachedTokens: inputTokens == null ? null : row.provider_tokens_cached ?? 0, responses: 0, final: false,
  };
}

/** What one settlement books: the session's seconds and cost, and its delegated tokens. */
export interface VoiceSettlement {
  seconds: number | null;
  costUsd: number | null;
  basis: CostBasis;
  delegated: DelegatedUsage | null;
  tokensBasis: KnownBasis;
}

/**
 * The provider's figures win over the dock's (G12). Seconds: the provider's
 * when it sent `session.closed`, when the dock reported none, or when they are
 * at least the dock's (a mid-session `usage.updated` is a floor, so a dock
 * that saw more is the newer figure); floored at the 15-second minimum, never
 * capped (it is the bill). Tokens: the same rule on the input count. `dock`
 * is already bounded (the close route's wall-time cap, boundDelegatedUsage).
 * Pure.
 */
export function preferProviderFigures(
  row: Pick<VoiceSessionRow, 'usd_per_minute'>,
  provider: ProviderUsage | null,
  dock: { seconds: number | null; delegated: DelegatedUsage | null },
): VoiceSettlement {
  let seconds: number | null = null;
  let basis: CostBasis = 'unknown';
  const p = provider?.seconds ?? null;
  if (p != null && (provider!.final || dock.seconds == null || p >= dock.seconds)) {
    seconds = Math.ceil(Math.max(MIN_BILLED_SECONDS, p));
    basis = 'reported';
  } else if (dock.seconds != null) {
    seconds = dock.seconds;
    basis = 'estimated';
  }
  let delegated: DelegatedUsage | null = dock.delegated;
  let tokensBasis: KnownBasis = 'estimated';
  if (provider && provider.inputTokens != null
    && (provider.final || !dock.delegated || provider.inputTokens >= dock.delegated.inputTokens)) {
    const inputTokens = provider.inputTokens;
    delegated = {
      inputTokens, outputTokens: provider.outputTokens ?? 0,
      cachedTokens: Math.min(provider.cachedTokens ?? 0, inputTokens), responses: provider.responses,
    };
    tokensBasis = 'reported';
  }
  return { seconds, costUsd: seconds == null ? null : voiceCostUsd(seconds, row.usd_per_minute), basis, delegated, tokensBasis };
}

/** The delegation model a session's tokens are priced at: the configured one, else the default. */
export function delegationModel(): string {
  return voiceConfig().delegationModel ?? DEFAULT_DELEGATION_MODEL;
}

/**
 * The session's two ledger rows (§7, G11), keyed by its id so a retry is a
 * no-op; a known voice cost settles the hold, an unknown one leaves it until
 * it expires. The voice row carries the session row's basis (`reported` from
 * the sideband, else `estimated`); `delegated` absent = the token row is
 * unknown, else it is `tokensBasis` (G12).
 */
export async function bookVoiceSpend(row: VoiceSessionRow, delegated?: DelegatedUsage | null, tokensBasis: KnownBasis = 'estimated'): Promise<void> {
  const { recordSpend } = await import('../../providers/spend-ledger.js');
  await recordSpend({
    source: 'voice_session', sourceId: row.id, initiativeId: null, boxId: null, actorId: row.user_sub,
    trigger: `voice:${row.tenant}`, model: row.model, costUsd: row.cost_usd,
    costBasis: row.cost_usd == null ? 'unknown' : row.cost_basis === 'reported' ? 'reported' : 'estimated', provider: 'openai',
  });
  const model = delegationModel();
  const costUsd = delegated ? await delegationCostUsd(model, delegated) : null;
  await recordSpend({
    source: 'voice_session', sourceId: `${row.id}:tokens`, initiativeId: null, boxId: null, actorId: row.user_sub,
    trigger: 'voice-delegation', model, costUsd, costBasis: costUsd == null ? 'unknown' : tokensBasis, provider: 'openai',
    inputTokens: delegated?.inputTokens ?? null, outputTokens: delegated?.outputTokens ?? null,
    estimatedCostUsd: costUsd,
  });
}
