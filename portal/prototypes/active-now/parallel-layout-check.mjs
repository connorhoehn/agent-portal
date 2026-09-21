import assert from 'node:assert/strict';
import {getScenario} from './graphData.mjs';
import {projectWindow,DEFAULT_RANGE,estimatedHeight} from './timeline.mjs';
const overlaps=(a,b)=>a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;
for(const count of [2,3,5])for(const [width,height,full] of [[720,720,false],[1200,650,true],[1700,950,true]]){
 const data=getScenario(count),graph=projectWindow(data.nodes,data.edges,DEFAULT_RANGE,{width,height},{full});
 assert.equal(graph.groupBounds.length,count);
 for(let a=0;a<count;a++)for(let b=a+1;b<count;b++)assert(!overlaps(graph.groupBounds[a],graph.groupBounds[b]),'Independent activity frames never overlap');
 const cards=graph.nodes.filter(n=>n.type!=='activityFrame');
 for(const card of cards){
  const containing=graph.groupBounds.filter(g=>card.position.x>=g.x&&card.position.y>=g.y&&card.position.x+200<=g.x+g.width&&card.position.y+estimatedHeight(card)<=g.y+g.height);
  assert.equal(containing.length,1,`${card.id} belongs entirely to one activity frame`);
 }
 for(let a=0;a<cards.length;a++)for(let b=a+1;b<cards.length;b++)assert(!overlaps({...cards[a].position,width:200,height:estimatedHeight(cards[a])},{...cards[b].position,width:200,height:estimatedHeight(cards[b])}),'Cards do not overlap');
 for(const edge of graph.edges){const a=cards.find(n=>n.id===edge.source),b=cards.find(n=>n.id===edge.target);assert(a&&b,'Collapsed sources leave no orphan edges');}
 assert.equal(graph.nodes.find(n=>n.id==='workitem').className,'input-node');
 assert.equal(graph.nodes.find(n=>n.id==='background').className,'focus-node');
 if(count>2){assert(!graph.nodes.some(n=>n.id==='meeting'));assert(graph.groupBounds.find(g=>g.id==='presentation').collapsed);}
 const focused=projectWindow(data.nodes,data.edges,DEFAULT_RANGE,{width,height},{full,focusGroup:'presentation'});
 assert.equal(focused.groupBounds.length,1);assert(focused.nodes.some(n=>n.id==='meeting'));
}
const scenario=getScenario(2);
const full=projectWindow(scenario.nodes,scenario.edges,DEFAULT_RANGE,{width:1500,height:750},{full:true});
assert.equal(full.layoutMode,'wide','Full view defaults to more spacious horizontal flow');
const terminal=full.nodes.find(n=>n.id==='background'),work=full.nodes.find(n=>n.id==='workitem');
assert(terminal.position.x>work.position.x);assert.equal(terminal.position.y,work.position.y);
const three=getScenario(3),expanded=projectWindow(three.nodes,three.edges,DEFAULT_RANGE,{width:1500,height:750},{full:true,sourceVisibility:{presentation:true}});
assert(expanded.nodes.some(n=>n.id==='meeting'));assert(!expanded.groupBounds.find(g=>g.id==='presentation').collapsed);
console.log('PASS: 2/3/5 isolated groups, non-overlapping packing, source disclosure, no orphan edges, focused activity, and horizontal full-view flow.');
