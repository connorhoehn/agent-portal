import React from 'react';

// The supplied Sass pattern generates box-shadow points at build time. This
// small deterministic equivalent keeps the standalone HTML export self-contained.
function shadows(count:number,seed:number,color:string){
 let value=seed;
 const next=()=>{value^=value<<13;value^=value>>>17;value^=value<<5;return (value>>>0)/4294967296};
 return Array.from({length:count},()=>`${Math.round(next()*1200)}px ${Math.round(next()*1200)}px ${color}`).join(',');
}
const layers=[
 {className:'small',shadow:shadows(230,1127,'#8298c850')},
 {className:'medium',shadow:shadows(65,4199,'#738bc359')},
 {className:'large',shadow:shadows(18,9173,'#738bc34d')},
];

export function PipelineStarfield(){
 return <div className="pipeline-starfield" aria-hidden="true" data-testid="pipeline-starfield">
  {layers.map(layer=><span key={layer.className} className={`pipeline-star-layer ${layer.className}`} style={{boxShadow:layer.shadow}}/>)}
 </div>;
}
