// The Computer Lab, as something the split view can hold.
//
// Same shell, same split, same inspector: `/run` in the chat opens THIS beside
// the conversation instead of the activity graph, with the queue of what this
// conversation dispatched sitting above the machines. The lab itself is the
// shipped library component on a fixture transport — panes, terminals and the
// keyboard layer are the real ones, nothing here is drawn to look like them.
import React from 'react';
import {ComputerLab,fixtureComputers,fixtureModels,fixtureRuntimeStatus,mockShellUrl,mockTailUrl,type ComputeClient} from './shared';

export interface QueuedRun{
 id:string;command:string;instruction:string;initiative:string;model:string;computer:string;
 status:'queued'|'running'|'review'|'blocked';spendUsd:number;forecastUsd:[number,number];
}

// What `POST /api/bots/dispatch-work` hands back, shaped after the real rows.
export const seedQueue:QueuedRun[]=[
 {id:'run-4471',command:'/run',instruction:'Clear the legacy shim cookie on logout',initiative:'Auth Migration',model:'Sonnet',computer:'auth-migration-3',status:'review',spendUsd:0.09,forecastUsd:[0.03,0.30]},
 {id:'run-4472',command:'/run',instruction:'Backfill integration tests for the refresh path',initiative:'Auth Migration',model:'Haiku',computer:'auth-migration-2',status:'running',spendUsd:0.04,forecastUsd:[0.02,0.18]},
];

/**
 * A ComputeClient with nothing behind it. A terminal pane still has to ask
 * for a shell URL before it can open a socket, and `mockShellUrl`/`mockTailUrl`
 * mint the `mock-shell:`/`mock-tail:` URLs the installed simulators recognise
 * — the only channel through which a simulator learns which shell it is.
 * Every mutating method resolves without doing anything: a prototype should
 * not pretend to stop a machine it never started.
 */
export const fixtureClient=({
 getStatus:async()=>fixtureRuntimeStatus,
 listComputers:async()=>fixtureComputers,
 createComputer:async()=>fixtureComputers[0],
 adoptComputer:async()=>{},renameComputer:async()=>{},removeComputer:async()=>{},stopSession:async()=>{},
 runTask:async()=>{},runCommand:async()=>{},
 getShellUrl:async(sessionId:string,shellId?:string)=>mockShellUrl(sessionId,shellId),
 // The library ships three scripted tails; the test-triage one is the story a
 // 'coverage checks' terminal is telling.
 tail:(boxId:string)=>({url:mockTailUrl(boxId,boxId==='auth-migration-4'?'nightly-dependency-audit':'flaky-test-triage'),withCredentials:false,headers:{}}),
} as unknown) as ComputeClient;
export {fixtureComputers,fixtureModels};

export function QueueStrip({queue,selectedId,onSelect}:{queue:QueuedRun[];selectedId:string|null;onSelect:(id:string)=>void}){
 return <div className="lab-queue" aria-label="Agents this conversation dispatched">
  {queue.map(r=><button type="button" key={r.id} className={'lab-queue-item '+(selectedId===r.id?'is-selected':'')} onClick={()=>onSelect(r.id)}>
   <span className={'lab-queue-dot '+r.status}/><span className="lab-queue-id">{r.id}</span><span className="lab-queue-text">{r.instruction}</span>
   <span className="lab-queue-meta">{r.computer}{r.spendUsd>0?` · $${r.spendUsd.toFixed(2)}`:''}</span>
  </button>)}
 </div>;
}

export function LabBody({header,queue,selectedId,onSelect,onClose}:{header?:React.ReactNode;queue:QueuedRun[];selectedId:string|null;onSelect:(id:string)=>void;onClose:()=>void}){
 return <div className="lab-body">
  {header}
  <QueueStrip queue={queue} selectedId={selectedId} onSelect={onSelect}/>
  <div className="lab-frame"><ComputerLab open variant="inline" onClose={onClose}/></div>
 </div>;
}
