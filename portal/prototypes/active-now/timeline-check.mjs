import assert from 'node:assert/strict';
import {nodes,edges} from './graphData.mjs';
import {NOW,DEFAULT_RANGE,clock,resizeWindow,moveWindow,backToNow,projectWindow,estimatedHeight} from './timeline.mjs';
const now=projectWindow(nodes,edges,DEFAULT_RANGE);
const real=g=>g.nodes.filter(n=>n.type!=='activityFrame');
assert.deepEqual(real(now).map(n=>n.id).sort(),['meeting','transcript','doc','deckagent','deck','workitem','background'].sort());
assert.deepEqual(now.groupOrder,['presentation','background']);
assert(now.edges.some(e=>e.source==='meeting'&&e.target==='transcript'));
assert(now.edges.some(e=>e.source==='transcript'&&e.target==='deckagent'));
assert(now.edges.some(e=>e.source==='doc'&&e.target==='deckagent'));
assert(now.edges.some(e=>e.source==='deckagent'&&e.target==='deck'));
assert(now.edges.some(e=>e.source==='workitem'&&e.target==='background'));
for(const id of ['meeting']){
 const node=now.nodes.find(n=>n.id===id);assert.equal(node.className,'context-node');assert(node.data.compact);
}
for(const id of ['transcript','doc','workitem'])assert.equal(now.nodes.find(n=>n.id===id).className,'input-node');
for(const id of ['deckagent','deck','background'])assert.equal(now.nodes.find(n=>n.id===id).className,'focus-node');
assert.equal(now.nodes.find(n=>n.id==='deck').data.feedbackCount,2);
assert.deepEqual(now.nodes.find(n=>n.id==='deck').data.availableVersions,[1,2]);
assert.equal(now.nodes.find(n=>n.id==='deck').data.generatingVersion,3);
const meeting=projectWindow(nodes,edges,{start:45,end:60});
assert(meeting.nodes.some(n=>n.id==='meeting'));
assert(meeting.nodes.some(n=>n.id==='transcript'));
assert(!meeting.nodes.some(n=>['deck','doc','deckagent'].includes(n.id)));
const firstDraft=projectWindow(nodes,edges,{start:80,end:90});
assert.equal(firstDraft.nodes.find(n=>n.id==='deck').data.slide,1);
assert.deepEqual(firstDraft.nodes.find(n=>n.id==='deck').data.availableVersions,[1]);
assert.equal(firstDraft.nodes.find(n=>n.id==='deck').data.feedbackCount,0);
assert(!projectWindow(nodes,edges,{start:80,end:86}).nodes.some(n=>n.id==='deck'));
assert(projectWindow(nodes,edges,{start:104,end:NOW}).nodes.some(n=>n.id==='meeting'),'Sources remain visible when they predate the selected window');
assert(projectWindow(nodes,edges,{start:90,end:104}).edges.every(e=>e.data.state!=='active'),'History must not animate as if live');
const wholeDay=projectWindow(nodes,edges,{start:0,end:NOW});
assert.deepEqual(wholeDay.groupOrder,['presentation','background','chat','story2','story1']);
assert.equal(wholeDay.nodes.filter(n=>n.id==='meeting').length,1,'Meeting is source context, not a duplicate history graph');
for(let start=0;start<NOW;start++)for(let end=start+1;end<=NOW;end++){
 const range={start,end};
 for(const direction of [-1,1]){const moved=moveWindow(range,direction);assert(moved.start>=0&&moved.end<=NOW);assert.equal(moved.end-moved.start,end-start)}
 const live=backToNow(range);assert.equal(live.end,NOW);assert.equal(live.end-live.start,end-start);
}
assert.deepEqual(resizeWindow({start:45,end:60},105),{start:0,end:105});assert.equal(clock(NOW),'9:45');
const wide=projectWindow(nodes,edges,DEFAULT_RANGE,{width:1500,height:750},{full:true});
const narrow=projectWindow(nodes,edges,DEFAULT_RANGE,{width:720,height:720});
assert.equal(wide.layoutMode,'wide');assert.equal(narrow.layoutMode,'compact');
for(const layout of [wide,narrow]){
 const main=layout.groupBounds.find(g=>g.id==='presentation'),background=layout.groupBounds.find(g=>g.id==='background');
 assert.equal(main.y,background.y,'Concurrent efforts share the same row');assert(background.x>=main.x+main.width+36);
 assert(layout.nodes.find(n=>n.id==='frame-background').style.width>=240);
 const cards=real(layout);
 for(let a=0;a<cards.length;a++)for(let b=a+1;b<cards.length;b++){
  const x=cards[a],y=cards[b];
  assert(!(x.position.x<y.position.x+200&&y.position.x<x.position.x+200&&x.position.y<y.position.y+estimatedHeight(y)&&y.position.y<x.position.y+estimatedHeight(x)),`${x.id} overlaps ${y.id}`);
 }
}
const activeBottom=Math.max(...wholeDay.groupBounds.filter(g=>['presentation','background'].includes(g.id)).map(g=>g.y+g.height));
assert(wholeDay.groupBounds.filter(g=>!['presentation','background'].includes(g.id)).every(g=>g.y>activeBottom));
console.log('PASS: source context, one output with revisions and feedback, no future nodes, no duplicate history, concurrent layout, no card overlap, and time controls.');
