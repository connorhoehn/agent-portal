// answerSources — work out where an answer actually came from, and make sure
// the model's own claims about that never reach the user unverified.
//
// History: this module used to be a pure prose scraper. It matched exactly one
// shape — `[Source: <uri>]` with an s3:// or http(s):// payload — and nothing
// in the fleet has ever produced it. Live capture of a supervisor turn
// (2026-08, "top two Kubernetes experts") ends:
//
//     *Source: Scoring specialist*
//
// and an earlier stored answer ends `[Source: Search agent]`. Both name an
// INTERNAL AGENT, which is not evidence — it is our own architecture leaking
// into the user's citation line. The old parser rendered the second one as
// literal text (no URI → `return whole`) and ignored the first entirely.
//
// So provenance is no longer taken from prose. It is DERIVED from what the
// stream actually observed — the turn's tool calls, their arguments and their
// results — which is data the portal already holds (useAgentStream attaches
// `toolCalls[].result` from TOOL_CALL_RESULT). Prose citations are still read,
// but only to harvest real URIs; a citation the model asserts without a URI is
// removed from the answer and counted as unverified, never rendered.
//
// Two consequences worth stating:
//   - Chips survive model-phrasing variance, because they are not parsed from
//     phrasing. `*Source: X*`, `**Sources**: X` and `[Source: X]` all produce
//     the same chips: the ones the tool calls justify.
//   - "No sources" becomes a fact with a reason attached (see SourceProvenance),
//     rather than a silent absence. With zero documents ingested today, that is
//     the case a user actually hits.

/** What kind of thing a chip points at. Only `document`/`web` have a URI. */
export type SourceKind = 'document' | 'graph' | 'web';

export interface AnswerSource {
  /** 1-based citation number, assigned in order of first appearance. */
  n: number;
  kind: SourceKind;
  /** Present for retrieved documents and fetched pages; absent for data origins. */
  uri?: string;
  /** Human label — a document title where we have one, else a derived name. */
  label: string;
  /** `tool` = observed in the stream; `prose` = a URI the model wrote itself. */
  origin: 'tool' | 'prose';
  /** Longer explanation for the chip tooltip. */
  detail?: string;
}

/**
 * Why the source list looks the way it does. This is what lets the UI tell
 * four situations apart that used to render identically: nothing ran, a
 * retrieval ran and matched nothing, the model cited something we could not
 * verify, and a genuinely sourced answer.
 */
export interface SourceProvenance {
  /** Tool calls observed this turn (any tool). */
  toolCalls: number;
  /** Of those, calls against the knowledge base. */
  retrievalCalls: number;
  /** Documents those retrieval calls actually returned. */
  documentsRetrieved: number;
  /** Citations the model wrote that carried no URI — removed, not rendered. */
  unverifiedClaims: number;
}

export interface ExtractedSources {
  cleaned: string;
  sources: AnswerSource[];
  provenance: SourceProvenance;
}

export interface ToolCallLike {
  name: string;
  args?: string;
  result?: string;
}

const EMPTY_PROVENANCE: SourceProvenance = {
  toolCalls: 0,
  retrievalCalls: 0,
  documentsRetrieved: 0,
  unverifiedClaims: 0,
};

// ── URI handling ─────────────────────────────────────────────────────────────

const URI_RE = /^(s3:\/\/|https?:\/\/)/i;
const URI_SCAN_RE = /(?:s3|https?):\/\/[^\s,;)\]}"']+/gi;
/** A key that is just an opaque id tells the reader nothing on its own. */
const OPAQUE_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

/**
 * Human label for a URI.
 *
 * Last path segment, URI-decoded, extension stripped. Two deliberate
 * departures from "just use the URI":
 *   - an opaque basename (UUID / long hex) becomes `document 9f3a2b1c…`,
 *     because a bare UUID chip communicates nothing; the full URI is still in
 *     the tooltip.
 *   - the raw URI is never the label. If there is no usable segment we fall
 *     back to the host/bucket, which at least names where it lives.
 */
export function labelFor(uri: string): string {
  const noScheme = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const segments = noScheme.split('/').filter(Boolean);
  const bucket = segments[0] ?? noScheme;
  let last = segments[segments.length - 1] ?? noScheme;
  last = last.split(/[?#]/)[0] ?? last;
  try {
    last = decodeURIComponent(last);
  } catch {
    /* malformed escape — keep the raw segment */
  }
  // Strip a trailing file extension ("perf-Theo Williams.txt" → "perf-Theo
  // Williams") without eating dot-names that are all extension.
  const stripped = last.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  if (stripped.trim()) last = stripped;
  last = last.trim();
  if (!last) return bucket;
  if (OPAQUE_RE.test(last)) return `document ${last.slice(0, 8)}…`;
  return last;
}

// ── Prose citations ──────────────────────────────────────────────────────────

// `[Source: …]` / `[Sources: …]`, anywhere in the text.
const BRACKET_RE = /\[\s*Sources?\s*:\s*([^\]]*)\]/gi;
// `*Source: …*` / `**Sources: …**` — the shape the supervisor actually emits.
const EMPHASIS_RE = /\*{1,2}\s*Sources?\s*:\s*([^*\n]*)\*{1,2}/gi;
// A whole line that is nothing but a citation, with or without a list marker
// and with or without bold on the label: `- **Sources**: Relational graph`.
const LINE_RE = /^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*(?:\*{1,2}|_{1,2})?\s*Sources?\s*(?:\*{1,2}|_{1,2})?\s*:\s*(.*)$/i;
// An unclosed bracket group at the very end (mid-stream or truncated output).
const DANGLING_TAIL_RE = /\[\s*Sources?\s*:[^\]]*$/i;

/**
 * Pull the URIs out of one citation fragment.
 *
 * Comma-split first, because an s3 key may contain spaces ("perf-Theo
 * Williams.txt") so whitespace cannot be a separator. If no whole item is a
 * URI we scan for embedded ones, which catches "see https://x for details".
 */
function harvestUris(inner: string): string[] {
  const items = inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => URI_RE.test(s));
  if (items.length > 0) return items;
  return inner.match(URI_SCAN_RE) ?? [];
}

/** Collapse the whitespace/punctuation debris left where a citation was. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]+([.,;:!?])/g, '$1') // "word ." → "word."
    .replace(/\(\s*\)/g, '') // empty parens left behind
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]*$/gm, '') // orphaned list marker
    // Doubled spaces inside a line only: leading indentation is Markdown
    // structure — "   - Decision" under "1. …" is that item's sub-list, and
    // collapsing it to one space split the list into flat runs (search DEFECTS 2).
    .replace(/(\S)[ \t]{2,}/g, '$1 ')
    .replace(/[ \t]+$/gm, '') // trailing spaces per line
    .replace(/\n{3,}/g, '\n\n') // blank-line runs
    .trim();
}

interface ProseResult {
  cleaned: string;
  uris: string[];
  unverifiedClaims: number;
}

/**
 * Remove every citation-shaped fragment from the prose, keeping the URIs it
 * contained. A fragment with no URI is a claim we cannot check — it is dropped
 * from the answer and counted, so the UI can say so instead of printing an
 * internal agent name as though it were a citation.
 */
function readProse(text: string): ProseResult {
  const uris: string[] = [];
  let unverifiedClaims = 0;

  const take = (inner: string): void => {
    const found = harvestUris(inner);
    if (found.length > 0) uris.push(...found);
    else if (inner.trim()) unverifiedClaims += 1;
  };

  let out = text.replace(BRACKET_RE, (_whole, inner: string) => {
    take(inner);
    return '';
  });
  out = out.replace(EMPHASIS_RE, (_whole, inner: string) => {
    take(inner);
    return '';
  });
  out = out
    .split('\n')
    .filter((line) => {
      const m = LINE_RE.exec(line);
      if (!m) return true;
      take(m[1] ?? '');
      return false;
    })
    .join('\n');

  return { cleaned: tidy(out.replace(DANGLING_TAIL_RE, '')), uris, unverifiedClaims };
}

// ── Tool-derived provenance ──────────────────────────────────────────────────

// `search_organization` is the supervisor's retrieval hop: it routes to the
// Search agent, which runs `query_knowledge_base` and hands back an answer that
// cites the KB documents it used as inline `[Source: s3://…]`. So it IS a
// retrieval call — the documents just arrive in prose, not a JSON result array
// (see `documentsFromResult`). Matching it here is what makes a supervisor turn
// chip its real documents instead of one generic A2A placeholder.
const RETRIEVAL_RE = /retriev|knowledge_base|knowledgebase|search_organization/i;
const GRAPH_RE = /query_graph|^graph$|_sql|sql_/i;
const WEB_RE = /fetch_web|browse|web_page/i;

/**
 * Supervisor tools are A2A hops, and the sub-agent hands back prose — a live
 * TOOL_CALL_RESULT for `get_expertise_scores` is literally "The top 2
 * Kubernetes experts are: …". There is no URI to be had. What IS known, and
 * true, is which body of data the hop consulted, so that is what the chip
 * says. Never the agent's name: "Scoring specialist" is our topology, not the
 * user's evidence.
 *
 * `search_organization` is NOT here — it retrieves documents and is handled by
 * the retrieval branch, which chips the actual s3 URIs it cited.
 */
const A2A_ORIGINS: Array<[RegExp, string, string]> = [
  [/get_expertise_scores/i, 'expertise scores', 'Ranking computed over the org graph'],
  [/get_strategic_advice/i, 'advisory analysis', 'Derived from org graph structure, not a stored document'],
];

/** Table names a read-only query touched, for a "org graph (people, skills)" chip. */
function tablesInSql(sql: string): string[] {
  const out: string[] = [];
  const re = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const t = m[1];
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 4) break;
  }
  return out;
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

interface RetrievedDoc {
  uri: string;
  title?: string;
}

/**
 * Documents a retrieval result names.
 *
 * `query_knowledge_base` returns `[{content, score, source}]`; the middleware
 * annotates each item with `title` when it can resolve one from the
 * `documents` table. Both the annotated and un-annotated shapes are read, plus
 * the raw Bedrock `location.s3Location.uri` shape, so this keeps working if a
 * tool starts returning retrieval results verbatim.
 */
export function retrievedDocuments(result: string | undefined): RetrievedDoc[] {
  const parsed = parseJson(result);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { results?: unknown })?.results)
      ? ((parsed as { results: unknown[] }).results)
      : [];
  const out: RetrievedDoc[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const location = r['location'] as { s3Location?: { uri?: unknown } } | undefined;
    const raw =
      (typeof r['source'] === 'string' && r['source']) ||
      (typeof r['uri'] === 'string' && r['uri']) ||
      (typeof r['sourceUri'] === 'string' && r['sourceUri']) ||
      (typeof location?.s3Location?.uri === 'string' && location.s3Location.uri) ||
      '';
    if (!raw || !URI_RE.test(raw)) continue;
    const title = typeof r['title'] === 'string' && r['title'].trim() ? r['title'].trim() : undefined;
    out.push(title ? { uri: raw, title } : { uri: raw });
  }
  return out;
}

/**
 * Documents a retrieval tool call names, across both result shapes.
 *
 * `query_knowledge_base` returns a JSON array (`retrievedDocuments`), but the
 * supervisor's `search_organization` hop returns the Search agent's *prose*
 * answer, which cites its KB documents inline as `[Source: s3://…]`. When the
 * JSON shape yields nothing, scan the raw result for those URIs so the hop
 * still chips the documents it actually used. Deduped, JSON always preferred.
 */
export function documentsFromResult(result: string | undefined): RetrievedDoc[] {
  const docs = retrievedDocuments(result);
  if (docs.length > 0 || !result) return docs;
  const seen = new Set<string>();
  const out: RetrievedDoc[] = [];
  for (const uri of result.match(URI_SCAN_RE) ?? []) {
    if (seen.has(uri)) continue;
    seen.add(uri);
    out.push({ uri });
  }
  return out;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Derive an answer's sources from the turn's tool calls, and strip the model's
 * own unverifiable citations out of its prose.
 *
 * Ordering is deliberate: observed sources (tool calls) come first and prose
 * URIs after, so the numbering reflects evidence strength.
 */
export function deriveSources(input: {
  content: string;
  toolCalls?: ToolCallLike[] | undefined;
}): ExtractedSources {
  const text = typeof input.content === 'string' ? input.content : '';
  const prose = readProse(text);
  const provenance: SourceProvenance = { ...EMPTY_PROVENANCE, unverifiedClaims: prose.unverifiedClaims };

  const sources: AnswerSource[] = [];
  const seen = new Set<string>();
  const add = (s: Omit<AnswerSource, 'n'>): void => {
    const key = s.uri ?? `${s.kind}:${s.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ ...s, n: sources.length + 1 });
  };

  for (const tc of input.toolCalls ?? []) {
    if (!tc?.name) continue;
    provenance.toolCalls += 1;

    if (RETRIEVAL_RE.test(tc.name)) {
      provenance.retrievalCalls += 1;
      const docs = documentsFromResult(tc.result);
      provenance.documentsRetrieved += docs.length;
      for (const d of docs) {
        const kind: SourceKind = /^s3:/i.test(d.uri) ? 'document' : 'web';
        add({ kind, uri: d.uri, label: d.title ?? labelFor(d.uri), origin: 'tool', detail: d.uri });
      }
      continue;
    }

    if (WEB_RE.test(tc.name)) {
      const args = parseJson(tc.args) as { url?: unknown } | null;
      const url = typeof args?.url === 'string' ? args.url : '';
      if (url && URI_RE.test(url)) {
        add({ kind: 'web', uri: url, label: labelFor(url), origin: 'tool', detail: url });
      }
      continue;
    }

    if (GRAPH_RE.test(tc.name)) {
      const args = parseJson(tc.args) as { sql?: unknown } | null;
      const sql = typeof args?.sql === 'string' ? args.sql : '';
      const tables = tablesInSql(sql);
      add({
        kind: 'graph',
        label: tables.length > 0 ? `org graph: ${tables.join(', ')}` : 'org graph',
        origin: 'tool',
        detail: tables.length > 0 ? `Read from ${tables.join(', ')} in the org graph` : 'Read from the org graph',
      });
      continue;
    }

    const a2a = A2A_ORIGINS.find(([re]) => re.test(tc.name));
    if (a2a) add({ kind: 'graph', label: a2a[1], origin: 'tool', detail: a2a[2] });
  }

  for (const uri of prose.uris) {
    add({ kind: URI_RE.test(uri) && /^s3:/i.test(uri) ? 'document' : 'web', uri, label: labelFor(uri), origin: 'prose', detail: uri });
  }

  return { cleaned: prose.cleaned, sources, provenance };
}

/**
 * The honest one-liner for a turn's provenance, or null when silence is
 * accurate (nothing ran, nothing was claimed).
 *
 * This is what separates the four situations that used to render identically:
 *   - nothing ran, nothing claimed              → null (say nothing)
 *   - retrieval ran, matched no documents       → "knowledge base searched — …"
 *   - the model cited a non-document            → "removed 1 citation …"
 *   - tools ran but produced no citable source  → "no document sources …"
 */
export function provenanceNote(
  sources: AnswerSource[],
  provenance: SourceProvenance | undefined,
): string | null {
  if (!provenance) return null;
  const parts: string[] = [];

  if (provenance.retrievalCalls > 0 && provenance.documentsRetrieved === 0) {
    parts.push('knowledge base searched — no documents matched');
  }
  if (provenance.unverifiedClaims > 0) {
    parts.push(
      provenance.unverifiedClaims === 1
        ? 'removed 1 citation with no source behind it'
        : `removed ${provenance.unverifiedClaims} citations with no source behind them`,
    );
  }
  if (parts.length === 0 && sources.length === 0) {
    if (provenance.toolCalls === 0) return null; // nothing ran, nothing claimed
    parts.push('no document sources for this answer');
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Text-only entry point (streaming partials, and any caller without tool
 * calls to hand). Same cleaning rules; sources limited to URIs the model wrote.
 */
export function extractSources(text: string): ExtractedSources {
  if (!text || typeof text !== 'string') {
    return { cleaned: text ?? '', sources: [], provenance: { ...EMPTY_PROVENANCE } };
  }
  return deriveSources({ content: text });
}
