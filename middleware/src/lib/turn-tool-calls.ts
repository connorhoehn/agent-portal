// turn-tool-calls — the provenance half of a persisted chat turn.
//
// Why this exists
// ---------------
// Source chips and the "searched knowledge base ×3" summary line are DERIVED
// from the tool calls a turn made (portal `answerSources.deriveSources` /
// `toolCallSummary.summarizeToolCalls`), not scraped from the model's prose.
// Live, the portal gets those tool calls from the AG-UI stream. Restored, it
// got nothing: `recordTurn` wrote only the user text and the assistant text to
// AgentCore Memory, so reopening a conversation showed the same answer with
// every chip and the summary line gone — silently weaker evidence for the
// identical claim.
//
// So the turn's tool calls are now persisted alongside its text, as one extra
// `role: TOOL` payload item on the same Memory event, carrying a JSON envelope
// behind a marker. Old events have no such item and decode to `undefined`,
// which restores exactly as before.
//
// Size
// ----
// A retrieval result is the whole retrieved passage set — tens of KB. Storing
// it verbatim would bloat every event for data the chips never read. Caps:
//
//   - at most MAX_TOOL_CALLS (24) calls per turn, in order of appearance
//   - args capped at MAX_ARGS_CHARS (2 000) — enough for the `sql` / `url`
//     that the graph and web chips read
//   - result capped at MAX_RESULT_CHARS (4 000)
//   - the whole envelope capped at MAX_ENVELOPE_CHARS (60 000)
//
// Capping a *retrieval* result by plain truncation would be worse than useless:
// `retrievedDocuments()` JSON.parses the result, so a truncated JSON array
// parses as nothing, and the turn would then render as "knowledge base
// searched — no documents matched". That is a false statement, not a missing
// one. Retrieval results are therefore DISTILLED instead — each item reduced to
// the URI and title the chip actually needs, `content` (the bulk) dropped — so
// the stored value stays valid JSON and still names every document.
//
// Two invariants worth stating, because they are what keeps a restored turn
// honest rather than merely smaller:
//
//   1. A stored call is complete or absent. When the envelope must shrink,
//      whole calls are dropped from the end — a call is never kept with its
//      result stripped, because a retrieval call with no result reads as
//      "retrieved nothing".
//   2. Distillation preserves the document COUNT wherever it fits, so
//      `documentsRetrieved` survives the round trip.

/** One tool call as persisted with a turn. Mirrors the portal's `ToolCall` minus `done`. */
export interface StoredToolCall {
  id?: string;
  name: string;
  args?: string;
  result?: string;
  /** True when `result` was distilled or truncated to fit the caps above. */
  truncated?: boolean;
}

/** Marker prefix on the TOOL-role payload item so we never mistake prose for it. */
export const TOOL_CALLS_MARKER = 'ORGIQ_TOOL_CALLS:';

export const MAX_TOOL_CALLS = 24;
export const MAX_ARGS_CHARS = 2_000;
export const MAX_RESULT_CHARS = 4_000;
export const MAX_ENVELOPE_CHARS = 60_000;

const TRUNCATION_SUFFIX = '…[truncated]';

function clampText(raw: string, max: number): { text: string; truncated: boolean } {
  if (raw.length <= max) return { text: raw, truncated: false };
  return { text: raw.slice(0, Math.max(0, max - TRUNCATION_SUFFIX.length)) + TRUNCATION_SUFFIX, truncated: true };
}

interface DistilledDoc {
  source: string;
  title?: string;
}

/**
 * Reduce a retrieval result to the fields a source chip reads.
 *
 * Accepts every shape `retrievedDocuments()` accepts: a bare array, `{results:
 * [...]}`, and items whose URI lives under `source` / `uri` / `sourceUri` /
 * `location.s3Location.uri`. Returns null when the payload is not a retrieval
 * result at all (prose from an A2A hop, a scalar, malformed JSON) — the caller
 * then falls back to plain truncation, which is safe because no chip parses a
 * non-retrieval result.
 */
export function distillRetrievalResult(raw: string): DistilledDoc[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { results?: unknown } | null)?.results)
      ? (parsed as { results: unknown[] }).results
      : null;
  if (!list) return null;

  const docs: DistilledDoc[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const location = r['location'] as { s3Location?: { uri?: unknown } } | undefined;
    const uri =
      (typeof r['source'] === 'string' && r['source']) ||
      (typeof r['uri'] === 'string' && r['uri']) ||
      (typeof r['sourceUri'] === 'string' && r['sourceUri']) ||
      (typeof location?.s3Location?.uri === 'string' && location.s3Location.uri) ||
      '';
    if (!uri) continue;
    const title = typeof r['title'] === 'string' && r['title'].trim() ? r['title'].trim() : undefined;
    docs.push(title ? { source: uri, title } : { source: uri });
  }
  return docs.length > 0 ? docs : null;
}

/** Cap one call's args/result. Never drops the result entirely — see invariant 1. */
function capOne(tc: StoredToolCall): StoredToolCall {
  const out: StoredToolCall = { name: tc.name };
  if (tc.id) out.id = tc.id;

  if (typeof tc.args === 'string' && tc.args) {
    const { text, truncated } = clampText(tc.args, MAX_ARGS_CHARS);
    out.args = text;
    if (truncated) out.truncated = true;
  }

  if (typeof tc.result === 'string' && tc.result) {
    if (tc.name === 'search_context' && tc.result.length > MAX_RESULT_CHARS) {
      // Structured record citations must survive restoration as valid JSON with
      // stable numbers. Keep their existing IDs/links; omit bulky excerpts.
      try {
        const parsed = JSON.parse(tc.result) as { records: Array<Record<string, unknown>>; edges?: Array<{ source: string; target: string }> };
        const records = parsed.records.map(({ description: _description, ...record }) => record);
        let kept = records;
        const serialize = () => {
          const keys = new Set(kept.map(record => `${record['type']}:${record['id']}`));
          return JSON.stringify({ records: kept, edges: (parsed.edges ?? []).filter(edge => keys.has(edge.source) && keys.has(edge.target)), omitted: records.length - kept.length });
        };
        let json = serialize();
        while (json.length > 48_000 && kept.length) {
          kept = kept.slice(0, -1);
          json = serialize();
        }
        out.result = json;
        out.truncated = true;
      } catch { out.result = JSON.stringify({ records: [], edges: [], unavailable: true }); out.truncated = true; }
    } else if (tc.result.length <= MAX_RESULT_CHARS) {
      out.result = tc.result;
    } else {
      const docs = distillRetrievalResult(tc.result);
      if (docs) {
        // Keep as many documents as fit; the chips' document count survives
        // unless the retrieval was enormous.
        let kept = docs;
        let json = JSON.stringify(kept);
        while (json.length > MAX_RESULT_CHARS && kept.length > 1) {
          kept = kept.slice(0, kept.length - 1);
          json = JSON.stringify(kept);
        }
        out.result = json;
        out.truncated = true;
      } else {
        const { text } = clampText(tc.result, MAX_RESULT_CHARS);
        out.result = text;
        out.truncated = true;
      }
    }
  }

  return out;
}

/**
 * Cap a turn's tool calls for storage. Order of appearance is preserved
 * because citation numbering follows it.
 */
export function capToolCalls(calls: StoredToolCall[] | undefined): StoredToolCall[] {
  if (!Array.isArray(calls) || calls.length === 0) return [];
  const named = calls.filter((c) => c && typeof c.name === 'string' && c.name.trim().length > 0);
  let capped = named.slice(0, MAX_TOOL_CALLS).map(capOne);

  // Envelope ceiling: drop whole calls from the end rather than gutting a
  // kept call's result (invariant 1).
  while (capped.length > 0 && JSON.stringify(capped).length > MAX_ENVELOPE_CHARS) {
    capped = capped.slice(0, capped.length - 1);
  }
  return capped;
}

/**
 * Serialize a turn's tool calls into the marker-prefixed payload text, or null
 * when there is nothing worth writing (so no extra payload item is created and
 * an old-shaped event is what gets stored).
 */
export function encodeToolCalls(calls: StoredToolCall[] | undefined): string | null {
  const capped = capToolCalls(calls);
  if (capped.length === 0) return null;
  return TOOL_CALLS_MARKER + JSON.stringify(capped);
}

/** True when a Memory payload's text is one of our tool-call envelopes. */
export function isToolCallsPayload(text: string | undefined): boolean {
  return typeof text === 'string' && text.startsWith(TOOL_CALLS_MARKER);
}

/**
 * Read a stored envelope back. Returns null for anything that is not one —
 * including events written before this existed, which is the common case and
 * must degrade to "no chips", never to an exception.
 */
export function decodeToolCalls(text: string | undefined): StoredToolCall[] | null {
  if (!isToolCallsPayload(text)) return null;
  try {
    const parsed = JSON.parse((text as string).slice(TOOL_CALLS_MARKER.length)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: StoredToolCall[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const name = typeof r['name'] === 'string' ? r['name'] : '';
      if (!name) continue;
      const tc: StoredToolCall = { name };
      if (typeof r['id'] === 'string') tc.id = r['id'];
      if (typeof r['args'] === 'string') tc.args = r['args'];
      if (typeof r['result'] === 'string') tc.result = r['result'];
      if (r['truncated'] === true) tc.truncated = true;
      out.push(tc);
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
