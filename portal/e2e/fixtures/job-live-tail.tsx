// Actual JobDetailPage and useFetch; transport/actor fixtures are inert and
// never create, dispatch, cancel, review or connect to a native worker.
import '../../src/app.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import JobDetailPage from '../../src/pages/work/JobDetailPage';

const originalNow=Date.now, originalInterval=window.setInterval.bind(window), originalClear=window.clearInterval.bind(window);
let offset=0, intervalSequence=100000;
const watchdogs=new Map<number,()=>void>();
Date.now=()=>originalNow()+offset;
window.setInterval=((handler:TimerHandler,ms?:number,...args:unknown[])=>{
  if(ms===10000&&typeof handler==='function'){const id=++intervalSequence;watchdogs.set(id,()=>handler(...args));return id;}
  return originalInterval(handler,ms,...args);
}) as typeof window.setInterval;
window.clearInterval=((id:number)=>{if(watchdogs.delete(id))return;originalClear(id);}) as typeof window.clearInterval;
class FixtureEventSource {
  static CLOSED=2; static CONNECTING=0; static OPEN=1;
  readonly url:string; readyState=1; closeCalls=0;
  onmessage:((event:{data:string})=>void)|null=null; onerror:(()=>void)|null=null;
  private listeners=new Map<string,Array<()=>void>>();
  constructor(url:string){this.url=url;control.streams.push(this);}
  addEventListener(name:string,listener:()=>void){this.listeners.set(name,[...this.listeners.get(name)??[],listener]);}
  close(){this.closeCalls+=1;this.readyState=2;}
  // Retain callbacks after close deliberately: a queued stale browser frame
  // is the regression, rather than a fake transport that conveniently hides it.
  emit(event:unknown){this.onmessage?.({data:typeof event==='string'?event:JSON.stringify(event)});}
  heartbeat(){for(const callback of this.listeners.get('heartbeat')??[])callback();}
  error(readyState:number){this.readyState=readyState;this.onerror?.();}
}
const control={actor:'fixture-tail-a',streams:[] as FixtureEventSource[],watchdogs,
  tick:(ms:number)=>{offset+=ms;for(const callback of [...watchdogs.values()])callback();}};
(window as any).__jobTail=control;
window.EventSource=FixtureEventSource as unknown as typeof EventSource;
function Fixture(){
  const [,render]=useState(0),navigate=useNavigate();
  return <main className="h-screen p-3">
    <div className="flex gap-3"><button onClick={()=>{control.actor=control.actor==='fixture-tail-a'?'fixture-tail-b':'fixture-tail-a';render(n=>n+1);}}>Switch fixture actor</button>
      <button onClick={()=>navigate('/iq/work/job-tail-two?tab=activity')}>Change fixture route</button>
      <button onClick={()=>navigate('/fixture-closed')}>Unmount fixture job</button></div>
    <Routes><Route path="/iq/work/:jobId" element={<JobDetailPage/>}/><Route path="/fixture-closed" element={<p>Fixture closed</p>}/></Routes>
  </main>;
}
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/iq/work/job-tail-one?tab=activity']}><Fixture/></MemoryRouter>);
