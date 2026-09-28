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
