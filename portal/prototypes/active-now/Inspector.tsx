import React,{useEffect,useState} from 'react';
import {Button,Tabs,Select,IconButton,ChevronIcon,ChatSidePanelFrame,ShellTerminal} from './shared';

// PROVENANCE FIRST. A detail pane that shows more than the platform can
// attribute — a slide preview from a generator that does not exist — teaches a
// viewer to distrust the whole screen, and it is the pane a demo lingers on.
// So each inspector leads with what produced this and how, and when nothing
// registered can, it says exactly that: a worse-looking panel, and a better
// one, because it is a thing somebody can go and fix.
const DeckProvenance=({reference}:{reference:(label:string)=>void})=><div className="detail-section"><div className="detail-section-label">Produced by</div>
 <div className="detail-provenance is-unavailable"><b>Not backed by a registered skill</b><span>Nothing on this fleet can generate a presentation — <code>skill:deck.pptx</code> is not registered.</span><small>What is shown here is sample output. A registered deck skill would appear in this block with its inputs, runtime and cost, the way a code run lists its tool calls.</small></div>
 <Button size="sm" variant="secondary" onClick={()=>reference('Skill library · deck.pptx')}>Open the skill library</Button></div>;
import {Slide,slideTitles,edges} from './graphComponents';
import {allSampleNodes as nodes} from './graphData.mjs';
import {NOW,clock} from './timeline.mjs';
const names=Object.fromEntries(nodes.map(n=>[n.id,n.data.title??n.data.prompt??n.data.type]));
const slideOptions=slideTitles.map((title,index)=>({value:String(index+1),label:`${index+1}. ${title}`}));

export function Inspector({selection,asked,setAsked,range,close,select,reference,runFailed=false}:any){
 const [slide,setSlide]=useState(4);
 const [previewOpen,setPreviewOpen]=useState(false);
 const [query,setQuery]=useState('Anything for me?');
 const [answerVisible,setAnswerVisible]=useState(true);
 useEffect(()=>{setPreviewOpen(false)},[selection?.id,selection?.version]);
 useEffect(()=>{
  if(!previewOpen)return;
  const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')setPreviewOpen(false);if(event.key==='ArrowLeft')setSlide(value=>Math.max(1,value-1));if(event.key==='ArrowRight')setSlide(value=>Math.min(12,value+1))};
  window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);
 },[previewOpen]);
 if(!selection)return null;
 const transcript=['transcript','meeting'].includes(selection.id);
 const deck=selection.id==='deck';
 const generation=selection.id==='deckagent';
 const terminal=selection.id==='background'||selection.id==='preview-terminal';
 const rel=edges.find(e=>e.id===selection.id);
 const title=selection.kind==='edge'&&rel?`${names[rel.source]} → ${names[rel.target]}`:names[selection.id];
 const available=range.end>=98?[1,2]:range.end>=87?[1]:[];
 const choices=range.end>=103?[...available,3]:available;
 const version=choices.includes(selection.version)?selection.version:available.at(-1)??1;
 const generating=version===3||!available.length;
 const lastAvailable=available.at(-1);
 const previewControls=(large=false)=><div className="slide-controls" aria-label="Slide navigation">
  <IconButton size="sm" aria-label="Previous slide" disabled={slide===1} onClick={()=>setSlide(value=>Math.max(1,value-1))}><ChevronIcon dir="left" size={16}/></IconButton>
  <span className="slide-position" aria-live="polite">Slide {slide} of 12</span>
  <IconButton size="sm" aria-label="Next slide" disabled={slide===12} onClick={()=>setSlide(value=>Math.min(12,value+1))}><ChevronIcon dir="right" size={16}/></IconButton>
  {!large&&<Select size="sm" aria-label="Go to slide" value={String(slide)} options={slideOptions} onChange={event=>setSlide(Number(event.target.value))}/>}
 </div>;
 const referenceLabel=transcript?'Planning sync · 08:42':deck?`Sprint review · v${version}${generating?'':` · Slide ${slide}`}`:generation?'Presentation generation run':title;
 return <ChatSidePanelFrame className="activity-inspector" title={transcript?'Planning sync':deck?'Sprint review':generation?'Generate Sprint review':title} subtitle={transcript?'Meeting transcript · Shared with you':deck?'Presentation · Shared with you':generation?'Presentation agent · Running':terminal?'Cloud project · Shared with you':'Shared with you'} onClose={close} data-testid="work-details">
  <div className="inspector-content">
   <div className="inspector-main">
   {transcript?<>
    <div className="detail-status-block"><span className="detail-status-dot ready"/><div><strong>Transcript ready</strong><span>Planning sync · 08:30–09:00 · 2 speakers</span></div></div>
    <Tabs items={[{id:'transcript',label:'Transcript'},{id:'ask',label:'Ask'}]} value={asked?'ask':'transcript'} onValueChange={id=>setAsked(id==='ask')} size="sm" aria-label="Transcript view"/>
    {!asked?<div className="transcript"><div><time>08:42</time><b>Connor</b><p>Frank, can you review the release risks before noon?</p></div><div><time>08:47</time><b>Frank</b><p>Yes — send me the updated deck.</p></div></div>:<div className="ask"><label htmlFor="ask">Ask this transcript</label><div className="ask-input"><input id="ask" value={query} onChange={event=>{setQuery(event.target.value);setAnswerVisible(false)}}/><Button size="sm" onClick={()=>setAnswerVisible(true)} disabled={!query.trim()}>Ask</Button></div>
     {answerVisible&&<div className="answer"><p>Review the release risks in Connor’s updated deck before noon.</p><div className="inline-actions"><Button size="sm" variant="secondary" onClick={()=>setAsked(false)}>08:42 in transcript</Button>{range.end>=87&&<Button size="sm" variant="secondary" onClick={()=>select({kind:'node',id:'deck',version:range.end>=98?2:1})}>Sprint review ↗</Button>}</div><small>Sample answer for this preview.</small></div>}
    </div>}
   </>:deck?<div className="artifact-inspector">
    <div className="detail-status-block"><span className={'detail-status-dot '+(runFailed?'failed':range.end>=103?'live':'ready')}/><div><strong>{runFailed?'v3 generation failed':range.end>=103?'Generating v3':'Presentation ready'}</strong><span>{runFailed?'v2 remains available to review':range.end>=103?'v2 is available to review while the agent works':'Presentation activity at '+clock(range.end)}</span></div></div>
    {!!choices.length&&<div className="revision-selector"><div className="detail-section-label">Revisions</div><Tabs items={choices.map(v=>({id:String(v),label:`v${v}${v===3?runFailed?' · Failed':' · Generating':''}`}))} value={String(version)} onValueChange={id=>select({kind:'node',id:'deck',version:Number(id)})} size="sm" variant="segmented" aria-label="Presentation revision"/></div>}
    {generating?<div className="generation-progress" role="status"><span className={'detail-status-dot '+(runFailed?'failed':'live')}/><div><strong>{runFailed?'The presentation agent failed while generating v3.':`The presentation agent is generating ${version===3?'v3':'the first draft'}.`}</strong><p>Using the planning transcript and release plan.</p>{lastAvailable&&<Button size="sm" variant="secondary" onClick={()=>select({kind:'node',id:'deck',version:lastAvailable})}>Review available v{lastAvailable}</Button>}</div></div>:<>
     <div className="artifact-preview" role="group" aria-label="Presentation slide preview"><Slide version={version} slide={slide}/>{previewControls()}<Button size="sm" variant="secondary" fullWidth onClick={()=>setPreviewOpen(true)}>Open larger preview</Button></div>
    </>}
    <div className="detail-section"><div className="detail-section-label">Sources used</div><button type="button" className="detail-source" onClick={()=>select({kind:'node',id:'transcript'})}><span>▤</span><span><strong>Planning sync transcript</strong><small>Meeting · 08:30–09:00</small></span><span>↗</span></button><button type="button" className="detail-source" onClick={()=>select({kind:'node',id:'doc'})}><span>▤</span><span><strong>Release plan</strong><small>Project document · Revision 6</small></span><span>↗</span></button></div>
    <DeckProvenance reference={reference}/>
   </div>:generation?<div className="process-inspector"><div className="detail-status-block"><span className={'detail-status-dot '+(runFailed?'failed':'live')}/><div><strong>{runFailed?'Presentation agent failed':'Presentation agent running'}</strong><span>{runFailed?'v3 was not produced · v2 remains available':'Creating the next revision of Sprint review'}</span></div></div><div className="detail-section-label">Inputs</div><div className="detail-chips"><span>Planning sync transcript</span><span>Release plan · rev 6</span></div><DeckProvenance reference={reference}/><Button size="sm" variant="secondary" onClick={()=>select({kind:'node',id:'deck',version:2})}>Inspect available v2</Button></div>:terminal?<div className="process-inspector"><div className="detail-status-block"><span className="detail-status-dot live"/><div><strong>Tests running in cloud terminal</strong><span>Session started 09:15 · Shared with you</span></div></div><div className="detail-section-label">Work item</div><button type="button" className="detail-source" onClick={()=>select({kind:'node',id:'workitem'})}><span>☑</span><span><strong>WORK-144</strong><small>Gateway · Coverage checks</small></span><span>↗</span></button><div className="detail-provenance"><b>Running</b><span>AgentCore microVM · <code>{selection.id==='background'?'auth-migration-3':'auth-migration-4'}</code> · Sonnet</span><small>/mnt/workspace persists across the session · stops after 20 min idle · $0.04 so far</small></div>
    <div className="inspector-terminal"><ShellTerminal sessionId={selection.id==='background'?'sess-mock-auth-migration-0003':'sess-mock-auth-migration-0004'} label="AgentCore devbox" autoConnect height={230} chrome={false}/></div>
    <p className="inspector-terminal-meta">The same shell the agent is working in. Type <code>help</code> for what this box understands.</p></div>:<div className="process-inspector"><div className="detail-status-block"><span className="detail-status-dot ready"/><div><strong>{title}</strong><span>{selection.kind==='edge'?'Connection between work items':'Shared work context'}</span></div></div><p className="detail-copy">{selection.kind==='edge'?'This connection shows how the two work items are related. Reference it in chat to discuss this relationship.':selection.id==='workitem'?'Gateway · WORK-144 feeds the shared cloud terminal for coverage checks.':selection.id==='doc'?'Release plan · Revision 6. Used with the meeting transcript to create the sprint review presentation.':'Follow the connected sources and outputs to see the context.'}</p></div>}
   </div>
   <div className="inspector-actionbar"><Button size="sm" fullWidth variant="secondary" onClick={()=>reference(referenceLabel)}>Reference in chat</Button></div>
  </div>
  {previewOpen&&deck&&!generating&&<div className="slide-lightbox" role="dialog" aria-modal="true" aria-label={`Sprint review v${version} larger preview`}><div className="slide-lightbox-card"><div className="lightbox-heading"><div><strong>Sprint review · v{version}</strong><span>Slide {slide} of 12</span></div><IconButton aria-label="Close larger preview" onClick={()=>setPreviewOpen(false)}>✕</IconButton></div><Slide version={version} slide={slide}/>{previewControls(true)}</div></div>}
 </ChatSidePanelFrame>
}
