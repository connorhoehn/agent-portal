import React,{useEffect,useState} from 'react';
import {Button,Tabs,Select,IconButton,ChevronIcon,ChatSidePanelFrame,ShellTerminal,TailPane,PaneStatusLine,fixtureModels,Avatar,Chip,StatusPill} from './shared';
import {TerminalGlyph,FlaskGlyph,PackageGlyph,DownloadGlyph,MonitorGlyph,JoinGlyph,LinkGlyph,MoreGlyph,ChevronDownGlyph,PopOutGlyph,DocGlyph} from './icons';

// PROVENANCE FIRST. A detail pane that shows more than the platform can
// attribute — a slide preview from a generator that does not exist — teaches a
// viewer to distrust the whole screen, and it is the pane a demo lingers on.
// So each inspector leads with what produced this and how, and when nothing
// registered can, it says exactly that: a worse-looking panel, and a better
// one, because it is a thing somebody can go and fix.
// The two cloud-terminal nodes as the `Computer` the lab's own components
// read — so the inspector shows the SAME gauges, the same live tail and the
// same shell a pane in Computer Lab would, not a drawing of them.
const boxes:Record<string,any>={
 background:{id:'auth-migration-3',label:'auth-migration-3',sessionId:'sess-mock-auth-migration-0003-0000-0000-000000000003',createdAt:'2026-09-21T13:15:00.000Z',status:'running',projectId:'p-auth-migration',project:'Auth Migration',spendUsd:0.04,tokensUsed:31200,contextUsed:0.32,activeModel:'claude-sonnet-5',currentTask:'WORK-144 · Flaky test triage: find the tests that failed intermittently this week and say why',lastResult:{subtype:'success',turns:6,durationMs:212_000,costUsd:0.04},costUsd:0.04,lastActivityAt:new Date().toISOString(),stopsInMs:41*60_000,idleMsLeft:19*60_000,lifetimeMsLeft:41*60_000},
 'preview-terminal':{id:'auth-migration-4',label:'auth-migration-4',sessionId:'sess-mock-auth-migration-0004-0000-0000-000000000004',createdAt:'2026-09-21T13:34:00.000Z',status:'running',projectId:'p-auth-migration',project:'Auth Migration',spendUsd:0.02,tokensUsed:9800,contextUsed:0.11,activeModel:'claude-haiku-4-5',currentTask:'WORK-145 · Nightly dependency audit: bump patch versions, flag advisories',lastResult:{subtype:'success',turns:3,durationMs:88_000,costUsd:0.02},costUsd:0.02,lastActivityAt:new Date().toISOString(),stopsInMs:55*60_000,idleMsLeft:20*60_000,lifetimeMsLeft:55*60_000},
};
const session:Record<string,{files:{path:string;stat:string}[];git:string[];workItem:[string,string]}>={
 background:{files:[{path:'test/gateway/session-recovery.test.ts',stat:'+27 −4'},{path:'test/helpers/retry.ts',stat:'+18'},{path:'vitest.config.ts',stat:'+2 −1'}],git:['0048a0b (HEAD -> main) Quarantine the two flaky recovery specs','9a42f1c Session recovery','M  test/gateway/session-recovery.test.ts','A  test/helpers/retry.ts','M  vitest.config.ts'],workItem:['WORK-144','Gateway · Flaky test triage']},
 'preview-terminal':{files:[{path:'package.json',stat:'+6 −6'},{path:'package-lock.json',stat:'+212 −198'}],git:['4bc2718 (HEAD -> main) Retry handling','M  package.json','M  package-lock.json'],workItem:['WORK-145','Gateway · Dependency audit']},
};

// The cloud-terminal inspector, to the 2026-09-21 mockup: who and what at the
// top, the run as a card with its four numbers, and Overview first — a live
// preview of the terminal, the run's steps, what it produced, and the work
// item it answers. The full shell, the files and the raw event tail are one
// tab away each; "Join session" is the primary action because the point of a
// shared cloud terminal is that you can get into it.
type Step={label:string;state:'done'|'running'|'queued';meta:string};
const runs:Record<string,{title:string;summary:string;icon:'flask'|'package';env:string;elapsed:string;ctx:string;preview:string[];steps:Step[];artifacts:{name:string;size:string;updated:string}[];work:{id:string;state:string;text:string;tags:string[]}}>={
 background:{title:'Flaky test triage',summary:'Find the tests that failed intermittently this week and say why.',icon:'flask',env:'devbox:task',elapsed:'Started 09:15 · 30m elapsed',ctx:'32% (128K)',
  preview:['$ flaky-test-triage','▸ Find tests that failed intermittently this week...','▸ Pulling the last 40 CI runs...','✓ Pulled CI history (40 runs, 2.3 GB)','○ Correlating flaky suites...','  Waiting for results...'],
  steps:[{label:'Pulling CI history',state:'done',meta:'Completed · 2m 14s'},{label:'Correlating flaky suites',state:'running',meta:'Running · 30m elapsed'},{label:'Writing findings',state:'queued',meta:'Queued'}],
  artifacts:[{name:'flaky-tests-report.md',size:'12 KB',updated:'Updated 2m ago'},{name:'ci-run-analysis.json',size:'48 KB',updated:'Updated 2m ago'}],
  work:{id:'WORK-144',state:'In Progress',text:'Flaky test triage for auth migration',tags:['testing','reliability','auth']}},
 'preview-terminal':{title:'Dependency audit',summary:'Bump patch versions and flag security advisories as critical.',icon:'package',env:'devbox:task',elapsed:'Started 09:34 · 11m elapsed',ctx:'11% (128K)',
  preview:['$ nightly-dependency-audit','▸ Reading the lockfile and resolving the graph...','▸ npm audit --json','✓ 3 advisories: 1 high, 2 moderate','○ Checking whether the high one is reachable...','  Tracing imports...'],
  steps:[{label:'Resolve dependency graph',state:'done',meta:'Completed · 48s'},{label:'Check advisory reachability',state:'running',meta:'Running · 11m elapsed'},{label:'Open change request',state:'queued',meta:'Queued'}],
  artifacts:[{name:'audit-report.md',size:'6 KB',updated:'Updated 4m ago'},{name:'npm-audit.json',size:'31 KB',updated:'Updated 9m ago'}],
  work:{id:'WORK-145',state:'In Progress',text:'Nightly dependency audit for the gateway',tags:['security','dependencies']}},
};

/** Plays the run's recent output line by line, then holds on a blinking caret
 *  — a preview, not the PTY; the Terminal tab is the real shell. */
function LivePreview({lines}:{lines:string[]}){
 const [shown,setShown]=useState(1);
 useEffect(()=>{setShown(1);const t=setInterval(()=>setShown(n=>n>=lines.length?n:n+1),650);return()=>clearInterval(t)},[lines]);
 return <pre className="live-preview" aria-label="Live terminal preview">{lines.slice(0,shown).map((line,i)=>{
  const tone=line.startsWith('✓')?'ok':line.startsWith('○')?'pending':line.startsWith('$')?'cmd':'';
  const last=i===shown-1&&shown===lines.length;
  return <span key={i} className={'live-line '+tone}>{line}{last&&<i className="live-caret"/>}{'\n'}</span>;
 })}</pre>;
}

function TerminalInspector({id,reference,view,setView}:{id:string;reference:(label:string)=>void;view:string;setView:(v:string)=>void}){
 const box=boxes[id]??boxes.background;
 const run=runs[id]??runs.background;
 const files=(session[id]??session.background);
 return <div className="term-inspector">
  <div className="term-crumbs"><span>AgentCore microVM</span><ChevronIcon dir="right" size={12}/><span>{box.project}</span><StatusPill state="info" label="RUNNING" size="sm"/></div>
  <div className="term-owner"><Avatar name="Frank Davis" size={26}/><b>Frank Davis</b><span>Shared with you</span></div>
  <div className="term-actions">
   <Button variant="secondary" onClick={()=>setView('terminal')}><TerminalGlyph/>Open shell</Button>
   <Button variant="secondary" onClick={()=>reference(`${box.label} · ${run.title}`)}><LinkGlyph/>Reference in chat</Button>
   <IconButton aria-label="More actions"><MoreGlyph/></IconButton>
  </div>

  <section className="term-run-card">
   <div className="term-run-head">
    <span className="term-run-icon">{run.icon==='flask'?<FlaskGlyph/>:<PackageGlyph/>}</span>
    <div><h3>{run.title}</h3><p>{run.summary}</p></div>
   </div>
   <div className="term-run-status"><StatusPill state="info" label="RUNNING" size="sm"/><span>{run.elapsed}</span></div>
   <dl className="term-run-stats">
    <div><dt>Model</dt><dd>{box.activeModel}</dd></div>
    <div><dt>Cost</dt><dd>${box.spendUsd.toFixed(4)}</dd></div>
    <div><dt>Context</dt><dd>{run.ctx}</dd></div>
    <div><dt>Environment</dt><dd>{run.env}</dd></div>
   </dl>
  </section>

  <Tabs items={[{id:'overview',label:'Overview'},{id:'terminal',label:'Terminal'},{id:'files',label:'Files'},{id:'activity',label:'Activity'}]} value={view} onValueChange={setView} aria-label="Cloud terminal view"/>

  {view==='overview'&&<div className="term-overview">
   <div className="term-section-head"><span>Live terminal preview</span><button type="button" className="term-link" onClick={()=>setView('terminal')}><PopOutGlyph/>Open in new</button></div>
   <LivePreview lines={run.preview}/>

   <div className="term-section-head"><span className="term-strong">Progress</span><span>{run.steps.length} steps</span></div>
   <ol className="term-steps">{run.steps.map(step=><li key={step.label} className={'is-'+step.state}>
    <span className="term-step-mark" aria-hidden="true">{step.state==='done'?'✓':''}</span><span className="term-step-label">{step.label}</span><span className="term-step-meta">{step.meta}</span>
   </li>)}</ol>

   <div className="term-grid">
    <section className="term-box">
     <div className="term-box-head"><b>Artifacts</b><span>{run.artifacts.length} files</span></div>
     <ul className="term-artifacts">{run.artifacts.map(a=><li key={a.name}>
      <span className="term-file-icon"><DocGlyph/></span><span className="term-file-text"><b>{a.name}</b><small>{a.size} · {a.updated}</small></span>
      <IconButton size="sm" aria-label={`Download ${a.name}`}><DownloadGlyph/></IconButton>
     </li>)}</ul>
    </section>
    <section className="term-box">
     <div className="term-box-head"><b>Work item</b><IconButton size="sm" aria-label={`Open ${run.work.id}`}><PopOutGlyph/></IconButton></div>
     <div className="term-work-id"><b>{run.work.id}</b><Chip size="xs" tone="info">{run.work.state}</Chip></div>
     <p className="term-work-text">{run.work.text}</p>
     <div className="term-tags">{run.work.tags.map(t=><Chip key={t} size="xs" tone="neutral">{t}</Chip>)}</div>
    </section>
   </div>
  </div>}

  {view==='terminal'&&<><div className="terminal-frame is-shell"><ShellTerminal sessionId={box.sessionId} label={box.label} autoConnect fillHeight chrome={false}/></div>
   <p className="inspector-terminal-meta">The shell the agent is working in — same PTY, same <code>/mnt/workspace</code>. Type <code>help</code> for what this box understands.</p></>}

  {view==='files'&&<div className="terminal-workspace">
   <div className="detail-section-label">Checkout</div>
   <div className="workspace-repo"><b>connorhoehnslalom/orgiq-auth-service</b><span>main · /mnt/workspace/orgiq-auth-service</span></div>
   <div className="detail-section-label">Changed this session</div>
   <ul className="workspace-files">{files.files.map(f=><li key={f.path}><code>{f.path}</code><span>{f.stat}</span></li>)}</ul>
   <div className="detail-section-label">Artifacts</div>
   <ul className="workspace-files">{run.artifacts.map(a=><li key={a.name}><code>{a.name}</code><span className="muted">{a.size}</span></li>)}</ul>
   <div className="detail-section-label">Git</div>
   <pre className="workspace-git">{files.git.join('\n')}</pre>
  </div>}

  {view==='activity'&&<><div className="terminal-gauges"><PaneStatusLine computer={box} modelId={box.activeModel} models={fixtureModels}/></div><div className="terminal-frame"><TailPane computer={box}/></div></>}
 </div>;
}

/** The terminal inspector's own footer: getting into the machine, not quoting it. */
function TerminalFooter({openLab,onJoin}:{openLab?:()=>void;onJoin:()=>void}){
 return <div className="inspector-actionbar term-footer">
  <Button variant="secondary" onClick={openLab}><MonitorGlyph/>Open Computer Lab</Button>
  <div className="term-split"><Button variant="primary" onClick={onJoin}><JoinGlyph/>Join session</Button><IconButton aria-label="More ways to join" className="term-split-more"><ChevronDownGlyph/></IconButton></div>
 </div>;
}

const DeckProvenance=({reference}:{reference:(label:string)=>void})=><div className="detail-section"><div className="detail-section-label">Produced by</div>
 <div className="detail-provenance is-unavailable"><b>Not backed by a registered skill</b><span>Nothing on this fleet can generate a presentation — <code>skill:deck.pptx</code> is not registered.</span><small>What is shown here is sample output. A registered deck skill would appear in this block with its inputs, runtime and cost, the way a code run lists its tool calls.</small></div>
 <Button size="sm" variant="secondary" onClick={()=>reference('Skill library · deck.pptx')}>Open the skill library</Button></div>;
import {Slide,slideTitles,edges} from './graphComponents';
import {allSampleNodes as nodes} from './graphData.mjs';
import {NOW,clock} from './timeline.mjs';
const names=Object.fromEntries(nodes.map(n=>[n.id,n.data.title??n.data.prompt??n.data.type]));
const slideOptions=slideTitles.map((title,index)=>({value:String(index+1),label:`${index+1}. ${title}`}));

export function Inspector({selection,asked,setAsked,range,close,select,reference,runFailed=false,openLab}:any){
 const [slide,setSlide]=useState(4);
 const [termView,setTermView]=useState('overview');
 useEffect(()=>{setTermView('overview')},[selection?.id]);
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
 return <ChatSidePanelFrame className="activity-inspector" title={transcript?'Planning sync':deck?'Sprint review':generation?'Generate Sprint review':terminal?(boxes[selection.id]??boxes.background).label:title} subtitle={transcript?'Meeting transcript · Shared with you':deck?'Presentation · Shared with you':generation?'Presentation agent · Running':terminal?'':'Shared with you'} onClose={close} data-testid="work-details">
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
   </div>:generation?<div className="process-inspector"><div className="detail-status-block"><span className={'detail-status-dot '+(runFailed?'failed':'live')}/><div><strong>{runFailed?'Presentation agent failed':'Presentation agent running'}</strong><span>{runFailed?'v3 was not produced · v2 remains available':'Creating the next revision of Sprint review'}</span></div></div><div className="detail-section-label">Inputs</div><div className="detail-chips"><span>Planning sync transcript</span><span>Release plan · rev 6</span></div><DeckProvenance reference={reference}/><Button size="sm" variant="secondary" onClick={()=>select({kind:'node',id:'deck',version:2})}>Inspect available v2</Button></div>:terminal?<TerminalInspector id={selection.id} reference={reference} view={termView} setView={setTermView}/>:<div className="process-inspector"><div className="detail-status-block"><span className="detail-status-dot ready"/><div><strong>{title}</strong><span>{selection.kind==='edge'?'Connection between work items':'Shared work context'}</span></div></div><p className="detail-copy">{selection.kind==='edge'?'This connection shows how the two work items are related. Reference it in chat to discuss this relationship.':selection.id==='workitem'?'Gateway · WORK-144 feeds the shared cloud terminal for coverage checks.':selection.id==='doc'?'Release plan · Revision 6. Used with the meeting transcript to create the sprint review presentation.':'Follow the connected sources and outputs to see the context.'}</p></div>}
   </div>
   {terminal?<TerminalFooter openLab={openLab} onJoin={()=>setTermView('terminal')}/>:<div className="inspector-actionbar"><Button size="sm" fullWidth variant="secondary" onClick={()=>reference(referenceLabel)}>Reference in chat</Button></div>}
  </div>
  {previewOpen&&deck&&!generating&&<div className="slide-lightbox" role="dialog" aria-modal="true" aria-label={`Sprint review v${version} larger preview`}><div className="slide-lightbox-card"><div className="lightbox-heading"><div><strong>Sprint review · v{version}</strong><span>Slide {slide} of 12</span></div><IconButton aria-label="Close larger preview" onClick={()=>setPreviewOpen(false)}>✕</IconButton></div><Slide version={version} slide={slide}/>{previewControls(true)}</div></div>}
 </ChatSidePanelFrame>
}
