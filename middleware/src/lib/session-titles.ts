// Bedrock-driven session title cache.
//
// When a user starts a new session by sending their first message, the chat
// sidebar shows the raw UUID. Awful. Instead, fire a tiny Nova Lite call to
// summarize the first message in 3–5 words and cache the result keyed by
// sessionId. Subsequent /api/sessions reads merge the title in.
//
// Cost per title: ~$0.0001 (Nova Lite, ~100 tokens). Pure fire-and-forget;
// titles arrive on the next sidebar poll. Lost on middleware restart by
// design — it's a UX nicety, not durable state.
//
// The /api/sessions poll backfills titles, so every function here is on a
// hot, repeating path. A title attempt has exactly three settled outcomes and
// each must cost *nothing* on the next poll:
//   - titled            → remembered in `_titles`
//   - no USER message    → permanently untitleable, negative-cached in `_abandoned`
//   - model returned ""  → permanently untitleable, negative-cached in `_abandoned`
// The caller checks `beginBackfill` BEFORE issuing its (memory/Data-API) events
// read, so a settled session never re-queries and never re-calls Nova. Only a
// *transient* failure (the events read threw) releases the reservation for a
// later retry — that path is not negative-cached.

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { recordBffCall } from '../providers/spend-ledger.js';
import { config } from '../config.js';

// Bounded so neither map/set grows without limit on a long-lived process (one
// entry per session, never otherwise evicted). Maps/Sets keep insertion order,
// so `.keys()/.values().next()` is the oldest — a cheap FIFO eviction that
// keeps recent sessions titleable rather than freezing the cache once full.
const CACHE_MAX = 2000;
const _titles = new Map<string, string>();
const _abandoned = new Set<string>();
const _inFlight = new Set<string>();

let _client: BedrockRuntimeClient | null = null;
function client(): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region: config.region });
  return _client;
}

const TITLE_MODEL = 'amazon.nova-lite-v1:0';

function remember(sessionId: string, title: string): void {
  if (!_titles.has(sessionId) && _titles.size >= CACHE_MAX) {
    const oldest = _titles.keys().next().value;
    if (oldest !== undefined) _titles.delete(oldest);
  }
  _titles.set(sessionId, title);
  _abandoned.delete(sessionId);
}

// Negative cache: this session can never be titled (no USER message, or the
// model produced nothing usable). Never overrides a real title.
function abandon(sessionId: string): void {
  if (_titles.has(sessionId) || _abandoned.has(sessionId)) return;
  if (_abandoned.size >= CACHE_MAX) {
    const oldest = _abandoned.values().next().value;
    if (oldest !== undefined) _abandoned.delete(oldest);
  }
  _abandoned.add(sessionId);
}

export function getSessionTitle(sessionId: string): string | undefined {
  return _titles.get(sessionId);
}

export function getSessionTitleMap(): Record<string, string> {
  return Object.fromEntries(_titles.entries());
}

/**
 * Whether a title backfill for this session is worth a query. False when it is
 * already titled, an attempt is in-flight, or it is negative-cached as
 * untitleable — the settled cases that used to re-query on every poll.
 */
export function shouldBackfillTitle(sessionId: string): boolean {
  return (
    !!sessionId &&
    !_titles.has(sessionId) &&
    !_inFlight.has(sessionId) &&
    !_abandoned.has(sessionId)
  );
}

/**
 * Reserve a backfill attempt BEFORE the caller issues its events read, so the
 * de-dupe covers the query too — not just the LLM call. Returns true when the
 * caller now owns the attempt and MUST settle it (generateTitleReserved /
 * markUntitleable) or release it (releaseBackfill) on a transient failure;
 * false when there is nothing to do.
 */
export function beginBackfill(sessionId: string): boolean {
  if (!shouldBackfillTitle(sessionId)) return false;
  _inFlight.add(sessionId);
  return true;
}

/** No USER-role first message → nothing to ever title from. Terminal. */
export function markUntitleable(sessionId: string): void {
  _inFlight.delete(sessionId);
  abandon(sessionId);
}

/** Transient failure (e.g. the events read threw) — retry on a later poll. */
export function releaseBackfill(sessionId: string): void {
  _inFlight.delete(sessionId);
}

// Trigger a title generation if we don't already have one for this session.
// Fire-and-forget — never throws to callers. Used where the first user message
// is already in hand (see routes/agents.ts); reserves then generates.
export function maybeGenerateTitle(sessionId: string, firstUserMessage: string): void {
  if (!sessionId || !firstUserMessage) return;
  if (!beginBackfill(sessionId)) return;
  generateTitleReserved(sessionId, firstUserMessage);
}

/**
 * Run generation under an already-held reservation (beginBackfill returned
 * true). Releases the reservation when done. An empty message settles as
 * untitleable rather than leaking the reservation.
 */
export function generateTitleReserved(sessionId: string, firstUserMessage: string): void {
  if (!firstUserMessage) {
    markUntitleable(sessionId);
    return;
  }
  void generateTitle(sessionId, firstUserMessage)
    .catch((err) => {
      console.warn('[session-titles] generate failed:', (err as Error).message);
    })
    .finally(() => {
      _inFlight.delete(sessionId);
    });
}

async function generateTitle(sessionId: string, firstUserMessage: string): Promise<void> {
  const truncated = firstUserMessage.slice(0, 500);
  const resp = await client().send(
    new ConverseCommand({
      modelId: TITLE_MODEL,
      system: [{
        text: 'You produce 3-5 word session titles. Output ONLY the title — no quotes, no punctuation, no preamble. Match the language and tone of the user message. Examples:\n- User: "Who knows kubernetes?" → Kubernetes Experts\n- User: "Show me the data platform team" → Data Platform Roster\n- User: "What is everyone\'s influence?" → Org Influence Snapshot',
      }],
      messages: [{
        role: 'user',
        content: [{ text: truncated }],
      }],
      inferenceConfig: { maxTokens: 24, temperature: 0.2 },
    }),
  );
  void recordBffCall({ feature: 'session-title', model: TITLE_MODEL, usage: resp.usage });
  const blocks = resp.output?.message?.content ?? [];
  const raw = blocks.map((c) => ('text' in c ? c.text : '')).join('').trim();
  // Strip leading/trailing quotes/punctuation and limit to ~50 chars.
  const cleaned = raw
    .replace(/^["'`*]+/, '')
    .replace(/["'`*.,!?]+$/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 50);
  // A usable title is remembered; a blank result is terminal — negative-cache
  // it so the next poll doesn't re-run the read + Nova call forever.
  if (cleaned) remember(sessionId, cleaned);
  else abandon(sessionId);
}

/** Test hook: clear all in-process state. */
export function _resetTitleState(): void {
  _titles.clear();
  _abandoned.clear();
  _inFlight.clear();
}
