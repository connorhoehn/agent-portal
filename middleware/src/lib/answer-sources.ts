// Citation annotation for the agent stream.
//
// The portal derives an answer's sources from the turn's tool calls rather
// than from the model's prose (see portal/src/components/chat/answerSources.ts
// for why: the model's own "citations" name internal agents). That works
// entirely client-side except for one thing the browser cannot do — turn an
// s3:// key into a document title.
//
// `query_knowledge_base` returns `[{content, score, source}]` where `source` is
// a raw `s3://orgiq-documents-.../<key>` URI. Chipping that gives the reader a
// filename at best and a UUID at worst. `documents.title` is the human name and
// lives in Aurora, so the middleware — which is already parsing and reforwarding
// every TOOL_CALL_RESULT — annotates each retrieval item with its title on the
// way past. The portal then prefers `title` and falls back to the derived label.
//
// Properties that matter here:
//   - Zero cost when nothing is cited. No URIs in the payload → no query. With
//     the knowledge base currently empty, that is every request.
//   - Never fails the turn. Any parse or Aurora problem forwards the original
//     content unchanged; a missing title is a worse chip, not a broken answer.
//   - Shape-preserving. The AG-UI adapter double-encodes tool results (the
//     SSE `content` is a JSON string holding the tool's own JSON string), so
//     the annotated payload is re-encoded to exactly the depth it arrived at.

import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

const URI_RE = /^(s3:\/\/|https?:\/\/)/i;
/** Tool names whose results carry retrieved documents. */
const RETRIEVAL_RE = /retriev|knowledge_base|knowledgebase/i;
/** A single answer cites a handful of documents; more than this is a bug. */
const MAX_URIS = 25;

export function isRetrievalTool(name: string): boolean {
  return RETRIEVAL_RE.test(name ?? '');
}

// ── JSON nesting ─────────────────────────────────────────────────────────────

export interface Unwrapped {
  value: unknown;
  /** How many JSON.parse calls were needed. 0 = it was already an object. */
  depth: number;
}

/**
 * Peel JSON encoding off a tool result until it stops being a JSON string.
 *
 * Bounded at three levels: the observed shape is two (adapter-encoded string
 * containing the tool's own JSON), and an unbounded loop on adversarial input
 * is not worth the flexibility.
 */
export function unwrapJson(raw: unknown): Unwrapped {
  let value = raw;
  let depth = 0;
  while (typeof value === 'string' && depth < 3) {
    const trimmed = value.trim();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{') && !trimmed.startsWith('"')) break;
    try {
      value = JSON.parse(trimmed) as unknown;
      depth += 1;
    } catch {
      break;
    }
  }
  return { value, depth };
}

/** Re-encode to the nesting depth the payload arrived at. */
export function rewrapJson(value: unknown, depth: number): unknown {
  let out: unknown = value;
  for (let i = 0; i < depth; i += 1) out = JSON.stringify(out);
  return out;
}

// ── Retrieval payloads ───────────────────────────────────────────────────────

function itemUri(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const r = item as Record<string, unknown>;
  const location = r['location'] as { s3Location?: { uri?: unknown } } | undefined;
  const raw =
    (typeof r['source'] === 'string' && r['source']) ||
    (typeof r['uri'] === 'string' && r['uri']) ||
    (typeof r['sourceUri'] === 'string' && r['sourceUri']) ||
    (typeof location?.s3Location?.uri === 'string' && location.s3Location.uri) ||
    '';
  return URI_RE.test(raw) ? raw : '';
}

function itemList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const results = (value as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? results : [];
}

/** Every distinct document URI a retrieval result names, capped. */
export function retrievalUris(value: unknown): string[] {
  const out: string[] = [];
  for (const item of itemList(value)) {
    const uri = itemUri(item);
    if (uri && !out.includes(uri)) out.push(uri);
    if (out.length >= MAX_URIS) break;
  }
  return out;
}

/**
 * Attach `title` to each retrieval item we have one for.
 *
 * Returns the value unchanged (same reference) when nothing was annotated, so
 * the caller can cheaply decide whether to re-encode at all.
 */
export function annotateTitles(value: unknown, titles: Map<string, string>): unknown {
  const list = itemList(value);
  if (list.length === 0 || titles.size === 0) return value;
  let changed = false;
  const annotated = list.map((item) => {
    const uri = itemUri(item);
    const title = uri ? titles.get(uri) : undefined;
    if (!title || !item || typeof item !== 'object') return item;
    changed = true;
    return { ...(item as Record<string, unknown>), title };
  });
  if (!changed) return value;
  if (Array.isArray(value)) return annotated;
  return { ...(value as Record<string, unknown>), results: annotated };
}

// ── Title lookup ─────────────────────────────────────────────────────────────

/**
 * Process-lifetime cache. Document titles change on re-ingest, not mid-session,
 * and the miss cost is a chip that reads as a filename — so a bounded cache
 * with no TTL is the right trade against querying Aurora on every retrieval.
 */
const titleCache = new Map<string, string>();
const CACHE_MAX = 2000;

export function _resetTitleCache(): void {
  titleCache.clear();
}

export async function lookupDocumentTitles(uris: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const missing: string[] = [];
  for (const uri of uris) {
    const cached = titleCache.get(uri);
    if (cached !== undefined) {
      if (cached) found.set(uri, cached);
    } else {
      missing.push(uri);
    }
  }
  if (missing.length === 0 || config.mock.aurora) return found;

  const params: SqlParameter[] = missing.map((uri, i) => ({
    name: `u${i}`,
    value: { stringValue: uri },
  }));
  const placeholders = missing.map((_, i) => `:u${i}`).join(', ');
  const rows = await exec(
    `SELECT source_uri, title FROM documents WHERE source_uri IN (${placeholders})`,
    params,
  );
  for (const row of rows) {
    const uri = typeof row['source_uri'] === 'string' ? row['source_uri'] : '';
    const title = typeof row['title'] === 'string' ? row['title'].trim() : '';
    if (!uri || !title) continue;
    found.set(uri, title);
    if (titleCache.size < CACHE_MAX) titleCache.set(uri, title);
  }
  // Negative-cache the misses too: a URI with no `documents` row is the steady
  // state for anything ingested straight into the KB, and re-asking Aurora for
  // it on every turn buys nothing.
  for (const uri of missing) {
    if (!found.has(uri) && titleCache.size < CACHE_MAX) titleCache.set(uri, '');
  }
  return found;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Annotate a TOOL_CALL_RESULT payload with document titles, if it is a
 * retrieval result that names documents. Returns the original content on any
 * problem — this runs inside a live SSE stream and must never be the reason a
 * turn fails.
 */
export async function annotateToolResult(toolName: string, content: unknown): Promise<unknown> {
  if (!isRetrievalTool(toolName)) return content;
  try {
    const { value, depth } = unwrapJson(content);
    const uris = retrievalUris(value);
    if (uris.length === 0) return content;
    const titles = await lookupDocumentTitles(uris);
    if (titles.size === 0) return content;
    const annotated = annotateTitles(value, titles);
    if (annotated === value) return content;
    return rewrapJson(annotated, depth);
  } catch (err) {
    console.warn('[agents] source title annotation failed:', (err as Error).message);
    return content;
  }
}
