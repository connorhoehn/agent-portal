import { parseRecordKeys, recordKey, SEARCH_TYPES, type SearchEdge, type SearchRecord, type SearchRecordType } from './searchTypes.ts';
export function searchMigration(pathname: string, search: string, hash = '') {
  const params = new URLSearchParams(search);
  const graph = /explore|graph/.test(pathname);
  if (!params.has('tab')) params.set('tab', graph ? 'connections' : 'answer');
  const focus = params.get('focus') ?? params.get('selected');
  if (focus && !params.has('selection')) params.set('selection', focus.split(',').filter(Boolean).map(id => id.includes(':') && SEARCH_TYPES.includes(id.split(':')[0] as SearchRecordType) ? id : `person:${id}`).join(','));
  const entities = params.get('entities');
  if (entities && !params.has('type')) params.set('type', ({people:'person', projects:'initiative'} as Record<string,string>)[entities] ?? 'all');
  return `/iq/search?${params}${hash}`;
}
export function readSearchEvidence(toolCalls?: Array<{name: string; result?: string}>) {
  const records = new Map<string, SearchRecord & {n:number}>();
  for (const tool of toolCalls ?? []) {
    if (tool.name !== 'search_context' || !tool.result) continue;
    try {
      const body = JSON.parse(tool.result);
      for (const r of body.records ?? []) {
        if (!r || typeof r.id !== 'string' || !SEARCH_TYPES.includes(r.type) || typeof r.title !== 'string' || typeof r.href !== 'string' || !r.href.startsWith('/iq/') || !Number.isInteger(r.n)) continue;
        records.set(recordKey(r), r);
      }
    } catch { /* Older truncated tool output cannot substantiate a citation. */ }
  }
  return [...records.values()];
}
export function linkSearchCitations(content: string, records: Array<SearchRecord & {n:number}>) {
  const byNumber = new Map(records.map(r => [r.n,r]));
  return content.replace(/\[(\d+)\](?!\()/g, (match, n) => {
    const record = byNumber.get(Number(n));
    return record ? `[${n}](${record.href.replace(/\)/g, '%29')})` : match;
  });
}
export { parseRecordKeys };

/** Only persisted, typed relationships can accompany a restored answer. */
export function readSearchEdges(toolCalls?: Array<{name:string;result?:string}>): SearchEdge[] {
  return (toolCalls??[]).flatMap(tool=>{
    if(tool.name!=='search_context'||!tool.result)return [];
    try {const body=JSON.parse(tool.result);return (Array.isArray(body.edges)?body.edges:[]).filter((edge:SearchEdge)=>typeof edge.id==='string'&&typeof edge.label==='string'&&typeof edge.source==='string'&&typeof edge.target==='string'&&parseRecordKeys(edge.source).length===1&&parseRecordKeys(edge.target).length===1);}catch{return [];}
  });
}

/**
 * The composer issues queries (decision 9): a bare message — nothing
 * attached, nothing selected — becomes the new `q`, replacing any previous
 * query. A message sent WITH context or a selection is a question about
 * those records and leaves `q` alone, so "Ask about selection → Send" never
 * rewrites the results or empties the graph. Returns the `q` to keep.
 */
export function nextQueryAfterSend({ q, attached, selected, text }: {
  q: string | null; attached: number; selected: number; text: string;
}): string | null {
  if (attached > 0 || selected > 0) return q || null;
  return text.trim() || q || null;
}

/** After a send, stay on the tab the user was on; only Results moves to Answer. */
export function nextTabAfterSend(tab: string | null): 'answer' | 'connections' {
  return tab === 'connections' ? 'connections' : 'answer';
}

/**
 * The assistant strip's collapsed one-liner: plain text with the Markdown
 * syntax stripped (links keep their label) and bare `s3://…` URIs dropped.
 */
export function assistantStripText(markdown: string): string {
  return markdown
    .replace(/<thinking>[\s\S]*?(<\/thinking>|$)/g, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\bs3:\/\/[^\s)\]>]+/g, '')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/^\s*([-*_]\s*){3,}$/gm, ' ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*#]/g, '')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The expanded assistant strip renders Markdown, but the agent's trailing
 * "Sources: s3://…" line is raw storage URIs, not prose — the numbered
 * source chips already carry the citations. Drop lines that are only a
 * sources label and/or bare `s3://` URIs; keep every other line as is.
 */
export function stripSourceUris(markdown: string): string {
  const uri = /\bs3:\/\/[^\s)\]>,*_]+/g;
  const label = /^\s*(\*{1,2}|_{1,2})?\s*sources?\s*:?\s*(\*{1,2}|_{1,2})?/i;
  return markdown
    .split('\n')
    .filter(line => {
      if (!uri.test(line) && !label.test(line)) return true;
      uri.lastIndex = 0;
      const rest = line.replace(/^\s*([-*+]|\d+[.)])\s+/, '').replace(label, '').replace(uri, '').replace(/[,.;:*_\s]+/g, '');
      return rest.length > 0;
    })
    .join('\n')
    .replace(uri, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The header title for a query. A workflow run from an initiative lands here
 * with a whole prompt as `q`; the row shows its first sentence or line, whole
 * — the header (`ScopeHeader` inline, 2.407.15) truncates it to the room it
 * has and the whole prompt goes on `titleHint`, so nothing is cut here: a
 * title cut to a character count lost the rest of the sentence from the
 * hover text and drew "…" with room to spare.
 */
export function searchTitle(q: string): string {
  const first = q.trim().split(/\r?\n/)[0] ?? '';
  const sentence = first.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? first;
  return sentence.trim();
}
