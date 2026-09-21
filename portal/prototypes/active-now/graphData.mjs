const node=(id,data,type='resource')=>({id,type,position:{x:0,y:0},data});
export const nodes=[
 node('w1',{title:'WORK-142',icon:'☑',category:'source',text:'Session recovery',state:'completed',time:'08:00 → 08:13'}),
 node('t1',{title:'Terminal 1',icon:'⌘',category:'source',text:'Gateway · session recovery',state:'completed',time:'Cloud project'}),
 node('a1',{prompt:'Implement session recovery',model:'code agent',allowedTools:['Bash','Read','Edit'],_state:'completed'},'agent'),
 node('b1',{type:'build:passed',label:'Commit 9a42f1 · story updated',_state:'completed'},'server'),
 node('w2',{title:'WORK-143',icon:'☑',category:'source',text:'Retry handling',state:'completed',time:'08:14 → 08:28'}),
 node('t2',{title:'Terminal 2',icon:'⌘',category:'source',text:'Gateway · retry handling',state:'completed',time:'Cloud project'}),
 node('a2',{prompt:'Implement retry handling',model:'code agent',allowedTools:['Bash','Read','Edit'],_state:'completed'},'agent'),
 node('b2',{type:'build:passed',label:'Commit 4bc271 · story updated',_state:'completed'},'server'),
 node('chat',{title:'Engineering chat',icon:'◌',category:'human',text:'Release discussion · 08:28',compact:true}),
 node('meeting',{title:'Planning sync',icon:'◉',category:'human',text:'08:30–09:00 · Meeting',compact:true,role:'context'}),
 node('transcript',{title:'Transcript',icon:'▤',category:'sink',text:'Meeting notes · 09:00',compact:true,role:'context'}),
 node('doc',{title:'Project documents',icon:'▤',category:'source',text:'Release plan · rev 6 · 09:08',compact:true,role:'context'}),
 node('deckagent',{prompt:'Generate presentation',model:'Presentation agent',allowedTools:['Slides','Charts','Files'],showTools:true,_state:'running'},'agent'),
 node('deck',{title:'Sprint review',icon:'▣',category:'sink',text:'v3 generating · v2 available',slide:2,state:'running',time:'First draft · 09:27',feedbackCount:2}),
 node('workitem',{title:'WORK-144',icon:'☑',category:'source',text:'Gateway · Flaky test triage',compact:true,tag:'Cloud project',state:'idle',role:'context'}),
 node('background',{title:'Cloud terminal',icon:'⌘',category:'source',text:'auth-migration-3 · WORK-144',state:'running',time:'AgentCore microVM · 09:15',tag:'Triaging tests'}),
];
const edge=(id,source,target,options={})=>({id,source,target,sourceHandle:'out',targetHandle:'in',type:'existing',...options,data:{state:'default',...(options.data??{})}});
export const edges=[
 edge('e1','w1','t1'),edge('e2','t1','a1'),edge('e3','a1','b1'),
 edge('e4','w2','t2'),edge('e5','t2','a2'),edge('e6','a2','b2'),
 edge('meeting-transcript','meeting','transcript',{data:{role:'input'}}),
 edge('notes-input','transcript','deckagent',{sourceHandle:'down',targetHandle:'notes',data:{role:'input'}}),
 edge('documents-input','doc','deckagent',{data:{role:'input'}}),
 edge('generation','deckagent','deck',{data:{state:'active',payload:'image',label:'generating'}}),
 edge('work-session','workitem','background',{sourceHandle:'down',targetHandle:'up',data:{state:'active'}}),
];

// Optional sample efforts let the preview demonstrate concurrent-work density.
const extraEfforts=[
 {id:'release-notes',title:'Release notes',detail:'Document agent · Drafting',order:102,nodes:[
  node('release-source',{title:'Release plan',icon:'▤',category:'source',text:'Revision 6 · Shared document',compact:true,role:'context'}),
  node('release-agent',{prompt:'Draft release notes',model:'Document agent',allowedTools:['Documents'],_state:'running'},'agent'),
 ]},
 {id:'preview-build',title:'Dependency audit',detail:'Cloud terminal · Auditing',order:101,nodes:[
  node('preview-source',{title:'WORK-145',icon:'☑',category:'source',text:'Gateway · Dependency audit',compact:true,role:'context'}),
  node('preview-terminal',{title:'Cloud terminal 2',icon:'⌘',category:'source',text:'auth-migration-4 · WORK-145',state:'running',tag:'Audit running',time:'AgentCore microVM · 09:34'}),
 ]},
 {id:'design-assets',title:'Design assets',detail:'Design agent · Rendering',order:100,nodes:[
  node('design-source',{title:'Design brief',icon:'▤',category:'source',text:'Product launch · Shared brief',compact:true,role:'context'}),
  node('design-agent',{prompt:'Create launch visuals',model:'Design agent',allowedTools:['Images','Files'],_state:'running'},'agent'),
 ]},
];
export function getScenario(count=2){
 const extra=extraEfforts.slice(0,Math.max(0,count-2));
 return {nodes:[...nodes,...extra.flatMap(effort=>effort.nodes.map(n=>({...n,data:{...n.data,period:[94,105],effort:{id:effort.id,title:effort.title,detail:effort.detail,order:effort.order}}})))],
 edges:[...edges,...extra.map(effort=>edge(`${effort.id}-input`,effort.nodes[0].id,effort.nodes[1].id,{data:{role:'input',state:'active'}}))]};
}
export const allSampleNodes=getScenario(5).nodes;
