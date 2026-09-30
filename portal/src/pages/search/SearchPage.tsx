import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  CanvasPaneLayout, CitedRecordList, ConnectionPathStrip, DepartmentChips, DepartmentInsightStrip, ExplorerLayout, GraphSearchBox,
  OrgGraph, PersonDetailCard, RailNavList, RailSection, RecordGraph, RecordGraphCard, RecordResultList, ScopeHeader, ViewportFillRegion,
  findConnectionPath, indexBusFactorFindings, recordResultKey,
  type GraphDepartment, type GraphRelationship, type OrgGraphPerson, type PersonDetail, type PersonEvidenceDocument,
  type RailNavListItem, type RecordGraphEdge, type RecordGraphRecord,
} from '@connorhoehnslalom/ui-components';
import {
  Banner, Button, DropdownMenu, EmptyState, FilterChip, IconButton, Inline, Input, LoadingState,
  SegmentedControl, Stack, T,
} from '@connorhoehnslalom/ui-components/shared';
import InvokePage, { type SearchConversationAPI } from '../InvokePage';
import { RangeSliderFrame } from '../RangeSliderFrame';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { SearchComposer } from './SearchComposer';
import { connectionsView, focusedRecordEdges, focusedRecords, focusOrgPeople, orgFocusIds } from './connectionsModel';
import { searchWorkflows } from './searchWorkflows';
import { Markdown } from '../../components/Markdown';
import {
  assistantStripText, linkSearchCitations, nextQueryAfterSend, nextTabAfterSend, parseRecordKeys, readSearchEvidence, readSearchEdges, searchTitle, stripSourceUris,
} from './searchModel';
import { groupResults, openLabelFor, parseSort, resultsFooter } from './resultsModel';
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
const PAGE_SIZE = 25;
const MAIN_TYPES: Array<SearchRecordType | 'all'> = ['all', 'person', 'initiative', 'work', 'decision', 'knowledge'];
const isPlainClick = (event: MouseEvent) => !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);

/** One family for every header control: 28px, 13px/500, secondary ink (decision 9). */
const HEADER_CONTROL='h-7 px-2.5 text-[13px] font-medium text-text-secondary hover:text-text-primary';

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const refs = useMemo(()=>parseRecordKeys(params.get('context') ?? params.get('selection')), [params]);
  // The composer issues queries (decision 9): a bare send becomes the new `q`
  // (nextQueryAfterSend); a send with context or a selection is a question
  // about it and leaves `q` alone. A send stays on the tab it came from
  // unless that was Results.
  const submitted = useCallback((text:string)=>setParams(previous=>{
    const next=new URLSearchParams(previous);
    const q=nextQueryAfterSend({q:previous.get('q'),attached:parseRecordKeys(previous.get('context')).length,selected:parseRecordKeys(previous.get('selection')).length,text});
    if(q!==previous.get('q')){ if(q) next.set('q',q); else next.delete('q'); next.delete('offset'); }
    next.set('tab',nextTabAfterSend(previous.get('tab')));return next;
  }),[setParams]);
  return <InvokePage contextRefs={refs} onSubmitted={submitted} renderWorkspace={api=><SearchWorkspace api={api} />}
    renderAnswerEvidence={toolCalls=><AnswerEvidence toolCalls={toolCalls} />} />;
}

type ToolCalls = Array<{ name: string; result?: string }>;
/** The graph card the workspace hangs under the LAST assistant turn (decision 9).
 *  The transcript is built by InvokePage but rendered inside the workspace, so
 *  a context provided there reaches each turn's evidence. */
const AnswerGraphContext = createContext<{ lastToolCalls?: ToolCalls; card: ReactNode } | null>(null);

/** The records an answer was built from, under each assistant message; the
 *  last turn also carries the graph card. */
function AnswerEvidence({ toolCalls }: { toolCalls?: ToolCalls }) {
  const navigate = useNavigate();
  const graph = useContext(AnswerGraphContext);
  const records = readSearchEvidence(toolCalls);
  const isLast = Boolean(graph && graph.lastToolCalls && toolCalls === graph.lastToolCalls);
  if (!records.length && !isLast) return null;
  return <Stack gap="sm" className="ml-0 sm:ml-11">
    {!!records.length && <CitedRecordList data-testid="search-evidence" records={records}
    onOpen={record => navigate(record.href)}
    onViewConnections={() => {
      const params = new URLSearchParams(window.location.search);
      params.set('tab', 'connections'); params.delete('type');
      params.set('selection', records.map(recordKey).join(','));
      navigate(`/iq/search?${params}`);
    }}
    footnote="Based on project roles and linked work." />}
    {isLast && graph?.card}
  </Stack>;
}

function SearchWorkspace({ api }: {api: SearchConversationAPI}) {
  const [params, setParams]=useSearchParams();
  const navigate=useNavigate();
  const query=params.get('q') ?? '';
  const type=SEARCH_TYPES.includes(params.get('type') as SearchRecordType) ? params.get('type') as SearchRecordType : 'all';
  const tab=(['results','answer','connections'].includes(params.get('tab') ?? '') ? params.get('tab') : 'results') as SearchTab;
  const scope=params.get('scope') ?? '';
  const sort=parseSort(params.get('sort'));
  const offset=Math.max(0,Number(params.get('offset'))||0);
  const selected=useMemo(()=>parseRecordKeys(params.get('selection')).map(recordKey),[params]);
  const attached=useMemo(()=>parseRecordKeys(params.get('context')),[params]);
  const [moreTypes,setMoreTypes]=useState(type==='asset');
  const [busy,setBusy]=useState(false);
  const [actionError,setActionError]=useState<string|null>(null);
  const [saveName,setSaveName]=useState<string|null>(null);
  const [conversationExpanded,setConversationExpanded]=useState(false);
  const [graphCardExpanded,setGraphCardExpanded]=useState(false);
  const composerRef=useRef<HTMLDivElement>(null);
  const update=useCallback((values:Record<string,string|null>,replace=false)=>setParams(previous=>{
    const next=new URLSearchParams(previous);for(const [key,value] of Object.entries(values)) value ? next.set(key,value):next.delete(key);return next;
  },{replace}),[setParams]);
  const queryString=new URLSearchParams({q:query,type,limit:String(PAGE_SIZE),offset:String(offset),sort,...(scope?{scope}:{})});
  const {data,error,isLoading,refresh}=useFetch<SearchResponse>(`/api/search?${queryString}`);
  const {data:saved,error:savedError,refresh:refreshSaved}=useFetch<{searches:SavedSearch[]}>('/api/saved-searches');
  const {data:scopes}=useFetch<SearchResponse>('/api/search?type=initiative&limit=100');
  const requestedKeys=[...new Set([...selected,...attached.map(recordKey)])].slice(0,30);
  const {data:resolved}=useFetch<{records:SearchRecord[];edges:SearchResponse['edges']}>(requestedKeys.length?`/api/search/records?${new URLSearchParams({keys:requestedKeys.join(',')})}`:null);
  const scopeRecord=scope?(scopes?.results??[]).find(r=>r.id===scope) ?? resolved?.records.find(r=>r.type==='initiative'&&r.id===scope):undefined;
  const scopeName=scope?(scopeRecord?.title ?? scope):null;
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
  const lastAssistant=api.messages.filter(m=>m.role==='assistant').at(-1);
  const lastAnswer=lastAssistant?.content;
  const lastSources=useMemo(()=>readSearchEvidence(lastAssistant?.toolCalls),[lastAssistant]);
  const graphEdges=useMemo(()=>[...new Map([...(data?.edges??[]),...(resolved?.edges??[]),...api.messages.flatMap(m=>readSearchEdges(m.toolCalls))].map(edge=>[edge.id,edge])).values()],[data,resolved,api.messages]);
  // Decision 8: a people selection is the org graph; the record graph only
  // ever draws the selection and what an edge connects to it.
  const view=connectionsView({type,selectedKeys:selected,query,edges:graphEdges,records:allGraphRecords});
  const graphRecords=useMemo(()=>focusedRecords(allGraphRecords,graphEdges,selected),[allGraphRecords,graphEdges,selected]);
  const graphRecordEdges=useMemo(()=>focusedRecordEdges(allGraphRecords,graphEdges,selected),[allGraphRecords,graphEdges,selected]);
  const focusIds=useMemo(()=>orgFocusIds(selected),[selected]);
  const showWholeOrg=params.get('graphAll')==='1';
  // One read of the org graph, shared by the People canvas and the Answer card.
  const orgGraph=useFetch<OrgGraphData>(view==='org'?'/api/graph/entities':null);
  const orgCard=useMemo(()=>orgGraph.data?orgGraphCardData(orgGraph.data,focusIds,showWholeOrg):null,[orgGraph.data,focusIds,showWholeOrg]);
  // The People view keeps the graph tall: its strip opens on the one-liner.
  useEffect(()=>{if(view==='org')setConversationExpanded(false);},[view]);
  const selectedRecords=selected.map(key=>allRecords.get(key)).filter((r):r is SearchRecord=>Boolean(r));
  const workflows=searchWorkflows({query,scope,scopeName,selectedKeys:selected,selectedRecords,...(data&&!error?{resultCount:data.total}:{})});
  const searchHref=(changes:Record<string,string|null>)=>{
    const next=new URLSearchParams(params);Object.entries(changes).forEach(([key,value])=>value?next.set(key,value):next.delete(key));next.delete('offset');return `/iq/search?${next}`;
  };
  const go=(href:string)=>(event:MouseEvent<HTMLAnchorElement>)=>{ if(!isPlainClick(event))return; event.preventDefault(); navigate(href); };
  const setSelection=(keys:string[])=>update({selection:keys.length?keys.join(','):null},true);

  // ── Rail ───────────────────────────────────────────────────────────────────
  const typeRows:RailNavListItem[]=[...MAIN_TYPES,...(moreTypes?['asset' as const]:[])].map(kind=>{
    const href=searchHref({type:kind==='all'?null:kind});
    return {id:kind,label:SEARCH_LABELS[kind],href,onNavigate:go(href),current:type===kind,
      ...(!error&&data?{count:data.counts[kind]}:{})};
  });
  typeRows.push({id:'more-types',label:moreTypes?'Fewer types ▴':'More types ▾',onSelect:()=>setMoreTypes(!moreTypes)});
  const savedRows:RailNavListItem[]=(saved?.searches??[]).map(s=>({id:`saved:${s.id}`,label:s.name,current:params.get('saved')===s.id,onSelect:()=>{
    api.newSession();setParams(new URLSearchParams({q:s.query,tab:s.tab,...(s.types.length===1?{type:s.types[0]}:{}),...(s.scope&&s.scope!=='workspace'?{scope:s.scope}:{}),...(s.selectedKeys.length?{selection:s.selectedKeys.join(',')}:{}),saved:s.id}));
  }}));
  const recentRows:RailNavListItem[]=api.sessions.slice(0,12).map(s=>{
    const href=`/iq/search?${new URLSearchParams({session:s.sessionId,tab:'answer',q:s.title??''})}`;
    return {id:`session:${s.sessionId}`,label:s.title||'Untitled conversation',href,onNavigate:go(href),current:s.sessionId===api.sessionId};
  });

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
  function newSearch(){api.newSession();api.setInput('');setParams(new URLSearchParams());}
  async function saveSearch(){
    if(!saveName?.trim())return;setBusy(true);setActionError(null);
    try {await readJSON('/api/saved-searches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:saveName.trim(),query,scope:scope||'workspace',types:type==='all'?[]:[type],tab,selectedKeys:selected})});setSaveName(null);refreshSaved();}
    catch(e){setActionError(e instanceof Error?e.message:'Could not save search.');}finally{setBusy(false);}
  }
  async function deleteSaved(){const id=params.get('saved');if(!id)return;setActionError(null);try{await readJSON(`/api/saved-searches/${encodeURIComponent(id)}`,{method:'DELETE'});update({saved:null});refreshSaved();}catch(e){setActionError(e instanceof Error?e.message:'Could not remove saved search.');}}
  function focusComposer(){composerRef.current?.querySelector<HTMLElement>('[contenteditable=true],textarea,input')?.focus();}
  function askAbout(keys:string[]){
    update({context:keys.join(',')});
    api.setInput(keys.length===1?'Tell me about this record.':`What connects these ${keys.length} records, and what needs attention?`);
    focusComposer();
  }
  const askSelection=()=>askAbout(selected);

  // ── Pane header: ONE row (decision 9) ──────────────────────────────────────
  // Crumbs › title on the left; the view tabs, then the compact chips, on the
  // right. No hero field — the composer issues queries.
  const scopeOptions=[{id:'',title:'Workspace'},...(scopes?.results??[]).map(r=>({id:r.id,title:r.title})),...(scope&&!scopes?.results.some(r=>r.id===scope)?[{id:scope,title:scopeName??scope}]:[])];
  const title=(query&&searchTitle(query))||(view==='org'&&tab==='connections'?'People & connections':'Search');
  const crumbs=[{label:'Org'},...(title!=='Search'||scope?[{label:'Search',href:'/iq/search'}]:[]),...(scope?[{label:scopeName??scope,href:`/iq/projects/${encodeURIComponent(scope)}`}]:[])];
  const paneHeader=<Stack gap="none" className="shrink-0">
    <ScopeHeader variant="inline" className="border-b border-border" data-testid="search-header"
      breadcrumbs={crumbs} title={title} titleHint={query||undefined}
      tabs={[{id:'results',label:'Results',...(data&&!error?{count:data.counts.all}:{})},{id:'answer',label:'Answer'},{id:'connections',label:'Connections'}]}
      activeTab={tab} onTabChange={value=>update({tab:value})}
      controls={<Inline gap="xs" align="center" wrap={false} data-testid="search-chips">
        <DropdownMenu align="end" triggerLabel="Search scope" triggerTestId="search-scope" triggerClassName={HEADER_CONTROL} trigger={<T as="span">{scope?`In: ${scopeName}`:'Workspace'} ▾</T>}
          sections={[{items:[
            ...(scope?[{label:'Search entire workspace',onSelect:()=>update({scope:null,offset:null})}]:[]),
            ...scopeOptions.map(option=>({label:option.title,active:option.id===scope,onSelect:()=>update({scope:option.id||null,offset:null})})),
          ]}]} />
        <DropdownMenu align="end" triggerLabel={type==='all'?'Add a filter':'Record type filter'} triggerTestId="search-type" triggerClassName={HEADER_CONTROL} trigger={<T as="span">{type==='all'?'+ Filter':`Type: ${SEARCH_LABELS[type]} ▾`}</T>}
          sections={[{label:'Record type',items:(['all',...SEARCH_TYPES] as Array<SearchRecordType|'all'>).map(kind=>({label:kind==='all'?'Any type':SEARCH_LABELS[kind],active:kind===type,onSelect:()=>update({type:kind==='all'?null:kind,offset:null})}))}]} />
        <DropdownMenu align="end" triggerLabel="Sort results" triggerTestId="search-sort" triggerClassName={HEADER_CONTROL} trigger={<T as="span">{sort==='recent'?'Recent':'Relevance'} ▾</T>}
          sections={[{items:[{label:'Relevance',active:sort==='relevance',onSelect:()=>update({sort:null,offset:null})},{label:'Recent',active:sort==='recent',onSelect:()=>update({sort:'recent',offset:null})}]}]} />
      </Inline>}
      menuLabel="Search actions"
      menu={[{items:[
        {label:'Save search',onSelect:()=>setSaveName(query),...(!query?{disabled:true,disabledReason:'Search for something first.'}:{})},
        ...(params.has('saved')?[{label:'Remove saved search',danger:true,onSelect:()=>void deleteSaved()}]:[]),
      ]}]}
    />
    {saveName!==null&&<Inline gap="xs" align="center" wrap={false} className="px-6 py-2 border-b border-border">
      <Input aria-label="Saved search name" value={saveName} maxLength={120} onChange={e=>setSaveName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void saveSearch();}}} className="flex-1" />
      <Button size="sm" disabled={busy||!saveName.trim()} onClick={()=>void saveSearch()}>Save</Button>
      <Button size="sm" variant="ghost" onClick={()=>setSaveName(null)}>Cancel</Button>
    </Inline>}
    {actionError&&<Banner variant="error" title={actionError} className="mx-6 mt-2" />}
    {savedError&&<Inline gap="xs" align="center" className="px-6 pt-1"><T className="text-xs text-text-tertiary">Saved searches unavailable.</T><Button size="sm" variant="link" onClick={refreshSaved}>Retry</Button></Inline>}
  </Stack>;

  // ── Results ────────────────────────────────────────────────────────────────
  const groups=data&&!error?groupResults(data.results,data.counts,kind=>searchHref({type:kind,tab:'results'})):[];
  const resultKeys=(data?.results??[]).map(recordKey);
  const results=<Stack gap="sm" className="flex-1 min-h-0 overflow-auto px-6 py-3" data-testid="search-results">
    {!!data?.partial?.length&&<Banner variant="warning" title="Some sources are unavailable">{data.partial.join(' · ')}</Banner>}
    <RecordResultList aria-label="Search results" groups={groups} selectedKeys={selected}
      onToggleSelect={record=>{const key=recordResultKey(record);setSelection(selected.includes(key)?selected.filter(k=>k!==key):[...selected,key]);}}
      onOpen={record=>navigate(record.href)}
      {...(scope?{openLabel:(record)=>openLabelFor(record.type)}:{})}
      highlightTerms={query.split(/\s+/).filter(term=>term.length>1)}
      loading={isLoading&&!data} error={error??null} onRetry={refresh}
      emptyState={query||scope?{title:'No matching records',description:'Try another phrase or clear a filter.'}:{title:'Search your workspace',description:'Find people, initiatives, work, decisions, and knowledge.'}}
      footer={data&&!error&&data.total?<Inline gap="sm" align="center" wrap><T as="span">{resultsFooter(data.total,scopeName)}</T>{scope&&<Button variant="link" size="sm" className="whitespace-nowrap" data-testid="search-scope-all" onClick={()=>update({scope:null,offset:null})}>Search entire workspace</Button>}</Inline>:undefined}
      hint="Select results to ask about them or view their connections." />
    {!!data?.total&&data.total>PAGE_SIZE&&<Inline justify="between" gap="sm">
      <T className="text-xs text-text-tertiary">{offset+1}–{Math.min(offset+PAGE_SIZE,data.total)} of {data.total}</T>
      <Inline gap="xs"><Button size="sm" variant="secondary" disabled={!offset} onClick={()=>update({offset:String(Math.max(0,offset-PAGE_SIZE))})}>Previous</Button><Button size="sm" variant="secondary" disabled={offset+PAGE_SIZE>=data.total} onClick={()=>update({offset:String(offset+PAGE_SIZE)})}>Next</Button></Inline>
    </Inline>}
    {scope&&!!resultKeys.length&&!selected.length&&<Inline gap="sm">
      <Button size="sm" variant="secondary" onClick={()=>askAbout(resultKeys.slice(0,30))}>Ask about these results ↗</Button>
      <Button size="sm" variant="secondary" onClick={()=>update({tab:'connections',selection:resultKeys.slice(0,30).join(',')})}>View connections ↗</Button>
    </Inline>}
    {selected.length>0&&<Inline className="sticky bottom-0 bg-surface border-t border-border py-2" justify="between" data-testid="search-selection-bar">
      <T className="text-xs">{selected.length} selected</T>
      <Inline gap="xs"><Button size="sm" variant="ghost" onClick={()=>setSelection([])}>Clear</Button><Button size="sm" onClick={askSelection}>Ask about selection →</Button></Inline>
    </Inline>}
  </Stack>;

  // ── Connections ────────────────────────────────────────────────────────────
  const singleSelected=selected.length===1?allRecords.get(selected[0]):undefined;
  const connections=view==='org'
    ? <PeopleConnections graph={orgGraph} selectedKeys={selected} focusIds={focusIds} showWholeOrg={showWholeOrg}
        onShowWholeOrgChange={all=>update({graphAll:all?'1':null},true)}
        // Clearing the last person keeps the org graph (People filter) instead of
        // flipping to the record view mid-gesture.
        onSelectionChange={keys=>update({selection:keys.length?keys.join(','):null,...(!keys.length&&type!=='person'?{type:'person'}:{})},true)}
        onAsk={askAbout}
        layout={params.get('layout')==='radial'?'radial':'force'} onLayoutChange={layout=>update({layout},true)} />
    : <Stack gap="none" className="flex-1 min-h-0 px-6">
      {!!data?.partial?.length&&<Banner variant="warning" title="Some sources are unavailable">{data.partial.join(' · ')}</Banner>}
      {error?<EmptyState title="Connections unavailable" description={error} actionLabel="Retry" onAction={refresh}/>:
        isLoading&&!data?<LoadingState label="Loading connections…" />:
        view==='empty'?<EmptyState data-testid="search-connections-empty" title="No recorded connections" description="Search for something, or select related records to see how they connect."
          {...(singleSelected?{actionLabel:'Open record',onAction:()=>navigate(singleSelected.href)}:{})} />:
        <RecordGraph data-testid="search-connections" records={graphRecords} edges={graphRecordEdges} selectedKeys={selected} focusKeys={selected} onSelectionChange={setSelection}
          onAskSelection={askSelection} onOpenRecord={r=>navigate(r.href)}
          layout={(['force','radial','hierarchy'].includes(params.get('layout')??'')?params.get('layout'):'force') as 'force'|'radial'|'hierarchy'}
          typeFilter={(SEARCH_TYPES.includes(params.get('graphType') as SearchRecordType)?params.get('graphType'):'all') as SearchRecordType|'all'}
          onTypeFilterChange={graphType=>update({graphType:graphType==='all'?null:graphType})} onLayoutChange={layout=>update({layout})} className="flex-1 min-h-0" />}
    </Stack>;
  const assistantStrip=tab==='connections'&&(lastAnswer||api.isStreaming)&&<Stack gap="none" className="border-t border-border mx-6 shrink-0" data-testid="search-assistant-strip">
    <Inline justify="between" gap="sm" wrap={false} className="py-2">
      <Inline gap="sm" wrap={false} className="min-w-0">
        <T className="text-xs font-semibold shrink-0">Org Assistant</T>
        <T className="text-xs text-text-secondary truncate min-w-0">{api.isStreaming?'Answering…':assistantStripText(lastAnswer??'').slice(0,180)}</T>
        {lastSources.slice(0,3).map(source=><Button key={recordKey(source)} size="sm" variant="link" onClick={()=>navigate(source.href)}>{`[${source.n}]`}</Button>)}
      </Inline>
      <Button variant="ghost" size="sm" onClick={()=>setConversationExpanded(!conversationExpanded)}>{conversationExpanded?'Collapse':'Expand'} conversation</Button>
    </Inline>
    {conversationExpanded&&<Stack gap="none" className="max-h-40 overflow-auto pb-2" data-testid="search-assistant-conversation">
      <Markdown size={13}>{api.isStreaming?api.streamingText:linkSearchCitations(stripSourceUris(lastAnswer??''),lastSources)}</Markdown>
    </Stack>}
  </Stack>;

  // ── Graph card under the last answer (decision 9) ───────────────────────────
  // The text and the visual are two faces of one search: the card summarises
  // the graph Connections would draw, expands inline, or opens the full view.
  const cardGraph:{records:RecordGraphRecord[];edges:RecordGraphEdge[]}|null=view==='org'?orgCard:{records:graphRecords,edges:graphRecordEdges};
  const graphCard=cardGraph&&<RecordGraphCard data-testid="search-graph-card" records={cardGraph.records} edges={cardGraph.edges} selectedKeys={selected}
    {...(view==='org'?{title:'People & connections'}:{})}
    expanded={graphCardExpanded} onToggleExpanded={setGraphCardExpanded}
    onOpen={()=>update(view==='org'?{tab:'connections',type:'person'}:{tab:'connections'})}
    onSelectionChange={setSelection} onAskSelection={askSelection} onOpenRecord={record=>navigate(record.href)} />;
  const answerGraph=useMemo(()=>({...(lastAssistant?.toolCalls?{lastToolCalls:lastAssistant.toolCalls}:{}),card:graphCard}),[lastAssistant,graphCard]);

  // ── Composer ───────────────────────────────────────────────────────────────
  const references=attached.map(ref=>allRecords.get(recordKey(ref))).filter((r):r is SearchRecord=>Boolean(r));
  const scopeKey=scope?`initiative:${scope}`:null;
  const scopeReference=scopeKey&&scopeRecord&&!references.some(r=>recordKey(r)===scopeKey)?[scopeRecord]:[];
  const composer=<Stack ref={composerRef} gap="none" className="mx-6 mb-3 mt-2 shrink-0 min-w-0">
    <SearchComposer value={api.input} onChange={api.setInput} onSubmit={submit} disabled={busy||api.isStreaming}
      agents={api.agents.filter(agent=>!/(^|[-_])assessment[-_]/i.test(agent.id))}
      references={[...scopeReference,...references]}
      onRemoveReference={key=>key===scopeKey&&!attached.some(r=>recordKey(r)===key)?update({scope:null,offset:null}):update({context:attached.filter(r=>recordKey(r)!==key).map(recordKey).join(',')||null})}
      onSearchContext={async q=>(await readJSON<SearchResponse>(`/api/search?${new URLSearchParams({q,limit:'8'})}`)).results}
      contextSuggestions={data?.results??[]}
      knownPeople={orgGraph.data?.nodes.map(n=>({id:n.id,name:n.name}))??[]}
      onAddReference={record=>update({context:[...new Set([...attached.map(recordKey),recordKey(record)])].join(',')})}
      workflows={workflows} onWorkflow={row=>{if(!row.disabled){api.setInput(row.prompt);focusComposer();}}}
    />
    {api.historyUnavailable&&<T className="px-3 pt-1 text-xs text-text-tertiary">Session history is unavailable until memory is configured.</T>}
  </Stack>;

  return <ViewportFillRegion bottomGap={0} data-testid="search-workspace">
    <Stack gap="none" className="h-full min-h-0 min-w-0 bg-surface" data-shell-flush>
      <ExplorerLayout
        data-testid="search-explorer"
        className="min-h-0 min-w-0 flex-1"
        railWidth="ms"
        railHeading="caption"
        railCountStyle="plain"
        railTitle="Search"
        railLabel="Search navigation"
        railActions={<IconButton aria-label="New search" size="sm" variant="ghost" disabled={api.isStreaming} onClick={newSearch}>+</IconButton>}
        railHeader={<RailNavList aria-label="Search types" currentStyle="tint" items={typeRows} data-testid="search-type-rail" />}
        rail={<>
          <RailSection title="Saved">
            {savedRows.length?<RailNavList aria-label="Saved searches" currentStyle="tint" items={savedRows} />:<T className="text-xs text-text-tertiary">No saved searches yet.</T>}
          </RailSection>
          <RailSection title="Recent">
            {recentRows.length?<RailNavList aria-label="Recent conversations" currentStyle="tint" items={recentRows} />:<T className="text-xs text-text-tertiary">No conversations yet.</T>}
          </RailSection>
        </>}
        panePadding="none"
        paneHeader={paneHeader}
        paneFooter={<>{assistantStrip}{composer}</>}
      >
        <Stack gap="none" className="h-full min-h-0 min-w-0">
          {tab==='results'&&results}
          <Stack gap="none" className={tab==='answer'?'flex-1 min-h-0 px-6':'hidden'} aria-hidden={tab!=='answer'}>
            <AnswerGraphContext.Provider value={answerGraph}>{api.transcript}</AnswerGraphContext.Provider>
            {/* A turn restored without tool calls cannot be told apart from
                the others; the card then follows the transcript. */}
            {lastAssistant&&!lastAssistant.toolCalls&&<Stack gap="none" className="shrink-0 pb-3">{graphCard}</Stack>}
          </Stack>
          {tab==='connections'&&connections}
        </Stack>
      </ExplorerLayout>
    </Stack>
  </ViewportFillRegion>;
}

// ── People connections: the org graph (People row + Connections tab) ───────

interface OrgGraphData { nodes: OrgGraphPerson[]; edges: GraphRelationship[]; departments: GraphDepartment[]; peopleTotal?: number }
type BusFactorFinding = Parameters<typeof indexBusFactorFindings>[0][number];
// The graph draws every node in one SVG pass; past a couple hundred it hangs
// the tab. Cap the canvas and say so.
const GRAPH_NODE_CAP = 200;

/** Keep the strongest `topK` edges per person above `minStrength`. */
function strongestEdges(edges: GraphRelationship[], topK: number, minStrength: number) {
  const perNode = new Map<string, number>();
  return [...edges].filter(e => e.strength >= minStrength).sort((a, b) => b.strength - a.strength).filter(e => {
    const s = perNode.get(e.source) ?? 0; const t = perNode.get(e.target) ?? 0;
    if (s >= topK && t >= topK) return false;
    perNode.set(e.source, s + 1); perNode.set(e.target, t + 1); return true;
  });
}

/** The Answer card's view of the org graph: the people the People canvas
 *  would draw (the focus and its neighbours, or everyone), as person records,
 *  with their relationships as edges. */
function orgGraphCardData(graph: OrgGraphData, focusIds: string[], showWholeOrg: boolean): { records: RecordGraphRecord[]; edges: RecordGraphEdge[] } {
  const focused = showWholeOrg ? { people: graph.nodes, relationships: graph.edges } : focusOrgPeople(graph.nodes, graph.edges, focusIds);
  const people = focused.people.slice(0, GRAPH_NODE_CAP);
  const kept = new Set(people.map(p => p.id));
  return {
    records: people.map(p => ({ id: p.id, type: 'person', title: p.name, subtitle: [p.title, p.department].filter(Boolean).join(' · '),
      href: `/iq/search?tab=connections&selection=${encodeURIComponent(`person:${p.id}`)}` })),
    edges: focused.relationships.filter(e => kept.has(e.source) && kept.has(e.target))
      .map(e => ({ id: `${e.source}~${e.type}~${e.target}`, source: `person:${e.source}`, target: `person:${e.target}`, label: e.type.replace(/_/g, ' ') })),
  };
}

function PeopleConnections({ graph, selectedKeys, focusIds, showWholeOrg, onShowWholeOrgChange, onSelectionChange, onAsk, layout, onLayoutChange }: {
  graph: { data: OrgGraphData | null; error: string | null; refresh: () => void };
  selectedKeys: string[]; focusIds: string[]; showWholeOrg: boolean; onShowWholeOrgChange: (all: boolean) => void;
  onSelectionChange: (keys: string[]) => void; onAsk: (keys: string[]) => void;
  layout: 'force' | 'radial'; onLayoutChange: (layout: 'force' | 'radial') => void;
}) {
  const navigate = useNavigate();
  const { session } = useSession();
  // Influence is leadership analytics (ViewLeaderboard tier): node size and the
  // person card must not leak it to other roles.
  const showInfluence = session?.role === 'org-leader' || session?.role === 'hr-admin' || session?.role === 'admin';
  const { data, error, refresh } = graph;
  const [topK, setTopK] = useState(4);
  const [minStrength, setMinStrength] = useState(0.6);
  const [activeDepartment, setActiveDepartment] = useState<string | null>(null);
  const [rareSkillsOpen, setRareSkillsOpen] = useState(false);
  // A lone focused person (the old /iq/explore?focus=<id>) opens on their card.
  const [detailId, setDetailId] = useState<string | null>(() => focusIds.length === 1 ? focusIds[0] : null);
  const selectedIds = useMemo(() => new Set(selectedKeys.filter(key => key.startsWith('person:')).map(key => key.slice(7))), [selectedKeys]);
  const otherKeys = selectedKeys.filter(key => !key.startsWith('person:'));
  const setPeople = (ids: Iterable<string>) => onSelectionChange([...otherKeys, ...[...ids].map(id => `person:${id}`)]);
  const { data: detail, isLoading: detailLoading, error: detailError } = useFetch<PersonDetail>(detailId ? `/api/graph/people/${encodeURIComponent(detailId)}` : null);
  const { data: evidence } = useFetch<{ documents: PersonEvidenceDocument[] }>(detailId ? `/api/graph/people/${encodeURIComponent(detailId)}/evidence` : null);
  const { data: findings, error: findingsError } = useFetch<{ findings: BusFactorFinding[] }>(
    activeDepartment || rareSkillsOpen ? '/api/work/findings?status=open&sweep=bus_factor&limit=200' : null,
  );
  const findingsIndex = useMemo(() => findings ? indexBusFactorFindings(findings.findings) : null, [findings]);
  // The selected people and their direct neighbours, over every relationship;
  // Top-K and min-strength then apply to that narrowed set. The library's
  // OrgGraph `focusIds` prop (shipping in 2.403.0) replaces this local narrowing.
  const focused = useMemo(() => showWholeOrg ? { people: data?.nodes ?? [], relationships: data?.edges ?? [] }
    : focusOrgPeople(data?.nodes ?? [], data?.edges ?? [], focusIds), [data, focusIds, showWholeOrg]);
  const people = useMemo(() => focused.people.slice(0, GRAPH_NODE_CAP), [focused]);
  const edges = useMemo(() => {
    const kept = new Set(people.map(p => p.id));
    return strongestEdges(focused.relationships.filter(e => kept.has(e.source) && kept.has(e.target)), topK, minStrength);
  }, [focused, people, topK, minStrength]);
  const focusMissing = !showWholeOrg && focusIds.length > 0 && !people.length;
  const path = useMemo(() => {
    if (!data || selectedIds.size !== 2) return null;
    const [a, b] = [...selectedIds];
    return findConnectionPath(data.nodes, data.edges, a, b);
  }, [data, selectedIds]);
  const total = data?.peopleTotal ?? data?.nodes.length ?? 0;
  const focusPerson = (id: string) => { setPeople([id]); setDetailId(id); };

  if (error && !data) return <Stack gap="sm" className="flex-1 min-h-0 px-6 py-3">
    <Banner variant="error" title="Could not load the org graph">{error}. People and relationships come from Aurora, so this usually means the database is unreachable rather than that the graph is empty.</Banner>
    <Inline><Button size="sm" variant="secondary" onClick={refresh}>Try again</Button></Inline>
  </Stack>;
  if (!data) return <LoadingState label="Loading org graph…" />;

  return <Stack gap="none" className="flex-1 min-h-0 min-w-0 px-6" data-testid="search-people-graph">
    <Inline gap="sm" align="center" className="py-2 shrink-0">
      <SegmentedControl size="sm" aria-label="Org graph layout" value={layout} onChange={value => onLayoutChange(value === 'radial' ? 'radial' : 'force')}
        options={[{ value: 'force', label: 'Force' }, { value: 'radial', label: 'Radial' }]} />
      <GraphSearchBox people={data.nodes} onPickPerson={focusPerson} onPickSkill={(_skill, ids) => { setPeople(ids); setDetailId(null); }} placeholder="Find a person or skill…" />
      <RangeSliderFrame className="text-xs" label="Top-K" ariaLabel="Top K relationships per person" min={1} max={10} value={topK} onChange={setTopK} valueLabel={topK} />
      <RangeSliderFrame className="text-xs" label="Min strength" ariaLabel="Minimum relationship strength" min={0} max={100} value={Math.round(minStrength * 100)} onChange={v => setMinStrength(v / 100)} valueLabel={minStrength.toFixed(2)} />
      <Inline gap="xs" align="center" className="ml-auto">
        {focusIds.length > 0 && <Button size="sm" variant="ghost" aria-pressed={showWholeOrg} onClick={() => onShowWholeOrgChange(!showWholeOrg)}>{showWholeOrg ? 'Focus selection' : 'Show whole org'}</Button>}
        {selectedIds.size > 0 && <T className="text-xs text-primary">{selectedIds.size} selected</T>}
        <Button size="sm" variant="secondary" disabled={!selectedIds.size} onClick={() => { setPeople([]); setActiveDepartment(null); setDetailId(null); }}>Clear</Button>
        <Button size="sm" disabled={!selectedIds.size} onClick={() => onAsk([...selectedIds].map(id => `person:${id}`))}>Ask about selection →</Button>
      </Inline>
    </Inline>
    <Inline gap="xs" align="center" className="pb-2 shrink-0">
      <DepartmentChips departments={data.departments} people={data.nodes} activeDepartment={activeDepartment}
        onToggle={(name, memberIds) => { setActiveDepartment(name); setPeople(name ? memberIds : []); setDetailId(null); }} />
      <FilterChip active={rareSkillsOpen} size="sm" onClick={() => setRareSkillsOpen(open => !open)}>⚠ Rare skills · org-wide</FilterChip>
      <T className="ml-auto text-xs text-text-tertiary">{people.length < total ? `${people.length} / ${total}` : total} people · {edges.length} edges</T>
    </Inline>
    {(activeDepartment || rareSkillsOpen) && <DepartmentInsightStrip department={activeDepartment} people={data.nodes}
      busFactorFindings={findingsIndex} busFactorFindingsUnavailable={Boolean(findingsError)}
      onFocusPerson={id => { setActiveDepartment(null); setRareSkillsOpen(false); focusPerson(id); }}
      onNavigate={(href, event) => { if (!isPlainClick(event)) return; event.preventDefault(); navigate(href); }} />}
    {path && <ConnectionPathStrip path={path} onHighlightPath={ids => { setPeople(ids); setDetailId(null); }} />}
    {focusMissing && <Banner variant="warning" title="Not in the org graph">{`${focusIds.join(', ')} ${focusIds.length === 1 ? 'is' : 'are'} not in the org graph. Show whole org to browse everyone.`}</Banner>}
    {/* The card takes its own column beside the canvas rather than floating
        over the drawn nodes; the canvas gets the rest of the pane height. */}
    <CanvasPaneLayout data-testid="search-people-canvas" className="min-h-80" paneLabel="person details" expandKey={detailId}
      pane={detailId && selectedIds.has(detailId) ? <PersonDetailCard data-testid="search-person-card" className="static h-full w-full max-h-full rounded-none border-0 shadow-none"
        person={detail} evidence={evidence?.documents ?? []} loading={detailLoading} error={detailError ?? null}
        showInfluence={showInfluence} onClose={() => setDetailId(null)}
        onFocusPerson={id => { setPeople([...selectedIds, id]); setDetailId(id); }}
        onAsk={id => onAsk([`person:${id}`])} askLabel={person => `Ask about ${person.name.split(' ')[0]}`} /> : null}>
      <OrgGraph data-testid="search-org-graph" aria-label="Org graph" people={people} relationships={edges} departments={data.departments}
        // focusIds is what the automatic fit centres on when the drawing
        // overflows; without it the fit start-aligned the drawing beside the
        // legend and a selected person could sit past the right edge (D9,
        // 6 of 75 two-person opens, 2026-09-29).
        // pruneToFocus={false} (2.407.31): this page already chose the drawn
        // set (`focusOrgPeople` + the Top-K / min-strength sliders) and counts
        // it; the library's own one-hop trim on top dropped 3 of 11 people the
        // counter and the person card still named (D10).
        multiSelectIds={selectedIds} spotlightIds={selectedIds} focusIds={selectedIds} pruneToFocus={false} layout={layout} showInfluence={showInfluence}
        onToggleMultiSelect={id => {
          if (selectedIds.has(id)) { setPeople([...selectedIds].filter(item => item !== id)); if (detailId === id) setDetailId(null); }
          else { setPeople([...selectedIds, id]); setDetailId(id); }
        }} />
    </CanvasPaneLayout>
    {!selectedIds.size && <T className="py-1 text-xs text-text-tertiary shrink-0">Click people to select them, then Ask about selection to query with the graph in view.</T>}
  </Stack>;
}
