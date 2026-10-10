// Actual initiative composer; every authority, transport and call in this
// fixture is explicit and inert. Captured sends never reach a native service.
import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { GatewayContext } from '@connorhoehnslalom/realtime-modules/client';
import { ConversationInputProvider } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { SidePaneProvider } from '@connorhoehnslalom/ui-components';
import { offlineGateway } from '../../src/components/OptionalGatewayProvider';
import { InitiativeComposer } from '../../src/pages/projects/InitiativeComposer';
import type { ConversationRuntime } from '../../src/components/chat/ConversationThread';
import type { ComposerSubject } from '../../src/pages/project-detail/composerPrompts';

const channel='orgiq:initiative:p-observability';
const listeners=new Set<(frame: Record<string, unknown>)=>void>();
const proof={ sends:[] as Array<{text:string;metadata:Record<string,unknown>}>, dms:[] as unknown[], invitations:[] as unknown[], huddleSends:[] as unknown[], comments:[] as unknown[], commentRefreshes:0 };
const fixture={ proof, social:null as any, huddle:null as any, host:null as any, session:null as any, commentWaiters:[] as Array<()=>void>,retiredDrafts:[] as any[],callSequence:0 };
(window as any).__initiativeInquiry=fixture;
const gateway={...offlineGateway,connectionState:'connected' as const,authToken:'fixture-token',
  onMessage:(h:(frame:Record<string,unknown>)=>void)=>{listeners.add(h);return()=>{listeners.delete(h);};}};
function Fixture(){
  const [revision,setRevision]=useState(0),[maySend,setMaySend]=useState(true),[actor,setActor]=useState('fixture-actor'),[calebVisible,setCalebVisible]=useState(true),[item,setItem]=useState(false);
  const delayedRuntime=new URLSearchParams(window.location.search).has('delayedRuntime');
  const [runtimeReady,setRuntimeReady]=useState(!delayedRuntime);
  fixture.session={sub:actor,name:'Fixture Actor',role:'sme',tenant:'orgiq',grants:{orgiq:['sme'],social:['participant']},masquerading:null};
  fixture.social={ actorId:actor,people:[...(calebVisible?[{userId:'caleb',displayName:'Caleb Turner'}]:[]),{userId:'nora',displayName:'Nora DaSilva'}],canMessagePeople:true,unavailableReason:null,state:{error:null},
    controller:{sendToPerson:async(...args:unknown[])=>{proof.dms.push(args);return true;}},sendToPerson:async(...args:unknown[])=>{proof.dms.push(args);return true;},openDm:async()=>true};
  const conversation={channel,maySend,connected:true,userId:actor,displayName:'Fixture Actor',
    chat:{sendMessage:(text:string,metadata:Record<string,unknown>)=>{proof.sends.push({text,metadata:structuredClone(metadata)});},setTyping:()=>{}},quote:{reply:null,clear:()=>{}},commands:[],summarize:{}} as unknown as ConversationRuntime;
  function join(){
    const callId=++fixture.callSequence===1?'fixture-call':`fixture-call-${fixture.callSequence}`;
    fixture.huddle={callId,actorId:actor,title:'Observability fixture',draft:{html:'',files:[]},page:{kind:'initiative',id:'p-observability'},state:{error:null},unavailableReason:null,
      retiredDrafts:fixture.retiredDrafts,
      updateRetiredDraft:(id:string,draft:unknown)=>{const row=fixture.retiredDrafts.find(row=>row.scope.callId===id);if(row)row.draft=draft;setRevision(n=>n+1);},
      discardRetiredDraft:(id:string)=>{fixture.retiredDrafts=fixture.retiredDrafts.filter(row=>row.scope.callId!==id);fixture.huddle.retiredDrafts=fixture.retiredDrafts;setRevision(n=>n+1);},
      setDraft:(draft:unknown)=>{fixture.huddle.draft=draft;setRevision(n=>n+1);},openPane:()=>true,closeMessage:()=>{},send:async(...args:unknown[])=>{proof.huddleSends.push(args);return true;}};
    fixture.host={connectionState:'connected',self:{userId:actor,displayName:'Fixture Actor'},tenant:'orgiq',call:{call:{callId},invitationRequests:[],invitationError:null,inviteUsers:(targets:unknown[])=>{
      proof.invitations.push(targets);const requestId=`fixture-invite-${proof.invitations.length}`;
      fixture.host.call.invitationRequests=targets.map((t:any)=>({...t,requestId,callId,state:'requested'}));setRevision(n=>n+1);
      return{requestedUserIds:targets.map((t:any)=>t.userId),requestId};}}};setRevision(n=>n+1);
  }
  function retire(){
    const source=fixture.huddle;if(!source?.callId)return;
    fixture.retiredDrafts.push({scope:{callId:source.callId,tenant:'orgiq',actorId:source.actorId,identityKey:JSON.stringify(['orgiq',source.actorId,null,null])},
      title:source.title,draft:{...source.draft,files:[new File(['retained'],'retained-fixture.txt')]},page:source.page});
    source.retiredDrafts=fixture.retiredDrafts;source.callId=null;source.actorId=null;source.draft={html:'',files:[]};fixture.host.call.call=null;setRevision(n=>n+1);
  }
  function confirm(){const last=proof.sends.at(-1)!;const id=`fixture-message-${proof.sends.length}`;
    for(const h of [...listeners])h({type:'chat',action:'message',channel,message:{id,channel,userId:'fixture-actor',metadata:{clientDeliveryId:last.metadata.clientDeliveryId}}});
    for(const h of [...listeners])h({type:'chat',action:'sent',channel,messageId:id});}
  function deny(){for(const h of [...listeners])h({type:'error',service:'chat',channel,error:'Fixture posting denied'});}
  function invitationState(state:string){fixture.host.call.invitationRequests=fixture.host.call.invitationRequests.map((row:any)=>({...row,state,...(state==='failed'?{error:'Fixture invitation denied'}:{})}));setRevision(n=>n+1);}
  const subject=(item?{kind:'item',project:{id:'p-observability',name:'Observability Platform'},item:{id:'fixture-item',key:'FIX-1',title:'Fixture work item'},facts:{}}:{kind:'initiative',project:{id:'p-observability',name:'Observability Platform'},rows:[]}) as ComposerSubject;
  return <main className="p-6" data-testid="initiative-inquiry-fixture" data-revision={revision}>
    <div className="flex gap-3"><button onClick={join}>Join fixture huddle</button><button onClick={confirm}>Confirm fixture receipt</button><button onClick={deny}>Deny fixture send</button><button onClick={()=>setMaySend(false)}>Revoke fixture posting</button>
      <button onClick={()=>invitationState('failed')}>Reject fixture invitation</button><button onClick={()=>invitationState('accepted')}>Accept fixture invitation</button>
      <button onClick={()=>setActor(value=>value==='fixture-actor'?'fixture-other':'fixture-actor')}>Switch fixture actor</button>
      <button onClick={()=>{if(!fixture.huddle)return;fixture.huddle.callId='fixture-next-call';fixture.host.call.call.callId='fixture-next-call';setRevision(n=>n+1);}}>Switch fixture call</button>
      <button onClick={retire}>End fixture huddle retaining draft</button>
      <button onClick={()=>setCalebVisible(value=>!value)}>Toggle fixture Caleb availability</button><button onClick={()=>setItem(true)}>Use fixture work item</button>
      <button onClick={()=>fixture.commentWaiters.shift()?.()}>Confirm fixture comment</button></div>
    <button onClick={()=>setRuntimeReady(true)}>Mount fixture discussion</button>
    <InitiativeComposer subject={subject} setup={{draft:''}} conversation={runtimeReady?conversation:null} defaultMode={delayedRuntime?'agent':'chat'} expanded onComment={()=>{proof.commentRefreshes+=1;}} data-testid="inquiry-composer" />
  </main>;
}
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/iq/projects/p-observability?scope=mine']}><ConversationInputProvider><SidePaneProvider><GatewayContext.Provider value={gateway}><Fixture /></GatewayContext.Provider></SidePaneProvider></ConversationInputProvider></MemoryRouter>);
