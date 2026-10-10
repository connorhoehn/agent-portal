import { writeFile } from 'node:fs/promises';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './cdpTest';
test.use({ baseURL:'http://localhost:5183',viewport:{width:1440,height:900},actionTimeout:5000 });

function job(id:string,actor='fixture-tail-a') { return {id,kind:'computer',title:`${id} · ${actor}`,payload:{prompt:'Inert rendering fixture'},status:'running',priority:1,
  boxId:id==='job-tail-one'?'fixture-box-one':'fixture-box-two',sessionId:null,attempts:1,maxAttempts:1,result:null,error:null,createdBy:actor,
  createdAt:'2026-10-10T00:00:00.000Z',claimedAt:null,startedAt:null,finishedAt:null,botId:null,botName:null,botTrigger:null}; }
async function mount(page:Page){
  const apiWrites:string[]=[],jobReads:string[]=[],errors:string[]=[],held:Route[]=[];let hold=false;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
    if(route.request().method()!=='GET'){apiWrites.push(route.request().url());return route.abort();}
    const path=new URL(route.request().url()).pathname;
    if(path.startsWith('/api/work/jobs/')){jobReads.push(path);if(hold){held.push(route);return;}
      const actor=await page.evaluate(()=>(window as any).__jobTail.actor);return route.fulfill({json:job(path.split('/').at(-1)!,actor)});}
    return route.fulfill({json:{proposals:[]}});
  });
  await page.route('**/src/lib/auth.tsx*',route=>route.fulfill({contentType:'application/javascript',body:`export function useSession(){return{session:{sub:window.__jobTail.actor,name:'Fixture Actor',tenant:'orgiq',role:'sme',grants:{orgiq:['sme']},masquerading:null}};}`}));
  await page.route('**/src/lib/capabilities.tsx*',route=>route.fulfill({contentType:'application/javascript',body:`export function useCapabilities(){return{ready:true,can:()=>true};}`}));
  await page.route('**/src/pages/work/JobConversation.tsx*',route=>route.fulfill({contentType:'application/javascript',body:`export function JobConversation(){return null;}`}));
  await page.route('**/__job-live-tail',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/job-live-tail.tsx"></script></body></html>`}));
  await page.goto('/__job-live-tail');await expect(page.getByTestId('run-detail')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as any).__jobTail.streams.length)).toBe(1);
  return{apiWrites,jobReads,errors,hold:()=>{hold=true;},held,
    release:async(id:string,actor:string)=>{hold=false;const route=held.shift();expect(route).toBeTruthy();await route!.fulfill({json:job(id,actor)});}};
}
async function emit(page:Page,index:number,event:unknown){await page.evaluate(({index,event})=>(window as any).__jobTail.streams[index].emit(event),{index,event});}
const text=(value:string)=>({type:'assistant',message:{content:[{type:'text',text:value}]}});
async function snapshot(page:Page){return page.evaluate(()=>{const c=(window as any).__jobTail;return{actor:c.actor,watchdogs:c.watchdogs.size,streams:c.streams.map((s:any)=>({url:s.url,readyState:s.readyState,closeCalls:s.closeCalls}))};});}
async function proof(page:Page,observations:unknown){await writeFile(test.info().outputPath('verification.json'),JSON.stringify({observations,
  final:await snapshot(page),scope:'Actual JobDetailPage and useFetch, mocked session/capability reads and fake EventSource/accelerated clock. No native worker stream, dispatch, job mutation or session/grant change.'},null,2));}

test('watchdog retires prior stream and rejects all stale callbacks while respecting current heartbeats',async({page})=>{
  const control=await mount(page);await emit(page,0,{type:'job_started',jobId:'job-tail-one'});await emit(page,0,text('Original activity'));
  await expect(page.getByText('Original activity',{exact:true})).toBeVisible();
  await page.evaluate(()=>(window as any).__jobTail.tick(60001));await expect.poll(()=>snapshot(page).then(s=>s.streams.length)).toBe(2);
  expect((await snapshot(page)).streams.map(s=>s.closeCalls)).toEqual([1,0]);
  await emit(page,0,{type:'job_started',jobId:'job-tail-one'});await emit(page,0,text('Stale retired output'));
  await page.evaluate(()=>{const stream=(window as any).__jobTail.streams[0];stream.error(2);stream.heartbeat();});
  await expect(page.getByText('Stale retired output',{exact:true})).toHaveCount(0);await expect(page.getByText('Live activity',{exact:true})).toBeVisible();
  await emit(page,1,text('Ungated replacement output'));await expect(page.getByText('Ungated replacement output',{exact:true})).toHaveCount(0);
  await emit(page,1,{type:'job_started',jobId:'other-job'});await emit(page,1,text('Other job output'));await expect(page.getByText('Other job output',{exact:true})).toHaveCount(0);
  await emit(page,1,{type:'job_started',jobId:'job-tail-one'});await emit(page,1,text('Current replacement activity'));await expect(page.getByText('Current replacement activity',{exact:true})).toBeVisible();
  await expect(page.getByText('Original activity',{exact:true})).toHaveCount(0);
  await page.evaluate(()=>{const c=(window as any).__jobTail;c.streams[1].heartbeat();c.tick(50000);});expect((await snapshot(page)).streams).toHaveLength(2);
  await page.evaluate(()=>{const c=(window as any).__jobTail;c.streams[0].heartbeat();c.tick(10001);});await expect.poll(()=>snapshot(page).then(s=>s.streams.length)).toBe(3);
  expect((await snapshot(page)).streams.map(s=>s.closeCalls)).toEqual([1,1,0]);
  await page.getByRole('button',{name:'Unmount fixture job',exact:true}).click();await expect(page.getByText('Fixture closed',{exact:true})).toBeVisible();
  const before=control.jobReads.length;await emit(page,2,{type:'job_finished',jobId:'job-tail-one'});await page.evaluate(()=>(window as any).__jobTail.tick(70000));
  expect(control.jobReads.length).toBe(before);expect((await snapshot(page)).streams.map(s=>s.closeCalls)).toEqual([1,1,1]);expect((await snapshot(page)).watchdogs).toBe(0);
  expect(control.apiWrites).toEqual([]);expect(control.errors).toEqual([]);await proof(page,{jobReads:control.jobReads,apiWrites:control.apiWrites,errors:control.errors});
});

test('actor and route changes use fresh readers and cannot show or tail a cached previous job',async({page})=>{
  const control=await mount(page);await emit(page,0,{type:'job_started',jobId:'job-tail-one'});await emit(page,0,text('Previous actor output'));await expect(page.getByText('Previous actor output',{exact:true})).toBeVisible();
  control.hold();await page.getByRole('button',{name:'Switch fixture actor',exact:true}).click();await expect.poll(()=>control.held.length).toBe(1);
  await expect(page.getByTestId('run-detail')).toHaveCount(0);await expect(page.getByText('Previous actor output',{exact:true})).toHaveCount(0);expect((await snapshot(page)).streams.map(s=>s.closeCalls)).toEqual([1]);
  await emit(page,0,text('Stale previous actor output'));await control.release('job-tail-one','fixture-tail-b');await expect(page.getByTestId('run-detail')).toBeVisible();
  await expect.poll(()=>snapshot(page).then(s=>s.streams.length)).toBe(2);await emit(page,1,{type:'job_started',jobId:'job-tail-one'});await emit(page,1,text('Current actor output'));await expect(page.getByText('Current actor output',{exact:true})).toBeVisible();
  control.hold();await page.getByRole('button',{name:'Change fixture route',exact:true}).click();await expect.poll(()=>control.held.length).toBe(1);
  await expect(page.getByTestId('run-detail')).toHaveCount(0);await expect(page.getByText('Current actor output',{exact:true})).toHaveCount(0);expect((await snapshot(page)).streams.map(s=>s.closeCalls)).toEqual([1,1]);
  await emit(page,1,{type:'job_finished',jobId:'job-tail-one'});await control.release('job-tail-two','fixture-tail-b');await expect(page.getByTestId('run-detail')).toBeVisible();
  await expect.poll(()=>snapshot(page).then(s=>s.streams.length)).toBe(3);expect((await snapshot(page)).streams[2].url).toBe('/api/devbox/boxes/fixture-box-two/tail');
  await emit(page,2,{type:'job_started',jobId:'job-tail-one'});await emit(page,2,text('Prior job on current worker'));await expect(page.getByText('Prior job on current worker',{exact:true})).toHaveCount(0);
  await emit(page,2,{type:'job_started',jobId:'job-tail-two'});await emit(page,2,text('Second job output'));await expect(page.getByText('Second job output',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Unmount fixture job',exact:true}).click();await expect(page.getByText('Fixture closed',{exact:true})).toBeVisible();
  await expect.poll(()=>snapshot(page).then(s=>s.streams.map(stream=>stream.closeCalls))).toEqual([1,1,1]);expect((await snapshot(page)).watchdogs).toBe(0);
  expect(control.apiWrites).toEqual([]);expect(control.errors).toEqual([]);await proof(page,{jobReads:control.jobReads,apiWrites:control.apiWrites,errors:control.errors});
});
