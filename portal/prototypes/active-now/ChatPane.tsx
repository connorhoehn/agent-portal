import React,{useCallback,useEffect,useRef,useState} from 'react';
import { Button, IconButton, Avatar, ChannelHeader, Tabs, RichChatComposer, MessageBody, DocumentActivityCard, AgentRunCard, CloseIcon, DocumentIcon, PhoneIcon, VideoCallIcon, type ComposerCommand } from './shared';

// The composer's slash commands, in the library's own `ComposerCommand` shape —
// the same bar and argument menu the real app uses for `/doc`. `/run` is the
// one this variant is about; `/deck` is deliberately disabled with the reason,
// because a command that offers a deck nothing can generate is the kind of
// detail that outruns the product.
const initiatives=[{id:'p-auth-migration',label:'Auth Migration',description:'2 computers · $14.91 of your envelope left'},{id:'p-observability',label:'Observability Platform',description:'1 computer · needs you'},{id:'p-llm-platform',label:'LLM Application Platform',description:'no computer yet'}];
const computers=[{id:'auth-migration-3',label:'auth-migration-3',description:'running · Sonnet'},{id:'auth-migration-2',label:'auth-migration-2',description:'idle'},{id:'observability-1',label:'observability-1',description:'needs you'}];
const pick=(list:{id:string;label:string;description:string}[])=>(query:string)=>list.filter(item=>item.label.toLowerCase().includes(query.trim().toLowerCase()));
export const commands:ComposerCommand[]=[
 {trigger:'/run',label:'Dispatch an agent',hint:'pick an initiative, then say what to do · spends your sprint envelope',description:'Forecasts the run against your sprint envelope and the initiative allocation, claims the work, and opens the Computer Lab beside this chat.',argument:{placeholder:'which initiative?',search:pick(initiatives)}},
 {trigger:'/terminal',label:'Open a cloud terminal',hint:'attach a shell to one of your computers',argument:{placeholder:'which computer?',search:pick(computers)}},
 {trigger:'/doc',label:'Edit the open document with Haiku',hint:'Sprint review'},
 {trigger:'/schedule',label:'Put it on a schedule',hint:'becomes a cron mission with its own budget',argument:{placeholder:'which initiative?',search:pick(initiatives)}},
 {trigger:'/deck',label:'Build a deck',hint:'no deck skill is registered on this fleet',disabled:true},
];
import {AttentionStars} from './AttentionStars';
import {TerminalGlyph,AgentGlyph,ChatBubbleGlyph,DriveGlyph,BookGlyph,MoreGlyph,ChevronDownGlyph,DocGlyph} from './icons';


// The library owns the editor. Keep its document in the host while full view
// unmounts the left chat, so formatting and an unfinished reply survive.
export function DraftComposer({draft,draftStore,onSend,onReference,name='Connor',handleRef}:any){
 const latest=useRef({draft,draftStore});latest.current={draft,draftStore};
 const release=useRef<(()=>void)|null>(null);
 const bind=useCallback((handle:any)=>{
  release.current?.();release.current=null;
  if(handleRef)handleRef.current=handle;
  const editor=handle?.editor;if(!editor)return;
  const store=latest.current.draftStore;
  editor.commands.setContent(store.current??{type:'doc',content:[{type:'paragraph',...(latest.current.draft?{content:[{type:'text',text:latest.current.draft}]}:{})}]});
  const save=()=>{if(!editor.isDestroyed)store.current=editor.getJSON()};
  save();editor.on('update',save);
  editor.view.dom.setAttribute('role','textbox');
  editor.view.dom.setAttribute('aria-label',`Message ${name}`);
  editor.view.dom.setAttribute('aria-multiline','true');
  release.current=()=>{save();editor.off('update',save)};
 },[name]);
 useEffect(()=>()=>release.current?.(),[]);
 const root=useRef<HTMLDivElement>(null);
 // The library composer owns sending (commands, attachments, the draft); the
 // mockup's split Send button is a face on it, so it presses the real one.
 const send=()=>root.current?.querySelector<HTMLButtonElement>('[data-testid="social-composer-send"]')?.click();
 const extras=<>
  <span className="composer-hints" aria-hidden="true"><kbd>/</kbd>for commands<kbd><TerminalGlyph size={13}/></kbd>for shell<kbd>⌘K</kbd>to quickly open</span>
  <IconButton size="sm" aria-label="Add from Google Drive" className="composer-tool"><DriveGlyph/></IconButton>
  <IconButton size="sm" aria-label="Reference a document" className="composer-tool" onClick={onReference}><BookGlyph/></IconButton>
  <IconButton size="sm" aria-label="More composer actions" className="composer-tool"><MoreGlyph/></IconButton>
  <span className="composer-send-split"><Button onClick={send} className="composer-send-main"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/></svg>Send</Button><IconButton aria-label="Send options" className="composer-send-more"><ChevronDownGlyph/></IconButton></span>
 </>;
 return <div className="composer-effect agent-composer" ref={root}><RichChatComposer ref={bind} onSend={onSend} commands={commands} allowAttachments placeholder={`Message ${name}, ask an agent, or run a command…`} data-testid="social-composer" toolbarExtras={extras}/><AttentionStars seed="chat-composer" className="composer-stars"/></div>;
}

export function ChatPane({messages,draft,draftStore,reference,setReference,onSend,onOpenDeck,onOpenActivity,onOpenLab,review,onReview,runFailed=false,person='Connor Hoehn',isConnor=true,shelf}:any){
 const [tab,setTab]=useState('chat');
 const [callNotice,setCallNotice]=useState('');
 // Chat / Agent / Terminal: the same composer, told what the next message is.
 // Agent and Terminal start the draft with the command the library composer
 // already understands (`/run`, `/terminal`), so its command bar and argument
 // menu take over from there — the mode is a shortcut, not a second input.
 const [mode,setMode]=useState<'chat'|'agent'|'terminal'>('chat');
 const composer=useRef<any>(null);
 const chooseMode=(next:'chat'|'agent'|'terminal')=>{
  setMode(next);
  const editor=composer.current?.editor;if(!editor)return;
  const text=editor.getText().replace(/^\/(run|terminal)\s*/,'');
  editor.commands.setContent('');
  composer.current.insertText((next==='agent'?'/run ':next==='terminal'?'/terminal ':'')+text);
  composer.current.focus();
 };
 const bottom=useRef<HTMLDivElement>(null);
 useEffect(()=>{bottom.current?.scrollIntoView({block:'end'})},[messages.length,person]);
 const firstName=person.split(' ')[0];
 const tabs=[{id:'chat',label:'Chat'},{id:'files',label:'Files'},{id:'documents',label:'Documents',badge:isConnor?1:undefined},{id:'pinned',label:'Pinned'},{id:'calls',label:'Calls'}];
 return <section className="conversation-pane" aria-label={shelf?`${shelf} preview`:`Chat with ${firstName}`}>
  <ChannelHeader name={shelf||person} online={shelf?undefined:isConnor} size="md" className="social-channel-header" data-testid="social-channel-header"
   tabs={!shelf&&<Tabs items={tabs} value={tab} onValueChange={setTab} size="sm" idPrefix="conversation" aria-label="Conversation views"/>}
   actions={!shelf&&<div className="chat-header-actions"><IconButton aria-label={`Call ${firstName}`} onClick={()=>setCallNotice('Calling is not connected in this local preview.')}><PhoneIcon size={16}/></IconButton><IconButton aria-label={`Video call ${firstName}`} onClick={()=>setCallNotice('Calling is not connected in this local preview.')}><VideoCallIcon size={17}/></IconButton></div>}/>
  {callNotice&&<div className="chat-notice" role="status">{callNotice}<IconButton size="sm" aria-label="Dismiss call notice" onClick={()=>setCallNotice('')}><CloseIcon size={12}/></IconButton></div>}
  {shelf?<div className="chat-tab-content"><h3>{shelf==='Mentions'?'Mentioned in Sprint review':'Shared work from Connor'}</h3><p>Connor is reviewing the sprint presentation while the next revision generates.</p><Button variant="secondary" onClick={onOpenActivity}>Open active work</Button></div>:tab!=='chat'?<div className="chat-tab-content" role="tabpanel" id={`conversation-panel-${tab}`} aria-labelledby={`conversation-tab-${tab}`}>
   {isConnor&&['files','documents'].includes(tab)?<DocumentActivityCard documentId="sprint-review" title="Sprint review" createdBy="Connor Hoehn" onOpen={onOpenDeck}/>:<p>{tab==='calls'?'No calls in this conversation.':tab==='pinned'?'No pinned messages.':`No shared ${tab} yet.`}</p>}
  </div>:<>
  <div className="conversation-messages" role="tabpanel" id="conversation-panel-chat" aria-labelledby="conversation-tab-chat">
   <div className="message-history">
   <div className="day-marker">Today</div>
   {isConnor&&<>
    <article className="chat-message card-message"><Avatar name="Connor Hoehn" size={22}/><div className="message-content">
     <div className="message-meta"><b>Connor Hoehn</b><time>09:38</time></div>
     <p>Here’s the sprint review. You can open my shared work beside this chat.</p>
     <DocumentActivityCard documentId="sprint-review" title="Sprint review" createdBy="Connor Hoehn" editors={[{userId:'connor',displayName:'Connor Hoehn'}]} onOpen={onOpenActivity} data-testid="shared-work-card"/>
    </div></article>
    <article className="chat-message card-message"><Avatar name="Connor Hoehn" size={22}/><div className="message-content">
     <div className="message-meta"><b>Connor Hoehn</b><time>09:39</time></div>
     <AgentRunCard runId="sprint-review-run" command="/doc" instruction="Add release risks and owners" agentName="Presentation agent" requestedBy="Connor Hoehn"
      status={{phase:runFailed?'failed':'completed',detail:runFailed?'Generation failed · inspect run':'3 changes suggested',...(!runFailed?{suggestion:{key:'risk-revisions',documentId:'sprint-review'},review}:{}),
       result:{kind:'panel',panel:{kind:'work-graph',id:'connor',title:'Connor’s activity'}},
       details:{document:{id:'sprint-review',title:'Sprint review'},steps:[{id:'read',label:'Read the deck',status:'completed'},{id:'draft',label:'Suggest release risks',status:'completed'},{id:'apply',label:'Ready for review',status:'completed'}]}}}
      onReview={(_,decision)=>onReview({decision,by:'frank',byName:'Frank Davis',at:'2026-09-20T09:45:00-04:00'})}
      onOpenResult={onOpenActivity} onOpenDocument={onOpenDeck} onOpenRun={onOpenActivity} data-testid="shared-run-card"/>
    </div></article>
   </>}
   {messages.map((m:any,i:number)=><article className={'chat-message '+(m.from==='Frank'&&!m.run?'from-self':m.run?'card-message':'')} key={i}>
    <Avatar name={m.from==='Frank'?'Frank Davis':person} size={22}/><div className="message-content">
     <div className="message-meta"><b>{m.from==='Frank'?'Frank Davis':person}</b><time>{m.time}</time></div>
     {m.run?<AgentRunCard runId={m.run.id} command="/run" instruction={m.run.instruction} agentName={`Code agent · ${m.run.model}`} requestedBy="Frank Davis"
       status={{phase:m.run.status==='review'?'completed':'running',detail:m.run.status==='review'?'Change captured · waiting on review':`On ${m.run.computer} · forecast $${m.run.forecastUsd[0].toFixed(2)}–$${m.run.forecastUsd[1].toFixed(2)}`,
        result:{kind:'panel',panel:{kind:'computer-lab',id:m.run.computer,title:'Computer Lab'}},
        details:{steps:[{id:'claim',label:'Claim the work item',status:'completed'},{id:'clone',label:`Check out on ${m.run.computer}`,status:'completed'},...(m.run.status==='review'?[{id:'capture',label:'Diff captured for review',status:'completed'}]:[])]}}}
       onOpenRun={onOpenLab} onOpenResult={onOpenLab} data-testid="run-card"/>:<>
     {m.ref&&<Button size="sm" variant="secondary" className="reference-action" onClick={onOpenDeck}><DocumentIcon size={13}/>{m.ref}</Button>}
     <div className="message-text"><MessageBody text={m.text} html={m.html}/></div>
     {m.files?.map((name:string)=><span className="local-attachment" key={name}><DocumentIcon size={13}/>{name}</span>)}</>}
     {m.from==='Frank'&&<span className="sent-status">Sent</span>}
    </div>
   </article>)}
   <div ref={bottom}/>
   </div>
  </div>
  <div className="composer agent-composer-wrap">
   {isConnor&&<div className="agent-status" role="status"><span className="agent-status-dot"/>Presentation agent · {runFailed?'v3 failed':'v3 generating'}<span className="agent-status-sep">·</span>Terminal tests running</div>}
   <div className="agent-modes">
    <div className="mode-pills" role="radiogroup" aria-label="What this message is">
     {([['chat','Chat',<ChatBubbleGlyph key="c" size={14}/>],['agent','Agent',<AgentGlyph key="a"/>],['terminal','Terminal',<TerminalGlyph key="t" size={15}/>]] as const).map(([id,label,icon])=>
      <button key={id} type="button" role="radio" aria-checked={mode===id} className={'mode-pill'+(mode===id?' is-on':'')} onClick={()=>chooseMode(id)}>{icon}{label}</button>)}
    </div>
    {reference&&<div className="reference-chip"><DocGlyph size={15}/><span>{reference}</span><IconButton size="sm" aria-label="Remove message reference" onClick={()=>setReference('')}><CloseIcon size={12}/></IconButton></div>}
   </div>
   <DraftComposer draft={draft} draftStore={draftStore} onSend={onSend} onReference={()=>setReference('Sprint review · v2')} name={firstName} handleRef={composer}/>
  </div>
  </>}
 </section>
}
