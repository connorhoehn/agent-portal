import assert from 'node:assert/strict';
import {getViewportForBounds} from '@xyflow/system';
import {GRAPH_FIT,CANVAS_INSETS} from './viewport.mjs';
// Includes the tall slide card and generating output seen near the bottom in
// the reported screenshot, a compact split, a full canvas and full-day history.
for(const size of [{width:1024,height:650},{width:620,height:480},{width:1500,height:800}]){
 for(const bounds of [{x:0,y:0,width:676,height:556},{x:0,y:0,width:912,height:482},{x:-25,y:0,width:960,height:2700}]){
  const view=getViewportForBounds(bounds,size.width,size.height,GRAPH_FIT.minZoom,GRAPH_FIT.maxZoom,GRAPH_FIT.padding);
  const left=bounds.x*view.zoom+view.x,top=bounds.y*view.zoom+view.y;
  const right=(bounds.x+bounds.width)*view.zoom+view.x,bottom=(bounds.y+bounds.height)*view.zoom+view.y;
  assert(left>=CANVAS_INSETS.left-.01&&right<=size.width-CANVAS_INSETS.right+.01,'Left/right card bounds stay inside the canvas');
  assert(top>=CANVAS_INSETS.top-.01&&bottom<=size.height-CANVAS_INSETS.bottom+.01,'Bottom outputs clear the canvas toolbar');
  assert(view.zoom<=1.2,'Automatic fitting must not enlarge cards beyond 120%');
 }
}
console.log('PASS: measured bounds fit inside safe margins in split, full and full-day views; automatic zoom capped at 120%.');
