import React from 'react';

// Based on the supplied drop/stem/splat example; positions and timing are
// deterministic so the preview does not reshuffle between renders.
const drops=Array.from({length:27},(_,index)=>({
 left:(index*37+13)%96,
 delay:-((index*17)%37)/17,
 duration:.85+((index*11)%13)/22,
 back:index%3===0,
}));

export function FailureRain(){
 return <div className="node-rain" aria-hidden="true" data-testid="failure-rain-node">
  <div className="rain-row back-row">{drops.filter(drop=>drop.back).map((drop,index)=><Drop key={index} {...drop}/>)}</div>
  <div className="rain-row front-row">{drops.filter(drop=>!drop.back).map((drop,index)=><Drop key={index} {...drop}/>)}</div>
 </div>;
}

function Drop({left,delay,duration}:{left:number;delay:number;duration:number}){
 const style={left:`${left}%`,animationDelay:`${delay}s`,animationDuration:`${duration}s`};
 return <span className="rain-drop" style={style}><span className="rain-stem"/><span className="rain-splat"/></span>;
}
