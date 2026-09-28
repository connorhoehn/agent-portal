import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ScopeHeader, ViewportFillRegion } from '@connorhoehnslalom/ui-components';
import { Banner, Button, EmptyState, Inline, LoadingState, SearchInput, Select, Stack, SubNavLayout, Tabs, activeNavItemClassName, inactiveNavItemClassName, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import InvokePage, { type SearchConversationAPI } from '../InvokePage';
import { useFetch } from '../../hooks/useFetch';
import { SearchComposer } from './SearchComposer';
import { SearchConnections } from './SearchConnections';
import { parseRecordKeys, readSearchEvidence, readSearchEdges } from './searchModel';
import { recordKey, SEARCH_LABELS, SEARCH_TYPES, type SearchRecord, type SearchRecordType, type SearchResponse, type SearchTab } from './searchTypes';

interface SavedSearch {
  id: string; name: string; query: string; scope: string; types: SearchRecordType[];
  tab: SearchTab; selectedKeys: string[];
}
async function readJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials:'include', ...init });
  if (!response.ok) { const body=await response.json().catch(()=>({})); throw new Error(body.error ?? `Request failed (${response.status})`); }
  return response.status===204 ? undefined as T : response.json();
}
export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const refs = useMemo(()=>parseRecordKeys(params.get('context') ?? params.get('selection')), [params]);
  const submitted = useCallback((query:string)=>setParams(previous=>{
    const next=new URLSearchParams(previous); next.set('q',query);next.set('tab','answer');next.delete('offset');return next;
  }),[setParams]);
  return <InvokePage contextRefs={refs} onSubmitted={submitted} renderWorkspace={api=><SearchWorkspace api={api} />} />;
}
function SearchWorkspace({ api }: {api: SearchConversationAPI}) {
  const [params, setParams]=useSearchParams();
  const navigate=useNavigate();
  const query=params.get('q') ?? '';
  const type=SEARCH_TYPES.includes(params.get('type') as SearchRecordType) ? params.get('type') as SearchRecordType : 'all';
  const tab=(['results','answer','connections'].includes(params.get('tab') ?? '') ? params.get('tab') : 'results') as SearchTab;
  const scope=params.get('scope') ?? '';
  const offset=Math.max(0,Number(params.get('offset'))||0);
  const selected=useMemo(()=>parseRecordKeys(params.get('selection')).map(recordKey),[params]);
  const attached=useMemo(()=>parseRecordKeys(params.get('context')),[params]);
  const [searchText,setSearchText]=useState(query);
  const [moreTypes,setMoreTypes]=useState(type==='asset');
  const [busy,setBusy]=useState(false);
  const [actionError,setActionError]=useState<string|null>(null);
  const [saveName,setSaveName]=useState<string|null>(null);
  const [conversationExpanded,setConversationExpanded]=useState(false);
  const composerRef=useRef<HTMLDivElement>(null);
  useEffect(()=>setSearchText(query),[query]);
  const update=useCallback((values:Record<string,string|null>,replace=false)=>setParams(previous=>{
    const next=new URLSearchParams(previous);for(const [key,value] of Object.entries(values)) value ? next.set(key,value):next.delete(key);return next;
  },{replace}),[setParams]);
  const queryString=new URLSearchParams({q:query,type,limit:'25',offset:String(offset),...(scope?{scope}:{})});
  const {data,error,isLoading,refresh}=useFetch<SearchResponse>(`/api/search?${queryString}`);
  const {data:saved,error:savedError,refresh:refreshSaved}=useFetch<{searches:SavedSearch[]}>('/api/saved-searches');
  const {data:scopes}=useFetch<SearchResponse>('/api/search?type=initiative&limit=100');
  const requestedKeys=[...new Set([...selected,...attached.map(recordKey)])].slice(0,30);
  const {data:resolved}=useFetch<{records:SearchRecord[];edges:SearchResponse['edges']}>(requestedKeys.length?`/api/search/records?${new URLSearchParams({keys:requestedKeys.join(',')})}`:null);
  const allRecords=useMemo(()=>{
    const records=new Map<string,SearchRecord>();
    for(const r of [...(data?.results??[]),...(data?.related??[]),...(scopes?.results??[]),...(resolved?.records??[]),...api.messages.flatMap(m=>readSearchEvidence(m.toolCalls))]) records.set(recordKey(r),r);
    return records;
  },[data,scopes,resolved,api.messages]);
  const evidence=useMemo(()=>api.messages.flatMap(m=>readSearchEvidence(m.toolCalls)),[api.messages]);
  const allGraphRecords=useMemo(()=>{
    const records=new Map<string,SearchRecord>();
    for(const r of [...(resolved?.records??[]),...evidence,...(data?.results??[]),...(data?.related??[])]) records.set(recordKey(r),r);
    return [...records.values()];
  },[data,evidence,resolved]);
  const lastAnswer=api.messages.filter(m=>m.role==='assistant').at(-1)?.content;
  const graphEdges=useMemo(()=>[...new Map([...(data?.edges??[]),...(resolved?.edges??[]),...api.messages.flatMap(m=>readSearchEdges(m.toolCalls))].map(edge=>[edge.id,edge])).values()],[data,resolved,api.messages]);
  const graphRecords=useMemo(()=>{
    if(params.get('graphAll')==='1')return allGraphRecords;
    const focus=new Set(selected);
    const neighbors=new Set(graphEdges.filter(e=>focus.has(e.source)||focus.has(e.target)).flatMap(e=>[e.source,e.target]));
    const prioritized=selected.length?[...allGraphRecords.filter(r=>focus.has(recordKey(r))),...allGraphRecords.filter(r=>!focus.has(recordKey(r))&&neighbors.has(recordKey(r))),...allGraphRecords.filter(r=>!neighbors.has(recordKey(r))&&!focus.has(recordKey(r)))]:allGraphRecords;
    return prioritized.slice(0,Math.max(16,selected.length));
  },[allGraphRecords,graphEdges,params,selected]);
  const navigationHref=(changes:Record<string,string>)=>{
    const next=new URLSearchParams(params);Object.entries(changes).forEach(([key,value])=>next.set(key,value));next.delete('offset');return `/iq/search?${next}`;
  };
  const mainTypes=['all',...SEARCH_TYPES.filter(t=>moreTypes||t!=='asset')] as Array<SearchRecordType|'all'>;
  const items:SubNavItem[]=[
    ...mainTypes.map(kind=>({path:navigationHref({type:kind,tab:'results'}),label:SEARCH_LABELS[kind],count:!error&&data?data.counts[kind]:undefined})),
    {path:'more-types',label:moreTypes?'Fewer types':'More types',onClick:()=>setMoreTypes(!moreTypes)},
    ...(saved?.searches??[]).map(s=>({path:`saved:${s.id}`,label:s.name,group:'Saved',onClick:()=>{
      api.newSession();setParams(new URLSearchParams({q:s.query,tab:s.tab,type:s.types.length===1?s.types[0]:'all',...(s.scope&&s.scope!=='workspace'?{scope:s.scope}:{}),...(s.selectedKeys.length?{selection:s.selectedKeys.join(',')}:{}),saved:s.id}));
    }})),
    ...api.sessions.slice(0,12).map(s=>({path:`/iq/search?${new URLSearchParams({session:s.sessionId,tab:'answer',q:s.title??''})}`,label:s.title||'Untitled conversation',group:'Recent'})),
  ];
  async function submit(text:string, agentId?:string) {
    if(!text.trim()||api.isStreaming||busy)return false;
    setBusy(true);setActionError(null);
    try {
      let refs=attached;
      if(!refs.length){
        const response=await readJSON<SearchResponse>(`/api/search?${new URLSearchParams({q:text,limit:'12',...(scope?{scope}:{})})}`);
        refs=[...response.results,...(response.related??[])].slice(0,12).map(r=>({id:r.id,type:r.type}));
      }
      api.send(text,refs,agentId ?? 'orgiq-supervisor');api.setInput('');return true;
    }catch(e){setActionError(e instanceof Error?e.message:'Search is unavailable.');return false;}finally{setBusy(false);}
  }
  function newSearch(){api.newSession();api.setInput('');setSearchText('');setParams(new URLSearchParams());}
  async function saveSearch(){
    if(!saveName?.trim())return;setBusy(true);setActionError(null);
    try {await readJSON('/api/saved-searches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:saveName.trim(),query,scope:scope||'workspace',types:type==='all'?[]:[type],tab,selectedKeys:selected})});setSaveName(null);refreshSaved();}
    catch(e){setActionError(e instanceof Error?e.message:'Could not save search.');}finally{setBusy(false);}
  }
  async function deleteSaved(){const id=params.get('saved');if(!id)return;setActionError(null);try{await readJSON(`/api/saved-searches/${encodeURIComponent(id)}`,{method:'DELETE'});update({saved:null});refreshSaved();}catch(e){setActionError(e instanceof Error?e.message:'Could not remove saved search.');}}
  function askSelection(){update({context:selected.join(',')});api.setInput(selected.length===1?'Tell me about this record.':`What connects these ${selected.length} records, and what needs attention?`);composerRef.current?.querySelector<HTMLElement>('[contenteditable=true],textarea,input')?.focus();}
  return <ViewportFillRegion bottomGap={0} data-testid="search-workspace">
    <Stack gap="none" className="h-full min-h-0 bg-surface" data-shell-flush>
      <SubNavLayout title="Search" storageKey="search-nav" railLabel="Search navigation" contentAs="section" contentLabel="Search workspace"
        titleAction={<Button variant="ghost" size="sm" aria-label="New search" disabled={api.isStreaming} onClick={newSearch}>＋</Button>}
        items={items} renderNavItem={(item,body)=>{
          const wanted=new URLSearchParams(item.path.split('?')[1]);const active=item.group==='Recent'?wanted.get('session')===api.sessionId:wanted.get('type')===type;
          return <Link to={item.path} aria-current={active?'page':undefined} className={active?activeNavItemClassName:inactiveNavItemClassName}>{body}</Link>;
        }}>
        <Stack gap="none" className="h-full min-h-0 min-w-0">
          <ScopeHeader variant="crumbs" breadcrumbs={[{label:'Org'},{label:'Search'}]} />
          <Stack gap="sm" className="px-6 pb-2 shrink-0">
            <Inline align="start" justify="between" gap="sm" wrap={false}>
              <h1 className="text-xl font-semibold text-text-primary min-w-0 break-words">{query||'Search'}</h1>
              <Inline gap="xs" className="shrink-0">
                {params.has('saved')&&<Button size="sm" variant="ghost" onClick={()=>void deleteSaved()}>Remove saved search</Button>}
                <Button size="sm" variant="secondary" disabled={!query} onClick={()=>setSaveName(query)}>Save search</Button>
              </Inline>
            </Inline>
            <form onSubmit={e=>{e.preventDefault();update({q:searchText,tab:'results',offset:null});}} className="flex flex-wrap items-center gap-2">
              <SearchInput aria-label="Search workspace" placeholder="Search people, work, decisions…" value={searchText} onChange={setSearchText} size="sm" className="w-80 max-w-full" />
              <Button size="sm" variant="secondary" type="submit">Search</Button>
              <Select size="sm" className="w-auto max-w-64" aria-label="Search scope" value={scope} onChange={e=>update({scope:e.target.value,offset:null})} options={[{value:'',label:'Workspace'},...(scopes?.results??[]).map(r=>({value:r.id,label:r.title})),...(scope&&!scopes?.results.some(r=>r.id===scope)?[{value:scope,label:scope}]:[])]} />
              {scope&&<Button size="sm" variant="ghost" onClick={()=>update({scope:null})}>Clear scope ×</Button>}
            </form>
            {saveName!==null&&<form onSubmit={e=>{e.preventDefault();void saveSearch();}} className="flex gap-2 items-center">
              <input className="border border-border rounded px-2 py-1 text-sm flex-1" aria-label="Saved search name" value={saveName} maxLength={120} onChange={e=>setSaveName(e.target.value)} />
              <Button size="sm" type="submit" disabled={busy||!saveName.trim()}>Save</Button><Button size="sm" variant="ghost" onClick={()=>setSaveName(null)}>Cancel</Button>
            </form>}
            {actionError&&<Banner variant="error" title={actionError} />}
            {savedError&&<span className="text-xs text-text-tertiary">Saved searches unavailable. <button className="text-primary" onClick={refreshSaved}>Retry</button></span>}
            <Tabs value={tab} onValueChange={value=>update({tab:value})} aria-label="Search views" items={[{id:'results',label:`Results${data&&!error?` (${data.counts.all})`:''}`},{id:'answer',label:'Answer'},{id:'connections',label:'Connections'}]} />
          </Stack>
          {tab==='results'&&<div className="flex-1 min-h-0 overflow-auto px-6" data-testid="search-results">
            {error?<EmptyState title="Search unavailable" description={error} actionLabel="Retry" onAction={refresh} />:isLoading&&!data?<LoadingState />:<>
              {!!data?.partial?.length&&<Banner variant="warning" title="Some sources are unavailable">{data.partial.join(' · ')}</Banner>}
              {!data?.results.length?<EmptyState title={query?'No matching records':'Search your workspace'} description={query?'Try another phrase or clear a filter.':'Find people, initiatives, work, decisions, and knowledge.'} />:
                <div className="divide-y divide-border">{data.results.map(r=><SearchResult key={recordKey(r)} record={r} selected={selected.includes(recordKey(r))} onSelect={()=>update({selection:(selected.includes(recordKey(r))?selected.filter(k=>k!==recordKey(r)):[...selected,recordKey(r)]).join(',')})} />)}</div>}
              {!!data?.total&&<Inline justify="between" gap="sm" className="py-4 text-xs text-text-tertiary"><span>{offset+1}–{Math.min(offset+25,data.total)} of {data.total}</span><Inline gap="xs"><Button size="sm" variant="secondary" disabled={!offset} onClick={()=>update({offset:String(Math.max(0,offset-25))})}>Previous</Button><Button size="sm" variant="secondary" disabled={offset+25>=data.total} onClick={()=>update({offset:String(offset+25)})}>Next</Button></Inline></Inline>}
              {selected.length>0&&<Inline className="sticky bottom-0 bg-surface border-t border-border py-2" justify="between"><span className="text-xs">{selected.length} selected</span><Button size="sm" onClick={askSelection}>Ask about selection →</Button></Inline>}
            </>}
          </div>}
          <div className={tab==='answer'?'flex flex-col flex-1 min-h-0 px-6':'hidden'} aria-hidden={tab!=='answer'}>{api.transcript}</div>
          {tab==='connections'&&<Stack gap="none" className="flex-1 min-h-0 px-6">
            {!!data?.partial?.length&&<Banner variant="warning" title="Some sources are unavailable">{data.partial.join(' · ')}</Banner>}
            {allGraphRecords.length>16&&<Inline gap="sm" className="text-xs text-text-tertiary py-1"><span>Showing {graphRecords.length} of {allGraphRecords.length} related records</span><Button size="sm" variant="ghost" onClick={()=>update({graphAll:params.get('graphAll')==='1'?null:'1'})}>{params.get('graphAll')==='1'?'Focus relevant records':'Show all'}</Button></Inline>}
            {error?<EmptyState title="Connections unavailable" description={error} actionLabel="Retry" onAction={refresh}/>:<SearchConnections records={graphRecords} edges={graphEdges} selectedKeys={selected} onSelectionChange={keys=>update({selection:keys.join(',')},true)} onAskSelection={askSelection} onOpenRecord={r=>navigate(r.href)} layout={(['force','radial','hierarchy'].includes(params.get('layout')??'')?params.get('layout'):'force') as 'force'|'radial'|'hierarchy'} typeFilter={(SEARCH_TYPES.includes(params.get('graphType') as SearchRecordType)?params.get('graphType'):'all') as SearchRecordType|'all'} onTypeFilterChange={graphType=>update({graphType})} onLayoutChange={layout=>update({layout})} />}
          </Stack>}
          {tab==='connections'&&(lastAnswer||api.isStreaming)&&<Stack gap="none" className="border-t border-border mx-6 shrink-0">
            <Inline justify="between" className="py-2"><span className="text-xs text-text-secondary truncate min-w-0">{api.isStreaming?'Answering…':lastAnswer?.replace(/[#*\[\]]/g,'').slice(0,180)}</span><Button variant="ghost" size="sm" onClick={()=>setConversationExpanded(!conversationExpanded)}>{conversationExpanded?'Collapse':'Expand'} conversation</Button></Inline>
            {conversationExpanded&&<div className="max-h-40 overflow-auto text-sm text-text-secondary pb-2">{lastAnswer||api.streamingText}</div>}
          </Stack>}
          <div ref={composerRef} className="mx-6 mb-3 mt-2 shrink-0 min-w-0">
            <SearchComposer value={api.input} onChange={api.setInput} onSubmit={submit} disabled={busy||api.isStreaming}
              agents={api.agents.filter(agent=>!/(^|[-_])assessment[-_]/i.test(agent.id))}
              references={attached.map(ref=>allRecords.get(recordKey(ref))).filter((r):r is SearchRecord=>Boolean(r))}
              onRemoveReference={key=>update({context:attached.filter(r=>recordKey(r)!==key).map(recordKey).join(',')})}
              onSearchContext={async q=>(await readJSON<SearchResponse>(`/api/search?${new URLSearchParams({q,limit:'8'})}`)).results}
              contextSuggestions={data?.results??[]}
              onAddReference={record=>update({context:[...new Set([...attached.map(recordKey),recordKey(record)])].join(',')})}
            />
            {api.historyUnavailable&&<p className="px-3 pt-1 text-xs text-text-tertiary">Session history is unavailable until memory is configured.</p>}
          </div>
        </Stack>
      </SubNavLayout>
    </Stack>
  </ViewportFillRegion>;
}
function SearchResult({record:r,selected,onSelect}:{record:SearchRecord;selected:boolean;onSelect:()=>void}){
  return <div className={`flex items-start gap-3 py-3 px-2 ${selected?'bg-primary/5':''}`}>
    <input type="checkbox" className="mt-1 accent-primary" aria-label={`Select ${r.title}`} checked={selected} onChange={onSelect} />
    <div className="min-w-0 flex-1"><Link to={r.href} className="text-sm font-medium hover:text-primary">{r.title}</Link><p className="text-xs text-text-secondary mt-1 line-clamp-2">{r.description||r.subtitle}</p><span className="text-xs text-text-tertiary">{SEARCH_LABELS[r.type]}{r.subtitle?` · ${r.subtitle}`:''}</span></div>
    {r.status&&<span className="text-xs text-text-secondary shrink-0">{r.status.replaceAll('_',' ')}</span>}
  </div>;
}
