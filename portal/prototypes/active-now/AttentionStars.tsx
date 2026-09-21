import React,{useEffect,useId,useRef,useState} from 'react';

type Star={x:number;y:number;radius:number;opacity:number;speed:number|null};

function hash(input:string){let value=2166136261;for(const char of input){value^=char.charCodeAt(0);value=Math.imul(value,16777619)}return value>>>0}
function random(seed:number){let state=seed||1;return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296}}
export function makeAttentionStars(width:number,height:number,seed:string,density=.00035):Star[]{
 const count=Math.min(54,Math.max(7,Math.round(width*height*density)));
 const next=random(hash(seed));
 return Array.from({length:count},()=>({x:next()*width,y:next()*height,radius:.7+next()*.65,opacity:.25+next()*.5,speed:next()<.6?2.7+next()*2.8:null}));
}

/** Decorative, local to an active item. The canvas and hit targets stay untouched. */
export function AttentionStars({seed,className='',trail=true}:{seed:string;className?:string;trail?:boolean}){
 const container=useRef<HTMLDivElement>(null);
 const [size,setSize]=useState({width:0,height:0});
 const [reducedMotion,setReducedMotion]=useState(()=>typeof window!=='undefined'&&window.matchMedia?.('(prefers-reduced-motion: reduce)').matches||false);
 const id=useId();
 useEffect(()=>{
  const node=container.current;if(!node)return;
  const measure=()=>{const width=Math.round(node.clientWidth),height=Math.round(node.clientHeight);setSize(old=>old.width===width&&old.height===height?old:{width,height})};
  measure();const observer=new ResizeObserver(measure);observer.observe(node);return()=>observer.disconnect();
 },[]);
 useEffect(()=>{
  const query=window.matchMedia?.('(prefers-reduced-motion: reduce)');if(!query)return;
  const changed=()=>setReducedMotion(query.matches);query.addEventListener?.('change',changed);return()=>query.removeEventListener?.('change',changed);
 },[]);
 const stars=size.width&&size.height?makeAttentionStars(size.width,size.height,seed):[];
 return <div ref={container} className={'attention-stars '+className} aria-hidden="true" data-testid={`attention-stars-${seed}`}>
  <svg width="100%" height="100%" viewBox={`0 0 ${Math.max(size.width,1)} ${Math.max(size.height,1)}`} preserveAspectRatio="none" focusable="false">
   <defs><linearGradient id={`${id}-trail`} x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0" stopColor="var(--attention-star)" stopOpacity="0"/><stop offset=".78" stopColor="var(--attention-star)" stopOpacity=".72"/><stop offset="1" stopColor="var(--attention-star)" stopOpacity="0"/></linearGradient></defs>
   {stars.map((star,index)=><circle key={index} cx={star.x} cy={star.y} r={star.radius} fill="var(--attention-star)" opacity={star.opacity}>
    {!reducedMotion&&star.speed&&<animate attributeName="opacity" values={`${star.opacity};${star.opacity*.32};${star.opacity}`} dur={`${star.speed}s`} repeatCount="indefinite"/>}
   </circle>)}
   {!reducedMotion&&trail&&size.width>100&&<line x1="-92" y1="-10" x2="-26" y2="8" stroke={`url(#${id}-trail)`} strokeWidth="1.3" className="attention-shooting-trail"><animateTransform attributeName="transform" type="translate" values={`0 0; ${size.width+180} ${Math.max(24,size.height*.72)}`} dur="8.5s" begin="1.2s" repeatCount="indefinite"/></line>}
  </svg>
 </div>;
}

export function AttentionSurface({children,seed,tone='work',className=''}:{children:React.ReactNode;seed:string;tone?:'work'|'review';className?:string}){
 return <div className={`attention-surface attention-${tone} ${className}`} data-attention={tone}>
  <AttentionStars seed={seed} trail={tone==='work'}/>
  <div className="attention-content">{children}</div>
 </div>;
}
