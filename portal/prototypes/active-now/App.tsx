import React,{useState,useMemo,useEffect,useRef,useCallback} from 'react';
import {ReactFlow,Background,useReactFlow,useNodesInitialized} from '@xyflow/react';
import {PipelineNodeRuntimeProvider,Button,IconButton,Select,Tabs,ChatSidePanelFrame,MenuIcon,DocumentIcon,BranchIcon,ComputeProvider,ComputerLab,fixtureComputers,fixtureModels,fixtureRuntimeStatus,installMockShellSocket,installMockTailSource,mockShellUrl,mockTailUrl,type ComputeClient} from './shared';
import {ChatPane} from './ChatPane';
import {SocialRail,conversations} from './SocialRail';
import {Inspector} from './Inspector';
import {PipelineStarfield} from './PipelineStarfield';
import {nodes,nodeTypes,edgeTypes} from './graphComponents';
import {getScenario} from './graphData.mjs';
import {NOW,DEFAULT_RANGE,clock,resizeWindow,moveWindow,backToNow,projectWindow} from './timeline.mjs';
import {GRAPH_FIT} from './viewport.mjs';
import {LabBody,seedQueue,fixtureClient,type QueuedRun} from './lab';
import './component-layout.css';
import './attention.css';
import './inspector-detail.css';

type Selection={kind:'node'|'edge';id:string;version?:number}|null;
type Range={start:number;end:number};
const events=[0,13,28,30,60,68,80,98,102,103,105];
// Presence reflects current shared work, even when the viewer scrubs into history.
const connorWorking=nodes.some(n=>n.data.state==='running'||n.data._state==='running');
const initialMessages=[
 {from:'Connor',time:'09:39',text:'I’m reviewing v2 and generating the next revision.'},
 {from:'Frank',time:'09:40',text:'Can we add an owner and mitigation for each release risk?',ref:'Sprint review · v2 · Slide 4'},
 {from:'Connor',time:'09:41',text:'Yes — I’m adding that while v3 regenerates.'},
];
function Timeline({range,onChange}:{range:Range;onChange:(r:Range)=>void}){
 const duration=range.end-range.start,live=range.end===NOW;
 const onDuration=(value:string)=>onChange(resizeWindow(range,Number(value)));
 return <div className="time-navigation" aria-label="Activity timeline"><div className="time-nav-row"><strong aria-live="polite">{clock(range.start)} – {live?'Now':clock(range.end)}</strong><div className="time-nav-buttons"><Button size="sm" variant="secondary" aria-label="Previous time window" disabled={range.start===0} onClick={()=>onChange(moveWindow(range,-1))}>‹</Button><Button size="sm" variant="secondary" aria-label="Next time window" disabled={live} onClick={()=>onChange(moveWindow(range,1))}>›</Button><Button size="sm" variant="secondary" className={live?'now-button at-now':'now-button'} disabled={live} onClick={()=>onChange(backToNow(range))}>{live?'● Following now':'Back to now'}</Button><label><span className="sr-only">Time window</span><Select size="sm" aria-label="Time window" value={duration} onChange={e=>onDuration(e.target.value)} options={[...(![15,30,60,105].includes(duration)?[{value:String(duration),label:`${duration} min`}]:[]),{value:"15",label:"15 min"},{value:"30",label:"30 min"},{value:"60",label:"1 hour"},{value:"105",label:"Full day"}]} /></label></div></div><div className="scrubber"><div className="time-ticks"><span style={{left:'0%'}}>8:00</span><span style={{left:`${30/NOW*100}%`}}>8:30</span><span style={{left:`${60/NOW*100}%`}}>9:00</span><span className="now-tick">Now 9:45</span></div><div className="event-track">{events.map((time,i)=><IconButton size="sm" key={time} style={{left:`${time/NOW*100}%`}} className={'event-marker '+(time>=range.start&&time<=range.end?'in-window':'')} aria-label={`View activity at ${clock(time)}`} onClick={()=>{const end=Math.max(duration,time);onChange({start:end-duration,end})}}><span style={{width:i%3===0?7:4,height:i%3===0?7:4}}/></IconButton>)}</div><div className="range-track"><div className="range-selection" style={{left:`${range.start/NOW*100}%`,width:`${duration/NOW*100}%`}}/><input type="range" className="range-input range-start" min="0" max={NOW} step="1" value={range.start} aria-label="Timeline window start" aria-describedby="timeline-help" aria-valuetext={clock(range.start)} onChange={e=>onChange({...range,start:Math.min(Number(e.target.value),range.end-1)})}/><input type="range" className="range-input range-end" min="0" max={NOW} step="1" value={range.end} aria-label="Timeline window end" aria-describedby="timeline-help" aria-valuetext={clock(range.end)} onChange={e=>onChange({...range,end:Math.max(Number(e.target.value),range.start+1)})}/></div></div><p id="timeline-help" className="sr-only">Newest work first. Drag either timeline handle to explore earlier activity.</p></div>
}
export function App(){
 const initialView=new URLSearchParams(window.location.search).get('view')??(window.location.hash.slice(1)||document.documentElement.dataset.previewView||'');
 const [panelOpen,setPanelOpen]=useState(['split','full','details','full-details','lab'].includes(initialView));
 // The split can hold two things now: the activity graph, or the Computer Lab.
 // `/run` in the chat opens the lab; the segmented switch inside the panel moves
 // between them without closing the split or losing the conversation.
 const [panelMode,setPanelMode]=useState<'activity'|'lab'>(initialView==='lab'?'lab':'activity');
 const [queue,setQueue]=useState<QueuedRun[]>(seedQueue);
 const [queueSelection,setQueueSelection]=useState<string|null>(seedQueue[0]?.id??null);
 // Route `mock-shell:`/`mock-tail:` URLs to the library's simulators so the lab's
 // terminals attach instead of sitting on `Failed to fetch reattach`.
 useEffect(()=>{const off=[installMockShellSocket(),installMockTailSource()];return()=>off.forEach(f=>f())},[]);
 const [expanded,setExpanded]=useState(initialView==='full'||initialView==='full-details');
 const [range,setRange]=useState<Range>({...DEFAULT_RANGE});
 const [selection,setSelection]=useState<Selection>(['details','full-details'].includes(initialView)?{kind:'node',id:'deck'}:null);
 const [focusCues,setFocusCues]=useState(true);
 const [runFailed,setRunFailed]=useState(document.documentElement.dataset.previewRun==='failed');
 const [activityCount,setActivityCount]=useState(2);
 const [focusGroup,setFocusGroup]=useState<string|null>(null);
 const [sourceVisibility,setSourceVisibility]=useState<Record<string,boolean>>({});
 const scenario=useMemo(()=>getScenario(activityCount),[activityCount]);
 const [asked,setAsked]=useState(true);
 const [reference,setReference]=useState('Sprint review · v2 · Slide 4');
 const draft='Also include the rollback owner.';
 const draftStores=useRef<Record<string,{current:any}>>({});
 const [railSelection,setRailSelection]=useState<any>({kind:'conversation',channel:'connor'});
 const [railCollapsed,setRailCollapsed]=useState(false);
 const [otherMessages,setOtherMessages]=useState<Record<string,any[]>>({});
 const channel=railSelection.kind==='conversation'?railSelection.channel:'connor';
 const conversation=conversations.find(c=>c.channel===channel);
 const person=conversation?.name??channel;
 const draftStore=draftStores.current[channel]??(draftStores.current[channel]={current:null});
 const [messages,setMessages]=useState(initialMessages);
 const [review,setReview]=useState<any>(undefined);
 const {fitView,zoomIn,zoomOut}=useReactFlow();
 const nodesInitialized=useNodesInitialized();
 const graphRef=useRef<HTMLDivElement>(null);
 const [canvasSize,setCanvasSize]=useState({width:1200,height:700});
 const projected=useMemo(()=>{
  const graph=projectWindow(scenario.nodes,scenario.edges,range,canvasSize,{full:expanded,focusGroup,sourceVisibility});
  if(!runFailed||range.end!==NOW)return graph;
  return {...graph,
   nodes:graph.nodes.map((node:any)=>node.id==='deckagent'?{...node,className:'failed-node',data:{...node.data,_state:'failed'}}:node.id==='deck'?{...node,data:{...node.data,state:'completed',text:'v3 failed · v2 available',generatingVersion:null}}:node.id==='frame-presentation'?{...node,data:{...node.data,sub:'v3 failed · v2 available'}}:node),
   edges:graph.edges.map((edge:any)=>edge.id==='generation'?{...edge,data:{...edge.data,state:'default',label:'failed'}}:edge),
  };
 },[scenario,range,canvasSize,expanded,focusGroup,sourceVisibility,runFailed]);
 const nodeIds=useMemo(()=>new Set(projected.nodes.map((n:any)=>n.id)),[projected]);
 const live=range.end===NOW;
 const fit=useCallback(()=>fitView({...GRAPH_FIT,duration:200}),[fitView]);
 useEffect(()=>{if(!panelOpen||!nodesInitialized)return;const frame=requestAnimationFrame(()=>requestAnimationFrame(()=>{void fit()}));return()=>cancelAnimationFrame(frame)},[range.start,range.end,expanded,panelOpen,canvasSize,nodesInitialized,activityCount,focusGroup,sourceVisibility,fit]);
 useEffect(()=>{
  const el=graphRef.current;if(!el)return;
  let frame=0;
  const measure=()=>{
   const width=Math.round(el.clientWidth),height=Math.round(el.clientHeight);
   if(width&&height)setCanvasSize(current=>current.width===width&&current.height===height?current:{width,height});
  };
  const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure)});
  measure();observer.observe(el);return()=>{cancelAnimationFrame(frame);observer.disconnect()};
 },[expanded,panelOpen,fit]);
 const changeRange=(next:Range)=>{setRange(next);setSelection(null);setFocusGroup(null)};
 const changeCount=(count:number)=>{setActivityCount(count);setSelection(null);setFocusGroup(null);setSourceVisibility({})};
 const toggleSources=(group:string,collapsed:boolean)=>setSourceVisibility(current=>({...current,[group]:collapsed}));
 const focus=(group:string)=>{setFocusGroup(current=>current===group?null:group);setSelection(null)};
 // Both existing card kinds open beside chat first. Expanding is a separate action.
 const openActivity=()=>{setRailSelection({kind:'conversation',channel:'connor'});setPanelOpen(true);setExpanded(false);setPanelMode('activity');setRange({...DEFAULT_RANGE});setSelection(null);setFocusGroup(null)};
 const openDeck=()=>{setRailSelection({kind:'conversation',channel:'connor'});setPanelOpen(true);setExpanded(false);setPanelMode('activity');setFocusGroup(null);setRange({...DEFAULT_RANGE});setSelection({kind:'node',id:'deck'})};
 const openLab=()=>{setRailSelection({kind:'conversation',channel:'connor'});setPanelOpen(true);setExpanded(false);setPanelMode('lab');setSelection(null);setFocusGroup(null)};
 // What `/run` does: the same dispatch the marketplace makes — a run bound to
 // the instruction, charged to an initiative, on a computer named after it —
 // recorded in the chat as a run card, and the lab opened beside the chat.
 const dispatchRun=(instruction:string,initiative='Auth Migration')=>{
  const run:QueuedRun={id:`run-${4473+queue.length}`,command:'/run',instruction,initiative,model:'Sonnet',computer:`auth-migration-${3+queue.length}`,status:'running',spendUsd:0,forecastUsd:[0.03,0.30]};
  setQueue(current=>[run,...current]);setQueueSelection(run.id);
  setMessages(current=>[...current,{from:'Frank',time:'09:45',text:'',run}]);
  openLab();
 };
 const closePanel=()=>{setPanelOpen(false);setExpanded(false);setSelection(null)};
 const toggleExpanded=()=>setExpanded(!expanded);
 const select=(next:Selection)=>{
  if(next?.kind==='node'&&!nodeIds.has(next.id)){
   setFocusGroup(null);
   if(['deck','deckagent'].includes(next.id))setRange({...DEFAULT_RANGE});
   else if(['transcript','meeting'].includes(next.id))setRange({start:45,end:60});
  }
  setSelection(next);setAsked(false);
 };
 const addReference=(label:string)=>{setRailSelection({kind:'conversation',channel:'connor'});setReference(label);setExpanded(false);setSelection(null)};
 const send=(message:any)=>{
  if(!message.text.trim()&&!message.files.length)return;
  // A draft that starts with `/run` is an instruction to the fleet, not a
  // message to the room — the composer already says so above the text.
  const trigger=message.command?.trigger??(/^\/run\s/.test(message.text.trim())?'/run':null);
  if(trigger==='/run'){
   const initiative=message.command?.argument?.label;
   let instruction=message.text.trim().replace(/^\/run\s*/,'');
   if(initiative&&instruction.startsWith(initiative))instruction=instruction.slice(initiative.length).trim();
   if(instruction)dispatchRun(instruction,initiative);
   return;
  }
  const next={from:'Frank',time:'09:45',text:message.text,html:message.html,files:message.files.map((f:File)=>f.name),ref:channel==='connor'?reference:''};
  if(channel==='connor'){setMessages(current=>[...current,next]);setReference('')}
  else setOtherMessages(current=>({...current,[channel]:[...(current[channel]??[{from:person,time:'09:19',text:conversation?.lastMessagePreview??'This is a local preview conversation.'}]),next]}));
 };
 const chooseConversation=(next:any)=>{setRailSelection(next);setPanelOpen(false);setExpanded(false);setSelection(null)};
 const chatProps={messages:channel==='connor'?messages:otherMessages[channel]??[{from:person,time:'09:19',text:conversation?.lastMessagePreview??'This is a local preview conversation.'}],draft:channel==='connor'?draft:'',draftStore,reference:channel==='connor'?reference:'',setReference,onSend:send,onOpenDeck:openDeck,onOpenActivity:openActivity,onOpenLab:openLab,review,onReview:setReview,runFailed,person,isConnor:channel==='connor',shelf:railSelection.kind==='shelf'?(railSelection.id==='mentions'?'Mentions':'Activity'):undefined};
 const modeSwitch=<div className="panel-mode"><Tabs size="sm" variant="segmented" aria-label="Side panel content" items={[{id:'activity',label:'Activity'},{id:'lab',label:'Computer Lab'}]} value={panelMode} onValueChange={id=>{setPanelMode(id as 'activity'|'lab');setSelection(null)}}/><small>{panelMode==='lab'?`${queue.filter(r=>r.status==='running').length} working · ${queue.length} dispatched from this chat`:'Shared work · newest first'}</small></div>;
 return <ComputeProvider client={fixtureClient} computers={fixtureComputers} models={fixtureModels} canManage><div className={'app component-app '+(!panelOpen?'chat-only':expanded?'expanded-mode':'split-mode')+(selection?' details-open':'')+(focusCues?' attention-enabled':' attention-disabled')}>
  <header className="topbar"><b>WebSocket Gateway</b><nav><span>Previews</span><span className="current">Social</span><span>Documents</span><span>Pipelines</span><span>Media</span></nav><div className="top-right"><span className="green-dot"/><span>Connected</span><span>frank.davis@local.dev</span></div></header>
  <div className="social-nav"><span className="selected">Chat</span><span>Calls</span><span>Contacts</span><span>Recordings</span><span>Profile</span><div className="sample-controls"><Button size="sm" variant="secondary" aria-pressed={focusCues} onClick={()=>setFocusCues(value=>!value)}>{focusCues?'✦ Focus cues on':'✦ Focus cues off'}</Button><Select size="sm" aria-label="Sample pipeline run state" value={runFailed?'failed':'completed'} onChange={e=>setRunFailed(e.target.value==='failed')} options={[{value:'completed',label:'Run completed'},{value:'failed',label:'Run failing'}]}/><span>Preview</span><Select size="sm" aria-label="Parallel activities in preview" value={activityCount} onChange={e=>changeCount(Number(e.target.value))} options={[{value:"2",label:"2 activities"},{value:"3",label:"3 activities"},{value:"5",label:"5 activities"}]}/></div></div>
  <div className="workspace">
   <div className="icon-rail"><IconButton size="sm" aria-label="Toggle chat list" onClick={()=>setRailCollapsed(!railCollapsed)}><MenuIcon size={17}/></IconButton><span className="green-dot" title="Connected"/><DocumentIcon size={17}/><BranchIcon size={18}/></div>
   <SocialRail selected={railSelection} onSelect={chooseConversation} onOpenActivity={openActivity} working={connorWorking} collapsed={railCollapsed} setCollapsed={setRailCollapsed}/>
   {!expanded&&<ChatPane key={channel+String(chatProps.shelf)} {...chatProps}/>}
   {panelOpen&&<ChatSidePanelFrame title={panelMode==='lab'?'Computer Lab':'Connor’s activity'} subtitle={panelMode==='lab'?'Auth Migration · opened by /run · AgentCore microVMs':live?'Working now · Sharing with you':'Earlier today · Sharing with you'} onClose={closePanel} expanded={expanded} onToggleExpanded={toggleExpanded} onOpenFullPage={()=>setExpanded(true)} className="activity-main" data-testid="activity-panel">
    {panelMode==='lab'?<LabBody header={modeSwitch} queue={queue} selectedId={queueSelection} onSelect={setQueueSelection} onClose={closePanel}/>:<div className="activity-body">
     <div className="graph-column">
      {modeSwitch}
      <Timeline range={range} onChange={changeRange}/>

      <div className="graph" ref={graphRef}>
       <PipelineStarfield/>
       <PipelineNodeRuntimeProvider value={{getLatestStepForNode:()=>null}}>
        <ReactFlow nodes={projected.nodes.map((n:any)=>({...n,data:{...n.data,...(n.type==='activityFrame'?{onFocus:()=>focus(n.data.group),onToggleSources:()=>toggleSources(n.data.group,n.data.collapsed)}:{}),...(n.id==='deck'?{onFeedback:()=>addReference('Sprint review · v2 · Feedback')}:{})},selected:selection?.kind==='node'&&n.id===selection.id}))} edges={projected.edges.map((e:any)=>({...e,selected:selection?.kind==='edge'&&e.id===selection.id}))} nodeTypes={nodeTypes} edgeTypes={edgeTypes} nodesConnectable={false} nodesDraggable={false} deleteKeyCode={null} fitView fitViewOptions={GRAPH_FIT} minZoom={GRAPH_FIT.minZoom} maxZoom={1.8} onNodeClick={(_,n)=>n.type!=='activityFrame'&&select({kind:'node',id:n.id})} onEdgeClick={(_,e)=>select({kind:'edge',id:e.id})} proOptions={{hideAttribution:true}}>
         <Background gap={24} color="#dce2ed" size={1}/>
        </ReactFlow>
       </PipelineNodeRuntimeProvider>
       <div className="graph-controls"><IconButton aria-label="Zoom in" onClick={()=>void zoomIn()}>+</IconButton><IconButton aria-label="Zoom out" onClick={()=>void zoomOut()}>−</IconButton><Button size="sm" variant="secondary" onClick={()=>void fit()}>Fit graph</Button></div>
       <div className="graph-legend"><span className="tier-swatch past"/>Earlier<span className="tier-swatch input"/>Input<span className="tier-swatch active"/>{live?'Active':'Active then'}</div>
      </div>
      <div className="graph-footer"><span>{focusGroup?<Button size="sm" variant="ghost" onClick={()=>setFocusGroup(null)}>← All activities</Button>:`${projected.activityCount} parallel activities · Newest work first`}</span><Button size="sm" variant="ghost" disabled={range.start===0} onClick={()=>changeRange(moveWindow(range,-1))}>← Earlier work</Button></div>
     </div>
     {selection&&<Inspector selection={selection} asked={asked} setAsked={setAsked} range={range} close={()=>setSelection(null)} select={select} reference={addReference} runFailed={runFailed&&live} openLab={()=>{setPanelMode('lab');setSelection(null)}}/>}
    </div>}
   </ChatSidePanelFrame>}
  </div>
 </div></ComputeProvider>
}
