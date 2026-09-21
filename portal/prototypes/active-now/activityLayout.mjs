import {CANVAS_INSETS} from './viewport.mjs';
export const estimatedHeight=node=>node.id==='transcript'?148:node.id==='meeting'?126:node.data.compact?82:node.data.slide?(node.data.condensed?190:258):node.data.showTools?100:node.type==='agent'||node.type==='server'?90:145;
const isRunning=n=>n?.data.state==='running'||n?.data._state==='running';
function localLayout(group,members,mode,full,crowded,openSources){
 const padding=full?28:20,header=48;
 const sourceNodes=group==='presentation'?members.filter(n=>['meeting','transcript','doc'].includes(n.id)):[];
 const collapsed=!openSources&&sourceNodes.length>0;
 const shown=members.filter(n=>!collapsed||!sourceNodes.includes(n)).map(n=>({...n,data:{...n.data,
  ...(crowded&&n.data.slide?{condensed:true}:{}),
  ...(crowded&&group!=='presentation'&&n.type==='resource'?{compact:true}:{})}}));
 const column=full?304:248;
 const presentation=collapsed?{deckagent:[0,header],deck:[304,header]}:mode==='compact'?{
  meeting:[0,header],transcript:[248,header],doc:[0,216],deckagent:[248,216],deck:[248,372],
 }:{meeting:[0,header],transcript:[column,header],doc:[0,full?224:216],deckagent:[column,full?224:216],deck:[column+328,full?224:216]};
 const placed=shown.map((node,index)=>{
  const xy=group==='presentation'?presentation[node.id]:mode==='compact'&&!crowded?[0,header+index*136]:[index*(full?304:296),header];
  return {node,x:xy[0]+padding,y:xy[1],height:estimatedHeight(node)};
 });
 const labelLane=group==='presentation'&&mode==='compact'&&!collapsed?100:0;
 return {group,placed,collapsed,sourceCount:sourceNodes.length,mode,width:Math.max(...placed.map(n=>n.x+(['transcript','meeting'].includes(n.node.id)?224:200)))+padding+labelLane,height:Math.max(...placed.map(n=>n.y+n.height))+padding};
}
function partitions(items){
 if(!items.length)return [[]];
 const result=[];
 function visit(index,rows){if(index===items.length){result.push(rows);return;}
  for(let end=index+1;end<=items.length;end++)visit(end,[...rows,items.slice(index,end)]);
 }
 visit(0,[]);return result;
}
function rowSize(row,gap){return {width:row.reduce((s,g)=>s+g.width,0)+Math.max(0,row.length-1)*gap,height:Math.max(0,...row.map(g=>g.height))};}
function rowsSize(rows,gap){return {width:Math.max(0,...rows.map(r=>rowSize(r,gap).width)),height:rows.reduce((s,r)=>s+rowSize(r,gap).height,0)+Math.max(0,rows.length-1)*gap};}
export function packActivities(byGroup,ordered,concurrent,viewport,options={}){
 const full=!!options.full,crowded=concurrent.length>=3&&!options.focusGroup,gap=full?64:36;
 const candidates=[];
 // Choose whole-group wrapping, never interleave nodes from separate efforts.
 for(const mode of ['wide','compact']){
  const layouts=concurrent.map(id=>localLayout(id,byGroup.get(id),mode,full,crowded,options.sourceVisibility?.[id]??(!crowded||options.focusGroup===id)));
  const arrangements=layouts.length<=2?[layouts.length?[layouts]:[]]:partitions(layouts);
  for(const rows of arrangements){
   const size=rowsSize(rows,gap);
   const fit=Math.min((viewport.width-CANVAS_INSETS.left-CANVAS_INSETS.right)/Math.max(1,size.width),(viewport.height-CANVAS_INSETS.top-CANVAS_INSETS.bottom)/Math.max(1,size.height),1.2);
   // At an equally readable size, prefer left-to-right flows and fewer rows.
   candidates.push({rows,mode,score:fit+(mode==='wide'?(full?.18:.025):0)-rows.length*.003+(rows[0]?.length??0)*.001});
  }
  // Balanced columns also use the space below shorter activity frames.
  if(layouts.length>=3)for(let columns=2;columns<=Math.min(3,layouts.length);columns++){
   const heights=Array(columns).fill(0),widths=Array(columns).fill(0),slots=[];
   for(const layout of layouts){const col=heights.indexOf(Math.min(...heights));slots.push({...layout,col,y:heights[col]});heights[col]+=layout.height+gap;widths[col]=Math.max(widths[col],layout.width);}
   const arranged=slots.map(({col,...layout})=>({...layout,x:widths.slice(0,col).reduce((sum,w)=>sum+w+gap,0)}));
   const totalWidth=widths.reduce((sum,w)=>sum+w,0)+(columns-1)*gap,totalHeight=Math.max(...heights)-gap;
   const fit=Math.min((viewport.width-CANVAS_INSETS.left-CANVAS_INSETS.right)/totalWidth,(viewport.height-CANVAS_INSETS.top-CANVAS_INSETS.bottom)/totalHeight,1.2);
   candidates.push({rows:[],arranged,mode,score:fit+(mode==='wide'?(full?.18:.025):0)-.005});
  }
 }
 const best=candidates.reduce((a,b)=>b.score>a.score?b:a);
 const rows=[...best.rows];
 for(const id of ordered.filter(id=>!concurrent.includes(id)))rows.push([localLayout(id,byGroup.get(id),'wide',full,false,true)]);
 const positioned=best.arranged?[...best.arranged]:[];let y=positioned.length?Math.max(...positioned.map(g=>g.y+g.height))+gap:0;
 for(const row of rows){let x=0;for(const layout of row){positioned.push({...layout,x,y});x+=layout.width+gap;}y+=rowSize(row,gap).height+gap;}
 return {layouts:positioned,mode:best.mode,crowded,gap};
}
export function emphasisFor(node,edges,nodeMap){
 if(isRunning(node)&&node.data.role!=='context')return 'focus-node';
 if(edges.some(e=>e.source===node.id&&isRunning(nodeMap.get(e.target))&&nodeMap.get(e.target)?.data.role!=='context'))return 'input-node';
 return 'context-node';
}
