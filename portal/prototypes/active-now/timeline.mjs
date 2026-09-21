import {packActivities,emphasisFor} from './activityLayout.mjs';
export {estimatedHeight} from './activityLayout.mjs';
export const NOW=105;
export const DEFAULT_RANGE={start:90,end:NOW};
export function clock(minute){const total=480+minute;return `${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;}
export function resizeWindow(range,duration){const size=Math.min(NOW,Math.max(1,duration));const end=Math.max(range.end,size);return {start:end-size,end};}
export function moveWindow(range,direction){const size=range.end-range.start;const end=Math.max(size,Math.min(NOW,range.end+size*direction));return {start:end-size,end};}
export function backToNow(range){return {start:NOW-(range.end-range.start),end:NOW};}
export const periods={
 w1:[0,13],t1:[0,13],a1:[1,13],b1:[13,13],w2:[14,28],t2:[14,28],a2:[15,28],b2:[28,28],
 chat:[28,28],meeting:[30,60],transcript:[60,60],doc:[68,68],
 deckagent:[80,NOW],deck:[87,NOW],workitem:[75,NOW],background:[75,NOW],
};
const groupOf={w1:'story1',t1:'story1',a1:'story1',b1:'story1',w2:'story2',t2:'story2',a2:'story2',b2:'story2',chat:'chat',meeting:'meeting',transcript:'meeting',doc:'document',deckagent:'presentation',deck:'presentation',workitem:'background',background:'background'};
const groups={
 presentation:{title:'SPRINT REVIEW',detail:'Sources → presentation',order:105},
 background:{title:'ALSO RUNNING',detail:'Cloud project · Coverage checks',order:104},
 document:{title:'09:08 — DOCUMENT UPDATE',detail:'Release plan · revision 6',order:68},
 meeting:{title:'08:30–09:00 — PLANNING SYNC',detail:'Shared meeting and transcript',order:60},
 chat:{title:'08:28 — ENGINEERING CHAT',detail:'Release discussion',order:28,start:28},
 story2:{title:'08:14–08:28 — WORK-143',detail:'Retry handling',order:28,start:14},
 story1:{title:'08:00–08:13 — WORK-142',detail:'Session recovery',order:13},
};
export function dataAt(node,end){
 const data={...node.data};const period=periods[node.id];
 if(end<NOW&&['t1','t2','a1','a2','w1','w2'].includes(node.id)&&end<period[1]){
  if(node.type==='agent')data._state='running';else data.state='running';data.tag='In progress then';
 }
 if(node.id==='deckagent')data._state=end>=98&&end<103?'completed':'running';
 if(node.id==='deck'){
  const version=end>=98?2:1;const generating=end>=103;
  data.slide=version;data.availableVersions=version===2?[1,2]:[1];data.generatingVersion=generating?3:null;
  data.text=generating?'v3 generating · v2 available':`v${version} ready`;
  data.state=generating?'running':'completed';data.feedbackCount=end>=101?2:end>=100?1:0;
 }
 if(node.id==='meeting')data.text=end<60?'08:30–09:00 · In progress then':'08:30–09:00 · Meeting';
 return data;
}
export function projectWindow(allNodes,allEdges,range,viewport={width:1200,height:700},options={}){
 const getPeriod=n=>n.data.period??periods[n.id];
 const allById=new Map(allNodes.map(n=>[n.id,n]));
 const visibleIds=new Set(allNodes.filter(n=>getPeriod(n)&&getPeriod(n)[0]<=range.end&&getPeriod(n)[1]>=range.start).map(n=>n.id));
 // Retain upstream context for work in this window, without pulling future or
 // unrelated historical activity into the current graph.
 let changed=true;
 while(changed){changed=false;for(const e of allEdges){if(e.data.role==='input'&&visibleIds.has(e.target)&&!visibleIds.has(e.source)&&getPeriod(allById.get(e.source))?.[0]<=range.end){visibleIds.add(e.source);changed=true;}}}
 const hasPresentation=visibleIds.has('deckagent');
 const visible=allNodes.filter(n=>visibleIds.has(n.id)).map(n=>({...n,data:dataAt(n,range.end)}));
 const byGroup=new Map();
 for(const n of visible){const id=hasPresentation&&['meeting','transcript','doc'].includes(n.id)?'presentation':n.data.effort?.id??groupOf[n.id];if(!byGroup.has(id))byGroup.set(id,[]);byGroup.get(id).push(n);}
 const metadata={...groups};for(const n of visible)if(n.data.effort)metadata[n.data.effort.id]=n.data.effort;
 const allOrdered=[...byGroup.keys()].sort((a,b)=>Math.min(metadata[b].order,range.end)-Math.min(metadata[a].order,range.end)||metadata[b].order-metadata[a].order||(metadata[b].start??0)-(metadata[a].start??0));
 const ordered=options.focusGroup&&byGroup.has(options.focusGroup)?[options.focusGroup]:allOrdered;
 const concurrent=ordered.filter(id=>id==='presentation'||id==='background'||!groups[id]);
 const packed=packActivities(byGroup,ordered,concurrent,viewport,options);
 const result=[],groupBounds=[];
 const nodeMap=new Map(visible.map(n=>[n.id,n]));
 for(const {group,width,height,placed,x,y,collapsed,sourceCount,mode} of packed.layouts){
  const g=metadata[group],live=range.end===NOW&&concurrent.includes(group);let title=g.title,detail=g.detail;
  if(group==='presentation'){title='Sprint review';detail=range.end>=103?'v3 generating · v2 available':range.end>=98?'v2 ready':range.end>=87?'First draft ready':'Creating first draft';}
  if(group==='background'){title='Coverage checks';detail='Gateway · Cloud project';}
  result.push({id:`frame-${group}`,type:'activityFrame',position:{x,y},style:{width,height},zIndex:-1,
   data:{group,title,sub:detail,live,width,height,collapsed,sourceCount,focused:options.focusGroup===group},selectable:false,draggable:false,focusable:false});
  for(const item of placed)result.push({...item.node,className:emphasisFor(item.node,allEdges,nodeMap),position:{x:x+item.x,y:y+item.y}});
  groupBounds.push({id:group,x,y,width,height,mode,collapsed});
 }
 const ids=new Set(result.map(n=>n.id));
 const presentation=groupBounds.find(g=>g.id==='presentation');
 const visibleEdges=allEdges.filter(e=>ids.has(e.source)&&ids.has(e.target)).map(e=>{
  const generation=e.id==='generation',generating=range.end>=103||range.end<98;
  const horizontalWork=e.id==='work-session'&&result.find(n=>n.id===e.target).position.x>result.find(n=>n.id===e.source).position.x;
  return {...e,...(generation&&presentation?.mode==='compact'&&!presentation.collapsed?{targetHandle:'up'}:{}),
   ...(horizontalWork?{sourceHandle:'out',targetHandle:'in'}:{}),
   data:{...e.data,...(generation?{label:generating?'generating':'generated'}:{}),...(e.data.state==='active'&&(range.end<NOW||generation&&!generating)?{state:'default'}:{})}};
 });
 return {nodes:result,edges:visibleEdges,groupOrder:ordered,groupBounds,layoutMode:packed.mode,crowded:packed.crowded,activityCount:allOrdered.filter(id=>id==='presentation'||id==='background'||!groups[id]).length};
}
